// workbench-window.js - Chat logic for the workbench Agent window.
//
// This window owns the conversation + AI calls + action protocol. It does NOT
// touch PpteEditor or files directly; instead it RPCs to the main window:
//   wb-request {type:'get-context'}            -> {title, slides:[{title}], aiConfig}
//   wb-request {type:'get-slide', payload:{page}} -> {html}
//   wb-request {type:'execute-action', payload:{action}} -> {result}
// Main window responds via wb-response {type, result}.
//
// AI streaming: call_ai_messages_stream emits global ai-stream-chunk / ai-stream-thinking / ai-stream-done
// events; only this window listens (the main window no longer streams).
window.WorkbenchWindow = {
  history: [],          // [{role, content}]; [0] is the system prompt
  manifest: null,       // {title, slides:[{title, slideType, file}], templateBlueprint, deckPlan}
  aiConfig: null,
  busy: false,
  _streamFull: '',
  _thinkingTail: '',
  _streamResolve: null,
  _streamBubble: null,
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
  _deckPath: null,        // folderPath of the connected deck; session file lives under it
  _transcript: [],        // persisted log entries: [{t:'user'|'sys'|'ok'|'err', text} | {t:'ai', md}]
  _sessionId: null,       // current conversation id; a new one per window open
  _sessionStartedAt: null,
  _sessions: [],          // cached session store entries (max 10 kept on disk)
  _sessionSaveTimer: null,
  _restoreToken: 0,
  _taskCardRun: null,
  _taskCardSpec: null,
  _taskSyncTimers: new Map(),
  _taskJournalLoadSeq: 0,
  _featureFlags: Object.create(null),
  _featureFlagsLoaded: false,
  _featureFlagsToken: '',

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
        listen('ai-stream-thinking', (e) => {
          if (!this._activeStreamRequest || this._activeStreamRequest.generation !== this._turnGeneration) return;
          // Rolling glimpse of the model's reasoning: the status-line timer
          // picks this up so waiting users see live progress, not a dead
          // "still waiting" message. Reasoning never enters the answer text.
          this._thinkingTail = ((this._thinkingTail || '') + String(e.payload || ''))
            .replace(/\s+/g, ' ')
            .trim()
            .slice(-40);
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
    // Flush the debounced session save when the window closes.
    window.addEventListener?.('beforeunload', () => {
      clearTimeout(this._sessionSaveTimer);
      this._saveSession();
    });
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
      this._deckPath = null;
      this._sessionId = null;
      this._sessions = [];
      this._renderPickCourse();
    } else {
      const deckPath = String(ctx.folderPath || '').replace(/[\\/]+$/, '') || null;
      if (deckPath && deckPath !== this._deckPath) {
        // Connected to a (different) deck: start a fresh conversation; past
        // sessions stay on disk and can be reopened with /resume.
        this._deckPath = deckPath;
        this.history = [];
        this._transcript = [];
        this._beginSession();
      } else if (document.getElementById('wb-pick-ppte')) {
        // was showing the pick-course guide, now connected -> reset to empty
        this._renderEmpty();
      }
    }
    if (ctx?.prefillPage) this._onPrefill({ page: ctx.prefillPage });
    if (ctx?.slides?.length) this._loadTaskJournal();
  },

  _taskStatusLabel(status) {
    return {
      created: '正在准备', awaiting_user: '等待补充说明', resolving: '正在理解目标',
      planning: '正在规划', ready: '等待开始', running: '处理中', paused: '已暂停',
      repairing: '正在返工', validating: '正在检查', needs_repair: '需要返工',
      completed: '已完成', failed: '未完成', cancelled: '已停止', reverted: '已撤销',
    }[String(status || '')] || '任务进行中';
  },

  _taskCardGoal(run, spec = null) {
    const intent = {
      answer: '回答课件问题', outline_write: '整理课件大纲', slide_edit: '修改目标页面',
      slide_insert: '新增课件页面', deck_cleanup: '整理整套课件', deck_rewrite: '重做整套课件',
      deck_validate: '检查整套课件', resume_run: '继续上次任务',
    }[String(run?.intent || spec?.intent || '')];
    return String(run?.userFacingGoal || spec?.userFacingGoal || intent || 'LectureAI 任务').replace(/[\r\n]+/g, ' ').slice(0, 180);
  },

  _renderTaskCard(run, spec = null) {
    const card = document.getElementById?.('wb-task-card');
    if (!card) return;
    this._taskCardRun = run || null;
    if (!this._featureEnabled('lectureai_task_ui_v2') && !run?.runId) { card.hidden = true; card.innerHTML = ''; return; }
    if (!run) { card.hidden = true; card.innerHTML = ''; return; }
    const status = String(run.status || 'created');
    const completed = Number(run.completedPages || run.completed_pages || 0);
    const total = Number(run.totalPages || run.total_pages || 0);
    const canContinue = ['paused', 'failed', 'needs_repair', 'ready', 'running', 'repairing'].includes(status);
    const canRetry = status === 'needs_repair' || status === 'failed';
    const canRevert = run.revertAvailable !== false
      && ['completed', 'failed', 'cancelled', 'paused', 'needs_repair'].includes(status);
    const syncPending = run.serverSync && run.serverSync.status === 'pending';
    card.hidden = false;
    card.innerHTML = `
      <div class="wb-task-card-head"><span class="wb-task-card-title">LectureAI 任务</span><span class="wb-task-card-status">${this._escape(this._taskStatusLabel(status))}</span></div>
      <div class="wb-task-card-goal" title="${this._escape(this._taskCardGoal(run, spec))}">${this._escape(this._taskCardGoal(run, spec))}</div>
      <div class="wb-task-card-meta">${completed || total ? `已完成 ${completed}/${total || '?'} 页` : '进度已保存'}${run.errorCode ? ' · 有待处理项' : ''}${syncPending ? ' · 正在同步恢复状态' : ''}</div>
      <div class="wb-task-card-actions">
        ${canContinue ? '<button type="button" data-task-action="continue">继续</button>' : ''}
        ${canRetry ? '<button type="button" data-task-action="retry">仅重试失败页</button>' : ''}
        ${canRevert ? '<button type="button" data-task-action="revert">撤销本次任务</button>' : ''}
        <button type="button" data-task-action="details">查看详情</button>
        <button type="button" data-task-action="clear-history">清理助教任务历史</button>
      </div>`;
    card.querySelectorAll('[data-task-action]').forEach(button => {
      button.onclick = () => this._handleTaskCardAction(button.dataset.taskAction);
    });
  },

  async _loadTaskJournal() {
    if (!this._deckPath || !window.__TAURI__?.core?.invoke) return;
    const loadSeq = ++this._taskJournalLoadSeq;
    try {
      const runs = await this._taskJournalInvoke('ppte_task_journal_list');
      if (loadSeq !== this._taskJournalLoadSeq) return;
      if (!Array.isArray(runs) || !runs.length) {
        this._taskCardSpec = null;
        this._renderTaskCard(null, null);
        return;
      }
      if (this.busy && this._taskCardRun?.runId) return;
      const run = runs.find(item => !['reverted'].includes(String(item?.status || ''))) || runs[0];
      const spec = run?.taskSpec && typeof run.taskSpec === 'object' ? run.taskSpec : null;
      this._taskCardSpec = spec;
      if (run?.plan && typeof run.plan === 'object' && this.manifest) {
        const currentRef = this.manifest.deckPlan?.plan?.taskSpecRef?.runId;
        const planRef = run.plan?.taskSpecRef?.runId;
        if (!currentRef || !planRef || String(currentRef) === String(planRef)) {
          this.manifest.deckPlan = { ...(this.manifest.deckPlan || {}), plan: run.plan };
        }
      }
      this._renderTaskCard(run, spec);
      this._retryPendingTaskSync(run).catch(() => {});
    } catch (_) { /* task history is optional and must not block chat */ }
  },

  async _retryPendingTaskSync(run) {
    if (!run?.runId || run.status !== 'reverted' || run.serverSync?.status === 'synced') return false;
    if (this._taskSyncTimers.has(run.runId)) return false;
    const attempts = Number(run.serverSync?.attempts || 0);
    this._taskCardRun = run;
    const nextAttempts = attempts + 1;
    const restoredDeckRevision = run.serverSync?.restoredDeckRevision || run.currentDeckRevision || null;
    try {
      await this._taskJournalInvoke('ppte_task_journal_update', {
        runId: run.runId,
        patch: { serverSync: { status: 'pending', action: 'revert', attempts: nextAttempts, restoredDeckRevision } },
      });
      const response = await this._taskApi('task_revert', {
        runId: run.runId,
        localReverted: true,
        restoredDeckRevision,
      });
      if (!response?.ok || response.data?.status !== 'reverted') throw new Error('任务状态暂未同步');
      const synced = { ...run, serverSync: { status: 'synced', action: 'revert', attempts: nextAttempts, restoredDeckRevision } };
      await this._taskJournalInvoke('ppte_task_journal_update', { runId: run.runId, patch: { serverSync: synced.serverSync } });
      this._renderTaskCard(synced, this._taskCardSpec);
      return true;
    } catch (_) {
      const delay = Math.min(30000, 1000 * (2 ** Math.min(nextAttempts - 1, 4)));
      const timer = setTimeout(() => {
        this._taskSyncTimers.delete(run.runId);
        this._retryPendingTaskSync({ ...run, serverSync: { ...(run.serverSync || {}), attempts: nextAttempts } }).catch(() => {});
      }, delay);
      this._taskSyncTimers.set(run.runId, timer);
      await this._taskJournalInvoke('ppte_task_journal_update', {
        runId: run.runId,
        patch: { serverSync: { status: 'pending', action: 'revert', attempts: nextAttempts, restoredDeckRevision, retryAt: Date.now() + delay } },
      }).catch(() => {});
      this._renderTaskCard({ ...run, serverSync: { status: 'pending', attempts: nextAttempts } }, this._taskCardSpec);
      return false;
    }
  },

  async _taskApi(action, payload = {}) {
    const token = String((this.selectedConfig || this.aiConfig || {}).aiApiKey || '').trim();
    if (!token || !window.__TAURI__?.core?.invoke) throw new Error('登录状态已失效，请重新登录后重试。');
    return window.__TAURI__.core.invoke('auth_api_request', { action, token, payload: { ...payload, runId: payload.runId || this._taskCardRun?.runId } });
  },

  async _taskActionRequest(action, payload = {}) {
    const response = await this._taskApi(action, payload);
    if (response?.ok) return response.data || {};
    const detail = response?.data?.detail;
    const friendly = window.LectureAiTaskProtocol?.friendlyError(
      detail && typeof detail === 'object' ? detail : { userMessage: String(detail || 'LectureAI 任务步骤同步失败。') },
    );
    const error = new Error(friendly?.userMessage || 'LectureAI 任务步骤同步失败。');
    error.details = detail;
    throw error;
  },

  // Planned desktop mutations need the same server receipt gate as native
  // bridge tool calls. The local executor remains the only writer; this
  // wrapper registers the action first and commits the result afterwards.
  async _executeServerTaskAction(action, runId, taskSpec, envelope) {
    const baseActionId = String(envelope?.actionId || '');
    const argsHash = String(envelope?.argsHash || '');
    const expectedDeckRevision = String(envelope?.expectedDeckRevision || '') || null;
    if (!runId || !baseActionId || !/^sha256:[a-fA-F0-9]{64}$/.test(argsHash)) {
      throw new Error('LectureAI 任务步骤缺少有效回执标识。');
    }
    let actionId = baseActionId;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      let started;
      try {
        started = await this._taskActionRequest('task_action_start', {
          runId,
          actionId,
          argsHash,
          tool: action.tool,
          actionMode: action.tool === 'render_template' ? action.mode || null : null,
          expectedDeckRevision,
        });
      } catch (error) {
        if (error?.details?.code === 'ACTION_PREVIOUSLY_FAILED') {
          actionId = `${baseActionId}:retry:${attempt + 1}`;
          continue;
        }
        throw error;
      }
      const decision = String(started?.decision || '');
      const serverReceipt = started?.receipt || {};
      if (decision === 'replay' || serverReceipt.status === 'succeeded') {
        return {
          ok: true,
          replayed: true,
          actionId,
          argsHash,
          result: serverReceipt.result || {},
          newDeckRevision: serverReceipt.newDeckRevision || null,
        };
      }
      if (decision === 'failed') {
        actionId = `${baseActionId}:retry:${attempt + 1}`;
        continue;
      }
      if (!['new', 'reclaimed', 'claimed'].includes(decision) || !serverReceipt.claimToken) {
        throw new Error('LectureAI 未能取得任务步骤执行权。');
      }
      let local;
      try {
        local = await this._rpc('execute-task-action', {
          runId,
          action,
          taskSpec,
          envelope: { actionId, argsHash, expectedDeckRevision },
        });
      } catch (error) {
        local = {
          ok: false,
          actionId,
          argsHash,
          error: { code: error?.code || 'CLIENT_UNAVAILABLE', category: 'client_unavailable', retryable: true, userMessage: this._modelErrorMessage(error) },
        };
      }
      const ok = local?.ok === true;
      const result = ok && local?.result && typeof local.result === 'object' ? local.result : {};
      const newDeckRevision = ok ? (local?.newDeckRevision || result.newDeckRevision || null) : null;
      const errorCode = ok ? null : String(local?.error?.code || 'CLIENT_TOOL_FAILED');
      const clientReceipt = {
        ok,
        actionId,
        argsHash,
        result,
        newDeckRevision,
        errorCode,
      };
      try {
        const finished = await this._taskActionRequest('task_action_finish', {
          runId,
          actionId,
          argsHash,
          ok,
          result,
          newDeckRevision,
          errorCode,
          claimToken: serverReceipt.claimToken,
        });
        const receipt = finished?.receipt || {};
        return {
          ok,
          actionId,
          argsHash,
          result: receipt.result || result,
          newDeckRevision: receipt.newDeckRevision || newDeckRevision,
          error: ok ? null : local?.error,
        };
      } catch (finishError) {
        // The local mutation has already happened. Reconcile the durable
        // local receipt rather than executing it again on reconnect.
        if (ok && newDeckRevision) {
          const reconciled = await this._taskActionRequest('task_action_reconcile', {
            runId,
            actionId,
            argsHash,
            currentDeckRevision: newDeckRevision,
            receipt: clientReceipt,
            claimToken: serverReceipt.claimToken,
          });
          const receipt = reconciled?.receipt || {};
          return { ok: true, actionId, argsHash, result: receipt.result || result, newDeckRevision: receipt.newDeckRevision || newDeckRevision };
        }
        throw finishError;
      }
    }
    throw new Error('LectureAI 任务步骤此前失败，已改用新的恢复步骤仍未完成。');
  },

  _taskJournalInvoke(command, payload = {}) {
    if (!this._deckPath || !window.__TAURI__?.core?.invoke) return Promise.reject(new Error('课件窗口暂时不可用'));
    return window.__TAURI__.core.invoke(command, { ...(payload || {}), folderPath: this._deckPath });
  },

  _featureEnabled(name) {
    return this._featureFlagsLoaded && this._featureFlags?.[String(name)] === true;
  },

  _nativeTaskRolloutEnabled() {
    return this._featureEnabled('lectureai_native_tools_required')
      && this._featureEnabled('lectureai_action_receipts_v1');
  },

  async _loadLectureAiFeatures(force = false) {
    const selected = this.selectedConfig || this.aiConfig || {};
    const token = String(selected.aiApiKey || '').trim();
    if (selected.aiProvider !== 'lectureai' || !token || !window.__TAURI__?.core?.invoke) {
      this._featureFlags = Object.create(null);
      this._featureFlagsLoaded = true;
      this._featureFlagsToken = token;
      return this._featureFlags;
    }
    if (!force && this._featureFlagsLoaded && this._featureFlagsToken === token) return this._featureFlags;
    this._featureFlags = Object.create(null);
    this._featureFlagsLoaded = false;
    this._featureFlagsToken = token;
    try {
      const response = await window.__TAURI__.core.invoke('auth_api_request', {
        action: 'features', payload: {}, token,
      });
      this._featureFlags = response?.ok && response?.data?.flags && typeof response.data.flags === 'object'
        ? { ...response.data.flags }
        : Object.create(null);
    } catch (_) {
      this._featureFlags = Object.create(null);
    }
    this._featureFlagsLoaded = true;
    return this._featureFlags;
  },

  async _handleTaskCardAction(action) {
    const run = this._taskCardRun;
    if (!run?.runId || this.busy) return;
    try {
      if (action === 'details') {
        const detail = await this._taskJournalInvoke('ppte_task_journal_read', { runId: run.runId });
        const count = Array.isArray(detail?.receipts) ? detail.receipts.length : 0;
        this._log('sys', `${this._taskStatusLabel(run.status)} · 已记录 ${count} 个任务步骤`, { skipRecord: true });
        return;
      }
      if (action === 'clear-history') {
        const confirm = window.confirm;
        if (typeof confirm === 'function' && !confirm('清理已结束的助教任务恢复副本？正在运行的任务不会被删除。')) return;
        const result = await this._taskJournalInvoke('ppte_task_journal_clear', { keepRecent: 0 });
        const removed = Array.isArray(result?.removed) ? result.removed.length : 0;
        this._log('sys', removed ? `已清理 ${removed} 条已结束任务历史` : '没有可清理的已结束任务历史', { skipRecord: true });
        await this._loadTaskJournal();
        return;
      }
      if (action === 'revert') {
        const revision = this.manifest?.deckRevision?.deckHash || null;
        const result = await this._rpc('task-journal-revert', { runId: run.runId, expectedDeckRevision: revision });
        const localRun = result || { ...run, status: 'reverted' };
        this._renderTaskCard(localRun, this._taskCardSpec);
        await this._refreshContext();
        const synced = await this._retryPendingTaskSync(localRun);
        this._log('sys', synced
          ? '任务已撤销，课件已恢复到任务开始前的版本'
          : '课件已恢复到任务开始前的版本，任务状态将在连接恢复后自动同步', { skipRecord: true });
        return;
      }
      const server = await this._taskApi('task_get', { runId: run.runId });
      if (!server?.ok) throw new Error('LectureAI 暂时无法读取任务状态。');
      const spec = this._taskCardSpec || run.taskSpec || server.data?.taskSpec;
      if (!spec) throw new Error('任务合同不可恢复，请重新提交任务。');
      this._taskCardSpec = spec;
      await this._taskApi('task_resume', { runId: run.runId });
      if (action === 'retry') {
        const plan = this.manifest?.deckPlan?.plan || run.plan;
        if (!plan?.slides?.length) throw new Error('未找到可恢复的课件规划。');
        const listed = run.failedPages || run.failed_pages || [];
        const failed = new Set((listed.length ? listed : this._harnessRepairPages(plan, plan?.execution?.validation || {})).map(Number));
        if (!failed.size) throw new Error('没有可定位的失败页面，请使用“继续”重新执行验收。');
        plan.execution = { ...(plan.execution || {}), status: 'repairing', completedPages: (plan.execution?.completedPages || []).filter(page => !failed.has(Number(page))), nextPage: null };
        this._activeTask = { ...(this._activeTask || {}), taskSpec: spec, runId: run.runId, plan, userInstruction: run.userInstruction || spec.userInstruction || spec.userFacingGoal || '继续处理课件' };
        await this._runPlannedHarness(plan, this._activeTask.userInstruction);
      } else {
        await this._runLectureAiNativeTask(spec, run.userInstruction || spec.userInstruction || spec.userFacingGoal || '继续处理课件', run);
      }
    } catch (error) {
      this._log('err', this._modelErrorMessage(error));
    }
  },

  // ---- session persistence (per deck, <deck>/.lectureai/workbench-sessions.json) ----
  // Each workbench open starts a new conversation; the last 10 are kept on disk.
  _sessionsFilePath() {
    return this._deckPath ? `${this._deckPath}/.lectureai/workbench-sessions.json` : null;
  },

  async _readSessionStore() {
    const filePath = this._sessionsFilePath();
    if (!filePath || !window.__TAURI__) return [];
    try {
      const raw = await window.__TAURI__.core.invoke('read_text_file', { filePath });
      const data = JSON.parse(raw);
      return Array.isArray(data?.sessions) ? data.sessions : [];
    } catch (_) {
      return []; // no saved sessions is normal
    }
  },

  async _beginSession() {
    const token = ++this._restoreToken;
    this._sessionId = `s${Date.now().toString(36)}`;
    this._sessionStartedAt = new Date().toISOString();
    const past = await this._readSessionStore();
    if (token !== this._restoreToken) return; // deck switched while reading
    this._sessions = past;
    this._renderEmpty();
    if (past.some(s => (s?.transcript || []).length)) {
      this._log('sys', `本课件有历史会话 · 输入 /resume 可恢复最近 ${Math.min(past.length, 10)} 次对话`, { skipRecord: true });
    }
  },

  _scheduleSessionSave() {
    if (!this._sessionsFilePath()) return;
    clearTimeout(this._sessionSaveTimer);
    this._sessionSaveTimer = setTimeout(() => this._saveSession(), 800);
  },

  async _saveSession() {
    const filePath = this._sessionsFilePath();
    if (!filePath || !window.__TAURI__ || !this._sessionId) return;
    // A brand-new window that never produced content leaves no trace on disk.
    const known = (this._sessions || []).some(s => s.id === this._sessionId);
    if (!this._transcript.length && !known) return;
    // Bound the log so long-lived decks do not grow the file without limit.
    if (this._transcript.length > 400) this._transcript = this._transcript.slice(-400);
    const preview = String(this._transcript.find(i => i.t === 'user')?.text || '').slice(0, 60);
    const entry = {
      id: this._sessionId,
      startedAt: this._sessionStartedAt,
      updatedAt: new Date().toISOString(),
      preview,
      history: this.history,
      transcript: this._transcript,
    };
    const others = (this._sessions || []).filter(s => s.id !== entry.id);
    this._sessions = [entry, ...others]
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, 10);
    try {
      await window.__TAURI__.core.invoke('write_text_file', {
        filePath,
        content: JSON.stringify({ version: 1, sessions: this._sessions }),
      });
    } catch (e) {
      console.error('workbench session save failed', e);
    }
  },

  // /resume — list past sessions and load the picked one into this window.
  async _resume() {
    if (!this._deckPath) {
      this._log('sys', '未连接课件，没有可恢复的会话');
      return;
    }
    this._sessions = await this._readSessionStore();
    const sessions = this._sessions
      .filter(s => s.id !== this._sessionId && (s?.transcript || []).length)
      .slice(0, 10);
    if (!sessions.length) {
      this._log('sys', '没有可恢复的历史会话');
      return;
    }
    this._log('sys', `最近 ${sessions.length} 次会话 · 点击恢复：`, { skipRecord: true });
    const m = document.getElementById('wb-messages');
    if (!m) return;
    sessions.forEach(session => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'wb-recent-item';
      const time = this._sessionTimeLabel(session.updatedAt || session.startedAt);
      const lines = (session.transcript || []).length;
      btn.innerHTML = `<span class="wb-recent-title"></span><span class="wb-recent-path"></span>`;
      btn.children[0].textContent = session.preview || '（无标题对话）';
      btn.children[1].textContent = `${time} · ${lines} 条记录`;
      btn.onclick = () => this._loadSession(session);
      m.appendChild(btn);
    });
    this._scroll();
  },

  _sessionTimeLabel(iso) {
    const date = new Date(iso || '');
    if (Number.isNaN(date.getTime())) return '时间未知';
    return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  },

  _loadSession(session) {
    if (!session?.id) return;
    this._sessionId = session.id;
    this._sessionStartedAt = session.startedAt || null;
    this.history = Array.isArray(session.history) ? session.history : [];
    this._transcript = Array.isArray(session.transcript) ? session.transcript : [];
    const m = document.getElementById('wb-messages');
    if (m) m.innerHTML = '';
    for (const item of this._transcript) {
      if (item?.t === 'ai' && item.md) this._appendAssistantMarkdown(item.md, { skipRecord: true });
      else if (item?.text) this._log(item.t, item.text, { skipRecord: true });
    }
    this._log('sys', `已恢复 ${this._sessionTimeLabel(session.updatedAt || session.startedAt)} 的会话 · ${this._transcript.length} 条记录，可直接继续提问`, { skipRecord: true });
  },

  _renderPickCourse() {
    const m = document.getElementById('wb-messages');
    if (!m) return;
    m.innerHTML = `<div class="term-empty">
      <span class="term-empty-accent">LectureAI 助教</span> · 课件工作台<br>
      未连接课件。选择一个 PPTE 课件开始对话。<br>
      <div class="wb-pick-actions">
        <button class="wb-pick-btn" id="wb-pick-ppte">从本地磁盘选择</button>
        <button class="wb-pick-btn wb-pick-btn-secondary" id="wb-pick-recent">选择打开过的 PPTE</button>
      </div>
      <div class="wb-recent-list" id="wb-recent-list"></div>
    </div>`;
    const btn = document.getElementById('wb-pick-ppte');
    if (btn) btn.onclick = () => {
      window.__TAURI__.event.emit('wb-request', { type: 'pick-ppte' });
    };
    const recentBtn = document.getElementById('wb-pick-recent');
    if (recentBtn) recentBtn.onclick = () => this._renderRecentPptePicker();
  },

  // List PPTEs opened before (from the main window's recentPpte config) and let
  // the user connect one directly, without going through the disk picker.
  async _renderRecentPptePicker() {
    const box = document.getElementById('wb-recent-list');
    if (!box) return;
    box.innerHTML = '<div class="wb-recent-empty">加载中…</div>';
    const result = await this._rpc('recent-ppte');
    const items = Array.isArray(result?.items) ? result.items : [];
    if (!items.length) {
      box.innerHTML = '<div class="wb-recent-empty">暂无打开过的 PPTE</div>';
      return;
    }
    box.innerHTML = items.map(item => `
      <button type="button" class="wb-recent-item" data-path="${this._escape(item.path)}">
        <span class="wb-recent-title">${this._escape(item.title || '未命名')}</span>
        <span class="wb-recent-path">${this._escape(item.path)}</span>
      </button>
    `).join('');
    box.querySelectorAll('.wb-recent-item').forEach(btn => {
      btn.onclick = () => {
        box.innerHTML = '<div class="wb-recent-empty">正在打开…</div>';
        window.__TAURI__.event.emit('wb-request', { type: 'pick-ppte', payload: { path: btn.dataset.path } });
      };
    });
  },

  _applySelectedModel(id) {
    this.selectedConfig = this.providers.find(p => p.id === id)?.config || null;
    this._featureFlagsLoaded = false;
    this._featureFlags = Object.create(null);
    this._loadLectureAiFeatures().then(() => this._loadTaskJournal()).catch(() => {});
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
    this._transcript = [];
    this._renderEmpty();
    this._saveSession();
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
    this._scheduleSessionSave();
    this._log('sys', `上下文已压缩 · 移除 ${removed} 条较早消息，保留最近 ${recent.length} 条`);
  },

  _renderEmpty() {
    const m = document.getElementById('wb-messages');
    if (m) m.innerHTML = `<div class="wb-empty">课件助教对话窗口。<br>输入 / 选择内置命令，@ 定位页面，<br>$ 启用已导入的技能。<br>改完自动保存并在主窗口预览。</div>`;
  },

  // ---- slash command discovery ----
  _updateInputPicker() {
    const input = document.getElementById('wb-input');
    const menu = document.getElementById('wb-slash-menu');
    if (!input || !menu || !window.PpteSlashCommands) return;
    const commandResult = window.PpteSlashCommands.search(input.value, input.selectionStart);
    const mentionFiles = this._mentionableFiles();
    const pageResult = window.PpteSlashCommands.searchPages(input.value, input.selectionStart, this.manifest?.slides || [], mentionFiles);
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
        ? `选择页面或文件 · ${result.items.length}/${(this.manifest?.slides?.length || 0) + mentionFiles.length} 项`
        : `斜杠命令 · ${result.items.length}/${window.PpteSlashCommands.commands.length} 项`);
    const rows = mode === 'skill'
      ? result.items.map((skill, index) => `
        <button type="button" class="slash-item${index === this._slashIndex ? ' active' : ''}" data-skill="${this._escape(skill.name)}" role="option" aria-selected="${index === this._slashIndex}">
          <span class="slash-name">$${this._escape(skill.name)}</span>
          <span class="slash-command-copy"><span class="slash-desc">${this._escape(skill.description)}</span><span class="skill-source">${this._escape(skill.sourceLabel || skill.source)}</span></span>
        </button>`).join('')
      : (mode === 'page'
      ? result.items.map((item, index) => item.kind === 'file' ? `
        <button type="button" class="slash-item slash-page-item${index === this._slashIndex ? ' active' : ''}" data-file="${this._escape(item.file)}" role="option" aria-selected="${index === this._slashIndex}">
          <span class="slash-page-number">文件</span>
          <span class="slash-page-copy"><span class="slash-page-title"><span class="slash-name">@ ${this._escape(item.file)}</span><span class="slash-separator"> - </span>${this._escape(item.label)}</span><span class="slash-desc">file</span></span>
        </button>` : `
        <button type="button" class="slash-item slash-page-item${index === this._slashIndex ? ' active' : ''}" data-page="${item.page}" role="option" aria-selected="${index === this._slashIndex}">
          <span class="slash-page-number">第 ${item.page} 页</span>
          <span class="slash-page-copy"><span class="slash-page-title"><span class="slash-name">@ ${this._escape(item.file || `slide${item.page}.html`)}</span><span class="slash-separator"> - </span>${this._escape(item.title)}</span><span class="slash-desc">${this._escape(item.slideType)}</span></span>
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
        else if (button.dataset.file) this._applyFileSuggestion(button.dataset.file);
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
      else if (this._pickerMode === 'page') {
        if (item.kind === 'file') this._applyFileSuggestion(item.file);
        else this._applyPageSuggestion(item.page);
      }
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

  // Deck files that can be @-mentioned in the workbench input
  _mentionableFiles() {
    if (!this.manifest?.slides?.length) return [];
    return [{ file: 'outline.md', label: '课件大纲' }];
  },

  _applyFileSuggestion(file) {
    const input = document.getElementById('wb-input');
    if (!input || !window.PpteSlashCommands) return;
    const applied = window.PpteSlashCommands.applyFileSuggestion(input.value, input.selectionStart, file);
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
        .map(role => `- ${role.slideType}${role.variantId ? `/${role.variantId}` : ''}: ${role.page != null ? `起始第${role.page}页` : '不可变母版快照'}「${role.title || role.file}」${role.stylesheets?.length ? `，样式 ${role.stylesheets.join('、')}` : ''}`)
        .join('\n');
      ctx += `\n\n模板蓝图：${blueprint.name || '默认模板'}（${blueprint.isStarter ? '尚未初始化' : '已用于当前课件'}）\n${roles}`;
    }
    if (blueprint?.isStarter) {
      ctx += `\n\n这是客户端刚创建的“角色母版起始课件”，当前 ${this.manifest.slides.length} 页是封面、目录、章节过渡、一个或多个正文变体、结束的样式样例，不是已经完成的课件。收到“制作 N 页课件”时，最终总页数必须恰好为 N，不是在现有起始页后再追加 N 页。先按主题规划完整页序，再改造起始页并按需新增页面。封面、目录、章节过渡、正文、结束必须使用各自角色母版；正文有多个 variantId 时，按内容结构选择 template_variant。保留原模板的 stylesheet 链接、背景资源、布局容器和配色，不得把正文页样式套到结构页。新增页面优先用 insert_slide 的 template_role 和 template_variant 克隆不可变母版快照，再用 write_slide 填充内容。章节过渡页必须放在对应章节内容之前，结束页必须是最后一页。`;
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
- write_outline {content}：把章纲（Markdown）写入课件的 outline.md；用户要求根据现有页面整理/保存大纲时使用，整套生成前也可先把章纲落成文件
- search_icons {query?}：检索云端图标库（AI 公司/工具 logo，支持中文别名，如“豆包”“英伟达”）；省略 query 列出全部
- use_icon {file}：把图标库中的图标下载进当前课件 resources/ 目录并返回引用路径；页面需要 logo 时先 search_icons 拿到 file，再 use_icon 下载后在 HTML 里用相对路径引用
- search_design_examples {content_kind?, layout_family?, density?, motion?, exclude?, limit?}：检索真实 HTML/CSS 设计案例
- render_template {template_id, template_version?, template_variant?, payload, mode, page?, after?, title?, slide_type?, note?}：正文页优先使用服务端模板；replace 提供 page，insert 可提供 after
- finalize_deck {plan?}：按已保存蓝图整理最终页序，移除不属于成品的起始占位页；只改 manifest，不删除磁盘源文件
- inspect_slides {check, pages?}：确定性检查页面；check 为 font/overflow/density/card/copy/motion/concept-animation/quality，pages 省略时检查整套；concept-animation 同时检查标准分步结构、字体、溢出和学员文案
- load_skill {skill_id}：加载一个可用 SKILL 的完整 SKILL.md；仅在任务与 description 明确匹配时调用
- read_skill_resource {skill_id, path}：读取已启用 skill 列出的 references/scripts 文本；禁止读取 skill 目录之外的文件
- validate_deck {}：检查页数、结束页、重复布局、卡片占比、动画覆盖与所有单页规范
plan 至少包含 targetSlideCount、visualSystem、slides；每页包含 page、role、title、contentKind、layoutFamily、componentIds、motion、visualIntent，可选 templateVariant 对应当前课件母版的正文变体。每个正文页还必须包含 narrative：buildsOn、learningGoal、keyTakeaway、leadsTo；相邻正文页的前页 leadsTo 与后页 buildsOn 必须是完全相同的短句，形成从已知到未知的教学叙事链。正文页在规划阶段就指定注册 templateId、templateVersion；任一模板最多占正文 25%，同一模板在连续三个正文页窗口内只能出现一次。普通正文及已覆盖的复杂场景优先 render_template，只提交结构化 payload；封面、目录、章节、结束页只做角色母版安全填充，不自由重写结构或样式，只有无法由模板表达的特殊正文页才自由写页。不得读取或索取模板源码。相邻正文页不得重复主构图，正文超过 8 页至少 6 种主布局，卡片类不超过正文 25%，12 页以上至少 3 页有意义动画。整套任务最终必须 validate_deck 通过。

用户指定的最终页数必须与 targetSlideCount 和 slides 数量完全一致，五类母版页也计入总数。默认情况下，30 页及以内采用单段连续叙事，不生成目录页和章节过渡页；超过 30 页才默认分为 2 章，可保留 1 个目录页和 2 个章节过渡页，保证每章至少约 15 页。只有用户明确下达“分成 N 章、保留/增加目录页或章节过渡页”等指令时才覆盖默认规则；仅提到章节问题、重写课件或内容中包含章节不算明确分章。starter 中的 catalog、chapter 只是角色母版占位：若成品规划不需要它们，必须在 plan 中将对应页标为 content，客户端才会允许转为正文。cover、catalog、chapter、finish 在保留原角色时必须保留角色母版 CSS、背景和结构；目录只替换标题与目录条目，不得覆盖 catalog.css 的目录组件样式；背景已有文字的 finish 页保持可见正文为空。正文和表格正文均不低于 1.8vw，1.5vw 仅限不超过 8 个字的短标签；正文统一使用 visualSystem 的深色 text/subtext，禁止模板自行使用浅灰正文。

扩展页面参数：write_slide 可同时提供 title 和 slide_type；insert_slide 可提供稳定的 template_role（cover/catalog/chapter/content/finish）、template_variant 和兼容参数 template_page。例：克隆章节母版到第6页后：{"tool":"insert_slide","after":6,"template_role":"chapter","slide_type":"chapter","title":"第二章"}；选择正文图文变体可加 "template_variant":"visual"。当存在 finish 页时，客户端会自动把普通新增页放到 finish 页之前；reorder_slides 只能重排现有全部页面，不能用于删除；整套生成完成后调用 finalize_deck 确定性整理成品页序。`;
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
      ? `用户要求最终 ${target} 页。当前 ${this.manifest.slides.length} 页都是角色母版起始页，必须计入最终 ${target} 页，因此只需净新增 ${Math.max(0, target - this.manifest.slides.length)} 页，完成后核对总页数恰好为 ${target}。`
      : `如果用户指定总页数，该数字包含当前 ${this.manifest.slides.length} 个角色母版起始页，完成后必须核对最终总页数。`;
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
    if (/(?:重新)?规划.{0,12}(?:课件|课件内容)|(?:课件|PPT|幻灯片).{0,12}(?:重新规划|重写|重做|改造)/i.test(value)) return true;
    if (/(?:目录|章节|母版|模板).{0,18}(?:多余|残留|不应|不该).{0,12}(?:出现|保留)?/i.test(value)) return true;
    return /(?:检查|校验|审查).{0,8}(?:一下|整个|整套|整体)?\s*(?:课件|PPT|幻灯片)|(?:课件|PPT|幻灯片).{0,8}(?:问题|检查|校验)/i.test(value);
  },

  _requiresDeckPlan(input) {
    const value = String(input || '');
    if (/(?:创建|制作|生成|重做|改造).{0,16}(?:整套|课件|PPT|幻灯片|\d{1,2}\s*页)/i.test(value)) return true;
    if (/(?:整套|整体|全部|所有|逐页).{0,10}(?:修改|重写|优化|生成)/i.test(value)) return true;
    return /(?:重新)?规划.{0,12}(?:课件|课件内容)|(?:课件|PPT|幻灯片).{0,12}(?:重新规划|重写|重做|改造)/i.test(value);
  },

  _isOutlineOnlyTask(input) {
    const value = String(input || '');
    if (!/(?:大纲|章纲|outline\.md|outline)/i.test(value)) return false;
    return !/(?:创建|制作|生成|重做|改造|重写).{0,16}(?:课件|PPT|幻灯片)|(?:课件|PPT|幻灯片).{0,16}(?:创建|制作|生成|重做|改造|重写)/i.test(value);
  },

  _taskMentions(input) {
    const pages = [];
    for (const match of String(input || '').matchAll(/(?:^|\s)[@＠](\d{1,2})(?=\s|$|[，。、,.；;])/gu)) {
      const page = Number(match[1]);
      if (page >= 1 && page <= Number(this.manifest?.slides?.length || 0) && !pages.includes(page)) pages.push(page);
    }
    return {
      pages,
      outline: /[@＠](?:大纲|outline(?:\.md)?)(?=\s|$|[，。、,.；;])/iu.test(String(input || '')),
    };
  },

  _taskSpecContext(spec) {
    if (!spec) return '';
    return `[LectureAI 任务合同]\n${JSON.stringify({
      runId: spec.runId,
      intent: spec.intent,
      scope: spec.scope,
      targets: spec.targets,
      executionStrategy: spec.executionStrategy,
      requiresDeckPlan: spec.requiresDeckPlan,
      userFacingGoal: spec.userFacingGoal,
      acceptanceCriteria: spec.acceptanceCriteria,
    })}\n任务类型、范围和验收条件由服务端确定；只能在 targets 允许的范围内行动。`;
  },

  async _resolveLectureAiTask(input, slash = null) {
    const protocol = window.LectureAiTaskProtocol;
    if (!protocol) throw new Error('当前客户端缺少 LectureAI 任务协议，请升级后重试。');
    const selected = this.selectedConfig || this.aiConfig || {};
    const token = String(selected.aiApiKey || '').trim();
    if (!token) throw new Error('登录状态已失效，请重新登录后使用 LectureAI。');
    const revision = String(this.manifest?.deckRevision?.deckHash || '');
    const manifestDeckId = String(this.manifest?.deckId || this.manifest?.manifest?.deckId || '').trim();
    // Keep this fallback identical to _nativeTaskDeckId so cancellation and
    // progress requests address the same server-side task scope.
    const derivedDeckId = /^sha256:[a-fA-F0-9]{32,64}$/.test(revision) ? `deck-${revision.slice(7, 47)}` : null;
    const resumePlan = this.manifest?.deckPlan?.plan;
    const resumable = ['running', 'paused', 'failed', 'repairing', 'needs-repair'].includes(resumePlan?.execution?.status)
      || ['ready', 'running', 'paused', 'failed', 'repairing', 'needs_repair'].includes(String(this._taskCardRun?.status || ''));
    const resumeRunId = this._isHarnessResumeRequest(input) && resumable
      ? String(resumePlan?.taskSpecRef?.runId || resumePlan?.execution?.runId || this._taskCardRun?.runId || '').trim() || protocol.newRunId()
      : null;
    const payload = {
      instruction: input,
      clientKind: 'desktop',
      protocolVersion: protocol.CONTRACT.protocolVersion,
      clientVersion: '2.2.3',
      deckId: manifestDeckId || derivedDeckId,
      deckRevision: revision || null,
      slides: (this.manifest?.slides || []).slice(0, 60).map((slide, index) => ({
        id: slide.id || null,
        page: index + 1,
        title: String(slide.title || '').slice(0, 200),
        role: String(slide.slideType || slide.slide_type || 'content').slice(0, 30),
      })),
      currentPage: this.currentPage,
      mentions: this._taskMentions(input),
      slashCommand: slash?.command?.name || null,
      hasOutline: !!String(this.manifest?.outline || '').trim(),
      isStarter: this.manifest?.templateBlueprint?.isStarter === true,
      templateRoles: [...new Set((this.manifest?.templateBlueprint?.roles || []).map(item => item.slideType).filter(Boolean))],
      capabilities: [...protocol.CONTRACT.capabilities],
      resumeRunId,
      failedPages: Array.isArray(resumePlan?.execution?.failedPages) ? resumePlan.execution.failedPages : [],
    };
    const response = await window.__TAURI__.core.invoke('auth_api_request', {
      action: 'task_resolve', payload, token,
    });
    if (!response?.ok) {
      const detail = response?.data?.detail;
      const structured = detail && typeof detail === 'object' ? detail : response?.data;
      throw new Error(protocol.friendlyError(structured || { userMessage: String(detail || 'LectureAI 暂时无法识别任务，请稍后重试。') }).userMessage);
    }
    const spec = response?.data?.taskSpec;
    const checked = protocol.validateTaskSpec(spec);
    if (!checked.valid) throw new Error(`LectureAI 返回的任务合同无效：${checked.errors.join('；')}`);
    return spec;
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
    const fetchOutline = async () => {
      if (seen.has('file:outline.md')) return null;
      seen.add('file:outline.md');
      const outline = await this._rpc('get-outline');
      if (!outline) return '@课件大纲（outline.md）：当前还没有大纲内容。';
      return `@课件大纲（outline.md）当前内容：\n\`\`\`markdown\n${outline}\n\`\`\``;
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

    // @title (substring) or @大纲 / @outline.md (deck outline file)
    const titleMatches = [...input.matchAll(/@([^\s@，。、,]+)/g)];
    for (const m of titleMatches) {
      const frag = m[1];
      const lower = frag.toLowerCase();
      if (lower === 'outline' || lower === 'outline.md' || frag === '大纲' || frag === '章纲') {
        const part = await fetchOutline();
        if (part) {
          ctxParts.push(part);
          input = input.replace(`@${frag}`, '课件大纲');
        }
        continue;
      }
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
      else if (slash.command.localAction === 'resume') this._resume();
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
    let taskSpec = null;
    if (cfg.aiProvider === 'lectureai') {
      await this._loadLectureAiFeatures();
      const resumePlan = this.manifest?.deckPlan?.plan;
      const resumeRequested = this._isHarnessResumeRequest(input);
      const existingV2Run = Boolean(resumeRequested && (
        resumePlan?.taskSpecRef?.runId
        || resumePlan?.execution?.runId
        || this._taskCardRun?.runId
      ));
      if (this._featureEnabled('lectureai_task_spec_v2') || existingV2Run) {
      try {
        taskSpec = await this._resolveLectureAiTask(input, slash);
      } catch (error) {
        this._appendUser(input, []);
        this._appendAssistantMarkdown(`### 无法开始任务\n\n${this._modelErrorMessage(error)}`);
        return;
      }
      if (taskSpec.requiresClarification) {
        this._appendUser(input, []);
        this._appendAssistantMarkdown(taskSpec.clarificationQuestion || '请再说明希望 LectureAI 修改哪些页面，以及最终需要保留什么内容。');
        if (inputEl) inputEl.value = '';
        this._autoResizeInput();
        this._hideSlashMenu();
        return;
      }
        if (existingV2Run || this._nativeTaskRolloutEnabled()) {
          this._appendUser(input, []);
          if (inputEl) inputEl.value = '';
          this._autoResizeInput();
          this._hideSlashMenu();
          await this._runLectureAiNativeTask(taskSpec, input);
          return;
        }
      }
    }
    const resumablePlan = this.manifest?.deckPlan?.plan;
    const executionStatus = resumablePlan?.execution?.status;
    const resumeRequested = taskSpec ? taskSpec.intent === 'resume_run' : this._isHarnessResumeRequest(input);
    if (resumeRequested && ['running', 'paused', 'failed', 'repairing', 'needs-repair'].includes(executionStatus)) {
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
    const outlineOnly = taskSpec ? taskSpec.intent === 'outline_write' : (slash ? false : this._isOutlineOnlyTask(input));
    const outlineBoundary = outlineOnly
      ? '[大纲任务边界]\n本轮只整理并写入 outline.md。可读取现有页面，但不得规划、插入、重排、渲染或改写任何页面；完成前必须调用 write_outline。'
      : '';
    const taskInitialization = [this._taskInitialization(input), outlineBoundary].filter(Boolean).join('\n\n');
    const deckLevel = taskSpec ? taskSpec.scope === 'deck' : (slash ? false : this._isDeckLevelTask(input));
    const requiresPlan = taskSpec ? taskSpec.requiresDeckPlan === true : (slash ? false : this._requiresDeckPlan(input));
    const taskPages = taskSpec?.targets?.allowInsert ? [] : (taskSpec?.targets?.pages || []);
    this._activeTask = {
      deckLevel,
      requiresPlan,
      planSaved: !requiresPlan,
      deckValidated: false,
      commandCheck: slash?.command?.check || null,
      commandPages: slash?.pages?.length ? slash.pages : taskPages,
      commandInspected: false,
      commandPassed: false,
      requestedSlideCount: this._requestedSlideCount(input),
      explicitSections: this._explicitSectionRequest(input),
      continuousSections: this._continuousSectionRequest(input),
      plan: null,
      harnessEnabled: requiresPlan,
      outlineOnly,
      outlineSaved: !outlineOnly,
      userInstruction: input,
      taskSpec,
      runId: taskSpec?.runId || null,
    };
    this._stopRequested = false;
    this._appendUser(input, mentioned);
    if (enabledSkills.length) this._log('sys', `本轮启用技能 · ${enabledSkills.join('、')}`);
    const additions = [this._taskSpecContext(taskSpec), skillContext, commandContext, taskInitialization, deckLevel ? this._outlinePromptBlock() : '', slash?.instruction || ''].filter(Boolean).join('\n\n');
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
          // The model emitted a bare JSON tool payload without the ```action
          // fence (Stepfun does this more often than DeepSeek). Without this
          // branch the turn would end as if the plan had been applied.
          if (this._hasBareToolPayload(text)) {
            recoveryRounds += 1;
            if (recoveryRounds > 3) throw new Error('模型连续 3 次未按规定格式调用工具，任务已停止，请重试');
            this.history.push({
              role: 'user',
              content: '[工具协议纠正] 你刚才输出了裸 JSON 工具调用，但没有放在 ```action 代码块里，系统无法解析执行。请重新输出同一个工具调用，完整包裹在 ```action 与 ``` 之间。',
            });
            if (this._modelStatusEl) {
              this._modelStatusEl.dataset.summary = '正在补发工具调用';
              this._modelStatusEl.textContent = `第 ${rounds} 轮 · 正在补发工具调用 · ${this._duration(turnStartedAt)}`;
            }
            continue;
          }
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
          if (this._activeTask?.outlineOnly && !this._activeTask.outlineSaved) {
            recoveryRounds += 1;
            if (recoveryRounds > 3) throw new Error('课件大纲连续 3 次未写入，任务已停止，请重试');
            this.history.push({
              role: 'user',
              content: '[大纲完成门禁] 本轮只需要保存课件大纲。请立即调用 write_outline，把最终 Markdown 写入 outline.md，不要生成或修改页面。',
            });
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
          if (this._streamBubble) {
            // The round streamed into a live bubble: finalize it in place.
            const el = this._streamBubble;
            this._streamBubble = null;
            el.classList.remove('wb-streaming');
            const finalText = this._userFacingText(this._stripActions(text));
            if (window.marked) {
              el.innerHTML = this._sanitizeHtml(window.marked.parse(finalText));
            } else {
              el.textContent = finalText;
            }
            this._scroll();
          } else {
            this._appendAssistantMarkdown(this._stripActions(text));
          }
          this._log('sys', `任务结束 · ${rounds} 轮模型响应 · ${toolCalls} 次工具调用 · ${this._duration(turnStartedAt)}`);
          break;
        }
        this._removeStreamBubble();
        const results = [];
        let terminalToolFailure = '';
        for (const a of actions) {
          if (this._stopRequested) break;
          const spec = this._activeTask?.taskSpec;
          const mutationTools = ['write_outline', 'render_template', 'write_slide', 'insert_slide', 'delete_slide', 'reorder_slides', 'finalize_deck'];
          if (spec?.executionStrategy === 'direct_reply' && mutationTools.includes(a.tool)) {
            results.push('[任务边界] 本轮只回答问题，不允许修改课件。');
            break;
          }
          if (spec && a.tool === 'write_outline' && spec.targets?.outline !== true) {
            results.push('[任务边界] 本轮未授权修改课件大纲。');
            break;
          }
          if (spec && a.tool === 'insert_slide' && spec.targets?.allowInsert !== true) {
            results.push('[任务边界] 本轮未授权插入页面。');
            break;
          }
          if (spec && a.tool === 'delete_slide' && spec.targets?.allowDelete !== true) {
            results.push('[任务边界] 本轮未授权删除页面。');
            break;
          }
          if (spec && a.tool === 'render_template' && (a.mode || 'replace') === 'insert' && spec.targets?.allowInsert !== true) {
            results.push('[任务边界] 本轮未授权插入页面。');
            break;
          }
          if (spec && a.tool === 'reorder_slides' && spec.targets?.allowReorder !== true) {
            results.push('[任务边界] 本轮未授权重排页面。');
            break;
          }
          if (spec && a.tool === 'finalize_deck' && spec.targets?.allowDelete !== true && spec.targets?.allowReorder !== true) {
            results.push('[任务边界] 本轮未授权整理或删除页面。');
            break;
          }
          if (this._activeTask?.outlineOnly && !['read_slide', 'write_outline', 'load_skill', 'read_skill_resource'].includes(a.tool)) {
            results.push(`[大纲任务边界] 本轮只允许读取页面并写入 outline.md，拒绝执行 ${this._toolDisplayName(a.tool)}。`);
            break;
          }
          if (this._activeTask?.requiresPlan && ['render_template', 'write_slide', 'insert_slide', 'delete_slide', 'reorder_slides', 'finalize_deck'].includes(a.tool) && !this._activeTask.planSaved) {
            results.push('[规划门禁] 这是整套课件任务，第一次修改前必须先调用 set_deck_plan。请现在输出 set_deck_plan action，不要开始写页。');
            break;
          }
          if (a.tool === 'set_deck_plan') {
            const explicitSections = this._activeTask?.explicitSections === true;
            const continuousSections = this._activeTask?.continuousSections === true;
            const taskSpec = this._activeTask?.taskSpec;
            a.plan = {
              ...a.plan,
              qualityPolicy: { schemaVersion: 2, source: 'desktop-client' },
              ...(taskSpec ? {
                planVersion: 3,
                taskSpecRef: { runId: taskSpec.runId, revision: 1 },
                plannedAgainstRevision: this.manifest?.deckRevision?.deckHash || null,
                acceptanceCriteria: taskSpec.acceptanceCriteria,
                mutationBudget: taskSpec.targets,
              } : {}),
            };
            const planError = this._deckPlanGateError(a.plan, this._activeTask?.requestedSlideCount, explicitSections, continuousSections);
            if (planError) {
              results.push(`[规划门禁] ${planError}。请修正规划后重新调用 set_deck_plan。`);
              break;
            }
            a.plan.sectionPolicy = { explicit: explicitSections || continuousSections, mode: continuousSections ? 'continuous' : explicitSections ? 'custom' : 'default', source: 'desktop-client' };
          }
          if (this._activeTask?.commandCheck && ['render_template', 'write_slide', 'insert_slide', 'delete_slide', 'reorder_slides', 'finalize_deck'].includes(a.tool) && !this._activeTask.commandInspected) {
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
          if (this._activeTask?.commandPages?.length && ['insert_slide', 'delete_slide', 'reorder_slides', 'finalize_deck'].includes(a.tool)) {
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
          if (a.tool === 'write_outline' && !/失败|出错|错误/.test(String(result || ''))) {
            // Keep the local context in sync so later rounds see the new outline
            this.manifest = this.manifest || {};
            this.manifest.outline = String(a.content ?? '');
            this._activeTask.outlineSaved = true;
          }
          if (a.tool === 'set_deck_plan' && !/失败|出错|错误/.test(String(result || ''))) {
            this._activeTask.planSaved = true;
            this._activeTask.plan = a.plan;
          }
          if (['render_template', 'write_slide', 'insert_slide', 'delete_slide', 'reorder_slides', 'finalize_deck'].includes(a.tool) && !/失败|出错|错误/.test(String(result || ''))) {
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
      // Stop mid-stream (or an error) can leave a live bubble: freeze its cursor.
      if (this._streamBubble) {
        this._streamBubble.classList.remove('wb-streaming');
        this._streamBubble = null;
      }
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
      ? { mode: 'insert', page, after: Math.max(0, page - 1), currentRole: currentRole || null, targetPageId: planSlide?.targetPageId || null, sourcePageId: planSlide?.sourcePageId || null }
      : { mode: 'replace', page, after: null, currentRole: currentRole || null, targetPageId: planSlide?.targetPageId || null, sourcePageId: planSlide?.sourcePageId || null };
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
    const templateVariant = planSlide.templateVariant || planSlide.template_variant || '';
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
${templateVariant ? `- 当前课件母版变体：${templateVariant}` : ''}
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
      if (directive.mode === 'insert' && directive.targetPageId && action.target_page_id && String(action.target_page_id) !== String(directive.targetPageId)) return `第 ${page} 页稳定标识与蓝图不一致`;
    }
    if (tool === 'write_slide' && directive.mode === 'insert') return '当前页需要插入，不能用 write_slide 覆盖结束页';
    if (tool === 'insert_slide' && (directive.mode !== 'insert' || Number(action.after) !== directive.after)) {
      return `当前页只能插入到第 ${directive.after} 页之后`;
    }
    if (tool === 'insert_slide' && directive.targetPageId && action.target_page_id && String(action.target_page_id) !== String(directive.targetPageId)) return `第 ${page} 页稳定标识与蓝图不一致`;
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
    const templateVariant = planSlide.templateVariant || planSlide.template_variant || null;
    if (directive.mode === 'replace' && !hasTemplate && ['cover', 'catalog', 'chapter', 'finish'].includes(templateRole) && directive.currentRole !== templateRole) {
      const action = { tool: 'apply_role_template', page: Number(planSlide.page), role: templateRole, template_variant: templateVariant, title: planSlide.title };
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
      template_variant: templateVariant,
      slide_type: templateRole,
      title: planSlide.title,
      target_page_id: directive.targetPageId || null,
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
    const token = String(provider?.config?.aiApiKey || selected.aiApiKey || '').trim();
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

  _nativeTaskDeckId(taskSpec) {
    const explicit = String(this.manifest?.deckId || this.manifest?.manifest?.deckId || '').trim();
    if (/^[a-zA-Z0-9._-]{8,120}$/.test(explicit)) return explicit;
    const revision = String(this.manifest?.deckRevision?.deckHash || '').replace(/^sha256:/, '');
    if (/^[a-fA-F0-9]{32,64}$/.test(revision)) return `deck-${revision.slice(0, 40)}`;
    return `deck-${String(taskSpec?.runId || this._newPiId('task')).replace(/^run_/, '').slice(0, 80)}`;
  },

  _nativeTaskContext() {
    return {
      deckRevision: this.manifest?.deckRevision?.deckHash || null,
      currentPage: this.currentPage,
      outline: String(this.manifest?.outline || '').slice(0, 20000),
      slides: (this.manifest?.slides || []).slice(0, 60).map((slide, index) => ({
        id: slide.id || null,
        page: index + 1,
        title: String(slide.title || '').slice(0, 200),
        role: String(slide.slideType || slide.slide_type || 'content').slice(0, 30),
      })),
    };
  },

  async _executeNativeTaskTool(message, runId, counters) {
    const action = { ...(message.args || {}), tool: message.tool };
    counters.tools += 1;
    const startedAt = this._now();
    const actionEl = this._logAction(action, counters.tools);
    const receipt = await this._rpc('execute-task-action', {
      runId,
      action,
      taskSpec: this._activeTask?.taskSpec || null,
      envelope: {
        actionId: message.actionId,
        argsHash: message.argsHash,
        expectedDeckRevision: message.expectedDeckRevision || null,
      },
    });
    const display = receipt?.ok === true ? receipt.result : receipt?.error?.userMessage || 'LectureAI 未能完成当前步骤';
    this._finishAction(actionEl, startedAt, display);
    this._logResult(display);
    if (receipt?.ok !== true) {
      const error = new Error(receipt?.error?.userMessage || 'LectureAI 未能完成当前步骤');
      error.details = receipt?.error || null;
      throw error;
    }
    if (['render_template', 'write_slide', 'insert_slide', 'delete_slide', 'reorder_slides', 'finalize_deck'].includes(action.tool)) await this._refreshContext();
    return receipt;
  },

  _nativeTaskValidation(taskSpec, terminal = {}) {
    if (terminal?.validation && typeof terminal.validation === 'object') return terminal.validation;
    const events = Array.isArray(terminal?.tools) ? terminal.tools : [];
    const slides = [];
    const failedPages = [];
    for (const event of events) {
      const tool = String(event?.tool || event?.name || '');
      const result = event?.result && typeof event.result === 'object' ? event.result : event;
      if (tool !== 'validate_slide' || !Number.isInteger(Number(result.page))) continue;
      const page = Number(result.page);
      const passed = result.passed === true;
      slides.push({ page, passed, errors: passed ? [] : ['页面检查未通过'], warnings: [], issues: [] });
      if (!passed) failedPages.push(page);
    }
    const deckEvent = [...events].reverse().find(event => String(event?.tool || event?.name || '') === 'validate_deck');
    const deckResult = deckEvent?.result && typeof deckEvent.result === 'object' ? deckEvent.result : {};
    const intent = String(taskSpec?.intent || '');
    const needsValidation = ['slide_edit', 'slide_insert', 'deck_validate'].includes(intent);
    if (!needsValidation) return { schemaVersion: 1, passed: true, errors: [], warnings: [], issues: [], failedPages: [], slides: [] };
    const passed = deckResult.passed === true || (slides.length > 0 && failedPages.length === 0);
    return {
      schemaVersion: 1,
      passed,
      errors: passed ? [] : ['页面检查未通过'],
      warnings: [],
      issues: [],
      failedPages: [...new Set(failedPages)],
      slides,
      metrics: { slideCount: slides.length },
    };
  },

  async _runLectureAiNativeTask(taskSpec, instruction, recoveredRun = null) {
    const config = this._lecturePiConfig();
    if (!config) {
      this._appendAssistantMarkdown('### 无法开始任务\n\nLectureAI 暂不可用，请稍后重试。');
      return;
    }
    const protocol = window.LectureAiTaskProtocol;
    const counters = { tools: 0 };
    const deckId = this._nativeTaskDeckId(taskSpec);
    const sessionId = taskSpec.runId;
    this.busy = true;
    this._setBusy(true);
    this._stopRequested = false;
    const recoveredPlan = recoveredRun?.plan && typeof recoveredRun.plan === 'object' ? recoveredRun.plan : null;
    this._activeTask = {
      taskSpec,
      runId: taskSpec.runId,
      userInstruction: instruction,
      deckLevel: taskSpec.scope === 'deck',
      requiresPlan: taskSpec.requiresDeckPlan === true,
      harnessEnabled: taskSpec.requiresDeckPlan === true,
      planSaved: !!recoveredPlan,
      plan: recoveredPlan,
      deckValidated: false,
    };
    this._taskCardSpec = taskSpec;
    this._renderTaskCard({ runId: taskSpec.runId, status: 'running', userFacingGoal: taskSpec.userFacingGoal, totalPages: this.manifest?.slides?.length || 0 }, taskSpec);
    if (window.__TAURI__?.core?.invoke) {
      try {
        await this._rpc('task-journal-start', { runId: taskSpec.runId, taskSpec, deckRevision: this.manifest?.deckRevision?.deckHash || null });
        await this._rpc('task-journal-update', {
          runId: taskSpec.runId,
          patch: { status: 'running', taskSpec, userInstruction: instruction, plan: recoveredPlan },
        });
      } catch (error) {
        this._appendAssistantMarkdown(`### 无法开始任务\n\n${this._modelErrorMessage(error) || '无法建立安全恢复点，LectureAI 未开始写入。'}`);
        this.busy = false;
        this._setBusy(false);
        return;
      }
    }
    try {
      const terminal = await new Promise((resolve, reject) => {
        const socket = new WebSocket(config.url, ['lectureai.pi.v1', `lectureai.auth.${config.token}`]);
        this._piSocket = socket;
        this._piReject = reject;
        let settled = false;
        let queue = Promise.resolve();
        const finish = (error, message) => {
          if (settled) return;
          settled = true;
          if (this._piSocket === socket) this._piSocket = null;
          if (this._piReject === reject) this._piReject = null;
          if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'task complete');
          if (error) reject(error); else resolve(message);
        };
        socket.onopen = () => {
          socket.send(JSON.stringify({
            type: 'start_task',
            protocol_version: protocol.CONTRACT.protocolVersion,
            capabilities: [...protocol.CONTRACT.capabilities],
            session_id: sessionId,
            deck_id: deckId,
            deck_revision: this.manifest?.deckRevision?.deckHash || null,
            task_spec: taskSpec,
            task_context: this._nativeTaskContext(),
            user_instruction: instruction,
          }));
        };
        socket.onmessage = event => {
          queue = queue.then(async () => {
            const message = JSON.parse(String(event.data || '{}'));
            if (message.type === 'tool_call') {
              try {
                const receipt = await this._executeNativeTaskTool(message, taskSpec.runId, counters);
                if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({
                  type: 'tool_result',
                  ['request_id']: message.request_id,
                  actionId: receipt.actionId,
                  argsHash: receipt.argsHash,
                  newDeckRevision: receipt.newDeckRevision,
                  ok: true,
                  result: { ...receipt.result, newDeckRevision: receipt.newDeckRevision },
                }));
              } catch (error) {
                const detail = error?.details || { code: 'CLIENT_TOOL_FAILED', category: 'client_unavailable', retryable: false, userMessage: this._modelErrorMessage(error) };
                if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({
                  type: 'tool_result',
                  ['request_id']: message.request_id,
                  actionId: message.actionId,
                  argsHash: message.argsHash,
                  ok: false,
                  error: detail,
                }));
              }
              return;
            }
            if (message.type === 'progress' || message.type === 'session_started') {
              const label = this._friendlyLabel(message.label || 'LectureAI 正在处理任务');
              this._log('sys', label);
              return;
            }
            if (['task_ready', 'task_complete', 'paused'].includes(message.type)) {
              finish(null, message);
              return;
            }
            if (message.type === 'error') {
              const raw = message.error && typeof message.error === 'object'
                ? message.error
                : { userMessage: this._friendlyLabel(message.error || 'LectureAI 任务执行失败') };
              const friendly = protocol.friendlyError(raw);
              finish(new Error(friendly.userMessage));
            }
          }).catch(error => finish(error));
        };
        socket.onerror = () => finish(new Error('无法连接 LectureAI 服务'));
        socket.onclose = event => {
          if (!settled) finish(new Error(this._stopRequested ? '用户取消了当前任务' : `LectureAI 连接已中断（${event.code}）`));
        };
      });

      await this._refreshContext();
      if (terminal.type === 'task_ready') {
        const plan = terminal.plan || this.manifest?.deckPlan?.plan || recoveredPlan;
        if (!plan || !Array.isArray(plan.slides)) throw new Error('LectureAI 已完成规划，但本地课件蓝图未能载入。');
        this._activeTask.planSaved = true;
        this._activeTask.plan = plan;
        if (window.__TAURI__?.core?.invoke) {
          await this._rpc('task-journal-update', {
            runId: taskSpec.runId,
            patch: { status: 'ready', taskSpec, userInstruction: instruction, plan },
          });
        }
        await this._runPlannedHarness(plan, instruction);
        return;
      }
      if (terminal.type === 'paused') {
        if (window.__TAURI__?.core?.invoke) await this._rpc('task-journal-update', { runId: taskSpec.runId, patch: { status: 'paused', taskSpec, userInstruction: instruction, plan: this._activeTask?.plan || recoveredPlan } }).catch(() => {});
        this._appendAssistantMarkdown('### 任务已暂停\n\n进度已经保存，下次可继续当前任务。');
        this._renderTaskCard({ runId: taskSpec.runId, status: 'paused', userFacingGoal: taskSpec.userFacingGoal }, taskSpec);
        return;
      }
      const accepted = await this._completeLectureAiTaskRun(
        null,
        [],
        this._nativeTaskValidation(taskSpec, terminal),
        {},
        [],
      );
      if (accepted?.status !== 'completed') {
        const status = accepted?.status === 'needs_repair' ? 'needs_repair' : 'paused';
        if (window.__TAURI__?.core?.invoke) await this._rpc('task-journal-update', { runId: taskSpec.runId, patch: { status, taskSpec, userInstruction: instruction, plan: this._activeTask?.plan || recoveredPlan, failedPages: accepted?.failedPages || [] } }).catch(() => {});
        this._renderTaskCard({ runId: taskSpec.runId, status, userFacingGoal: taskSpec.userFacingGoal, failedPages: accepted?.failedPages || [] }, taskSpec);
        this._appendAssistantMarkdown(status === 'needs_repair'
          ? `### 需要继续修复\n\nLectureAI 已定位到需要处理的页面。`
          : '### 任务已暂停\n\n任务进度已保存，完成状态尚未得到确认。');
        return;
      }
      if (window.__TAURI__?.core?.invoke) await this._rpc('task-journal-update', { runId: taskSpec.runId, patch: { status: 'completed', taskSpec, userInstruction: instruction, plan: this._activeTask?.plan || recoveredPlan } }).catch(() => {});
      const summary = this._friendlyLabel(terminal.summary || '任务已完成并通过检查。');
      this._renderTaskCard({ runId: taskSpec.runId, status: 'completed', userFacingGoal: taskSpec.userFacingGoal }, taskSpec);
      this._appendAssistantMarkdown(`### 任务已完成\n\n${summary}`);
    } catch (error) {
      if (window.__TAURI__?.core?.invoke) await this._rpc('task-journal-update', { runId: taskSpec.runId, patch: { status: this._stopRequested ? 'paused' : 'failed', error: this._modelErrorMessage(error), taskSpec, userInstruction: instruction, plan: this._activeTask?.plan || recoveredPlan } }).catch(() => {});
      if (this._stopRequested) {
        this._renderTaskCard({ runId: taskSpec.runId, status: 'paused', userFacingGoal: taskSpec.userFacingGoal }, taskSpec);
        this._appendAssistantMarkdown('### 任务已停止\n\n进度已经保存，下次可继续当前任务。');
      } else {
        this._renderTaskCard({ runId: taskSpec.runId, status: 'failed', userFacingGoal: taskSpec.userFacingGoal }, taskSpec);
        this._appendAssistantMarkdown(`### 任务未完成\n\n${this._modelErrorMessage(error)}`);
      }
    } finally {
      this.busy = false;
      this._setBusy(false);
    }
  },

  async _executePiTool(message, planSlide, directive, counters, plan = null) {
    const action = { ...(message.args || {}), tool: message.tool };
    const gateError = this._harnessAllowedAction(action, planSlide, directive, false);
    if (gateError) throw new Error(gateError);
    counters.tools += 1;
    const startedAt = this._now();
    const actionEl = this._logAction(action, counters.tools);
    const runId = String(plan?.taskSpecRef?.runId || this._activeTask?.runId || '').trim();
    const receipt = runId && message.actionId && message.argsHash
      ? await this._rpc('execute-task-action', {
        runId,
        action,
        taskSpec: this._activeTask?.taskSpec || null,
        envelope: {
          actionId: message.actionId,
          argsHash: message.argsHash,
          expectedDeckRevision: message.expectedDeckRevision || null,
        },
      })
      : null;
    const result = receipt ? (receipt.ok ? receipt.result : receipt.error?.userMessage) : await this._rpc('execute-action', { action });
    this._finishAction(actionEl, startedAt, result);
    this._logResult(result);
    if (receipt && receipt.ok !== true) {
      const error = new Error(receipt.error?.userMessage || 'LectureAI 未能完成当前步骤');
      error.details = receipt.error;
      throw error;
    }
    if (this._isTerminalToolFailure(result) || this._resultIsError(result)) throw new Error(String(result));
    if (['render_template', 'write_slide', 'insert_slide'].includes(action.tool)) await this._refreshContext();
    return receipt
      ? { ...receipt.result, actionId: receipt.actionId, argsHash: receipt.argsHash, newDeckRevision: receipt.newDeckRevision }
      : this._piToolDetails(action, result);
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
            templateVariant: planSlide.templateVariant || planSlide.template_variant || '',
            mode: directive.mode, after: directive.after,
            targetPageId: planSlide.targetPageId || null,
            sourcePageId: planSlide.sourcePageId || null,
            expectedDeckRevision: this.manifest?.deckRevision?.deckHash || null,
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
              const result = await this._executePiTool(message, planSlide, directive, counters, plan);
              if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({
                type: 'tool_result',
                ['request_id']: message.request_id,
                actionId: message.actionId || result.actionId || null,
                argsHash: message.argsHash || result.argsHash || null,
                newDeckRevision: result.newDeckRevision || null,
                ok: true,
                result,
              }));
            } catch (error) {
              if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({
                type: 'tool_result',
                ['request_id']: message.request_id,
                actionId: message.actionId || null,
                argsHash: message.argsHash || null,
                ok: false,
                error: error?.details || { code: 'CLIENT_TOOL_FAILED', category: 'client_unavailable', retryable: false, userMessage: this._modelErrorMessage(error) },
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
    if ((this.selectedConfig || this.aiConfig || {}).aiProvider === 'lectureai') {
      throw new Error('LectureAI 暂不可用，任务进度已保存。请稍后重试，或在模型选择器中明确选择兼容模式。');
    }
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

  async _runHarnessStageReview(plan, completedPages, summaries, stageReviews = []) {
    const taskSpec = this._activeTask?.taskSpec;
    const interval = Number(taskSpec?.executionPolicy?.stageReviewInterval || plan?.executionPolicy?.stageReviewInterval || 5);
    const pages = completedPages.slice(-interval);
    if ((this.selectedConfig || this.aiConfig || {}).aiProvider === 'lectureai' && taskSpec?.runId) {
      const token = String((this.selectedConfig || this.aiConfig || {}).aiApiKey || '').trim();
      const response = await window.__TAURI__.core.invoke('auth_api_request', {
        action: 'task_stage_review',
        token,
        payload: {
          runId: taskSpec.runId,
          plan,
          completedPages,
          summaries,
          previousReviews: stageReviews,
        },
      });
      if (!response?.ok) {
        const detail = response?.data?.detail;
        const friendly = window.LectureAiTaskProtocol?.friendlyError(
          detail && typeof detail === 'object' ? detail : { userMessage: String(detail || 'LectureAI 暂时无法完成阶段检查。') },
        );
        throw new Error(friendly?.userMessage || 'LectureAI 暂时无法完成阶段检查。');
      }
      return String(response?.data?.guidance || '').trim() || '阶段衔接通过';
    }
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
    const runId = String(plan?.taskSpecRef?.runId || this._activeTask?.taskSpec?.runId || this._activeTask?.runId || '').trim();
    if (runId && window.__TAURI__?.core?.invoke) {
      const patch = {
        status: execution.status,
        nextPage: execution.nextPage ?? null,
        completedPages: Array.isArray(execution.completedPages) ? execution.completedPages : [],
        totalPages: Number(plan?.targetSlideCount || 0),
        currentDeckRevision: this.manifest?.deckRevision?.deckHash || null,
        validation: execution.validation || null,
        error: execution.error || null,
        taskSpec: this._activeTask?.taskSpec || null,
        userInstruction: this._activeTask?.userInstruction || '',
        plan,
        summaries: execution.summaries || {},
        stageReviews: execution.stageReviews || [],
        piSessionId: execution.piSessionId || plan?.execution?.piSessionId || this._activeTask?.piSessionId || '',
        piDeckId: execution.piDeckId || plan?.execution?.piDeckId || this._activeTask?.piDeckId || '',
      };
      await this._rpc('task-journal-update', { runId, patch });
    }
  },

  async _completeLectureAiTaskRun(plan = null, completedPages = [], validation = {}, summaries = {}, stageReviews = []) {
    const taskSpec = this._activeTask?.taskSpec;
    if (!taskSpec?.runId || (this.selectedConfig || this.aiConfig || {}).aiProvider !== 'lectureai') return null;
    await this._refreshContext();
    const revision = String(this.manifest?.deckRevision?.deckHash || '');
    if (!/^sha256:[a-fA-F0-9]{32,64}$/.test(revision)) {
      throw new Error('无法确认课件最终版本，任务进度已保存。');
    }
    const token = String((this.selectedConfig || this.aiConfig || {}).aiApiKey || '').trim();
    const response = await window.__TAURI__.core.invoke('auth_api_request', {
      action: 'task_complete',
      token,
      payload: {
        runId: taskSpec.runId,
        currentDeckRevision: revision,
        taskSpec,
        completedPages: [...new Set((completedPages || []).map(Number).filter(Number.isInteger))],
        plan: plan || null,
        summaries,
        stageReviews,
        finalSummary: `LectureAI 已处理 ${completedPages?.length || 0} 页并完成整套课件检查。`,
        validation,
      },
    });
    if (!response?.ok) {
      const detail = response?.data?.detail;
      const friendly = window.LectureAiTaskProtocol?.friendlyError(
        detail && typeof detail === 'object' ? detail : { userMessage: String(detail || 'LectureAI 无法确认任务完成状态。') },
      );
      throw new Error(friendly?.userMessage || 'LectureAI 无法确认任务完成状态。');
    }
    if (!['completed', 'needs_repair'].includes(response?.data?.status)) {
      throw new Error('LectureAI 返回的任务状态与本地验收结果不一致，任务进度已保存。');
    }
    return response.data;
  },

  _harnessRepairPages(plan, validation) {
    const referenced = new Set();
    const target = Number(plan?.targetSlideCount || plan?.slides?.length || 0);
    const addPage = value => {
      const page = Number(value);
      if (Number.isInteger(page) && page >= 1 && page <= target) referenced.add(page);
    };
    for (const page of validation?.failedPages || []) addPage(page);
    const pageById = new Map();
    for (const item of plan?.slides || []) {
      const id = item?.targetPageId || item?.sourcePageId || item?.pageId || item?.id;
      if (id) pageById.set(String(id), Number(item.page));
    }
    for (const [index, item] of (this.manifest?.slides || []).entries()) {
      if (item?.id && !pageById.has(String(item.id))) pageById.set(String(item.id), index + 1);
    }
    for (const id of validation?.failedPageIds || []) addPage(pageById.get(String(id)));
    for (const item of validation?.issues || []) {
      if (!item || item.severity === 'warning') continue;
      addPage(item.page);
      for (const page of item.pages || []) addPage(page);
    }
    if (referenced.size) return [...referenced].slice(0, 5);
    const codes = new Set((validation?.issues || []).map(item => String(item?.code || '')));
    const motionError = codes.has('DECK_MOTION_COVERAGE_LOW');
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
      let validationResult;
      const taskSpec = this._activeTask?.taskSpec;
      const runId = String(taskSpec?.runId || '').trim();
      const cfg = this.selectedConfig || this.aiConfig || {};
      const useServerReceipt = Boolean(
        runId
        && cfg.aiProvider === 'lectureai'
        && (this._activeTask?.taskSpec?.runId || this._taskCardRun?.runId),
      );
      if (useServerReceipt) {
        const actionId = `${runId}:client:validate-deck:${attempt + 1}`;
        const argsHash = await window.LectureAiTaskProtocol.argsHash(validationAction);
        const receipt = await this._executeServerTaskAction(
          validationAction,
          runId,
          taskSpec,
          { actionId, argsHash, expectedDeckRevision: this.manifest?.deckRevision?.deckHash || null },
        );
        validationResult = JSON.stringify(receipt.result || {});
      } else {
        validationResult = await this._rpc('execute-action', { action: validationAction });
      }
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
      runId: String(plan?.taskSpecRef?.runId || this._taskCardRun?.runId || ''),
      taskSpec: this._taskCardSpec || plan?.taskSpec || null,
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
    const stageInterval = Number(this._activeTask?.taskSpec?.executionPolicy?.stageReviewInterval || plan?.executionPolicy?.stageReviewInterval || 5);
    this._log('sys', `LectureAI 已启动 · ${plan.targetSlideCount} 页 · 每页独立处理`);
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
        if (completedPages.length % stageInterval === 0 && page < Number(plan.targetSlideCount)) {
          const guidance = await this._runHarnessStageReview(plan, completedPages, summaries, stageReviews);
          stageReviews.push({ throughPage: page, guidance });
          this._log('sys', `阶段审查 · 完成至第 ${page} 页 · ${guidance}`);
          await this._persistHarnessExecution(plan, {
            status: 'running', nextPage: page + 1, completedPages, summaries, stageReviews, userInstruction,
          });
        }
      }
      const finalizeAction = { tool: 'finalize_deck', plan };
      counters.tools += 1;
      const finalizeStartedAt = this._now();
      const finalizeEl = this._logAction(finalizeAction, counters.tools);
      const runId = String(plan?.taskSpecRef?.runId || this._activeTask?.runId || '').trim();
      let finalizeResult;
      // Plans created by the legacy compatibility worker may still carry a
      // run reference, but they do not have the server-owned TaskSpec/lease
      // contract. Keep those plans on the local executor; only a LectureAI
      // TaskSpec run is allowed to enter the action-receipt path.
      const cfg = this.selectedConfig || this.aiConfig || {};
      const useServerReceipt = Boolean(
        runId
        && cfg.aiProvider === 'lectureai'
        && (this._activeTask?.taskSpec?.runId || this._taskCardRun?.runId),
      );
      if (useServerReceipt) {
        const receipt = await this._executeServerTaskAction(
          finalizeAction,
          runId,
          this._activeTask?.taskSpec || null,
          {
            actionId: `${runId}:client:finalize:1`,
            argsHash: await window.LectureAiTaskProtocol.argsHash(
              window.LectureAiTaskProtocol.finalizationFingerprint(plan, runId),
            ),
            expectedDeckRevision: this.manifest?.deckRevision?.deckHash || null,
          },
        );
        if (receipt?.ok !== true) {
          const error = new Error(receipt?.error?.userMessage || 'LectureAI 未能整理最终页序');
          error.details = receipt?.error || null;
          throw error;
        }
        finalizeResult = receipt.result?.label || receipt.result?.message || '已确认最终页序';
      } else {
        finalizeResult = await this._rpc('execute-action', { action: finalizeAction });
      }
      this._finishAction(finalizeEl, finalizeStartedAt, finalizeResult);
      this._logResult(finalizeResult);
      if (this._isTerminalToolFailure(finalizeResult) || this._resultIsError(finalizeResult)) throw new Error(String(finalizeResult));
      await this._refreshContext();
      const validation = await this._validateAndRepairHarness(plan, {
        completedPages, summaries, stageReviews, userInstruction,
      }, counters);
      await this._persistHarnessExecution(plan, {
        status: 'validating', nextPage: null, completedPages, summaries, stageReviews,
        validation: validation || { passed: false }, userInstruction,
      });
      if (!validation?.passed) {
        try {
          await this._completeLectureAiTaskRun(plan, completedPages, validation || { passed: false }, summaries, stageReviews);
        } catch (error) {
          error.harnessStatus = 'paused';
          throw error;
        }
        await this._persistHarnessExecution(plan, {
          status: 'needs-repair', nextPage: null, completedPages, summaries, stageReviews,
          validation, userInstruction,
        });
        const failure = new Error(`整套校验未通过：${(validation?.errors || []).join('；')}`);
        failure.harnessStatus = 'needs-repair';
        throw failure;
      }
      this._activeTask.deckValidated = true;
      try {
        const accepted = await this._completeLectureAiTaskRun(plan, completedPages, validation, summaries, stageReviews);
        if (accepted?.status === 'needs_repair') {
          const failure = new Error(`最终验收需要继续修复第 ${(accepted.failedPages || []).join('、') || '相关'} 页`);
          failure.harnessStatus = 'needs-repair';
          throw failure;
        }
      } catch (error) {
        error.harnessStatus = 'paused';
        throw error;
      }
      await this._persistHarnessExecution(plan, {
        status: 'completed', nextPage: null, completedPages, summaries, stageReviews,
        validation: { passed: true, metrics: validation.metrics || {} }, userInstruction,
      });
      this._appendAssistantMarkdown(`### 课件生成完成\n\nLectureAI 已完成 ${completedPages.length} 页，并按阶段检查教学衔接；整套课件检查已通过。`);
      this._log('sys', `LectureAI 任务完成 · ${counters.rounds} 轮响应 · ${counters.tools} 次操作 · ${this._duration(startedAt)}`);
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
      this._thinkingTail = '';
      this._removeStreamBubble();
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
    return this._userFacingText(String(error?.message || error || '未知错误').replace(/^(?:Error:\s*)+/i, '').trim());
  },

  _isRetryableModelError(message) {
    return /HTTP\s*50[234]|LLM 服务请求失败|LectureAI 服务暂时不可用|LectureAI 上游模型暂时不可用|网络请求失败|连接.*失败|模型只返回了思考过程|模型未返回可执行内容|输出达到长度上限/i.test(String(message || ''));
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
      this._renderStreamingBubble();
    }, 50);
  },

  // Streams the round's prose into a live bubble so a final answer appears
  // progressively. Tool-round prose stays compressed in the status line: as
  // soon as a complete ```action block exists, the bubble is removed.
  _renderStreamingBubble() {
    if (/```action\s*[\s\S]*?```|<tool_call>/i.test(this._streamFull)) {
      this._removeStreamBubble();
      return;
    }
    // Hide an unterminated action fence tail while it is still streaming in.
    const fenceIndex = this._streamFull.indexOf('```action');
    const source = fenceIndex >= 0 ? this._streamFull.slice(0, fenceIndex) : this._streamFull;
    const visible = this._userFacingText(this._stripActions(source).trim());
    if (visible.length < 80) return;
    if (!this._streamBubble) {
      const m = document.getElementById('wb-messages');
      if (!m) return;
      this._streamBubble = document.createElement('div');
      this._streamBubble.className = 'ln ln-ai markdown-body wb-streaming';
      m.appendChild(this._streamBubble);
    }
    if (window.marked) {
      this._streamBubble.innerHTML = this._sanitizeHtml(window.marked.parse(visible));
    } else {
      this._streamBubble.textContent = visible;
    }
    this._scroll();
  },

  _removeStreamBubble() {
    if (this._streamBubble) {
      this._streamBubble.remove();
      this._streamBubble = null;
    }
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
    const summary = this._compactStatus(this._userFacingText(this._stripActions(this._streamFull)));
    if (summary && this._modelStatusEl) {
      this._modelStatusEl.dataset.summary = summary;
      this._modelStatusEl.textContent = `第 ${this._activeRound} 轮 · ${summary} · ${this._modelDuration()}`;
      this._scroll();
    }
  },

  // ---- action parsing ----
  // Conservative repair for near-valid model JSON: retry once after stripping
  // trailing commas, and name truncation explicitly so the recovery prompt
  // tells the model to re-output compactly instead of failing opaquely.
  _parseActionJson(raw) {
    // Models occasionally leak ANSI escape/control bytes into the stream
    // (observed as ESC[118;1:3u landing mid-JSON), which otherwise fails
    // with an opaque "Property name must be a string literal".
    const sanitized = String(raw)
      .replace(/\x1b\[[0-9;:]*[A-Za-z]/g, '')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
    try {
      return { obj: JSON.parse(sanitized) };
    } catch (firstError) {
      const cleaned = sanitized.replace(/,\s*([}\]])/g, '$1');
      if (cleaned !== sanitized) {
        try {
          return { obj: JSON.parse(cleaned) };
        } catch (_) { /* fall through to the original error */ }
      }
      const opens = (sanitized.match(/[{[]/g) || []).length;
      const closes = (sanitized.match(/[}\]]/g) || []).length;
      if (opens > closes) {
        return { error: 'JSON 不完整（输出可能被截断）：请重新输出一个完整且更紧凑的 action JSON' };
      }
      return { error: String(firstError) };
    }
  },
  _parseActions(text) {
    const actions = [];
    const append = rawValue => {
      const raw = String(rawValue || '').trim();
      const { obj, error } = this._parseActionJson(raw);
      if (error) actions.push({ tool: '_parse_error', error, raw });
      else if (obj && obj.tool) actions.push(obj);
      else actions.push({ tool: '_parse_error', error: '缺少 tool 字段', raw });
    };
    const re = /```action\s*([\s\S]*?)```/gi;
    let m;
    while ((m = re.exec(text))) {
      append(m[1]);
    }
    // Some OpenAI-compatible reasoning models emit the same JSON action in a
    // native XML envelope. Accept the variants observed in real sessions,
    // including a missing </tool_call> or a misplaced </action> terminator.
    const xml = /<tool_call>\s*([\s\S]*?)(?:<\/tool_call>|(?=<tool_call>)|$)/gi;
    while ((m = xml.exec(String(text || '')))) {
      const raw = m[1]
        .replace(/^\s*(?:<action>\s*|action\b\s*)/i, '')
        .replace(/\s*<\/action>\s*$/i, '')
        .trim();
      append(raw);
    }
    return actions;
  },

  _stripActions(text) {
    return String(text || '')
      .replace(/```action\s*[\s\S]*?```/gi, '')
      .replace(/<tool_call>\s*[\s\S]*?(?:<\/tool_call>|(?=<tool_call>)|$)/gi, '')
      .trim();
  },

  // True when the reply carries a tool-call JSON payload that never made it
  // into an ```action fence — Stepfun emits bare {"tool": ...} JSON far more
  // often than DeepSeek. Long JSON trips the 160-char guard in
  // _hasUnexecutedToolIntent, so bare payloads need their own detector.
  _hasBareToolPayload(text) {
    return /"tool"\s*:/.test(this._stripActions(String(text || '')));
  },

  _hasUnexecutedToolIntent(text) {
    const clean = this._stripActions(String(text || ''))
      .replace(/^[#>*_`\s-]+/gm, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!clean || clean.length > 160) return false;
    if (/检查结果|校验结果|处理完成|检查完成|总结|发现以下|问题如下|无需修改/.test(clean)) return false;
    return /^(?:好的[，。!！\s]*)?(?:收到[，。!！\s]*)?(?:我?先|现在|继续|接下来|准备|开始|将|需要)?\s*(?:逐页)?(?:读取|查看|打开|检查|校验|验证|修改|重写|写入|插入|新增|删除|调整|重排|查找|检索|搜索|查询|下载|获取)/u.test(clean);
  },

  _isTerminalToolFailure(result) {
    const text = String(result || '');
    return /(?:write_slide|insert_slide|delete_slide|apply_role_template|reorder_slides|finalize_deck|set_deck_plan) 保存失败|已恢复执行前状态|文件冲突/.test(text);
  },

  // ---- terminal log ----
  _log(type, text, opts) {
    const m = document.getElementById('wb-messages');
    if (!m) return;
    const el = document.createElement('div');
    el.className = 'ln ln-' + type;
    const visibleText = type === 'user' ? String(text || '') : this._userFacingText(text);
    el.textContent = visibleText;
    m.appendChild(el);
    this._scroll();
    // Persist conversation-relevant lines; 'phase' status lines are transient.
    if (!opts?.skipRecord && ['user', 'sys', 'ok', 'err'].includes(type)) {
      this._transcript.push({ t: type, text: visibleText });
      this._scheduleSessionSave();
    }
    return el;
  },

  _appendUser(text, mentioned) {
    const explicitPages = new Set([...String(text || '').matchAll(/@(\d+)\b/g)].map(match => Number(match[1])));
    const implicitPages = (mentioned || []).map(item => Number(item.page)).filter(page => !explicitPages.has(page));
    const t = implicitPages.length ? `@${implicitPages.join(' @')} · ${text}` : text;
    this._log('user', t);
  },

  _appendAssistantMarkdown(markdown, opts) {
    const m = document.getElementById('wb-messages');
    if (!m || !markdown) return;
    const el = document.createElement('div');
    el.className = 'ln ln-ai markdown-body';
    const visibleMarkdown = this._userFacingText(markdown);
    if (window.marked) {
      el.innerHTML = this._sanitizeHtml(window.marked.parse(visibleMarkdown));
    } else {
      el.textContent = visibleMarkdown;
    }
    m.appendChild(el);
    this._scroll();
    if (!opts?.skipRecord) {
      this._transcript.push({ t: 'ai', md: visibleMarkdown });
      this._scheduleSessionSave();
    }
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
        const phase = this._thinkingTail
          ? `正在思考 · ${this._thinkingTail}`
          : elapsed < 1200
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
    read_outline: '读取课件大纲',
    write_outline: '写入课件大纲',
    load_skill: '加载助教技能',
    read_skill_resource: '读取技能资料',
    search_icons: '检索图标库',
    use_icon: '下载图标',
    search_design_examples: '检索设计案例',
    render_template: '渲染页面模板',
    read_slide: '读取页面',
    write_slide: '写入页面内容',
    insert_slide: '插入新页面',
    apply_role_template: '套用页面母版',
    delete_slide: '删除页面',
    reorder_slides: '调整页面顺序',
    finalize_deck: '整理成品页序',
    validate_slide: '校验页面',
    validate_deck: '校验整套课件',
    inspect_slides: '检查页面',
  },

  _toolDisplayName(tool) {
    return this._toolDisplayNames[tool] || '处理页面';
  },

  _userFacingText(value) {
    let text = String(value || '');
    for (const [tool, label] of Object.entries(this._toolDisplayNames)) {
      text = text.replace(new RegExp(`\\b${tool}\\b`, 'gi'), label);
    }
    return text
      .replace(/\bPi\s+(?:Agent|Runtime)\b/gi, 'LectureAI')
      .replace(/\bPi\b/gi, 'LectureAI')
      .replace(/\bRuntime\b/gi, 'LectureAI')
      .replace(/\btool_call\b/gi, '任务步骤')
      .replace(/\btool_result\b/gi, '步骤结果');
  },

  _friendlyLabel(label) {
    return this._userFacingText(label)
      .replace(/渲染私有模板/g, '渲染页面模板');
  },

  _logAction(a, callNumber) {
    if (a.tool === '_parse_error') {
      return this._log('err', `操作解析失败：${a.error || ''}`);
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
    return /(?:执行出错|保存失败|文件冲突|超出范围|缺少 tool|action 解析失败|未知工具|整理成品页序失败)/.test(text)
      || /^(?:\[[^\]]+\]|(?:set_deck_plan|write_slide|insert_slide|delete_slide|reorder_slides|finalize_deck|validate_slide|validate_deck|inspect_slides))\s*(?:失败|错误|出错)/.test(text);
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
