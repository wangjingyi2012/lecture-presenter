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
  manifest: null,       // {title, slides:[{title, slideType, file}], templateBlueprint, deckPlan}
  aiConfig: null,
  busy: false,
  _streamFull: '',
  _streamResolve: null,
  _renderTimer: null,
  _modelStatusTimer: null,
  _modelStatusEl: null,
  _modelStartedAt: 0,
  _activeRound: 0,
  _stopRequested: false,
  _turnGeneration: 0,
  _activeStreamRequest: null,
  _piSocket: null,
  _piReject: null,
  _slashItems: [],
  _slashIndex: 0,
  _pickerMode: null,
  currentPage: null,
  skills: [],

  async init() {
    // Input discovery must not depend on Tauri event subscriptions. If any
    // subscription is delayed or rejected, slash/page pickers must still work.
    this._bindInputUi();
    if (!window.__TAURI__ || !window.__TAURI__.event) return;
    const { listen, emit } = window.__TAURI__.event;

    try {
      // RPC response + prefill + streaming events. Register in parallel so one
      // slow subscription cannot delay the rest of the workbench startup.
      await Promise.all([
        listen('wb-response', (e) => this._onResponse(e.payload)),
        listen('wb-prefill', (e) => this._onPrefill(e.payload)),
        listen('wb-refresh', () => this._refreshContext()),
        listen('ai-stream-chunk', (e) => {
          if (!this._activeStreamRequest || this._activeStreamRequest.generation !== this._turnGeneration) return;
          const firstChunk = !this._streamFull;
          this._streamFull += String(e.payload || '');
          if (firstChunk) this._markModelReceiving();
          this._scheduleStreamingUpdate();
        }),
        listen('ai-stream-done', () => {
          if (!this._activeStreamRequest || this._activeStreamRequest.generation !== this._turnGeneration) return;
          if (this._renderTimer) { clearTimeout(this._renderTimer); this._renderTimer = null; }
          this._updateModelStatusFromOutput();
          this._finishModelStatus();
          const resolve = this._streamResolve;
          this._streamResolve = null;
          if (resolve) resolve(this._streamFull);
        }),
      ]);
    } catch (error) {
      this._log('err', `工作台事件初始化失败：${String(error)}`);
      return;
    }

    // Fetch course context from the main window.
    const ctx = await this._rpc('get-context');
    if (ctx) this._onContext(ctx);
  },

  _bindInputUi() {
    const input = document.getElementById('wb-input');
    if (!input || input.dataset.pickerBound === 'true') return;
    input.dataset.pickerBound = 'true';
    const send = document.getElementById('wb-send');
    const stop = document.getElementById('wb-stop');
    const clear = document.getElementById('wb-clear');
    const commandTrigger = document.getElementById('wb-command-trigger');
    const pageTrigger = document.getElementById('wb-page-trigger');
    const skillTrigger = document.getElementById('wb-skill-trigger');
    const skillImport = document.getElementById('wb-skill-import');
    if (send) send.onclick = () => this._send();
    if (stop) stop.onclick = () => this._requestStop();
    if (clear) clear.onclick = () => this._clear();
    input.oninput = () => { this._autoResizeInput(); this._updateInputPicker(); };
    input.onclick = () => this._updateInputPicker();
    input.onkeyup = (e) => {
      if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) this._updateInputPicker();
    };
    input.oncompositionend = () => this._updateInputPicker();
    input.onkeydown = (e) => {
      if (this._handleSlashKey(e)) return;
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this._send(); }
    };
    input.onblur = () => setTimeout(() => this._hideSlashMenu(), 120);
    if (commandTrigger) commandTrigger.onclick = () => this._openPickerToken('/');
    if (pageTrigger) pageTrigger.onclick = () => this._openPickerToken('@');
    if (skillTrigger) skillTrigger.onclick = () => this._openPickerToken('$');
    if (skillImport) skillImport.onclick = () => this._importSkills();
  },

  // Grows the textarea with its content, capped by the CSS max-height.
  _autoResizeInput() {
    const input = document.getElementById('wb-input');
    if (!input || !input.style) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight || 0, 160)}px`;
  },

  async _importSkills() {
    if (this.busy) return;
    const result = await this._rpc('import-skill');
    if (!result || result.cancelled) return;
    if (result.error) {
      this._log('err', `SKILL 导入失败 · ${result.error}`);
      return;
    }
    await this._refreshContext();
    const imported = Array.isArray(result.imported) ? result.imported : [];
    const skipped = Array.isArray(result.skipped) ? result.skipped : [];
    if (imported.length) this._log('ok', `已导入 SKILL · ${imported.map(skill => `$${skill.name}`).join('、')}`);
    if (skipped.length) this._log('sys', `未导入 ${skipped.length} 项 · ${skipped.join('；')}`);
    if (!imported.length && !skipped.length) this._log('sys', '没有发现可导入的 SKILL');
  },

  _openPickerToken(token) {
    const input = document.getElementById('wb-input');
    if (!input) return;
    const start = Number.isInteger(input.selectionStart) ? input.selectionStart : input.value.length;
    const end = Number.isInteger(input.selectionEnd) ? input.selectionEnd : start;
    const prefix = start > 0 && !/\s/.test(input.value[start - 1]) ? ' ' : '';
    input.value = input.value.slice(0, start) + prefix + token + input.value.slice(end);
    const caret = start + prefix.length + token.length;
    input.setSelectionRange?.(caret, caret);
    input.focus();
    this._updateInputPicker();
  },

  // ---- RPC over events (single in-flight request; busy guard ensures serial) ----
  _pendingResolve: null,
  _pendingType: null,
  _rpc(type, payload) {
    return new Promise((resolve) => {
      this._pendingResolve = resolve;
      this._pendingType = type;
      window.__TAURI__.event.emit('wb-request', { type, payload });
    });
  },
  _onResponse(resp) {
    if (!resp) return;
    // Ignore responses that don't match the in-flight request type (e.g. the
    // pick-ppte ack arriving while a get-context refresh is pending).
    if (this._pendingType && resp.type !== this._pendingType) return;
    const r = this._pendingResolve;
    this._pendingResolve = null;
    this._pendingType = null;
    if (r) r(resp.result);
  },

  _onContext(ctx) {
    this.manifest = ctx;
    this.skills = Array.isArray(ctx?.skills) ? ctx.skills : [];
    this.currentPage = Number(ctx?.currentPage || ctx?.prefillPage || 0) || null;
    this.aiConfig = ctx?.aiConfig || null;
    this.lectureAiServerUrl = ctx?.lectureAiServerUrl || 'https://design.hz-study-system.com';
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
    if (!ctx || !ctx.slides?.length) {
      this._renderPickCourse();
    } else if (document.getElementById('wb-pick-ppte')) {
      // was showing the pick-course guide, now connected -> reset to empty
      this._renderEmpty();
    }
    if (ctx?.prefillPage) this._onPrefill({ page: ctx.prefillPage });
  },

  _renderPickCourse() {
    const m = document.getElementById('wb-messages');
    if (!m) return;
    m.innerHTML = `<div class="term-empty">
      <span class="term-empty-accent">AI 助手</span> · 课件级 Agent<br>
      未连接课件。选择一个 PPTE 课件开始对话。<br>
      <button class="wb-pick-btn" id="wb-pick-ppte">选择 PPTE 课件</button>
    </div>`;
    const btn = document.getElementById('wb-pick-ppte');
    if (btn) btn.onclick = () => {
      window.__TAURI__.event.emit('wb-request', { type: 'pick-ppte' });
    };
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
    this._autoResizeInput();
    input.focus();
  },

  _clear() {
    this.history = [];
    this._renderEmpty();
    this._log('sys', '上下文已清理 · 课件连接和页面状态保留');
  },

  _compact() {
    this._ensureHistory();
    const system = this.history[0];
    const previous = this.history.slice(1);
    if (previous.length <= 2) {
      this._log('sys', '上下文无需压缩 · 当前对话已经很短');
      return;
    }
    const recent = previous.slice(-6);
    const removed = previous.length - recent.length;
    this.history = [system, {
      role: 'user',
      content: `[上下文压缩] 已压缩 ${removed} 条较早消息。课件当前状态以磁盘和最新上下文为准；如需细节，请重新读取页面。`,
    }, ...recent];
    this._log('sys', `上下文已压缩 · 移除 ${removed} 条较早消息，保留最近 ${recent.length} 条`);
  },

  _renderEmpty() {
    const m = document.getElementById('wb-messages');
    if (m) m.innerHTML = `<div class="wb-empty">课件级对话窗口。<br>输入 / 选择内置命令，@ 定位页面，<br>$ 启用从其他 Agent 导入的 SKILL。<br>改完自动保存并在主窗口预览。</div>`;
  },

  // ---- slash command discovery ----
  _updateInputPicker() {
    const input = document.getElementById('wb-input');
    const menu = document.getElementById('wb-slash-menu');
    if (!input || !menu || !window.PpteSlashCommands) return;
    const commandResult = window.PpteSlashCommands.search(input.value, input.selectionStart);
    const pageResult = window.PpteSlashCommands.searchPages(input.value, input.selectionStart, this.manifest?.slides || []);
    const skillResult = window.PpteSlashCommands.searchSkills(input.value, input.selectionStart, this.skills);
    const mode = skillResult.token ? 'skill' : (pageResult.token ? 'page' : (commandResult.token ? 'command' : null));
    const result = mode === 'skill' ? skillResult : (mode === 'page' ? pageResult : commandResult);
    this._slashItems = result.items;
    this._slashToken = result.token;
    this._pickerMode = mode;
    this._slashIndex = Math.min(this._slashIndex, Math.max(0, result.items.length - 1));
    if (!mode) {
      this._hideSlashMenu();
      return;
    }
    const heading = mode === 'skill'
      ? `选择技能 · ${result.items.length}/${this.skills.length} 项`
      : (mode === 'page'
        ? `选择页面 · ${result.items.length}/${this.manifest?.slides?.length || 0} 页`
        : `斜杠命令 · ${result.items.length}/${window.PpteSlashCommands.commands.length} 项`);
    const rows = mode === 'skill'
      ? result.items.map((skill, index) => `
        <button type="button" class="slash-item${index === this._slashIndex ? ' active' : ''}" data-skill="${this._escape(skill.name)}" role="option" aria-selected="${index === this._slashIndex}">
          <span class="slash-name">$${this._escape(skill.name)}</span>
          <span class="slash-command-copy"><span class="slash-desc">${this._escape(skill.description)}</span><span class="skill-source">${this._escape(skill.sourceLabel || skill.source)}</span></span>
        </button>`).join('')
      : (mode === 'page'
      ? result.items.map((page, index) => `
        <button type="button" class="slash-item slash-page-item${index === this._slashIndex ? ' active' : ''}" data-page="${page.page}" role="option" aria-selected="${index === this._slashIndex}">
          <span class="slash-page-number">第 ${page.page} 页</span>
          <span class="slash-page-copy"><span class="slash-page-title"><span class="slash-name">@ ${this._escape(page.file || `slide${page.page}.html`)}</span><span class="slash-separator"> - </span>${this._escape(page.title)}</span><span class="slash-desc">${this._escape(page.slideType)}</span></span>
        </button>`).join('')
      : result.items.map((command, index) => `
        <button type="button" class="slash-item${index === this._slashIndex ? ' active' : ''}" data-command="${this._escape(command.name)}" role="option" aria-selected="${index === this._slashIndex}">
          <span class="slash-name">/${this._escape(command.name)}</span>
          <span class="slash-command-copy"><span class="slash-command-title">${this._escape(command.title)}</span><span class="slash-separator"> - </span><span class="slash-desc">${this._escape(command.description)}</span></span>
        </button>`).join(''));
    const empty = mode === 'skill' ? '没有已导入的技能 · 点击下方“导入 SKILL”' : (mode === 'page' ? '没有匹配的页面或文件' : '没有匹配的命令');
    menu.innerHTML = `<div class="slash-menu-head"><span>${heading}</span><span>↑↓ 选择 · Enter 插入</span></div>${rows || `<div class="slash-empty">${empty}</div>`}`;
    menu.hidden = false;
    menu.querySelectorAll('.slash-item').forEach(button => {
      button.onmousedown = (event) => {
        event.preventDefault();
        if (button.dataset.skill) this._applySkillSuggestion(button.dataset.skill);
        else if (button.dataset.page) this._applyPageSuggestion(Number(button.dataset.page));
        else this._applySlashSuggestion(button.dataset.command);
      };
    });
  },

  _updateSlashMenu() {
    this._updateInputPicker();
  },

  _handleSlashKey(event) {
    const menu = document.getElementById('wb-slash-menu');
    if (!menu || menu.hidden || !this._slashItems.length) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      this._slashIndex = (this._slashIndex + delta + this._slashItems.length) % this._slashItems.length;
      this._updateInputPicker();
      menu.querySelector('.slash-item.active')?.scrollIntoView?.({ block: 'nearest' });
      return true;
    }
    if (event.key === 'Tab' || event.key === 'Enter') {
      event.preventDefault();
      const item = this._slashItems[this._slashIndex];
      if (this._pickerMode === 'skill') this._applySkillSuggestion(item.name);
      else if (this._pickerMode === 'page') this._applyPageSuggestion(item.page);
      else this._applySlashSuggestion(item.name);
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      this._hideSlashMenu();
      return true;
    }
    return false;
  },

  _applySlashSuggestion(name) {
    const input = document.getElementById('wb-input');
    if (!input || !window.PpteSlashCommands) return;
    const applied = window.PpteSlashCommands.applySuggestion(input.value, input.selectionStart, name);
    input.value = applied.value;
    input.setSelectionRange?.(applied.caret, applied.caret);
    this._autoResizeInput();
    this._hideSlashMenu();
    input.focus();
  },

  _applyPageSuggestion(page) {
    const input = document.getElementById('wb-input');
    if (!input || !window.PpteSlashCommands) return;
    const applied = window.PpteSlashCommands.applyPageSuggestion(input.value, input.selectionStart, page);
    input.value = applied.value;
    input.setSelectionRange?.(applied.caret, applied.caret);
    this._autoResizeInput();
    this._hideSlashMenu();
    input.focus();
  },

  _applySkillSuggestion(name) {
    const input = document.getElementById('wb-input');
    if (!input || !window.PpteSlashCommands) return;
    const applied = window.PpteSlashCommands.applySkillSuggestion(input.value, input.selectionStart, name);
    input.value = applied.value;
    input.setSelectionRange?.(applied.caret, applied.caret);
    this._autoResizeInput();
    this._hideSlashMenu();
    input.focus();
  },

  _hideSlashMenu() {
    const menu = document.getElementById('wb-slash-menu');
    if (menu) menu.hidden = true;
    this._slashItems = [];
    this._slashToken = null;
    this._slashIndex = 0;
    this._pickerMode = null;
  },

  // ---- system prompt ----
  _outlinePromptBlock() {
    // outline.md is the author's handwritten chapter outline (章纲): chapter
    // order, per-page intent, layout wishes. It must steer deck planning.
    const outline = String(this.manifest?.outline || '').trim();
    if (!outline) return '';
    return `[用户章纲]\n${outline}\n\n以上是作者在写页面前定下的章纲：整套生成时必须按章纲的章节顺序、每页主题和排版意图规划页面；章纲与本次指令冲突时以本次指令为准。`;
  },

  _systemPrompt() {
    let ctx = '当前未连接课件。';
    if (this.manifest?.slides?.length) {
      const list = this.manifest.slides.map((s, i) =>
        `${i + 1}. [${s.slideType || 'content'}] ${s.title || '（无标题）'}${s.file ? ` (${s.file})` : ''}`
      ).join('\n');
      ctx = `当前课件：${this.manifest.title || '未命名'}（共 ${this.manifest.slides.length} 页）\n页面清单：\n${list}`;
    }
    const blueprint = this.manifest?.templateBlueprint;
    if (blueprint?.roles?.length) {
      const roles = blueprint.roles
        .filter(role => role.page != null)
        .map(role => `- ${role.slideType}: 第${role.page}页「${role.title || role.file}」${role.stylesheets?.length ? `，样式 ${role.stylesheets.join('、')}` : ''}`)
        .join('\n');
      ctx += `\n\n模板蓝图：${blueprint.name || '默认模板'}（${blueprint.isStarter ? '尚未初始化' : '已用于当前课件'}）\n${roles}`;
    }
    if (blueprint?.isStarter) {
      ctx += `\n\n这是客户端刚创建的“五页母版”，不是已经完成的五页课件。五页分别是封面、目录、章节过渡、正文、结束的样式样例。收到“制作 N 页课件”时，最终总页数必须恰好为 N，不是在现有 5 页后再追加 N 页。先按主题规划完整页序，再把现有五页改造成实际页面，并按需新增页面。封面、目录、章节过渡、正文、结束必须使用各自角色的母版，保留原模板的 stylesheet 链接、背景资源、布局容器和配色，不得把正文页样式套到封面、目录或章节页。新增页面优先用 insert_slide 的 template_role 克隆对应母版，再用 write_slide 填充内容。章节过渡页必须放在对应章节内容之前，结束页必须是最后一页。`;
    }
    const planState = this.manifest?.deckPlan;
    if (planState?.plan) {
      ctx += `\n\n现有 LectureAI 规划状态：${planState.status || 'unknown'}。${planState.status === 'stale' ? '课件已在规划后变化，整套任务开始前应重新 set_deck_plan。' : ''}`;
    } else {
      ctx += '\n\n当前项目没有 LectureAI 规划。这不影响旧项目打开、播放或单页修改；整套生成时按需创建。';
    }
    const outlineBlock = this._outlinePromptBlock();
    if (outlineBlock) {
      ctx += `\n\n${outlineBlock}`;
    }
    if (this.skills.length) {
      const catalog = this.skills.map(skill => `- ${skill.id}：${skill.description}（${skill.sourceLabel}）`).join('\n');
      ctx += `\n\n可用 SKILL：\n${catalog}\n用户显式输入 $skill-name 时客户端会自动加载。若用户未显式指定，但任务与某个 description 明确匹配，可先调用 load_skill {skill_id}，读取完整 SKILL.md 后再行动。不要仅凭技能名猜测规则。`;
    }
    ctx += `\n\n课件级扩展工具：
