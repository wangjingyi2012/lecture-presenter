// workbench-window.js - Chat logic for the workbench Agent window.
//
// This window owns the conversation + AI calls + action protocol. It does NOT
// touch PpteEditor or files directly; instead it RPCs to the main window:
//   wb-request {type:'get-context'}            -> {title, slides:[{title}], aiConfig}
//   wb-request {type:'get-slide', payload:{page}} -> {html}
//   wb-request {type:'execute-action', payload:{action}} -> {result}
// Main window responds via wb-response {type, result}.
//
// AI streaming: call_ai_messages_stream emits global ai-stream-chunk / ai-stream-done
// events; only this window listens (the main window no longer streams).
window.WorkbenchWindow = {
  history: [],          // [{role, content}]; [0] is the system prompt
  manifest: null,       // {title, slides:[{title}]}
  aiConfig: null,
  busy: false,
  maxToolRounds: 6,
  _streamFull: '',
  _displayText: '',
  _streamResolve: null,
  _renderTimer: null,
  _typeTimer: null,

  PROTOCOL_PROMPT: `## 工具调用协议

你是课件级助手，可以修改整套 PPTE 课件。用户消息里 @第N页 的 HTML 是当前该页内容；需要看其他页时用 read_slide 工具。

要修改页面时，返回一个 \`\`\`action 代码块，内含 JSON（一次一个工具）：

{"tool":"write_slide","page":3,"html":"<完整页面HTML>","reason":"为何这样改"}

工具清单：
- write_slide {page, html, reason}：替换某页完整 HTML（page 从 1 开始）
- insert_slide {after, title, html, reason}：在某页之后插入新页（after=0 表示开头）
- reorder_slides {order, reason}：重排，order 是新顺序的页码数组，如 [1,3,2]
- read_slide {page}：读取某页 HTML
- validate_slide {page}：对该页跑 PPTE 规范检查

规则：
- 一次只返回一个 action 块；action 块外的文字是给用户的解释
- 不要用 \`\`\`html 返回裸 HTML，一律走 action 块
- 改完页面后主动 validate_slide 自检，发现问题再修
- html 字段是完整的单页 HTML（含 <style> 和页面结构）
- 主窗口会实时预览改动，用户能看到，无需重复描述页面内容`,

  async init() {
    if (!window.__TAURI__ || !window.__TAURI__.event) return;
    const { listen, emit } = window.__TAURI__.event;

    // RPC response + prefill + streaming events
    await listen('wb-response', (e) => this._onResponse(e.payload));
    await listen('wb-prefill', (e) => this._onPrefill(e.payload));
    await listen('ai-stream-chunk', (e) => {
      this._streamFull += e.payload;
      this._scheduleStreamingUpdate();
    });
    await listen('ai-stream-done', () => {
      if (this._renderTimer) { clearTimeout(this._renderTimer); this._renderTimer = null; }
      this._updateStreaming();
      const resolve = this._streamResolve;
      this._streamResolve = null;
      if (resolve) resolve(this._streamFull);
    });

    document.getElementById('wb-send').onclick = () => this._send();
    document.getElementById('wb-clear').onclick = () => this._clear();
    const input = document.getElementById('wb-input');
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this._send(); }
    };

    // Fetch course context from the main window.
    const ctx = await this._rpc('get-context');
    if (ctx) this._onContext(ctx);
    input.focus();
    // typewriter: continuously catch up the displayed text toward the streamed target
    this._typeTimer = setInterval(() => this._typeTick(), 16);
  },

  _typeTick() {
    if (!this._streamEl || !this._streamFull) return;
    const target = this._stripActions(this._streamFull);
    if (this._displayText.length < target.length) {
      // type ~3 chars per tick (~188 chars/sec) for a smooth terminal feel
      this._displayText = target.slice(0, this._displayText.length + 3);
      this._updateStreaming();
    }
  },

  _waitForTypewriter() {
    return new Promise(resolve => {
      const check = () => {
        const target = this._stripActions(this._streamFull);
        if (!target || this._displayText.length >= target.length) resolve();
        else setTimeout(check, 30);
      };
      check();
    });
  },

  // ---- RPC over events (single in-flight request; busy guard ensures serial) ----
  _pendingResolve: null,
  _rpc(type, payload) {
    return new Promise((resolve) => {
      this._pendingResolve = resolve;
      window.__TAURI__.event.emit('wb-request', { type, payload });
    });
  },
  _onResponse(resp) {
    if (!resp) return;
    const r = this._pendingResolve;
    this._pendingResolve = null;
    if (r) r(resp.result);
  },

  _onContext(ctx) {
    this.manifest = ctx;
    this.aiConfig = ctx?.aiConfig || null;
    this.providers = ctx?.providers || [];
    // populate model selector
    const sel = document.getElementById('wb-model');
    if (sel) {
      sel.innerHTML = this.providers.map(p => `<option value="${p.id}">${this._escape(p.label)}</option>`).join('');
      const def = (ctx?.defaultProvider && this.providers.some(p => p.id === ctx.defaultProvider)) ? ctx.defaultProvider : (this.providers[0]?.id || '');
      sel.value = def;
      this._applySelectedModel(def);
      sel.onchange = () => this._applySelectedModel(sel.value);
    }
    if (!this.providers.length) {
      const m = document.getElementById('wb-messages');
      if (m) m.innerHTML = `<div class="wb-empty">未配置可用 AI。<br>请在主窗口设置中配置 AI，<br>或登录后使用 LectureAI。</div>`;
    }
    const meta = document.getElementById('wb-course-meta');
    if (meta) {
      if (ctx && ctx.slides?.length) {
        meta.textContent = `${ctx.title || '未命名'} · ${ctx.slides.length} 页`;
        meta.title = ctx.slides.map((s, i) => `${i + 1}. ${s.title}`).join('\n');
      } else {
        meta.textContent = '未连接课件';
      }
    }
  },

  _applySelectedModel(id) {
    this.selectedConfig = this.providers.find(p => p.id === id)?.config || null;
  },

  // Re-fetch course context from the main window (a PPTE may have been opened
  // after this window loaded). Preserves the user's model selection if still available.
  async _refreshContext() {
    const ctx = await this._rpc('get-context');
    if (!ctx) return;
    const prevSel = document.getElementById('wb-model')?.value;
    this._onContext(ctx);
    const sel = document.getElementById('wb-model');
    if (sel && prevSel && this.providers.some(p => p.id === prevSel)) {
      sel.value = prevSel;
      this._applySelectedModel(prevSel);
    }
  },

  _onPrefill(payload) {
    const page = payload?.page;
    if (!page) return;
    const input = document.getElementById('wb-input');
    if (input && !input.value.startsWith('@')) input.value = `@${page} ` + input.value;
    input.focus();
  },

  _clear() {
    this.history = [];
    this._renderEmpty();
  },

  _renderEmpty() {
    const m = document.getElementById('wb-messages');
    if (m) m.innerHTML = `<div class="wb-empty">课件级对话窗口。<br>对整套课件发指令，<br>@页码定位单页（如 @3）。<br>改完自动保存并在主窗口预览。</div>`;
  },

  // ---- system prompt ----
  _systemPrompt() {
    let ctx = '当前未连接课件。';
    if (this.manifest?.slides?.length) {
      const list = this.manifest.slides.map((s, i) => `${i + 1}. ${s.title || '（无标题）'}`).join('\n');
      ctx = `当前课件：${this.manifest.title || '未命名'}（共 ${this.manifest.slides.length} 页）\n页面清单：\n${list}`;
    }
    // LectureAI: the server owns the SKILL (rules + protocol + pedagogy) as a
    // product asset and prepends it; the desktop sends only the dynamic manifest
    // so the model isn't double-prompted.
    if (this.selectedConfig?.aiProvider === 'lectureai') {
      return ctx;
    }
    // My own AI (direct provider): MINIMAL - only the tool protocol + manifest.
    // No SKILL (排版规范/教学法), so the contrast with LectureAI is clear:
    // LectureAI produces SKILL-compliant high-quality slides, my own AI does not.
    return [this.PROTOCOL_PROMPT, ctx].join('\n\n');
  },

  _ensureHistory() {
    if (!this.history.length) this.history.push({ role: 'system', content: this._systemPrompt() });
  },

  // ---- @-mention resolution (fetch slide HTML via RPC) ----
  async _resolveAt(rawInput) {
    if (!this.manifest?.slides?.length) return { content: rawInput, mentioned: [] };
    const mentioned = [];
    const seen = new Set();
    const ctxParts = [];
    const fetchSlide = async (i) => {
      if (seen.has(i)) return null;
      seen.add(i);
      const html = await this._rpc('get-slide', { page: i + 1 });
      const s = this.manifest.slides[i];
      mentioned.push({ page: i + 1, title: s.title });
      return `@第${i + 1}页「${s.title}」当前HTML：\n\`\`\`html\n${html || ''}\n\`\`\``;
    };

    // @N (page number) - resolve asynchronously
    let input = rawInput;
    const numMatches = [...rawInput.matchAll(/@(\d+)\b/g)];
    for (const m of numMatches) {
      const i = Number(m[1]) - 1;
      if (i >= 0 && i < this.manifest.slides.length) {
        const part = await fetchSlide(i);
        if (part) ctxParts.push(part);
      }
    }
    input = input.replace(/@(\d+)\b/g, (m, n) => `第${n}页`);

    // @title (substring)
    const titleMatches = [...input.matchAll(/@([^\s@，。、,]+)/g)];
    for (const m of titleMatches) {
      const frag = m[1];
      const i = this.manifest.slides.findIndex(s => (s.title || '').includes(frag));
      if (i >= 0) {
        const part = await fetchSlide(i);
        if (part) {
          ctxParts.push(part);
          input = input.replace(`@${frag}`, `第${i + 1}页「${this.manifest.slides[i].title}」`);
        }
      }
    }

    const content = ctxParts.length ? `${ctxParts.join('\n\n')}\n\n[用户要求]\n${input}` : input;
    return { content, mentioned };
  },

  // ---- send + agent loop ----
  async _send() {
    if (this.busy) return;
    const inputEl = document.getElementById('wb-input');
    const input = inputEl?.value.trim();
    if (!input) return;
    const cfg = this.selectedConfig || this.aiConfig || {};
    if (!cfg.aiProvider || (cfg.aiProvider !== 'lectureai' && !cfg.aiApiKey)) {
      alert('请先在主窗口设置中配置 AI，或登录后选择 LectureAI');
      return;
    }
    // refresh context (a PPTE may have been opened in the main window after this window loaded)
    await this._refreshContext();
    if (!this.manifest?.slides?.length) {
      alert('未连接课件。请在主窗口打开一个 PPTE 课件进编辑器，再发送指令。');
      return;
    }
    this._ensureHistory();
    // refresh system prompt (manifest may have changed)
    this.history[0] = { role: 'system', content: this._systemPrompt() };

    const { content, mentioned } = await this._resolveAt(input);
    this._appendUser(input, mentioned);
    this.history.push({ role: 'user', content });
    if (inputEl) inputEl.value = '';

    await this._runTurn();
  },

  async _runTurn() {
    this.busy = true;
    this._setBusy(true);
    try {
      let rounds = 0;
      while (rounds < this.maxToolRounds) {
        rounds++;
        const text = await this._callAI(this.history);
        await this._waitForTypewriter();
        if (!text) { this._log('err', 'AI 返回空内容，可能是服务端问题、额度耗尽或请求被拒'); break; }
        this.history.push({ role: 'assistant', content: text });
        const actions = this._parseActions(text);
        // prose already streamed into the log by _updateStreaming
        if (!actions.length) break;
        const results = [];
        for (const a of actions) {
          this._logAction(a);
          // inline diff for slide rewrites (current vs new html)
          if (a.tool === 'write_slide' && a.page != null) {
            try {
              const before = await this._rpc('get-slide', { page: a.page });
              if (before) this._appendDiff(before, a.html || '');
            } catch (e) { /* skip diff if fetch fails */ }
          }
          const result = await this._rpc('execute-action', { action: a });
          this._logResult(result);
          results.push(result || '(无结果)');
        }
        const resultMsg = '[工具结果]\n' + results.join('\n\n');
        this.history.push({ role: 'user', content: resultMsg });
      }
      if (rounds >= this.maxToolRounds) {
        this._log('sys', '已达工具调用上限，停止本轮');
      }
    } catch (e) {
      this._log('err', '出错：' + this._escape(String(e)));
    } finally {
      this.busy = false;
      this._setBusy(false);
    }
  },

  // ---- streaming AI call ----
  _callAI(messages) {
    return new Promise((resolve, reject) => {
      this._streamFull = '';
      this._streamResolve = resolve;
      const cfg = this.selectedConfig || this.aiConfig || {};
      const provider = cfg.aiProvider;
      // aiConfig.aiApiKey is populated by the main window: for 'lectureai' it is
      // the auth token, for others the raw API key. Pass it straight through.
      const apiKey = cfg.aiApiKey || '';
      const msgEl = this._appendAssistantStreaming();
      window.__TAURI__.core.invoke('call_ai_messages_stream', {
        provider,
        apiKey,
        apiType: cfg.aiApiType,
        baseUrl: cfg.aiBaseUrl,
        model: cfg.aiModel,
        messages,
      }).catch((e) => {
        // Surface the real backend error (quota / auth / format) instead of a
        // silent "empty" - reject so _runTurn's catch shows it.
        if (this._renderTimer) { clearTimeout(this._renderTimer); this._renderTimer = null; }
        this._streamResolve = null;
        msgEl.remove();
        reject(new Error(String(e)));
      });
    });
  },

  _scheduleStreamingUpdate() {
    if (this._renderTimer) return;
    this._renderTimer = setTimeout(() => { this._renderTimer = null; this._updateStreaming(); }, 50);
  },

  _updateStreaming() {
    if (this._streamEl) {
      this._streamEl.textContent = this._displayText;
      this._streamEl.appendChild(this._cursor());
    }
    this._scroll();
  },

  // ---- action parsing ----
  _parseActions(text) {
    const actions = [];
    const re = /```action\s*([\s\S]*?)```/gi;
    let m;
    while ((m = re.exec(text))) {
      const raw = m[1].trim();
      try {
        const obj = JSON.parse(raw);
        if (obj && obj.tool) actions.push(obj);
        else actions.push({ tool: '_parse_error', error: '缺少 tool 字段', raw });
      } catch (e) {
        actions.push({ tool: '_parse_error', error: String(e), raw });
      }
    }
    return actions;
  },

  _stripActions(text) {
    return text.replace(/```action\s*[\s\S]*?```/gi, '').trim();
  },

  // ---- terminal log ----
  _log(type, text) {
    const m = document.getElementById('wb-messages');
    if (!m) return;
    const el = document.createElement('div');
    el.className = 'ln ln-' + type;
    el.textContent = String(text || '');
    m.appendChild(el);
    this._scroll();
    return el;
  },

  _cursor() {
    const s = document.createElement('span');
    s.className = 'cursor';
    return s;
  },

  _appendUser(text, mentioned) {
    const t = mentioned.length ? `@${mentioned.map(x => x.page).join(' @')} · ${text}` : text;
    this._log('user', t);
  },

  _appendAssistantStreaming() {
    const m = document.getElementById('wb-messages');
    if (!m) return document.createElement('div');
    this._displayText = '';
    const el = document.createElement('div');
    el.className = 'ln ln-ai';
    el.appendChild(this._cursor());
    m.appendChild(el);
    this._streamEl = el;
    this._scroll();
    return el;
  },

  _logAction(a) {
    if (a.tool === '_parse_error') {
      this._log('err', `action 解析失败：${a.error || ''}`);
      return;
    }
    const page = a.page != null ? ` 第${a.page}页` : '';
    const after = a.after != null ? `（插在第${a.after}页后）` : '';
    const reason = a.reason ? ` · ${a.reason}` : '';
    this._log('act', `${a.tool}${page}${after}${reason}`);
  },

  _logResult(result) {
    const r = String(result || '(无结果)');
    const firstLine = r.split('\n')[0] || r;
    const isErr = /失败|错误|出错|超出范围/.test(firstLine);
    const summary = r.split('\n').slice(0, 3).join(' · ').slice(0, 200);
    this._log(isErr ? 'err' : 'ok', summary);
  },

  _appendDiff(before, after) {
    const m = document.getElementById('wb-messages');
    if (!m) return;
    const diff = this._lineDiff(String(before || ''), String(after || ''));
    if (!diff.length) return;
    const el = document.createElement('div');
    el.className = 'diff';
    const cap = diff.slice(0, 20);
    el.innerHTML = cap.map(d => `<div class="d-${d.t}">${this._escape(d.text)}</div>`).join('');
    if (diff.length > 20) el.innerHTML += `<div class="d-more">… 还有 ${diff.length - 20} 行</div>`;
    m.appendChild(el);
    this._scroll();
  },

  // Simple LCS line diff -> [{t:'add'|'del', text}]
  _lineDiff(a, b) {
    const A = a.split('\n'), B = b.split('\n');
    const n = A.length, m = B.length;
    if (n > 400 || m > 400) return []; // too large to diff in-window
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const out = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: 'del', text: A[i] }); i++; }
      else { out.push({ t: 'add', text: B[j] }); j++; }
    }
    while (i < n) { out.push({ t: 'del', text: A[i++] }); }
    while (j < m) { out.push({ t: 'add', text: B[j++] }); }
    return out;
  },

  _setBusy(busy) {
    const send = document.getElementById('wb-send');
    const input = document.getElementById('wb-input');
    if (send) send.disabled = busy;
    if (input) input.disabled = busy;
  },

  _scroll() {
    const m = document.getElementById('wb-messages');
    if (m) m.scrollTop = m.scrollHeight;
  },

  _escape(value) {
    return String(value || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
};

document.addEventListener('DOMContentLoaded', () => window.WorkbenchWindow.init());
