// ppte-workbench-agent.js - Main-window side of the workbench Agent.
//
// The chat UI + AI loop live in a separate Tauri window (workbench.html +
// workbench-window.js). This module runs in the main window and:
//   1. injects the "工作台" toggle button into the PPTE editor header (opens the window)
//   2. rewires the per-page "AI助手" button to open the window pre-@ing the current page
//   3. answers wb-request RPC from the workbench window:
//        get-context      -> {title, slides:[{title, slideType, file}], templateBlueprint, deckPlan, aiConfig}
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
      else if (type === 'pick-ppte') result = await this._pickPpte();
      else result = { error: '未知请求类型 ' + type };
    } catch (e) {
      result = { error: String(e) };
    }
    try {
      window.__TAURI__.event.emit('wb-response', { type, result });
    } catch (e) {
      console.error('workbench response emit failed', e);
    }
    // Notify the workbench to re-pull context only AFTER the response for this
    // request was emitted — the workbench resolves RPCs via a single pending
    // resolver, so a wb-refresh sent before the wb-response would make the
    // refresh's get-context resolve with this request's result instead.
    if (type === 'pick-ppte') {
      try {
        window.__TAURI__.event.emit('wb-refresh', {});
      } catch (e) {
        console.error('workbench refresh emit failed', e);
      }
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
    let deckPlan = { plan: null, status: 'missing' };
    if (pb?.folderPath && window.__TAURI__?.core?.invoke) {
      try {
        deckPlan = await window.__TAURI__.core.invoke('ppte_agent_plan_read', { folderPath: pb.folderPath });
      } catch (error) {
        console.warn('Failed to read optional LectureAI plan', error);
      }
    }
    const ctx = {
      title: pb?.manifest?.title || '',
      slides: (pb?.slides || []).map(s => ({
        title: s.title || '（无标题）',
        slideType: s.slide_type || 'content',
        file: s.file || '',
      })),
      templateBlueprint: this._templateBlueprint(pb),
      deckPlan,
      aiConfig: settingsConfig,
      providers,
      defaultProvider,
      prefillPage: this._pendingPrefill,
    };
    this._pendingPrefill = null;
    return ctx;
  },

  _templateBlueprint(pb) {
    if (!pb?.slides?.length) return null;
    const meta = pb.manifest?.agentTemplate;
    if (meta?.roles?.length) {
      const roles = meta.roles.map(role => {
        const pageIndex = pb.slides.findIndex(slide => slide.file === role.file);
        const slide = pageIndex >= 0 ? pb.slides[pageIndex] : null;
        return {
          page: pageIndex >= 0 ? pageIndex + 1 : null,
          file: role.file || '',
          title: role.title || '',
          slideType: role.slideType || 'content',
          stylesheets: this._stylesheetRefs(slide?.html),
        };
      });
      return {
        name: meta.name || '默认模板',
        state: meta.state || 'starter',
        isStarter: (meta.state || 'starter') === 'starter',
        roles,
      };
    }

    // Compatibility for PPTEs created before agentTemplate metadata existed.
    const canonicalTypes = ['cover', 'catalog', 'chapter', 'content', 'finish'];
    const canonicalTitles = ['封面', '目录', '章节 1', '内容', '总结'];
    const isLegacyStarter = pb.slides.length === canonicalTypes.length
      && pb.slides.every((slide, index) =>
        (slide.slide_type || 'content') === canonicalTypes[index]
        && (slide.title || '') === canonicalTitles[index]);
    if (!isLegacyStarter) return null;
    return {
      name: '旧版默认模板',
      state: 'starter',
      isStarter: true,
      roles: pb.slides.map((slide, index) => ({
        page: index + 1,
        file: slide.file || '',
        title: slide.title || '',
        slideType: slide.slide_type || 'content',
        stylesheets: this._stylesheetRefs(slide.html),
      })),
    };
  },

  _stylesheetRefs(html) {
    const refs = [];
    const re = /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi;
    let match;
    while ((match = re.exec(String(html || '')))) refs.push(match[1]);
    return refs;
  },

  _markTemplateInitialized(pb) {
    if (!pb?.manifest) return;
    const blueprint = this._templateBlueprint(pb);
    if (!blueprint?.isStarter) return;
    if (!pb.manifest.agentTemplate) {
      pb.manifest.agentTemplate = {
        schemaVersion: 1,
        name: blueprint.name,
        state: 'initialized',
        roles: blueprint.roles.map(role => ({
          file: role.file,
          title: role.title,
          slideType: role.slideType,
        })),
      };
    } else {
      pb.manifest.agentTemplate.state = 'initialized';
    }
    pb.manifestDirty = true;
  },

  _getSlide(page) {
    const pb = this._editor()._pptBuilder;
    if (!pb) return '';
    const i = (page | 0) - 1;
    if (i < 0 || i >= (pb.slides || []).length) return '';
    return pb.slides[i].html || '';
  },

  // Open a PPTE folder picker in the main window (requested by the workbench
  // window when no course is connected); _onRequest emits wb-refresh afterwards.
  async _pickPpte() {
    try {
      const editor = this._editor();
      const opener = editor.openPptExtra?.bind(editor) || window.Settings?.openPptExtra?.bind(window.Settings);
      if (opener) await opener();
      return 'ok';
    } catch (e) {
      return String(e);
    }
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
        case 'set_deck_plan': return await this._toolSetDeckPlan(pb, a);
        case 'search_design_examples': return await this._toolSearchDesignExamples(a);
        case 'write_slide': return await this._toolWriteSlide(pb, a);
        case 'insert_slide': return await this._toolInsertSlide(pb, a);
        case 'reorder_slides': return await this._toolReorderSlides(pb, a);
        case 'read_slide': return this._toolReadSlide(pb, a);
        case 'validate_slide': return await this._toolValidateSlide(pb, a);
        case 'validate_deck': return await this._toolValidateDeck(pb);
        case '_parse_error': return `action 解析失败：${a.error}\n原始内容：${(a.raw || '').slice(0, 200)}`;
        default: return `[未知工具] ${a.tool}`;
      }
    } catch (e) {
      return `[${a.tool}] 执行出错：${String(e)}`;
    }
  },

  async _toolSetDeckPlan(pb, a) {
    if (!a.plan || typeof a.plan !== 'object') return 'set_deck_plan 失败：缺少完整 plan 对象';
    const saved = await window.__TAURI__.core.invoke('ppte_agent_plan_write', {
      folderPath: pb.folderPath,
      plan: a.plan,
    });
    const count = Number(saved?.targetSlideCount || 0);
    return `set_deck_plan 已保存课件蓝图${count ? `（目标 ${count} 页）` : ''}。规划失败不会影响 PPTE 页面。`;
  },

  async _toolSearchDesignExamples(a) {
    const token = window.Auth?.getToken() || '';
    const query = {
      content_kind: a.content_kind || null,
      layout_family: a.layout_family || null,
      density: a.density || null,
      motion: a.motion || null,
      exclude: Array.isArray(a.exclude) ? a.exclude : [],
      limit: Math.max(1, Math.min(Number(a.limit || 3), 6)),
    };
    const result = await window.__TAURI__.core.invoke('lectureai_design_examples', { authToken: token, query });
    return `search_design_examples 匹配 ${result?.count || 0} 个案例：\n${JSON.stringify(result, null, 2)}`;
  },

  async _refreshAgentPlanRevision(pb) {
    try {
      await window.__TAURI__.core.invoke('ppte_agent_plan_refresh', { folderPath: pb.folderPath });
    } catch (error) {
      // Optional metadata must never turn a confirmed slide save into failure.
      console.warn('Failed to refresh optional LectureAI plan revision', error);
    }
  },

  _snapshotAgentBuilder(pb) {
    return {
      manifest: JSON.parse(JSON.stringify(pb.manifest || {})),
      slides: JSON.parse(JSON.stringify(pb.slides || [])),
      currentSlideIndex: pb.currentSlideIndex || 0,
      manifestDirty: !!pb.manifestDirty,
      templateFilesDirty: !!pb.templateFilesDirty,
      fileStats: JSON.parse(JSON.stringify(pb.fileStats || {})),
    };
  },

  _restoreAgentBuilder(pb, snapshot) {
    pb.manifest = snapshot.manifest;
    pb.slides = snapshot.slides;
    pb.manifest.slides = pb.slides;
    pb.currentSlideIndex = snapshot.currentSlideIndex;
    pb.manifestDirty = snapshot.manifestDirty;
    pb.templateFilesDirty = snapshot.templateFilesDirty;
    pb.fileStats = snapshot.fileStats;
  },

  async _commitAgentMutation(pb, mutate) {
    // Capture any manual editor text before taking the rollback snapshot.
    this._editor()._markCurrentSlideFromEditor?.(pb);
    const snapshot = this._snapshotAgentBuilder(pb);
    try {
      const mutation = mutate() || {};
      const saveResult = await this._editor()._savePptBuilderData(pb, { interactiveConflicts: false });
      const saved = new Set(saveResult?.saved || []);
      const requiredFiles = ['manifest.json', ...(mutation.requiredFiles || [])];
      const missing = requiredFiles.filter(file => !saved.has(file));
      const conflicts = saveResult?.conflicts || [];
      if (saveResult?.cancelled || saveResult?.skipped || conflicts.length || missing.length) {
        this._restoreAgentBuilder(pb, snapshot);
        this._editor()._renderPptBuilderInContent();
        const detail = conflicts.length
          ? `检测到文件冲突：${conflicts.join('、')}`
          : (missing.length ? `磁盘未确认写入：${missing.join('、')}` : '保存已取消');
        return { ok: false, error: detail };
      }
      this._editor()._renderPptBuilderInContent();
      return { ok: true, value: mutation.value, saveResult };
    } catch (error) {
      this._restoreAgentBuilder(pb, snapshot);
      this._editor()._renderPptBuilderInContent();
      throw error;
    }
  },

  async _toolWriteSlide(pb, a) {
    const page = (a.page | 0);
    const i = page - 1;
    if (i < 0 || i >= pb.slides.length) return `write_slide 失败：页码 ${page} 超出范围（共 ${pb.slides.length} 页）`;
    const commit = await this._commitAgentMutation(pb, () => {
      this._markTemplateInitialized(pb);
      pb.slides[i].html = a.html || '';
      pb.slides[i].dirty = true;
      if (a.title) {
        pb.slides[i].title = String(a.title).trim() || pb.slides[i].title;
        pb.manifestDirty = true;
      }
      if (['cover', 'catalog', 'chapter', 'content', 'finish'].includes(a.slide_type)) {
        pb.slides[i].slide_type = a.slide_type;
        pb.manifestDirty = true;
      }
      // Keep current editor fields aligned before _savePptBuilderData reads them.
      if (i === pb.currentSlideIndex) {
        const ta = document.getElementById('ppt-current-html');
        if (ta) ta.value = pb.slides[i].html;
        const titleInput = document.getElementById('ppt-current-title');
        if (titleInput && a.title) titleInput.value = pb.slides[i].title;
      }
      return { requiredFiles: [pb.slides[i].file] };
    });
    if (!commit.ok) return `write_slide 保存失败：${commit.error}。已恢复执行前状态，本轮必须停止。`;
    await this._refreshAgentPlanRevision(pb);
    const lint = window.PpteRules ? await window.PpteRules.lintSummary(pb.slides[i].html) : '';
    return `write_slide(第${page}页「${pb.slides[i].title}」) 已保存，主窗口已刷新预览。\n规范检查：\n${lint}`;
  },

  async _toolInsertSlide(pb, a) {
    const after = (a.after | 0);
    const requestedRole = ['cover', 'catalog', 'chapter', 'content', 'finish'].includes(a.template_role)
      ? a.template_role
      : null;
    let templatePage = a.template_page == null ? null : (a.template_page | 0);
    let templateSlide = templatePage == null ? null : pb.slides[templatePage - 1];
    if (requestedRole) {
      const roleFile = pb.manifest?.agentTemplate?.roles?.find(role => role.slideType === requestedRole)?.file;
      const roleIndex = roleFile
        ? pb.slides.findIndex(slide => slide.file === roleFile)
        : pb.slides.findIndex(slide => slide.slide_type === requestedRole);
      templateSlide = roleIndex >= 0 ? pb.slides[roleIndex] : null;
      templatePage = roleIndex >= 0 ? roleIndex + 1 : null;
    }
    if (templatePage != null && !templateSlide) {
      return `insert_slide 失败：模板页 ${templatePage} 超出范围（共 ${pb.slides.length} 页）`;
    }
    if (requestedRole && !templateSlide) {
      return `insert_slide 失败：未找到 ${requestedRole} 角色母版`;
    }
    const slideType = ['cover', 'catalog', 'chapter', 'content', 'finish'].includes(a.slide_type)
      ? a.slide_type
      : (templateSlide?.slide_type || 'content');
    let idx = Math.max(0, Math.min(pb.slides.length, after));
    const finishIndex = pb.slides.findIndex(slide => slide.slide_type === 'finish');
    // Content and chapter pages must never be appended behind an existing
    // finish page. This keeps the ending last even when the model says after=5
    // while expanding the original five-page starter deck.
    if (slideType !== 'finish' && finishIndex >= 0 && idx > finishIndex) idx = finishIndex;
    const newId = this._editor()._newPpteId?.('slide')
      || `slide-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const newFile = this._editor()._nextPpteSlideFile ? this._editor()._nextPpteSlideFile(pb) : `slide-${pb.slides.length + 1}.html`;
    const newSlide = {
      id: newId,
      file: newFile,
      title: a.title || `新页面 ${pb.slides.length + 1}`,
      slide_type: slideType,
      html: a.html || templateSlide?.html || '',
      dirty: true,
      created: true,
    };
    const commit = await this._commitAgentMutation(pb, () => {
      this._markTemplateInitialized(pb);
      pb.slides.splice(idx, 0, newSlide);
      pb.manifestDirty = true;
      if ((pb.currentSlideIndex || 0) >= idx) pb.currentSlideIndex = (pb.currentSlideIndex || 0) + 1;
      return { requiredFiles: [newSlide.file] };
    });
    if (!commit.ok) return `insert_slide 保存失败：${commit.error}。已恢复执行前状态，本轮必须停止。`;
    await this._refreshAgentPlanRevision(pb);
    const cloned = templateSlide ? `，继承第${templatePage}页 ${slideType} 模板` : '';
    const finishPage = pb.slides.findIndex(slide => slide.slide_type === 'finish') + 1;
    return `insert_slide 已插入「${newSlide.title}」（现为第${idx + 1}页，类型 ${slideType}${cloned}，共 ${pb.slides.length} 页${finishPage ? `，结束页为第${finishPage}页` : ''}）。`;
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
    const finishSlides = newSlides.filter(slide => slide.slide_type === 'finish');
    if (finishSlides.length === 1 && newSlides[newSlides.length - 1] !== finishSlides[0]) {
      return 'reorder_slides 失败：finish 结束页必须保持在最后一页';
    }
    const oldCurrentId = pb.slides[pb.currentSlideIndex]?.id;
    const commit = await this._commitAgentMutation(pb, () => {
      pb.slides = newSlides;
      pb.manifest.slides = newSlides;
      pb.currentSlideIndex = Math.max(0, newSlides.findIndex(s => s.id === oldCurrentId));
      pb.manifestDirty = true;
      return { requiredFiles: [] };
    });
    if (!commit.ok) return `reorder_slides 保存失败：${commit.error}。已恢复执行前状态，本轮必须停止。`;
    await this._refreshAgentPlanRevision(pb);
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
  },

  async _toolValidateDeck(pb) {
    const errors = [];
    const warnings = [];
    const slideResults = [];
    const finishPages = [];
    for (let index = 0; index < pb.slides.length; index++) {
      const slide = pb.slides[index];
      if (['finish', 'ending'].includes(slide.slide_type)) finishPages.push(index + 1);
      let issues;
      try {
        if (!window.PpteRules) throw new Error('PPTE 校验器未加载');
        issues = await window.PpteRules.lint(slide.html || '');
      } catch (error) {
        errors.push(`第 ${index + 1} 页无法校验：${String(error)}`);
        slideResults.push({ page: index + 1, passed: false, issues: [], validationError: String(error) });
        continue;
      }
      const hard = (issues || []).filter(issue => String(issue.severity || '').toLowerCase() === 'error');
      slideResults.push({ page: index + 1, passed: hard.length === 0, issues });
      if (hard.length) errors.push(`第 ${index + 1} 页未通过单页校验`);
    }
    if (finishPages.length > 1) errors.push('课件包含多个结束页');
    if (finishPages.length === 1 && finishPages[0] !== pb.slides.length) errors.push('结束页必须位于最后一页');

    let planPayload = { plan: null, status: 'missing' };
    try {
      planPayload = await window.__TAURI__.core.invoke('ppte_agent_plan_read', { folderPath: pb.folderPath });
    } catch (_) { /* old projects have no plan */ }
    const plan = planPayload?.plan;
    const plannedSlides = Array.isArray(plan?.slides) ? plan.slides : [];
    const plannedLayouts = plannedSlides.map(item => String(item.layoutFamily || item.layout_family || '').toLowerCase());
    const structural = new Set(['cover', 'catalog', 'immersive-chapter', 'ending', 'finish']);
    const actualLayouts = pb.slides.map((slide, index) => {
      const html = String(slide.html || '').toLowerCase();
      const role = String(slide.slide_type || '').toLowerCase();
      if (structural.has(role)) return role;
      const tagged = html.match(/data-layout-family=["']([^"']+)["']/)?.[1];
      if (tagged) return tagged.trim();
      if (/<(?:table)\b|class=["'][^"']*(?:data-table|comparison-table)/.test(html)) return 'data-table';
      if (/<(?:svg|canvas)\b|class=["'][^"']*(?:chart|graph|plot)/.test(html)) return 'data-chart';
      if (/class=["'][^"']*timeline/.test(html)) return 'timeline';
      if (/class=["'][^"']*(?:card|bento)/.test(html)) return 'card-grid';
      if (/<img\b/.test(html)) return 'image-led';
      const sectionCount = (html.match(/<(?:section|article)\b/g) || []).length;
      const columnCount = (html.match(/class=["'][^"']*(?:column|col-|split|grid)/g) || []).length;
      return `structure-${sectionCount}-${columnCount}`;
    });
    const layouts = actualLayouts;
    const contentLayouts = layouts.filter(layout => layout && !structural.has(layout));
    const families = new Set(contentLayouts);
    const cardCount = contentLayouts.filter(layout => /card|bento/.test(layout) || layout === 'feature-list').length;
    const adjacentDuplicateLayouts = [];
    for (let index = 1; index < layouts.length; index++) {
      if (layouts[index] && layouts[index] === layouts[index - 1]) adjacentDuplicateLayouts.push(index + 1);
    }
    const motionCount = pb.slides.filter(slide => /@keyframes|\banimation\s*:|\btransition\s*:|requestanimationframe|setinterval\s*\(|data-motion=/i.test(String(slide.html || ''))).length;
    for (let index = 0; index < Math.min(plannedLayouts.length, actualLayouts.length); index++) {
      if (!structural.has(actualLayouts[index]) && actualLayouts[index] !== 'unclassified' && plannedLayouts[index] && plannedLayouts[index] !== actualLayouts[index]) {
        warnings.push(`第 ${index + 1} 页实际布局 ${actualLayouts[index]} 与规划 ${plannedLayouts[index]} 不一致`);
      }
    }
    if (Number(plan?.targetSlideCount) && Number(plan.targetSlideCount) !== pb.slides.length) {
      errors.push(`当前共 ${pb.slides.length} 页，与规划目标 ${plan.targetSlideCount} 页不一致`);
    }
    if (adjacentDuplicateLayouts.length) errors.push(`相邻页面重复主构图：${adjacentDuplicateLayouts.map(page => `第 ${page} 页`).join('、')}`);
    if (contentLayouts.length >= 8 && families.size < 6) errors.push(`正文仅使用 ${families.size} 种主布局，至少需要 6 种`);
    if (contentLayouts.length && cardCount / contentLayouts.length > 0.25) errors.push(`卡片类布局占比 ${cardCount}/${contentLayouts.length}，超过 25%`);
    if (pb.slides.length >= 12 && motionCount < 3) errors.push('动画或交互页面少于 3 页');
    if (planPayload?.status === 'stale') warnings.push('课件内容已在规划后变化，建议更新规划');
    if (!plan) warnings.push('当前项目没有 LectureAI 规划，旧项目仍可正常播放和编辑');

    return JSON.stringify({
      passed: errors.length === 0,
      errors,
      warnings,
      metrics: {
        slideCount: pb.slides.length,
        layoutFamilies: families.size,
        cardLayoutCount: cardCount,
        cardRatio: Number((cardCount / Math.max(1, contentLayouts.length)).toFixed(3)),
        motionCount,
        adjacentDuplicateLayouts,
      },
      slides: slideResults,
      planStatus: planPayload?.status || 'missing',
    }, null, 2);
  }
};