- set_deck_plan {plan}：保存整套可执行蓝图，整套生成或大规模改造必须最先调用
- search_design_examples {content_kind?, layout_family?, density?, motion?, exclude?, limit?}：检索真实 HTML/CSS 设计案例
- render_template {template_id, template_version?, payload, mode, page?, after?, title?, slide_type?, note?}：正文页优先使用服务端私有模板；replace 提供 page，insert 可提供 after
- inspect_slides {check, pages?}：确定性检查页面；check 为 font/overflow/density/card/copy/motion/concept-animation/quality，pages 省略时检查整套；concept-animation 同时检查标准分步结构、字体、溢出和学员文案
- load_skill {skill_id}：加载一个可用 SKILL 的完整 SKILL.md；仅在任务与 description 明确匹配时调用
- read_skill_resource {skill_id, path}：读取已启用 skill 列出的 references/scripts 文本；禁止读取 skill 目录之外的文件
- validate_deck {}：检查页数、结束页、重复布局、卡片占比、动画覆盖与所有单页规范
plan 至少包含 targetSlideCount、visualSystem、slides；每页包含 page、role、title、contentKind、layoutFamily、componentIds、motion、visualIntent。每个正文页还必须包含 narrative：buildsOn、learningGoal、keyTakeaway、leadsTo；相邻正文页的前页 leadsTo 与后页 buildsOn 必须是完全相同的短句，形成从已知到未知的教学叙事链。正文页在规划阶段就指定注册 templateId、templateVersion；任一模板最多占正文 25%，同一模板在连续三个正文页窗口内只能出现一次。普通正文及已覆盖的复杂场景优先 render_template，只提交结构化 payload；封面、目录、章节、结束页只做角色母版安全填充，不自由重写结构或样式，只有无法由模板表达的特殊正文页才自由写页。不得读取或索取模板源码。相邻正文页不得重复主构图，正文超过 8 页至少 6 种主布局，卡片类不超过正文 25%，12 页以上至少 3 页有意义动画。整套任务最终必须 validate_deck 通过。

用户指定的最终页数必须与 targetSlideCount 和 slides 数量完全一致，五类母版页也计入总数。默认情况下，30 页及以内采用单段连续叙事，不生成目录页和章节过渡页；超过 30 页才默认分为 2 章，可保留 1 个目录页和 2 个章节过渡页，保证每章至少约 15 页。只有用户明确下达“分成 N 章、保留/增加目录页或章节过渡页”等指令时才覆盖默认规则；仅提到章节问题、重写课件或内容中包含章节不算明确分章。starter 中的 catalog、chapter 只是角色母版占位：若成品规划不需要它们，必须在 plan 中将对应页标为 content，客户端才会允许转为正文。cover、catalog、chapter、finish 在保留原角色时必须保留角色母版 CSS、背景和结构；目录只替换标题与目录条目，不得覆盖 catalog.css 的目录组件样式；背景已有文字的 finish 页保持可见正文为空。正文和表格正文均不低于 1.8vw，1.5vw 仅限不超过 8 个字的短标签；正文统一使用 visualSystem 的深色 text/subtext，禁止模板自行使用浅灰正文。

