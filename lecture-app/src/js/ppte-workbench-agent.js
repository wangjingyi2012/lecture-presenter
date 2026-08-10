// ppte-workbench-agent.js - Main-window side of the workbench Agent.
//
// The chat UI + AI loop live in a separate Tauri window (workbench.html +
// workbench-window.js). This module runs in the main window and:
//   1. injects the "工作台" toggle button into the PPTE editor header (opens the window)
//   2. rewires the per-page "AI助手" button to open the window pre-@ing the current page
//   3. answers wb-request RPC from the workbench window:
//        get-context      -> {title, slides:[{title}], aiConfig, prefillPage?}
//        get-slide {page} -> html string
//        execute-action {action} -> result string (runs the tool against PpteEditor)
//
// Tool execution goes through PpteEditor._pptBuilder + _savePptBuilderData +
// _renderPptBuilderInContent, never bypassing the editor (so the file watcher
// stays consistent). The "工作台" button in the editor header opens the window.
window.PpteWorkbenchAgent = {
  appConfig: null,
  _pendingPrefill: null,

  init(appConfig) {
    this.appConfig = appConfig || window.CourseLoader?.appConfig || {};
    this._injectToggle();
    this._listenRequests();
  },

  // ---- toggle button in editor header ----
  _injectToggle() {
    if (document.getElementById('ppt-workbench-toggle')) return;
    const actions = document.querySelector('.ppte-editor-primary-actions');
    if (!actions) return;
    const btn = document.createElement('button');
    btn.id = 'ppt-workbench-toggle';
    btn.className = 'ppte-editor-button ppte-editor-button-compact';
    btn.title = '工作台助手（课件级对话，@页码定位）';
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a3 3 0 0 0-3 3v1H7a3 3 0 0 0-3 3v1a3 3 0 0 0 0 6v1a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-1a3 3 0 0 0 0-6V9a3 3 0 0 0-3-3h-2V5a3 3 0 0 0-3-3z"/><path d="M9 13h6"/></svg> 工作台`;
    btn.onclick = () => this.open();
    const saveBtn = document.getElementById('ppt-save-btn');
    if (saveBtn) actions.insertBefore(btn, saveBtn);
    else actions.appendChild(btn);
  },

  _listenRequests() {
    if (!window.__TAURI__ || !window.__TAURI__.event) return;
    window.__TAURI__.event.listen('wb-request', (event) => {
      this._onRequest(event.payload).catch(e => console.error('workbench request error', e));
    });
  },

  async _onRequest(req) {
    const type = req?.type;
    let result;
    try {
      if (type === 'get-context') result = await this._getContext();
      else if (type === 'get-slide') result = this._getSlide(req.payload?.page);
      else if (type === 'execute-action') result = await this._executeAction(req.payload?.action);
      else result = { error: '未知请求类型 ' + type };
    } catch (e) {
      result = { error: String(e) };
    }
    try {
      window.__TAURI__.event.emit('wb-response', { type, result });
    } catch (e) {
      console.error('workbench response emit failed', e);
    }
  },

  // ---- context / slide providers ----
  // The PPTE editor's runtime state (_pptBuilder) lives on window.Settings, not
  // window.PpteEditor: PpteEditor is just a method bag (Object.assigned onto
  // Settings), and the editor entry point (Settings.openPptExtra) runs with
  // this=Settings. Return whichever object actually holds the live _pptBuilder.
  _editor() {
    if (window.Settings?._pptBuilder) return window.Settings;
    if (window.PpteEditor?._pptBuilder) return window.PpteEditor;
    return window.Settings;
  },

  async _getContext() {
    const pb = this._editor()._pptBuilder;
    const appConfig = window.CourseLoader?.appConfig || {};
    const token = window.Auth?.getToken() || '';
    const settingsProvider = appConfig.aiProvider || '';
    const settingsKey = settingsProvider === 'lectureai' ? token : (appConfig.aiApiKey || '');
    const settingsConfig = {
      aiProvider: settingsProvider,
      aiApiKey: settingsKey,
      aiApiType: appConfig.aiApiType,
      aiBaseUrl: appConfig.aiBaseUrl,
      aiModel: appConfig.aiModel,
    };
    // Available providers for the workbench model selector:
    //   - LectureAI (uses the logged-in account token, no API key needed)
    //   - the model configured in settings (deepseek / minimax / custom)
    const providers = [];
    if (token) {
      providers.push({ id: 'lectureai', label: 'LectureAI', config: { aiProvider: 'lectureai', aiApiKey: token } });
    }
    if (settingsProvider && settingsProvider !== 'lectureai' && appConfig.aiApiKey) {
      providers.push({ id: 'settings', label: `设置：${settingsProvider}`, config: settingsConfig });
    }
    // default: keep current behavior (the settings-configured model) if available, else LectureAI
    const defaultProvider = (settingsProvider && settingsProvider !== 'lectureai' && appConfig.aiApiKey)
      ? 'settings'
      : (token ? 'lectureai' : null);
    const ctx = {
      title: pb?.manifest?.title || '',
      slides: (pb?.slides || []).map(s => ({ title: s.title || '（无标题）' })),
      aiConfig: settingsConfig,
      providers,
      defaultProvider,
      prefillPage: this._pendingPrefill,
    };
    this._pendingPrefill = null;
    return ctx;
  },

  _getSlide(page) {
    const pb = this._editor()._pptBuilder;
    if (!pb) return '';
    const i = (page | 0) - 1;
    if (i < 0 || i >= (pb.slides || []).length) return '';
    return pb.slides[i].html || '';
  },

  // ---- open window ----
  async open() {
    if (!window.__TAURI__) return;
    try {
      await window.__TAURI__.core.invoke('open_workbench_window');
      window.Tracker?.track('workbench_open');
    } catch (e) {
      alert('打开工作台窗口失败：' + e);
    }
  },

  // Per-page "AI助手" button (Q1 rewire): open the window and pre-@ the current
  // page. The prefill is carried in the get-context response to avoid races with
  // the window's listener registration.
  async openForCurrentPage() {
    const pb = this._editor()._pptBuilder;
    if (pb) this._pendingPrefill = (pb.currentSlideIndex || 0) + 1;
    await this.open();
  },

  // ---- tool execution (delegated from the workbench window) ----
  async _executeAction(a) {
    const pb = this._editor()._pptBuilder;
    if (!pb) return `[${a?.tool}] 失败：未打开课件`;
    if (!a || !a.tool) return '[action] 失败：缺少 tool 字段';
    try {
      switch (a.tool) {
        case 'write_slide': return await this._toolWriteSlide(pb, a);
        case 'insert_slide': return await this._toolInsertSlide(pb, a);
        case 'reorder_slides': return await this._toolReorderSlides(pb, a);
        case 'read_slide': return this._toolReadSlide(pb, a);
        case 'validate_slide': return await this._toolValidateSlide(pb, a);
        case '_parse_error': return `action 解析失败：${a.error}\n原始内容：${(a.raw || '').slice(0, 200)}`;
        default: return `[未知工具] ${a.tool}`;
      }
    } catch (e) {
      return `[${a.tool}] 执行出错：${String(e)}`;
    }
  },

  async _toolWriteSlide(pb, a) {
    const page = (a.page | 0);
    const i = page - 1;
    if (i < 0 || i >= pb.slides.length) return `write_slide 失败：页码 ${page} 超出范围（共 ${pb.slides.length} 页）`;
    pb.slides[i].html = a.html || '';
    pb.slides[i].dirty = true;
    // sync the textarea for the current page so _markCurrentSlideFromEditor won't clobber it
    if (i === pb.currentSlideIndex) {
      const ta = document.getElementById('ppt-current-html');
      if (ta) ta.value = pb.slides[i].html;
    }
    await this._editor()._savePptBuilderData(pb, {});
    this._editor()._renderPptBuilderInContent();
    const lint = window.PpteRules ? await window.PpteRules.lintSummary(pb.slides[i].html) : '';
    return `write_slide(第${page}页「${pb.slides[i].title}」) 已保存，主窗口已刷新预览。\n规范检查：\n${lint}`;
  },

  async _toolInsertSlide(pb, a) {
    const after = (a.after | 0);
    const idx = Math.max(0, Math.min(pb.slides.length, after));
    const newId = this._editor()._newPpteId?.('slide')
      || `slide-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const newFile = this._editor()._nextPpteSlideFile ? this._editor()._nextPpteSlideFile(pb) : `slide-${pb.slides.length + 1}.html`;
    const newSlide = {
      id: newId,
      file: newFile,
      title: a.title || `新页面 ${pb.slides.length + 1}`,
      slide_type: 'content',
      html: a.html || '',
      dirty: true,
      created: true,
    };
    pb.slides.splice(idx, 0, newSlide);
    pb.manifestDirty = true;
    if ((pb.currentSlideIndex || 0) >= idx) pb.currentSlideIndex = (pb.currentSlideIndex || 0) + 1;
    await this._editor()._savePptBuilderData(pb, {});
    this._editor()._renderPptBuilderInContent();
    return `insert_slide 在第${after}页之后插入「${newSlide.title}」成功（现为第${idx + 1}页）。`;
  },

  async _toolReorderSlides(pb, a) {
    const order = a.order;
    if (!Array.isArray(order) || order.length !== pb.slides.length) {
      return `reorder_slides 失败：order 长度需为 ${pb.slides.length}（当前 ${Array.isArray(order) ? order.length : '非数组'}）`;
    }
    const newSlides = [];
    const seen = new Set();
    for (const p of order) {
      const i = (p | 0) - 1;
      if (i < 0 || i >= pb.slides.length || seen.has(i)) return `reorder_slides 失败：order 含非法或重复页码 ${p}`;
      seen.add(i);
      newSlides.push(pb.slides[i]);
    }
    const oldCurrentId = pb.slides[pb.currentSlideIndex]?.id;
    pb.slides = newSlides;
    pb.manifest.slides = newSlides;
    pb.currentSlideIndex = Math.max(0, newSlides.findIndex(s => s.id === oldCurrentId));
    pb.manifestDirty = true;
    await this._editor()._savePptBuilderData(pb, {});
    this._editor()._renderPptBuilderInContent();
    return `reorder_slides 已重排为 [${order.join(',')}]。`;
  },

  _toolReadSlide(pb, a) {
    const page = (a.page | 0);
    const i = page - 1;
    if (i < 0 || i >= pb.slides.length) return `read_slide 失败：页码 ${page} 超出范围`;
    const s = pb.slides[i];
    return `第${page}页「${s.title}」HTML：\n\`\`\`html\n${s.html || ''}\n\`\`\``;
  },

  async _toolValidateSlide(pb, a) {
    let html, label;
    if (a.page != null) {
      const page = (a.page | 0);
      const i = page - 1;
      if (i < 0 || i >= pb.slides.length) return `validate_slide 失败：页码 ${page} 超出范围`;
      html = pb.slides[i].html;
      label = `第${page}页「${pb.slides[i].title}」`;
    } else if (a.html) {
      html = a.html; label = '提供的 HTML';
    } else {
      return `validate_slide 失败：需指定 page 或 html`;
    }
    const lint = window.PpteRules ? await window.PpteRules.lintSummary(html) : 'linter 不可用';
    return `${label} 规范检查：\n${lint}`;
  }
};