扩展页面参数：write_slide 可同时提供 title 和 slide_type；insert_slide 可提供稳定的 template_role（cover/catalog/chapter/content/finish）、兼容参数 template_page 和 slide_type。例：克隆章节母版到第6页后：{"tool":"insert_slide","after":6,"template_role":"chapter","slide_type":"chapter","title":"第二章"}。当存在 finish 页时，客户端会自动把普通新增页放到 finish 页之前；reorder_slides 也不允许把唯一的 finish 页移出末页。`;
    ctx += `\n\n工作台会把工具轮次压缩成单行动态状态。需要读取、校验或修改页面时，必须在同一响应中输出对应的 \`\`\`action 工具块；只描述“准备读取/校验/修改”但不附 action 属于协议错误。带 action 的响应中，action 前只写一句不超过 32 个汉字的状态摘要，直接说明当前动作；禁止寒暄、重复已完成步骤或使用“好的”“收到”“我先”“继续读取”等填充句。最终不再调用工具时，一次性输出完整 Markdown 结论。不要输出冗长的内部思维链。`;
    // The tool-protocol prompt is prepended by the Rust backend when the request
    // is dispatched to a non-LectureAI provider; LectureAI's server owns the full
    // SKILL and prepends it itself. The desktop sends only the dynamic manifest
    // so the model isn't double-prompted.
    return ctx;
  },

  _ensureHistory() {
    if (!this.history.length) this.history.push({ role: 'system', content: this._systemPrompt() });
  },

  _requestedSlideCount(input) {
    const text = String(input || '');
    const matches = [
      ...text.matchAll(/(?:创建|制作|生成|做)(?:一套|一个|份)?\s*(\d{1,2})\s*页/gi),
      ...text.matchAll(/(?:目标|总共|一共|共)\s*(\d{1,2})\s*页/gi),
      ...text.matchAll(/(\d{1,2})\s*页(?:的|关于|课件|PPT|幻灯片)/gi),
    ];
    const count = matches.length ? Number(matches[0][1]) : 0;
    return count >= 3 && count <= 60 ? count : null;
  },

  _explicitSectionRequest(input) {
    const text = String(input || '');
    if (this._continuousSectionRequest(text)) return false;
    return /(?:分(?:成|为)?|划分为?|按)\s*(?:\d+|[一二两三四五六七八九十]+)\s*(?:个)?(?:章|章节)|(?:保留|需要|生成|增加|添加)\s*(?:一个|1个|一页|1页)?\s*(?:目录页?|章节过渡页?)/i.test(text);
  },

  _continuousSectionRequest(input) {
    return /(?:不分|无需|不要|取消).{0,8}(?:目录页?|章节(?:页|过渡页?)?)/i.test(String(input || ''));
  },

  _taskInitialization(input) {
    const blueprint = this.manifest?.templateBlueprint;
    if (!blueprint?.isStarter) return '';
    const target = this._requestedSlideCount(input);
    const targetRule = target
      ? `用户要求最终 ${target} 页。当前 5 页都是母版占位，必须计入最终 ${target} 页，因此只需净新增 ${Math.max(0, target - this.manifest.slides.length)} 页，完成后核对总页数恰好为 ${target}。`
      : '如果用户指定总页数，该数字包含当前五个母版页，完成后必须核对最终总页数。';
    const explicitSections = this._explicitSectionRequest(input);
    const continuousSections = this._continuousSectionRequest(input);
    const sectionRule = continuousSections
      ? '用户明确要求连续叙事：成品不要目录页和章节过渡页，catalog、chapter 占位页必须在 plan 中标为 content 后转成正文。'
      : target && target <= 30 && !explicitSections
      ? '本任务默认不分章：成品不要目录页和章节过渡页。catalog、chapter 只是母版占位，请在 plan 中把第 2、3 页规划为 content，再用正文模板覆盖。'
      : target && target > 30 && !explicitSections
        ? '本任务默认分 2 章：最多保留 1 个目录页和 2 个章节过渡页，每章至少约 15 页。'
        : '按用户明确提出的分章或目录要求规划；未要求的结构页不要额外增加。';
    return `[客户端模板初始化]\n${targetRule}\n${sectionRule}\n使用 template_role 克隆正确角色，保持模板配色与背景；保留章节页时应紧邻其章节内容之前，finish 页始终最后。`;
  },

  _isDeckLevelTask(input) {
    const value = String(input || '');
    if (/(?:创建|制作|生成|重做|改造).{0,16}(?:整套|课件|PPT|幻灯片|\d{1,2}\s*页)/i.test(value)) return true;
    if (/(?:整套|整体|全部|所有|逐页).{0,10}(?:修改|重写|检查|优化|生成)/i.test(value)) return true;
    return /(?:检查|校验|审查).{0,8}(?:一下|整个|整套|整体)?\s*(?:课件|PPT|幻灯片)|(?:课件|PPT|幻灯片).{0,8}(?:问题|检查|校验)/i.test(value);
  },

  _requiresDeckPlan(input) {
    const value = String(input || '');
    if (/(?:创建|制作|生成|重做|改造).{0,16}(?:整套|课件|PPT|幻灯片|\d{1,2}\s*页)/i.test(value)) return true;
    return /(?:整套|整体|全部|所有|逐页).{0,10}(?:修改|重写|优化|生成)/i.test(value);
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
    const slash = window.PpteSlashCommands?.parse(input, { currentPage: this.currentPage });
    const skillNames = window.PpteSlashCommands?.parseSkillNames(input) || [];
    if (slash?.unknown) {
      this._appendAssistantMarkdown(`未知命令 \`/${slash.unknown}\`。输入 \`/\` 查看可用命令，或使用 \`/help\`。`);
      return;
    }
    if (slash?.command?.local) {
      this._appendUser(input, []);
      if (slash.command.localAction === 'clear') this._clear();
      else if (slash.command.localAction === 'compact') this._compact();
      else this._appendAssistantMarkdown(window.PpteSlashCommands.helpMarkdown());
      if (inputEl) inputEl.value = '';
      this._autoResizeInput();
      this._hideSlashMenu();
      return;
    }
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
    const resumablePlan = this.manifest?.deckPlan?.plan;
    const executionStatus = resumablePlan?.execution?.status;
    if (this._isHarnessResumeRequest(input) && ['running', 'paused', 'failed', 'repairing', 'needs-repair'].includes(executionStatus)) {
      this._appendUser(input, []);
      if (inputEl) inputEl.value = '';
      this._autoResizeInput();
      this._hideSlashMenu();
      await this._resumePlannedHarness(resumablePlan, input);
      return;
    }
    this._ensureHistory();
    // refresh system prompt (manifest may have changed)
    this.history[0] = { role: 'system', content: this._systemPrompt() };

    const { content, mentioned } = await this._resolveAt(input);
    let commandContext = '';
    const workflowContext = slash ? window.PpteSlashCommands?.commandWorkflowContext(slash.command) : '';
    if (slash?.command?.commandContext) {
      const prepared = await this._rpc('get-command-context', {
        command: slash.command.name,
        pages: slash.pages,
      });
      if (prepared?.error) {
        this._appendAssistantMarkdown(`无法准备 /${slash.command.name} 的页面上下文：${prepared.error}`);
        return;
      }
      commandContext = [workflowContext, prepared].filter(Boolean).join('\n\n');
    }
    let skillContext = '';
    let enabledSkills = [];
    if (skillNames.length) {
      const loadedSkills = [];
      for (const name of skillNames) {
        const candidates = this.skills.filter(skill => skill.name === name);
        const selected = candidates[0];
        if (!selected) {
          this._appendAssistantMarkdown(`未找到技能 \`$${name}\`。输入 \`$\` 查看当前可用技能。`);
          return;
        }
        const document = await this._rpc('read-skill', { skillId: selected.id });
        loadedSkills.push(document);
      }
      enabledSkills = loadedSkills.map(document => `$${document.info.name}（${document.info.sourceLabel}）`);
      skillContext = loadedSkills.map(document => [
        `[已启用 SKILL $${document.info.name}]`,
        `skill_id: ${document.info.id}`,
        `来源: ${document.info.sourceLabel}`,
        document.files?.length ? `可按需读取的资源: ${document.files.join('、')}` : '无附加资源',
        document.content,
      ].join('\n')).join('\n\n');
    }
    const taskInitialization = this._taskInitialization(input);
    const deckLevel = slash ? false : this._isDeckLevelTask(input);
    const requiresPlan = slash ? false : this._requiresDeckPlan(input);
    this._activeTask = {
      deckLevel,
      requiresPlan,
      planSaved: !requiresPlan,
      deckValidated: false,
      commandCheck: slash?.command?.check || null,
      commandPages: slash?.pages || [],
      commandInspected: false,
      commandPassed: false,
      requestedSlideCount: this._requestedSlideCount(input),
      explicitSections: this._explicitSectionRequest(input),
      continuousSections: this._continuousSectionRequest(input),
      plan: null,
      harnessEnabled: requiresPlan,
      userInstruction: input,
    };
    this._stopRequested = false;
    this._appendUser(input, mentioned);
    if (enabledSkills.length) this._log('sys', `本轮启用技能 · ${enabledSkills.join('、')}`);
    const additions = [skillContext, commandContext, taskInitialization, deckLevel ? this._outlinePromptBlock() : '', slash?.instruction || ''].filter(Boolean).join('\n\n');
    this.history.push({ role: 'user', content: additions ? `${content}\n\n${additions}` : content });
    if (inputEl) inputEl.value = '';
    this._autoResizeInput();
    this._hideSlashMenu();

    await this._runTurn();
  },

  async _runTurn() {
    this.busy = true;
    this._setBusy(true);
    try {
      let rounds = 0;
      let toolCalls = 0;
      let recoveryRounds = 0;
      const turnStartedAt = this._now();
      // Keep the agent running until it returns a normal response without an
      // action. A fixed round cap breaks deck-level jobs because the model may
      // need to read, rewrite, and validate every slide in separate calls.
      while (true) {
        if (this._stopRequested) {
          this._appendAssistantMarkdown('### 任务已停止\n\n已停止后续模型请求，已成功保存的页面保留。');
          this._log('sys', `任务停止 · 用户取消 · ${rounds} 轮模型响应 · ${toolCalls} 次工具调用 · ${this._duration(turnStartedAt)}`);
          break;
        }
        rounds += 1;
        this._activeRound = rounds;
        const text = await this._callAI(this.history);
        if (!text) { this._log('err', 'AI 返回空内容，可能是服务端问题、额度耗尽或请求被拒'); break; }
        this.history.push({ role: 'assistant', content: text });
        const actions = this._parseActions(text);
        // Tool-round prose stays compressed in the single status line. Only a
        // final response without actions is rendered as a full Markdown block.
        if (!actions.length) {
          if (this._hasUnexecutedToolIntent(text)) {
            recoveryRounds += 1;
            if (recoveryRounds > 3) throw new Error('模型连续 3 次未发出有效工具调用，任务已停止，避免无限请求');
            this.history.push({
              role: 'user',
              content: '[工具协议纠正] 你刚才描述了要执行的页面操作，但没有调用工具。请立即输出对应的 ```action JSON``` 工具块，不要重复说明。',
            });
            if (this._modelStatusEl) {
              this._modelStatusEl.dataset.summary = '正在补发工具调用';
              this._modelStatusEl.textContent = `第 ${rounds} 轮 · 正在补发工具调用 · ${this._duration(turnStartedAt)}`;
            }
            continue;
          }
          if (this._activeTask?.deckLevel && !this._activeTask.deckValidated) {
            recoveryRounds += 1;
            if (recoveryRounds > 3) throw new Error('整套校验连续 3 次未通过或未执行，任务已停止，请查看校验结果后重试');
            this.history.push({
              role: 'user',
              content: '[完成门禁] 整套课件任务结束前必须调用 validate_deck 且检查通过。请现在直接调用，不要先总结。',
            });
            if (this._modelStatusEl) {
              this._modelStatusEl.dataset.summary = '等待整套课件校验';
              this._modelStatusEl.textContent = `第 ${rounds} 轮 · 等待整套课件校验 · ${this._duration(turnStartedAt)}`;
            }
            continue;
          }
          if (this._activeTask?.commandCheck && !this._activeTask.commandPassed) {
            recoveryRounds += 1;
            if (recoveryRounds > 3) throw new Error('斜杠命令连续 3 次未通过复检，任务已停止，请查看最后一次检查结果');
            const pages = this._activeTask.commandPages.length ? `,"pages":[${this._activeTask.commandPages.join(',')}]` : '';
            this.history.push({
              role: 'user',
              content: `[命令完成门禁] /${this._activeTask.commandCheck} 尚未通过。请立即调用 \`\`\`action {"tool":"inspect_slides","check":"${this._activeTask.commandCheck}"${pages}} \`\`\`；若仍有问题则继续修复，不要先总结。`,
            });
            continue;
          }
          this._appendAssistantMarkdown(this._stripActions(text));
          this._log('sys', `任务结束 · ${rounds} 轮模型响应 · ${toolCalls} 次工具调用 · ${this._duration(turnStartedAt)}`);
          break;
        }
        const results = [];
        let terminalToolFailure = '';
        for (const a of actions) {
          if (this._stopRequested) break;
          if (this._activeTask?.requiresPlan && ['render_template', 'write_slide', 'insert_slide', 'reorder_slides'].includes(a.tool) && !this._activeTask.planSaved) {
            results.push('[规划门禁] 这是整套课件任务，第一次修改前必须先调用 set_deck_plan。请现在输出 set_deck_plan action，不要开始写页。');
            break;
          }
          if (a.tool === 'set_deck_plan') {
            const explicitSections = this._activeTask?.explicitSections === true;
            const continuousSections = this._activeTask?.continuousSections === true;
            a.plan = {
              ...a.plan,
              qualityPolicy: { schemaVersion: 2, source: 'desktop-client' },
            };
            const planError = this._deckPlanGateError(a.plan, this._activeTask?.requestedSlideCount, explicitSections, continuousSections);
            if (planError) {
              results.push(`[规划门禁] ${planError}。请修正规划后重新调用 set_deck_plan。`);
              break;
            }
            a.plan.sectionPolicy = { explicit: explicitSections || continuousSections, mode: continuousSections ? 'continuous' : explicitSections ? 'custom' : 'default', source: 'desktop-client' };
          }
          if (this._activeTask?.commandCheck && ['render_template', 'write_slide', 'insert_slide', 'reorder_slides'].includes(a.tool) && !this._activeTask.commandInspected) {
            results.push(`[命令门禁] 必须先调用 inspect_slides，check 必须为 ${this._activeTask.commandCheck}，确认问题后再修改。`);
            break;
          }
          if (a.tool === 'inspect_slides' && this._activeTask?.commandCheck && a.check !== this._activeTask.commandCheck) {
            results.push(`[命令门禁] 当前命令要求 check=${this._activeTask.commandCheck}，不能改用 ${a.check || '空值'}。`);
            break;
          }
          if (a.tool === 'inspect_slides' && this._activeTask?.commandPages?.length) {
            const actualPages = Array.isArray(a.pages) ? [...new Set(a.pages.map(Number))].sort((x, y) => x - y) : [];
            const expectedPages = [...this._activeTask.commandPages].sort((x, y) => x - y);
            if (actualPages.join(',') !== expectedPages.join(',')) {
              results.push(`[命令门禁] 当前命令范围固定为第 ${expectedPages.join('、')} 页，inspect_slides.pages 必须与之完全一致。`);
              break;
            }
          }
          if (this._activeTask?.commandPages?.length && ['insert_slide', 'reorder_slides'].includes(a.tool)) {
            results.push(`[命令门禁] 当前命令限定第 ${this._activeTask.commandPages.join('、')} 页，不能插页或重排整套课件。`);
            break;
          }
          if (this._activeTask?.commandPages?.length && a.tool === 'write_slide' && !this._activeTask.commandPages.includes(Number(a.page))) {
            results.push(`[命令门禁] 当前命令只允许修改第 ${this._activeTask.commandPages.join('、')} 页，拒绝写入第 ${a.page} 页。`);
            break;
          }
          if (this._activeTask?.commandPages?.length && a.tool === 'render_template' && (a.mode || 'replace') !== 'replace') {
            results.push(`[命令门禁] 当前命令限定第 ${this._activeTask.commandPages.join('、')} 页，模板工具只能使用 replace 模式。`);
            break;
          }
          if (this._activeTask?.commandPages?.length && a.tool === 'render_template' && !this._activeTask.commandPages.includes(Number(a.page))) {
            results.push(`[命令门禁] 当前命令只允许修改第 ${this._activeTask.commandPages.join('、')} 页，拒绝写入第 ${a.page} 页。`);
            break;
          }
          toolCalls += 1;
          const actionStartedAt = this._now();
          const actionEl = this._logAction(a, toolCalls);
          // inline diff for slide rewrites (current vs new html)
          if (a.tool === 'write_slide' && a.page != null) {
            try {
              const before = await this._rpc('get-slide', { page: a.page });
              if (before) this._appendDiff(before, a.html || '');
            } catch (e) { /* skip diff if fetch fails */ }
          }
          const result = await this._rpc('execute-action', { action: a });
          this._finishAction(actionEl, actionStartedAt, result);
          this._logResult(result);
          results.push(result || '(无结果)');
          if (a.tool === 'set_deck_plan' && !/失败|出错|错误/.test(String(result || ''))) {
            this._activeTask.planSaved = true;
            this._activeTask.plan = a.plan;
          }
          if (['render_template', 'write_slide', 'insert_slide', 'reorder_slides'].includes(a.tool) && !/失败|出错|错误/.test(String(result || ''))) {
            this._activeTask.deckValidated = false;
            if (this._activeTask.commandCheck) {
              this._activeTask.commandInspected = false;
              this._activeTask.commandPassed = false;
            }
            recoveryRounds = 0;
          }
          if (a.tool === 'inspect_slides' && this._activeTask.commandCheck) {
            try {
              const inspection = JSON.parse(result);
              this._activeTask.commandInspected = true;
              this._activeTask.commandPassed = inspection.passed === true;
              if (this._activeTask.commandPassed) recoveryRounds = 0;
            } catch (_) {
              this._activeTask.commandInspected = false;
              this._activeTask.commandPassed = false;
            }
          }
          if (a.tool === 'validate_deck') {
            try { this._activeTask.deckValidated = JSON.parse(result).passed === true; }
            catch (_) { this._activeTask.deckValidated = false; }
            if (this._activeTask.deckValidated) recoveryRounds = 0;
            else recoveryRounds += 1;
          }
          if (this._isTerminalToolFailure(result)) {
            terminalToolFailure = String(result || '磁盘保存失败');
            break;
          }
        }
        const resultMsg = '[工具结果]\n' + results.join('\n\n');
        this.history.push({ role: 'user', content: resultMsg });
        if (terminalToolFailure) {
          this._appendAssistantMarkdown(`### 任务已停止\n\n${terminalToolFailure}\n\n未确认写入磁盘的修改不会继续累积。请处理文件冲突或重新打开课件后再试。`);
          this._log('sys', `任务停止 · 磁盘保存未成功 · ${rounds} 轮模型响应 · ${toolCalls} 次工具调用 · ${this._duration(turnStartedAt)}`);
          break;
        }
        if (this._activeTask?.harnessEnabled && this._activeTask.planSaved && this._activeTask.plan) {
          await this._runPlannedHarness(this._activeTask.plan, this._activeTask.userInstruction || '生成整套课件');
          break;
        }
      }
    } catch (e) {
      if (this._stopRequested) {
        this._appendAssistantMarkdown('### 任务已停止\n\n已立即停止后续模型请求，已成功保存的页面保留。');
        this._log('sys', '任务停止 · 用户取消');
      } else {
        const message = this._modelErrorMessage(e);
        this._log('err', `${e?.isModelRequestError ? '模型请求失败' : '出错'}：${message}`);
      }
    } finally {
      this.busy = false;
      this._setBusy(false);
    }
  },

  _deckPlanGateError(plan, requestedCount = null, explicitSections = false, continuousSections = false) {
    if (!plan || typeof plan !== 'object') return '缺少完整 plan 对象';
    const target = Number(plan.targetSlideCount);
    const slides = Array.isArray(plan.slides) ? plan.slides : [];
    if (requestedCount && target !== requestedCount) return `用户要求最终 ${requestedCount} 页，targetSlideCount 不能是 ${target || '空值'}`;
    if (!Number.isInteger(target) || slides.length !== target) return `targetSlideCount=${target || '空值'} 与 slides 数量 ${slides.length} 必须完全一致`;
    const strictQuality = Number(plan?.qualityPolicy?.schemaVersion) === 2;
    const contentSlides = slides.filter(slide => String(slide?.role || slide?.slide_type || '').toLowerCase() === 'content');
    for (let index = 0; strictQuality && index < contentSlides.length; index += 1) {
      const slide = contentSlides[index];
      const narrative = slide?.narrative;
      if (!narrative || ['buildsOn', 'learningGoal', 'keyTakeaway', 'leadsTo'].some(field => !String(narrative[field] || '').trim())) {
        return `第 ${slide?.page || '?'} 页缺少完整 narrative 教学叙事`;
      }
      if (!String(slide?.templateId || slide?.template_id || '').trim()
        && !(String(slide?.renderMode || '').toLowerCase() === 'custom' && String(slide?.customLayoutReason || '').trim())) {
        return `第 ${slide?.page || '?'} 页正文必须指定 templateId，或声明 renderMode=custom 及 customLayoutReason`;
      }
      if (index > 0 && String(contentSlides[index - 1].narrative.leadsTo).trim() !== String(narrative.buildsOn).trim()) {
        return `第 ${contentSlides[index - 1].page} 页 leadsTo 必须与第 ${slide.page} 页 buildsOn 完全一致`;
      }
    }
    const templateIds = contentSlides.map(slide => String(slide.templateId || slide.template_id || '').trim());
    const templateLimit = Math.max(2, Math.ceil(contentSlides.length * 0.25));
    for (const templateId of strictQuality ? new Set(templateIds) : []) {
      const count = templateIds.filter(id => id === templateId).length;
      if (templateId && count > templateLimit) return `模板 ${templateId} 使用 ${count} 次，超过本套正文上限 ${templateLimit} 次`;
    }
    for (let index = 0; strictQuality && index < templateIds.length; index += 1) {
      if (templateIds[index] && templateIds.slice(Math.max(0, index - 2), index).includes(templateIds[index])) {
        return `第 ${contentSlides[index].page} 页在三页窗口内重复使用模板 ${templateIds[index]}`;
      }
    }
    const chapters = slides.filter(slide => ['chapter', 'immersive-chapter'].includes(String(slide?.role || slide?.slide_type || slide?.layoutFamily || slide?.layout_family || '').toLowerCase())).length;
    const catalogs = slides.filter(slide => ['catalog', 'toc'].includes(String(slide?.role || slide?.slide_type || slide?.layoutFamily || slide?.layout_family || '').toLowerCase())).length;
    if (continuousSections && (catalogs || chapters)) {
      return `用户明确要求不分章，规划中不能包含目录页或章节过渡页（当前目录 ${catalogs} 页、章节过渡 ${chapters} 页）`;
    }
    if (!continuousSections && !explicitSections && target <= 30 && (catalogs || chapters)) {
      return `${target} 页课件默认不分章，规划中不能包含目录页或章节过渡页（当前目录 ${catalogs} 页、章节过渡 ${chapters} 页）`;
    }
    if (!continuousSections && !explicitSections && target > 30 && chapters !== 2) {
      return `${target} 页课件默认分为 2 章，规划中必须恰好包含 2 个章节过渡页（当前为 ${chapters} 个）`;
    }
    if (!continuousSections && !explicitSections && target > 30 && catalogs > 1) return `${target} 页课件最多保留 1 个目录页，当前为 ${catalogs} 个`;
    return '';
  },

  _harnessSystemPrompt() {
    return `你是 LectureAI 的单页课件 Worker。客户端 Harness 已经完成整套规划和页序调度；你只负责当前指定页面。
严格限制：
1. 只处理“当前页面任务”，不得主动读取或修改其他页面，不得重新规划整套课件。
2. 当前页为正文且给出 templateId 时，必须使用 render_template；只有 renderMode=custom 才能自由 write_slide。
3. replace 前若需要保留角色母版，先 read_slide 当前页；insert 不读取其他页。
4. 写入后必须 validate_slide 当前页，未通过则仅修复当前页并重验。
5. 工具一次一个。完成后返回不含 action 的一句总结，不输出长篇分析。
6. 页面正文不低于 1.8vw，短标签不低于 1.5vw，使用深色 text/subtext；容量不足时删减内容或换结构，不缩字。
7. 只使用 Harness 明确允许的 page、mode、after、templateId 和页面角色。`;
  },

  _harnessOutline(plan) {
    return (plan?.slides || []).map(slide => {
      const narrative = slide?.narrative || {};
      return `${slide.page}. [${slide.role || 'content'}] ${slide.title} | 结论：${narrative.keyTakeaway || slide.visualIntent || ''}`;
    }).join('\n');
  },

  _harnessMutationDirective(planSlide) {
    const page = Number(planSlide?.page || 0);
    const plannedRole = String(planSlide?.role || 'content').toLowerCase();
    const current = this.manifest?.slides?.[page - 1];
    const currentRole = String(current?.slideType || '').toLowerCase();
    const insert = !current || (['finish', 'ending'].includes(currentRole) && !['finish', 'ending'].includes(plannedRole));
    return insert
      ? { mode: 'insert', page, after: Math.max(0, page - 1), currentRole: currentRole || null }
      : { mode: 'replace', page, after: null, currentRole: currentRole || null };
  },

  _harnessPageContext(plan, planSlide, summaries = {}, stageGuidance = '') {
    const page = Number(planSlide.page);
    const nearby = (plan.slides || []).filter(item => Math.abs(Number(item.page) - page) <= 2);
    const neighborSummaries = Object.entries(summaries)
      .filter(([key]) => Math.abs(Number(key) - page) <= 2)
      .map(([key, value]) => `第${key}页：${value}`)
      .join('\n') || '尚无相邻页面执行摘要';
    const directive = this._harnessMutationDirective(planSlide);
    const templateId = planSlide.templateId || planSlide.template_id || '';
    const templateVersion = planSlide.templateVersion || planSlide.template_version || '';
    const outlineBlock = this._outlinePromptBlock();
    return `[整套任务原始目标]\n${this._activeTask?.userInstruction || ''}${outlineBlock ? `\n\n${outlineBlock}` : ''}

[全局视觉规范]\n${JSON.stringify(plan.visualSystem || {})}

[全套精简页序]\n${this._harnessOutline(plan)}

[当前页前后两页详细规划]\n${JSON.stringify(nearby)}

[已完成相邻页摘要]\n${neighborSummaries}

[最近阶段审查建议]\n${stageGuidance || '无'}

[当前页面任务]\n${JSON.stringify(planSlide)}

[Harness 写入指令]
- 目标页：第 ${page} 页
- 操作：${directive.mode}
${directive.mode === 'insert' ? `- 必须使用 after=${directive.after}，插入后即为第 ${page} 页` : `- 必须使用 page=${page}`}
- 页面角色：${planSlide.role || 'content'}
${templateId ? `- 必须使用模板 ${templateId}${templateVersion ? `@${templateVersion}` : ''}` : `- 自定义原因：${planSlide.customLayoutReason || '角色母版页'}`}
- 本页完成后必须调用 validate_slide {"page":${page}}

不要携带或索取其他页面完整 HTML。现在完成且只完成这一页。`;
  },

  _harnessAllowedAction(action, planSlide, directive, mutated) {
    const page = Number(planSlide.page);
    const tool = String(action?.tool || '');
    if (!['read_slide', 'search_design_examples', 'render_template', 'write_slide', 'insert_slide', 'validate_slide'].includes(tool)) {
      return `分页 Worker 不允许调用 ${tool || '空工具'}`;
    }
    if (['read_slide', 'write_slide', 'validate_slide'].includes(tool) && Number(action.page) !== page) {
      return `分页 Worker 只允许操作第 ${page} 页`;
    }
    if (tool === 'render_template') {
      const expectedTemplate = String(planSlide.templateId || planSlide.template_id || '');
      if (!expectedTemplate || String(action.template_id || '') !== expectedTemplate) return `第 ${page} 页必须使用规划模板 ${expectedTemplate || '（无）'}`;
      if (String(action.mode || '') !== directive.mode) return `第 ${page} 页必须使用 ${directive.mode} 模式`;
      if (directive.mode === 'replace' && Number(action.page) !== page) return `模板必须替换第 ${page} 页`;
      if (directive.mode === 'insert' && Number(action.after) !== directive.after) return `模板必须在第 ${directive.after} 页后插入`;
    }
    if (tool === 'write_slide' && directive.mode === 'insert') return '当前页需要插入，不能用 write_slide 覆盖结束页';
    if (tool === 'insert_slide' && (directive.mode !== 'insert' || Number(action.after) !== directive.after)) {
      return `当前页只能插入到第 ${directive.after} 页之后`;
    }
    if (tool === 'search_design_examples' && mutated) return '页面写入后不能再切换设计方向';
    return '';
  },

  _isHarnessResumeRequest(input) {
    return /^(?:请)?(?:继续|恢复|接着)(?:生成|制作|执行|完成)?(?:课件|任务)?[。！!\s]*$/u.test(String(input || '').trim());
  },

  async _prepareHarnessTarget(planSlide, counters) {
    let directive = this._harnessMutationDirective(planSlide);
    const hasTemplate = !!String(planSlide.templateId || planSlide.template_id || '').trim();
    const role = String(planSlide.role || 'content').toLowerCase();
    const templateRole = role === 'ending' ? 'finish' : role === 'toc' ? 'catalog' : role;
    if (directive.mode === 'replace' && !hasTemplate && ['cover', 'catalog', 'chapter', 'finish'].includes(templateRole) && directive.currentRole !== templateRole) {
      const action = { tool: 'apply_role_template', page: Number(planSlide.page), role: templateRole, title: planSlide.title };
      counters.tools += 1;
      const actionStartedAt = this._now();
      const actionEl = this._logAction(action, counters.tools);
      const result = await this._rpc('execute-action', { action });
      this._finishAction(actionEl, actionStartedAt, result);
      this._logResult(result);
      if (this._isTerminalToolFailure(result) || this._resultIsError(result)) throw new Error(String(result));
      await this._refreshContext();
      directive = this._harnessMutationDirective(planSlide);
    }
    if (directive.mode !== 'insert' || hasTemplate) return directive;
    const action = {
      tool: 'insert_slide',
      after: directive.after,
      template_role: ['cover', 'catalog', 'chapter', 'content', 'finish'].includes(templateRole) ? templateRole : 'content',
      slide_type: templateRole,
      title: planSlide.title,
    };
    counters.tools += 1;
    const actionStartedAt = this._now();
    const actionEl = this._logAction(action, counters.tools);
    const result = await this._rpc('execute-action', { action });
    this._finishAction(actionEl, actionStartedAt, result);
    this._logResult(result);
    if (this._isTerminalToolFailure(result) || this._resultIsError(result)) throw new Error(String(result));
    await this._refreshContext();
    return this._harnessMutationDirective(planSlide);
  },

  _lecturePiConfig() {
    const selected = this.selectedConfig || this.aiConfig || {};
    if (selected.aiProvider !== 'lectureai') return null;
    const provider = (this.providers || []).find(item => item.id === 'lectureai');
    const token = String(provider?.config?.aiApiKey || '').trim();
    if (!token || typeof WebSocket === 'undefined') return null;
    const base = String(this.lectureAiServerUrl || 'https://design.hz-study-system.com').replace(/\/+$/, '');
    const socketBase = base.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
    return { token, url: `${socketBase}/api/web/ai/pi/bridge` };
  },

  _newPiId(prefix) {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return `${prefix}-${uuid}`;
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  },

  _piDeckId(plan) {
    const existing = String(plan?.execution?.piDeckId || '').trim();
    if (/^[a-zA-Z0-9._-]{8,120}$/.test(existing)) return existing;
    const revision = String(plan?.baseRevision?.deckHash || '').replace(/^sha256:/, '');
    return /^[a-zA-Z0-9._-]{8,120}$/.test(revision) ? revision : this._newPiId('deck');
  },

  _piToolDetails(action, result) {
    const text = String(result || '');
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (_) { /* text tools are normalized below */ }
    const details = parsed && typeof parsed === 'object' ? parsed : { message: text.slice(0, 12000) };
    details.label = details.label || text.split('\n')[0].slice(0, 160) || action.tool;
    if (action.page != null) details.page = Number(action.page);
    if (action.tool === 'render_template') {
      details.template_id = action.template_id;
      details.page = Number(action.page || action.after + 1);
    }
    if (action.tool === 'insert_slide') details.page = Number(action.after) + 1;
    if (action.tool === 'validate_slide') {
      details.passed = details.passed === true || /合规：未发现|校验通过|"passed"\s*:\s*true/.test(text);
    }
    return details;
  },

  async _executePiTool(message, planSlide, directive, counters) {
    const action = { ...(message.args || {}), tool: message.tool };
    const gateError = this._harnessAllowedAction(action, planSlide, directive, false);
    if (gateError) throw new Error(gateError);
    counters.tools += 1;
    const startedAt = this._now();
    const actionEl = this._logAction(action, counters.tools);
    const result = await this._rpc('execute-action', { action });
    this._finishAction(actionEl, startedAt, result);
    this._logResult(result);
    if (this._isTerminalToolFailure(result) || this._resultIsError(result)) throw new Error(String(result));
    if (['render_template', 'write_slide', 'insert_slide'].includes(action.tool)) await this._refreshContext();
    return this._piToolDetails(action, result);
  },

  async _runPiHarnessPage(plan, planSlide, summaries, stageGuidance, counters, piConfig) {
    const page = Number(planSlide.page);
    const directive = await this._prepareHarnessTarget(planSlide, counters);
    const sessionId = this._activeTask?.piSessionId || plan.execution?.piSessionId || this._newPiId('session');
    const deckId = this._activeTask?.piDeckId || this._piDeckId(plan);
    counters.rounds += 1;
    this._activeRound = counters.rounds;
    this._startModelStatus(this._activeRound, 1);
    if (this._modelStatusEl) {
      this._modelStatusEl.dataset.summary = `LectureAI 正在设计第 ${page} 页`;
      this._modelStatusEl.textContent = `第 ${this._activeRound} 轮 · LectureAI 正在设计第 ${page} 页`;
    }
    this._log('sys', `LectureAI 已连接 · 第 ${page} 页 · 正在准备生成`);
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(piConfig.url, ['lectureai.pi.v1', `lectureai.auth.${piConfig.token}`]);
      this._piSocket = socket;
      this._piReject = reject;
      let settled = false;
      let queue = Promise.resolve();
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        if (this._piSocket === socket) this._piSocket = null;
        if (this._piReject === reject) this._piReject = null;
        if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'page complete');
        this._finishModelStatus(error ? 'LectureAI 生成失败' : `第 ${page} 页完成`);
        if (error) reject(error); else resolve(value);
      };
      socket.onopen = () => {
        socket.send(JSON.stringify({
          type: 'start_page', session_id: sessionId, deck_id: deckId,
          plan, page, directive: {
            page, templateId: planSlide.templateId || planSlide.template_id || '',
            mode: directive.mode, after: directive.after,
          },
          user_instruction: [this._activeTask?.userInstruction || '生成整套课件', this._outlinePromptBlock()].filter(Boolean).join('\n\n'),
          stage_guidance: stageGuidance || '',
        }));
      };
      socket.onmessage = event => {
        queue = queue.then(async () => {
          const message = JSON.parse(String(event.data || '{}'));
          if (message.type === 'tool_call') {
            if (this._modelStatusEl) this._modelStatusEl.textContent = `第 ${this._activeRound} 轮 · 正在${this._toolDisplayName(message.tool)} · ${this._duration(this._modelStartedAt)}`;
            this._log('sys', `LectureAI · 第 ${page} 页 · ${this._toolDisplayName(message.tool)}`);
            try {
              const result = await this._executePiTool(message, planSlide, directive, counters);
              if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({
                type: 'tool_result',
                ['request_id']: message.request_id,
                ok: true,
                result,
              }));
            } catch (error) {
              if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({
                type: 'tool_result',
                ['request_id']: message.request_id,
                ok: false,
                error: this._modelErrorMessage(error),
              }));
            }
            return;
          }
          if (message.type === 'progress' || message.type === 'session_started') {
            const label = this._friendlyLabel(message.label) || `LectureAI 已开始生成 · 第 ${page} 页`;
            this._log('sys', label);
            return;
          }
          if (message.type === 'page_complete') {
            const narrative = planSlide.narrative || {};
            finish(null, String(message.summary || narrative.keyTakeaway || planSlide.visualIntent || planSlide.title).slice(0, 1200));
            return;
          }
          if (message.type === 'paused') {
            finish(new Error('用户取消了当前任务'));
            return;
          }
          if (message.type === 'error') finish(new Error(this._friendlyLabel(message.error) || `第 ${page} 页生成失败`));
        }).catch(error => finish(error));
      };
      socket.onerror = () => finish(new Error('无法连接 LectureAI 服务'));
      socket.onclose = event => {
        if (!settled) finish(new Error(this._stopRequested ? '用户取消了当前任务' : `LectureAI 连接已中断（${event.code}）`));
      };
    });
  },

  async _runHarnessPage(plan, planSlide, summaries, stageGuidance, counters) {
    const piConfig = this._lecturePiConfig();
    if (piConfig) return this._runPiHarnessPage(plan, planSlide, summaries, stageGuidance, counters, piConfig);
    return this._runLegacyHarnessPage(plan, planSlide, summaries, stageGuidance, counters);
  },

  async _runLegacyHarnessPage(plan, planSlide, summaries, stageGuidance, counters) {
    const page = Number(planSlide.page);
    const directive = await this._prepareHarnessTarget(planSlide, counters);
    const messages = [
      { role: 'system', content: this._harnessSystemPrompt() },
      { role: 'user', content: this._harnessPageContext(plan, planSlide, summaries, stageGuidance) },
    ];
    let mutated = false;
    let validated = false;
    let protocolRetries = 0;
    for (let round = 1; round <= 12; round += 1) {
      if (this._stopRequested) throw new Error('用户取消了当前任务');
      counters.rounds += 1;
      this._activeRound = counters.rounds;
      const templateId = planSlide.templateId || planSlide.template_id || '';
      const text = await this._callAI(messages, 'page-worker', templateId ? [templateId] : []);
      if (!text) throw new Error(`第 ${page} 页模型返回空内容`);
      messages.push({ role: 'assistant', content: text });
      const actions = this._parseActions(text);
      if (!actions.length) {
        if (!mutated || !validated) {
          protocolRetries += 1;
          if (protocolRetries > 3) throw new Error(`第 ${page} 页未完成写入与校验`);
          messages.push({ role: 'user', content: mutated
            ? `[页面门禁] 第 ${page} 页尚未通过 validate_slide，请立即校验，不要总结。`
            : `[页面门禁] 第 ${page} 页尚未写入，请按 Harness 指令调用工具，不要总结。` });
          continue;
        }
        const narrative = planSlide.narrative || {};
        const reported = this._stripActions(text).replace(/\s+/g, ' ').trim().slice(0, 180);
        return reported || `${narrative.keyTakeaway || planSlide.visualIntent || planSlide.title}；已按 ${planSlide.templateId || planSlide.renderMode || planSlide.role} 生成并校验`;
      }
      if (actions.length !== 1) {
        messages.push({ role: 'user', content: '[工具协议纠正] 每次只能输出一个 action，请重新发送当前动作。' });
        continue;
      }
      const action = actions[0];
      const gateError = this._harnessAllowedAction(action, planSlide, directive, mutated);
      if (gateError) {
        messages.push({ role: 'user', content: `[Harness 门禁] ${gateError}。请按当前页固定指令修正。` });
        continue;
      }
      counters.tools += 1;
      const actionStartedAt = this._now();
      const actionEl = this._logAction(action, counters.tools);
      const result = await this._rpc('execute-action', { action });
      this._finishAction(actionEl, actionStartedAt, result);
      this._logResult(result);
      if (this._isTerminalToolFailure(result) || this._resultIsError(result)) throw new Error(String(result));
      if (['render_template', 'write_slide', 'insert_slide'].includes(action.tool)) {
        mutated = true;
        validated = false;
        await this._refreshContext();
      }
      if (action.tool === 'validate_slide') {
        try { validated = JSON.parse(String(result).replace(/^[^{]*/, '')).passed === true; }
        catch (_) { validated = /合规：未发现|校验通过|"passed"\s*:\s*true/.test(String(result)); }
        if (!validated) protocolRetries += 1;
      }
      const compact = String(result || '').length > 10000
        ? `${String(result).slice(0, 10000)}\n[当前页工具回执已截断]`
        : String(result || '');
      messages.push({ role: 'user', content: `[当前页工具回执]\n${compact}\n只继续第 ${page} 页。` });
    }
    throw new Error(`第 ${page} 页超过单页执行轮次上限`);
  },

  async _runHarnessStageReview(plan, completedPages, summaries) {
    const pages = completedPages.slice(-5);
    const next = (plan.slides || []).filter(slide => Number(slide.page) > pages[pages.length - 1]).slice(0, 3);
    const messages = [
      { role: 'system', content: '你是课件阶段审查器。只根据规划和页面摘要检查教学递进、概念跳跃、术语漂移和模板节奏。不得调用工具。输出不超过 180 字的具体修正建议；没有问题则输出“阶段衔接通过”。' },
      { role: 'user', content: `[刚完成页面]\n${pages.map(page => `第${page}页：${summaries[page]}`).join('\n')}\n\n[后续三页规划]\n${JSON.stringify(next)}\n\n[全局目标]\n${JSON.stringify(plan.goal || plan.learningObjectives || plan.title || '')}` },
    ];
    this._activeRound += 1;
    const review = await this._callAI(messages, 'stage-review');
    return this._stripActions(String(review || '')).replace(/\s+/g, ' ').trim().slice(0, 240) || '阶段衔接通过';
  },

  async _persistHarnessExecution(plan, execution) {
    plan.execution = { ...(plan.execution || {}), schemaVersion: 1, ...execution, updatedAt: new Date().toISOString() };
    const result = await this._rpc('execute-action', { action: { tool: 'set_deck_plan', plan } });
    if (this._resultIsError(result)) throw new Error(String(result));
  },

  _harnessRepairPages(plan, validation) {
    const errors = Array.isArray(validation?.errors) ? validation.errors : [];
    const referenced = new Set();
    for (const error of errors) {
      for (const match of String(error).matchAll(/第\s*(\d+)\s*页/g)) referenced.add(Number(match[1]));
    }
    if (referenced.size) return [...referenced].filter(page => page >= 1 && page <= Number(plan.targetSlideCount)).slice(0, 5);
    const motionError = errors.some(error => /动画|交互/.test(String(error)));
    const candidates = (plan.slides || []).filter(slide => String(slide.role || '').toLowerCase() === 'content');
    const preferred = motionError
      ? candidates.filter(slide => !['', 'none', 'static'].includes(String(slide.motion || '').toLowerCase()))
      : candidates;
    return (preferred.length ? preferred : candidates).slice(-3).map(slide => Number(slide.page));
  },

  async _validateAndRepairHarness(plan, state, counters) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const validationAction = { tool: 'validate_deck' };
      counters.tools += 1;
      const actionEl = this._logAction(validationAction, counters.tools);
      const actionStartedAt = this._now();
      const validationResult = await this._rpc('execute-action', { action: validationAction });
      this._finishAction(actionEl, actionStartedAt, validationResult);
      this._logResult(validationResult);
      let validation = null;
      try { validation = JSON.parse(validationResult); } catch (_) { /* handled below */ }
      if (validation?.passed) return validation;
      if (attempt === 2) return validation || { passed: false, errors: [validationResult] };
      const repairPages = this._harnessRepairPages(plan, validation);
      if (!repairPages.length) return validation || { passed: false, errors: [validationResult] };
      const guidance = `整套校验返工：${(validation?.errors || [validationResult]).join('；')}`.slice(0, 800);
      this._log('sys', `整套校验返工 ${attempt + 1}/2 · 第 ${repairPages.join('、')} 页`);
      for (const page of repairPages) {
        const planSlide = (plan.slides || []).find(slide => Number(slide.page) === page);
        if (!planSlide) continue;
        state.summaries[page] = await this._runHarnessPage(plan, planSlide, state.summaries, guidance, counters);
      }
      await this._persistHarnessExecution(plan, {
        status: 'repairing', nextPage: null, completedPages: state.completedPages,
        summaries: state.summaries, stageReviews: state.stageReviews, userInstruction: state.userInstruction,
      });
    }
    return { passed: false, errors: ['整套校验返工未完成'] };
  },

  async _resumePlannedHarness(plan, input) {
    this.busy = true;
    this._setBusy(true);
    this._stopRequested = false;
    this._activeTask = {
      deckLevel: true,
      requiresPlan: true,
      planSaved: true,
      deckValidated: false,
      plan,
      harnessEnabled: true,
      userInstruction: plan.execution?.userInstruction || input,
    };
    try {
      await this._runPlannedHarness(plan, this._activeTask.userInstruction);
    } catch (error) {
      if (!this._stopRequested) this._log('err', `恢复任务失败：${this._modelErrorMessage(error)}`);
    } finally {
      this.busy = false;
      this._setBusy(false);
    }
  },

  async _runPlannedHarness(plan, userInstruction) {
    const startedAt = this._now();
    const previous = plan.execution?.schemaVersion === 1 ? plan.execution : {};
    const summaries = { ...(previous.summaries || {}) };
    const completedPages = Array.isArray(previous.completedPages) ? [...new Set(previous.completedPages.map(Number))] : [];
    const stageReviews = Array.isArray(previous.stageReviews) ? [...previous.stageReviews] : [];
    const piSessionId = previous.piSessionId || this._newPiId('session');
    const piDeckId = this._piDeckId(plan);
    plan.execution = { ...previous, schemaVersion: 1, piSessionId, piDeckId };
    const counters = { rounds: 0, tools: 0 };
    this._activeTask.userInstruction = userInstruction;
    this._activeTask.piSessionId = piSessionId;
    this._activeTask.piDeckId = piDeckId;
    this._log('sys', `分页 Harness 已启动 · ${plan.targetSlideCount} 页 · 每页独立上下文`);
    try {
      for (const planSlide of plan.slides || []) {
        const page = Number(planSlide.page);
        if (completedPages.includes(page)) continue;
        if (this._stopRequested) throw new Error('用户取消了当前任务');
        const latestGuidance = stageReviews[stageReviews.length - 1]?.guidance || '';
        this._log('sys', `页面任务 ${page}/${plan.targetSlideCount} · 仅加载前后两页规划`);
        summaries[page] = await this._runHarnessPage(plan, planSlide, summaries, latestGuidance, counters);
        completedPages.push(page);
        await this._persistHarnessExecution(plan, {
          status: 'running', nextPage: page + 1, completedPages, summaries, stageReviews, userInstruction,
        });
        if (completedPages.length % 5 === 0 && page < Number(plan.targetSlideCount)) {
          const guidance = await this._runHarnessStageReview(plan, completedPages, summaries);
          stageReviews.push({ throughPage: page, guidance });
          this._log('sys', `阶段审查 · 完成至第 ${page} 页 · ${guidance}`);
          await this._persistHarnessExecution(plan, {
            status: 'running', nextPage: page + 1, completedPages, summaries, stageReviews, userInstruction,
          });
        }
      }
      const validation = await this._validateAndRepairHarness(plan, {
        completedPages, summaries, stageReviews, userInstruction,
      }, counters);
      if (!validation?.passed) {
        await this._persistHarnessExecution(plan, {
          status: 'needs-repair', nextPage: null, completedPages, summaries, stageReviews,
          validation, userInstruction,
        });
        const failure = new Error(`整套校验未通过：${(validation?.errors || []).join('；')}`);
        failure.harnessStatus = 'needs-repair';
        throw failure;
      }
      this._activeTask.deckValidated = true;
      await this._persistHarnessExecution(plan, {
        status: 'completed', nextPage: null, completedPages, summaries, stageReviews,
        validation: { passed: true, metrics: validation.metrics || {} }, userInstruction,
      });
      this._appendAssistantMarkdown(`### 课件生成完成\n\n已按分页 Harness 完成 ${completedPages.length} 页。每页使用独立局部上下文，并在每 5 页后进行一次教学衔接审查；整套校验已通过。`);
      this._log('sys', `分页 Harness 完成 · ${counters.rounds} 轮模型响应 · ${counters.tools} 次工具调用 · ${this._duration(startedAt)}`);
    } catch (error) {
      const status = this._stopRequested ? 'paused' : (error?.harnessStatus || 'failed');
      try {
        await this._persistHarnessExecution(plan, {
          status, nextPage: (plan.slides || []).find(slide => !completedPages.includes(Number(slide.page)))?.page || null,
          completedPages, summaries, stageReviews, error: this._modelErrorMessage(error), userInstruction,
        });
      } catch (_) { /* keep original failure */ }
      if (this._stopRequested) {
        const nextPage = (plan.slides || []).find(slide => !completedPages.includes(Number(slide.page)))?.page || null;
        this._appendAssistantMarkdown(`### 任务已停止\n\n已保存 ${completedPages.length} 页及执行进度${nextPage ? `，下次可从第 ${nextPage} 页继续` : ''}。`);
        return;
      }
      throw error;
    }
  },

  // ---- streaming AI call ----
  async _callAI(messages, contextMode = 'deck-plan', contextTemplateIds = []) {
    const cfg = this.selectedConfig || this.aiConfig || {};
    const maxAttempts = cfg.aiProvider === 'lectureai' ? 2 : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this._callAIOnce(messages, attempt, contextMode, contextTemplateIds);
      } catch (error) {
        const message = this._modelErrorMessage(error);
        if (attempt < maxAttempts && this._isRetryableModelError(message)) {
          this._markModelRetry(attempt + 1);
          await this._wait(1200);
          continue;
        }
        this._finishModelStatus('模型请求失败');
        const failure = new Error(this._friendlyModelError(message, attempt > 1));
        failure.isModelRequestError = true;
        throw failure;
      }
    }
    throw new Error('模型请求未返回结果');
  },

  _callAIOnce(messages, attempt = 1, contextMode = 'deck-plan', contextTemplateIds = []) {
    return new Promise((resolve, reject) => {
      this._streamFull = '';
      this._streamResolve = resolve;
      const request = { generation: this._turnGeneration, reject };
      this._activeStreamRequest = request;
      const cfg = this.selectedConfig || this.aiConfig || {};
      const provider = cfg.aiProvider;
      // aiConfig.aiApiKey is populated by the main window: for 'lectureai' it is
      // the auth token, for others the raw API key. Pass it straight through.
      const apiKey = cfg.aiApiKey || '';
      this._startModelStatus(this._activeRound, attempt);
      window.__TAURI__.core.invoke('call_ai_messages_stream', {
        provider,
        apiKey,
        apiType: cfg.aiApiType,
        baseUrl: cfg.aiBaseUrl,
        model: cfg.aiModel,
        messages,
        contextMode,
        contextTemplateIds,
      }).catch((e) => {
        // Surface the real backend error (quota / auth / format) instead of a
        // silent "empty" - reject so _runTurn's catch shows it.
        if (this._renderTimer) { clearTimeout(this._renderTimer); this._renderTimer = null; }
        if (this._activeStreamRequest === request) this._activeStreamRequest = null;
        this._streamResolve = null;
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  },

  _requestStop() {
    if (!this.busy) return;
    this._stopRequested = true;
    const piSocket = this._piSocket;
    this._piSocket = null;
    const piReject = this._piReject;
    this._piReject = null;
    if (piSocket?.readyState === 1) {
      try { piSocket.send(JSON.stringify({ type: 'stop' })); } catch (_) { /* closing below is authoritative */ }
      piSocket.close(1000, 'user stop');
    } else if (piSocket?.readyState === 0) {
      piSocket.close();
    }
    if (piReject) piReject(new Error('用户取消了当前任务'));
    this._turnGeneration += 1;
    this._stopModelStatusTimer();
    const request = this._activeStreamRequest;
    this._activeStreamRequest = null;
    this._streamResolve = null;
    if (request?.reject) request.reject(new Error('用户取消了当前任务'));
    if (this._modelStatusEl) this._modelStatusEl.textContent = '任务已停止 · 不再等待当前模型响应';
  },

  _wait(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
  },

  _modelErrorMessage(error) {
    return String(error?.message || error || '未知错误').replace(/^(?:Error:\s*)+/i, '').trim();
  },

  _isRetryableModelError(message) {
    return /HTTP\s*50[234]|LLM 服务请求失败|LectureAI 服务暂时不可用|LectureAI 上游模型暂时不可用|网络请求失败|连接.*失败/i.test(String(message || ''));
  },

  _friendlyModelError(message, retried = false) {
    const source = String(message || '');
    if (this._isRetryableModelError(source)) {
      const status = source.match(/HTTP\s*(\d{3})/i)?.[1];
      return `LectureAI 上游模型暂时不可用${status ? `（HTTP ${status}）` : ''}${retried ? '，已自动重试 1 次仍未恢复' : ''}。请稍后重试。`;
    }
    return source;
  },

  _scheduleStreamingUpdate() {
    if (this._renderTimer) return;
    this._renderTimer = setTimeout(() => {
      this._renderTimer = null;
      this._updateModelStatusFromOutput();
    }, 50);
  },

  _compactStatus(text) {
    const lines = String(text || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/[*_`>|]/g, '')
      .split(/\n+/)
      .map(line => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    const clean = lines[lines.length - 1] || '';
    if (!clean) return '';
    const sentences = clean.match(/[^。！？.!?]+[。！？.!?]?/g) || [clean];
    return sentences[sentences.length - 1].trim().slice(0, 48);
  },

  _updateModelStatusFromOutput() {
    const summary = this._compactStatus(this._stripActions(this._streamFull));
    if (summary && this._modelStatusEl) {
      this._modelStatusEl.dataset.summary = summary;
      this._modelStatusEl.textContent = `第 ${this._activeRound} 轮 · ${summary} · ${this._modelDuration()}`;
      this._scroll();
    }
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

  _hasUnexecutedToolIntent(text) {
    const clean = this._stripActions(String(text || ''))
      .replace(/^[#>*_`\s-]+/gm, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!clean || clean.length > 160) return false;
    if (/检查结果|校验结果|处理完成|检查完成|总结|发现以下|问题如下|无需修改/.test(clean)) return false;
    return /^(?:好的[，。!！\s]*)?(?:收到[，。!！\s]*)?(?:我?先|现在|继续|接下来|准备|开始|将|需要)?\s*(?:逐页)?(?:读取|查看|打开|检查|校验|验证|修改|重写|写入|插入|新增|删除|调整|重排)/u.test(clean);
  },

  _isTerminalToolFailure(result) {
    const text = String(result || '');
    return /(?:write_slide|insert_slide|apply_role_template|reorder_slides|set_deck_plan) 保存失败|已恢复执行前状态|文件冲突/.test(text);
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

  _appendUser(text, mentioned) {
    const explicitPages = new Set([...String(text || '').matchAll(/@(\d+)\b/g)].map(match => Number(match[1])));
    const implicitPages = (mentioned || []).map(item => Number(item.page)).filter(page => !explicitPages.has(page));
    const t = implicitPages.length ? `@${implicitPages.join(' @')} · ${text}` : text;
    this._log('user', t);
  },

  _appendAssistantMarkdown(markdown) {
    const m = document.getElementById('wb-messages');
    if (!m || !markdown) return;
    const el = document.createElement('div');
    el.className = 'ln ln-ai markdown-body';
    if (window.marked) {
      el.innerHTML = this._sanitizeHtml(window.marked.parse(markdown));
    } else {
      el.textContent = markdown;
    }
    m.appendChild(el);
    this._scroll();
    return el;
  },

  _sanitizeHtml(html) {
    const template = document.createElement('template');
    template.innerHTML = String(html || '');
    template.content.querySelectorAll('script, style, iframe, object, embed, link, meta').forEach(el => el.remove());
    template.content.querySelectorAll('*').forEach(el => {
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        const value = attr.value.trim().toLowerCase();
        if (name.startsWith('on') || ((name === 'href' || name === 'src') && value.startsWith('javascript:'))) {
          el.removeAttribute(attr.name);
        }
      }
    });
    return template.innerHTML;
  },

  // ---- truthful model-request status (no simulated "thinking" phrases) ----
  _now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  },
  _duration(startedAt) {
    const elapsed = Math.max(0, this._now() - startedAt);
    return elapsed >= 1000 ? `${(elapsed / 1000).toFixed(1)}s` : `${elapsed.toFixed(0)}ms`;
  },
  _modelDuration() {
    return this._duration(this._modelStartedAt);
  },
  _startModelStatus(round, attempt = 1) {
    this._stopModelStatusTimer();
    this._modelStartedAt = this._now();
    this._modelAttempt = attempt;
    const m = document.getElementById('wb-messages');
    if (this._modelStatusEl) {
      this._modelStatusEl.remove();
      this._modelStatusEl.dataset.summary = '';
      if (m) m.appendChild(this._modelStatusEl);
    } else {
      this._modelStatusEl = this._log('phase', `第 ${round} 轮 · 正在提交模型请求 · 0ms`);
    }
    const attemptLabel = attempt > 1 ? `自动重试 ${attempt}/2 · ` : '';
    if (this._modelStatusEl) this._modelStatusEl.textContent = `第 ${round} 轮 · ${attemptLabel}正在提交模型请求 · 0ms`;
    this._modelStatusTimer = setInterval(() => {
      if (this._modelStatusEl && !this._streamFull) {
        const elapsed = this._now() - this._modelStartedAt;
        const phase = elapsed < 1200
          ? '正在提交模型请求'
          : elapsed < 5000
            ? '请求已送达，等待模型首个响应'
            : elapsed < 15000
              ? '模型正在准备下一步工具计划'
              : '模型响应较慢，仍在等待首个响应';
        this._modelStatusEl.textContent = `第 ${round} 轮 · ${attemptLabel}${phase} · ${this._modelDuration()}`;
      }
    }, 100);
  },
  _markModelRetry(nextAttempt) {
    this._stopModelStatusTimer();
    if (this._modelStatusEl) {
      this._modelStatusEl.textContent = `第 ${this._activeRound} 轮 · 上游模型暂时不可用，1.2s 后自动重试 ${nextAttempt}/2`;
    }
  },
  _markModelReceiving() {
    this._stopModelStatusTimer();
    if (this._modelStatusEl) {
      this._modelStatusEl.textContent = `第 ${this._activeRound} 轮 · 接收模型输出 · ${this._modelDuration()}`;
    }
  },
  _finishModelStatus(label = '') {
    this._stopModelStatusTimer();
    if (this._modelStatusEl) {
      const summary = this._modelStatusEl.dataset.summary || label || '模型响应完成';
      this._modelStatusEl.textContent = `第 ${this._activeRound} 轮 · ${summary} · ${this._modelDuration()}`;
    }
  },
  _stopModelStatusTimer() {
    if (this._modelStatusTimer) {
      clearInterval(this._modelStatusTimer);
      this._modelStatusTimer = null;
    }
  },

  // User-facing names for internal tool calls; raw tool ids never reach the UI.
  _toolDisplayNames: {
    set_deck_plan: '规划整套大纲',
    search_design_examples: '检索设计案例',
    render_template: '渲染页面模板',
    read_slide: '读取页面',
    write_slide: '写入页面内容',
    insert_slide: '插入新页面',
    reorder_slides: '调整页面顺序',
    validate_slide: '校验页面',
    validate_deck: '校验整套课件',
    inspect_slides: '检查页面',
  },

  _toolDisplayName(tool) {
    return this._toolDisplayNames[tool] || '处理页面';
  },

  _friendlyLabel(label) {
    return String(label || '')
      .replace(/Pi\s*Agent/g, 'LectureAI')
      .replace(/\bPi\b/g, 'LectureAI')
      .replace(/渲染私有模板/g, '渲染页面模板');
  },

  _logAction(a, callNumber) {
    if (a.tool === '_parse_error') {
      return this._log('err', `action 解析失败：${a.error || ''}`);
    }
    const page = a.page != null ? ` 第${a.page}页` : '';
    const after = a.after != null ? `（插在第${a.after}页后）` : '';
    const reason = a.reason ? ` · ${a.reason}` : '';
    const label = `操作 ${callNumber} · ${this._toolDisplayName(a.tool)}${page}${after}${reason}`;
    const el = this._log('act', `${label} · 执行中`);
    if (el) el.dataset.actionLabel = label;
    return el;
  },

  _finishAction(el, startedAt, result) {
    if (!el) return;
    const firstLine = String(result || '').split('\n')[0];
    const failed = this._resultIsError(firstLine);
    el.textContent = `${el.dataset.actionLabel || '工具'} · ${failed ? '失败' : '完成'} · ${this._duration(startedAt)}`;
    if (failed) el.className = 'ln ln-err';
  },

  _logResult(result) {
    const r = String(result || '(无结果)');
    const firstLine = r.split('\n')[0] || r;
    const isErr = this._resultIsError(firstLine);
    const summary = r.split('\n').slice(0, 3).join(' · ').slice(0, 200);
    this._log(isErr ? 'err' : 'ok', summary);
  },

  _resultIsError(value) {
    const text = String(value || '').trim();
    return /(?:执行出错|保存失败|文件冲突|超出范围|缺少 tool|action 解析失败|未知工具)/.test(text)
      || /^(?:\[[^\]]+\]|(?:set_deck_plan|write_slide|insert_slide|reorder_slides|validate_slide|validate_deck|inspect_slides))\s*(?:失败|错误|出错)/.test(text);
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
    const stop = document.getElementById('wb-stop');
    const input = document.getElementById('wb-input');
    if (send) send.disabled = busy;
    if (stop) stop.hidden = !busy;
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
