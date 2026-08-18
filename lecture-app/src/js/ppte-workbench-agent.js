// ppte-workbench-agent.js - Main-window side of the workbench Agent.
//
// The chat UI + AI loop live in a separate Tauri window (workbench.html +
// workbench-window.js). This module runs in the main window and:
//   1. injects the "工作台" toggle button into the PPTE editor header (opens the window)
//   2. rewires the per-page "AI助手" button to open the window pre-@ing the current page
//   3. answers wb-request RPC from the workbench window:
//        get-context      -> {title, slides:[{title, slideType, file}], templateBlueprint, deckPlan, skills, outline, aiConfig}
//        get-slide {page} -> html string
//        get-outline      -> outline.md content string (live editor state)
//        get-command-context {command, pages} -> target + adjacent slide/CSS context
//        import-skill     -> imported external SKILL metadata
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
      else if (type === 'get-outline') result = this._getOutline();
      else if (type === 'get-command-context') result = await this._getCommandContext(req.payload);
      else if (type === 'read-skill') result = await this._readSkill(req.payload);
      else if (type === 'import-skill') result = await this._importSkill();
      else if (type === 'execute-action') result = await this._executeAction(req.payload?.action);
      else if (type === 'pick-ppte') result = await this._pickPpte(req.payload);
      else if (type === 'recent-ppte') result = this._recentPpte();
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
    let skills = [];
    if (pb?.folderPath && window.__TAURI__?.core?.invoke) {
      try {
        deckPlan = await window.__TAURI__.core.invoke('ppte_agent_plan_read', { folderPath: pb.folderPath });
      } catch (error) {
        console.warn('Failed to read optional LectureAI plan', error);
      }
    }
    if (window.__TAURI__?.core?.invoke) {
      try {
        skills = await window.__TAURI__.core.invoke('ppte_skill_list', { folderPath: pb?.folderPath || null });
      } catch (error) {
        console.warn('Failed to list optional workbench skills', error);
      }
    }
    // outline.md is the author's handwritten chapter outline; missing is normal
    let outline = null;
    if (pb?.folderPath && window.__TAURI__?.core?.invoke) {
      try {
        outline = await window.__TAURI__.core.invoke('read_text_file', {
          filePath: `${String(pb.folderPath).replace(/[\\/]+$/, '')}/outline.md`,
        });
      } catch (error) {
        outline = null;
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
      skills,
      outline,
      aiConfig: settingsConfig,
      providers,
      defaultProvider,
      lectureAiServerUrl: window.Auth?.serverUrl || 'https://design.hz-study-system.com',
      prefillPage: this._pendingPrefill,
      currentPage: pb ? (pb.currentSlideIndex || 0) + 1 : null,
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

  _getOutline() {
    const pb = this._editor()._pptBuilder;
    if (!pb) return '';
    return String(pb.outline ?? '');
  },

  async _getCommandContext(payload) {
    const pb = this._editor()._pptBuilder;
    if (!pb || payload?.command !== 'concept-animate') return '';
    const targetPage = Number(payload?.pages?.[0] || (pb.currentSlideIndex || 0) + 1);
    if (!Number.isInteger(targetPage) || targetPage < 1 || targetPage > pb.slides.length) {
      throw new Error(`概念动画目标页 ${targetPage} 超出范围`);
    }
    const pages = [...new Set([targetPage - 1, targetPage, targetPage + 1])]
      .filter(page => page >= 1 && page <= pb.slides.length);
    const sections = pages.map(page => {
      const slide = pb.slides[page - 1];
      const role = page === targetPage ? '目标页' : '相邻页';
      const limit = page === targetPage ? 90000 : 25000;
      const source = String(slide.html || '');
      const html = source.length > limit ? `${source.slice(0, limit)}\n<!-- 上下文已截断 -->` : source;
      return `[${role} 第${page}页「${slide.title || '无标题'}」]\n\`\`\`html\n${html}\n\`\`\``;
    });
    const stylesheetRefs = [...new Set(pages.flatMap(page => this._stylesheetRefs(pb.slides[page - 1]?.html)))];
    for (const reference of stylesheetRefs.slice(0, 3)) {
      if (!reference || /^(?:[a-z]+:|\/|#|data:)/i.test(reference) || reference.includes('..')) continue;
      const normalized = reference.split(/[?#]/)[0].replace(/^\.\//, '');
      if (!normalized) continue;
      try {
        const css = await window.__TAURI__.core.invoke('read_text_file', {
          filePath: `${pb.folderPath.replace(/[\\/]+$/, '')}/${normalized}`,
        });
        sections.push(`[现有样式 ${normalized}]\n\`\`\`css\n${String(css || '').slice(0, 18000)}\n\`\`\``);
      } catch (_) { /* optional stylesheet context */ }
    }
    return [
      `[客户端已准备 /concept-animate 上下文]\n目标页：第 ${targetPage} 页。修改时必须保持相邻页的共同对象、配色与位置连续。`,
      ...sections,
    ].join('\n\n');
  },

  async _readSkill(payload) {
    const pb = this._editor()._pptBuilder;
    return await window.__TAURI__.core.invoke('ppte_skill_read', {
      folderPath: pb?.folderPath || null,
      skillId: payload?.skillId || '',
      relativePath: payload?.relativePath || null,
    });
  },

  async _importSkill() {
    let sourcePath;
    try {
      // showHidden lets the macOS picker display dot-directories such as
      // ~/.claude/skills and ~/.agents/skills.
      sourcePath = await window.__TAURI__.core.invoke('pick_folder', { showHidden: true });
    } catch (error) {
      if (String(error) === 'cancelled') return { cancelled: true, imported: [], skipped: [] };
      throw error;
    }
    return await window.__TAURI__.core.invoke('ppte_skill_import', { sourcePath });
  },

  // Open a PPTE folder picker in the main window (requested by the workbench
  // window when no course is connected); _onRequest emits wb-refresh afterwards.
  // With payload.path the workbench already chose a recently opened PPTE, so
  // open it directly instead of showing the disk picker.
  async _pickPpte(payload) {
    try {
      const editor = this._editor();
      if (payload?.path) {
        const opener = editor.openPptExtraPath?.bind(editor) || window.Settings?.openPptExtraPath?.bind(window.Settings);
        if (!opener) return 'openPptExtraPath unavailable';
        await opener(payload.path);
        return 'ok';
      }
      const opener = editor.openPptExtra?.bind(editor) || window.Settings?.openPptExtra?.bind(window.Settings);
      if (opener) await opener();
      return 'ok';
    } catch (e) {
      return String(e);
    }
  },

  // Recently opened PPTE list for the workbench's "选择打开过的 PPTE" picker.
  _recentPpte() {
    const recent = window.CourseLoader?.appConfig?.recentPpte || [];
    return {
      items: recent.slice(0, 30).map(item => ({
        title: String(item?.title || '未命名'),
        path: String(item?.path || ''),
      })).filter(item => item.path),
    };
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
        case 'write_outline': return await this._toolWriteOutline(pb, a);
        case 'search_icons': return await this._toolSearchIcons(a);
        case 'use_icon': return await this._toolUseIcon(pb, a);
        case 'search_design_examples': return await this._toolSearchDesignExamples(a);
        case 'render_template': return await this._toolRenderTemplate(pb, a);
        case 'apply_role_template': return await this._toolApplyRoleTemplate(pb, a);
        case 'write_slide': return await this._toolWriteSlide(pb, a);
        case 'insert_slide': return await this._toolInsertSlide(pb, a);
        case 'reorder_slides': return await this._toolReorderSlides(pb, a);
        case 'read_slide': return this._toolReadSlide(pb, a);
        case 'load_skill': return await this._toolLoadSkill(a);
        case 'read_skill_resource': return await this._toolReadSkillResource(a);
        case 'inspect_slides': return await this._toolInspectSlides(pb, a);
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
    this._activeDeckPlan = { folderPath: pb.folderPath, plan: saved };
    const count = Number(saved?.targetSlideCount || 0);
    return `set_deck_plan 已保存课件蓝图${count ? `（目标 ${count} 页）` : ''}。`;
  },

  // Writes outline.md through the editor's own state + transactional save, so
  // the 大纲 tab and the anti-overwrite baseline stay consistent.
  async _toolWriteOutline(pb, a) {
    const content = String(a?.content ?? '');
    if (!content.trim()) return 'write_outline 失败：content 不能为空';
    if (pb.outlineDirty) {
      return 'write_outline 失败：大纲在编辑器里有未保存的修改，为避免覆盖没有写入。请在主窗口大纲页签中保存或放弃修改后重试。';
    }
    const previousOutline = pb.outline || '';
    const previousDirty = !!pb.outlineDirty;
    pb.outline = content;
    pb.outlineDirty = true;
    // Reflect into the 大纲 tab if it is currently open
    const edit = document.getElementById('ppte-outline-edit');
    if (edit && pb.activeTab === 'outline') edit.value = content;
    this._editor()._updatePptOutlineStatus?.();
    try {
      const result = await this._editor()._savePptBuilderData(pb, { interactiveConflicts: false });
      if (result?.cancelled || (result?.conflicts || []).length) {
        pb.outline = previousOutline;
        pb.outlineDirty = previousDirty;
        if (edit && pb.activeTab === 'outline') edit.value = previousOutline;
        this._editor()._updatePptOutlineStatus?.();
        return 'write_outline 失败：outline.md 在磁盘上被外部修改过，未覆盖。请在主窗口处理后重试。';
      }
      return `write_outline 已保存 outline.md（${content.length} 字）。`;
    } catch (error) {
      pb.outline = previousOutline;
      pb.outlineDirty = previousDirty;
      if (edit && pb.activeTab === 'outline') edit.value = previousOutline;
      this._editor()._updatePptOutlineStatus?.();
      return `write_outline 保存失败：${String(error)}`;
    }
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

  async _toolSearchIcons(a) {
    const token = window.Auth?.getToken() || '';
    const result = await window.__TAURI__.core.invoke('lectureai_icon_search', {
      authToken: token,
      query: String(a.query || ''),
    });
    const items = Array.isArray(result?.items) ? result.items : [];
    if (!items.length) return 'search_icons 没有匹配的图标，可换个名称或省略 query 列出全部';
    const lines = items.map(item => `- ${item.file}（${item.name}${item.aliases?.length ? `，别名：${item.aliases.join('、')}` : ''}）`);
    return `search_icons 匹配 ${items.length} 个图标：\n${lines.join('\n')}`;
  },

  // Downloads one library icon into the deck's resources/ so the PPTE stays
  // self-contained (backup / copy / export all carry it).
  async _toolUseIcon(pb, a) {
    const file = String(a?.file || '').trim();
    if (!file) return 'use_icon 失败：缺少 file 字段（先用 search_icons 查询图标文件名）';
    const token = window.Auth?.getToken() || '';
    const relPath = await window.__TAURI__.core.invoke('ppte_download_icon', {
      folderPath: pb.folderPath,
      file,
      authToken: token,
    });
    return `use_icon 已下载到 ${relPath}。页面 HTML 中用 <img src="${relPath}"> 引用；write_slide / render_template 可直接使用该路径。`;
  },

  async _toolRenderTemplate(pb, a) {
    if (!a.template_id || !a.payload || typeof a.payload !== 'object') {
      return 'render_template 失败：缺少 template_id 或结构化 payload';
    }
    const mode = a.mode || (Number.isInteger(a.page) ? 'replace' : 'insert');
    const page = Number(a.page || 0);
    if (mode === 'replace' && (!Number.isInteger(page) || page < 1 || page > pb.slides.length)) {
      return `render_template 失败：页码 ${page} 超出范围（共 ${pb.slides.length} 页）`;
    }
    if (mode !== 'replace' && mode !== 'insert') return 'render_template 失败：mode 必须是 insert 或 replace';
    const token = window.Auth?.getToken() || '';
    const resources = await window.__TAURI__.core.invoke('list_ppte_resources', { folderPath: pb.folderPath });
    const availableAssets = (Array.isArray(resources) ? resources : [])
      .filter(item => !['manifest', 'slide', 'note'].includes(item.kind))
      .map(item => item.path);
    const hostStylesheets = (Array.isArray(resources) ? resources : [])
      .filter(item => item.kind === 'style' && item.path === 'content.css')
      .map(item => item.path);
    const rendered = await window.__TAURI__.core.invoke('lectureai_render_template', {
      authToken: token,
      request: {
        template_id: a.template_id,
        template_version: a.template_version || null,
        payload: a.payload,
        role: a.role || 'content',
        available_assets: availableAssets,
        host_stylesheets: hostStylesheets,
      },
    });
    if (!rendered?.html || rendered?.validation?.passed !== true) {
      return 'render_template 失败：服务端没有返回通过校验的最终页面';
    }
    const title = String(a.title || a.payload.title || '模板页面').trim() || '模板页面';
    if (mode === 'replace') {
      return this._toolWriteSlide(pb, {
        tool: 'write_slide',
        page,
        html: rendered.html,
        title,
        slide_type: a.slide_type || 'content',
        note: a.note,
        _templateId: rendered.template_id,
      }).then(result => result.replace(/^write_slide/, `render_template(${rendered.template_id})`));
    }
    return this._toolInsertSlide(pb, {
      tool: 'insert_slide',
      after: Number(a.after || 0),
      title,
      html: rendered.html,
      slide_type: a.slide_type || 'content',
      note: a.note,
      _templateId: rendered.template_id,
    }).then(result => result.replace(/^insert_slide/, `render_template(${rendered.template_id})`));
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
    const existingRole = pb.slides[i].slide_type || 'content';
    const targetRole = a.slide_type || existingRole;
    const plannedRole = this._plannedRoleForPage(pb, page);
    const plannedPlaceholderConversion = ['catalog', 'chapter'].includes(existingRole)
      && targetRole === 'content'
      && plannedRole === 'content';
    const protectedRole = ['cover', 'catalog', 'chapter', 'finish'].includes(existingRole) && !plannedPlaceholderConversion
      ? existingRole
      : targetRole;
    const roleError = this._protectedRoleWriteError(
      protectedRole,
      a.html || '',
      this._roleStylesheets(pb, protectedRole),
      this._roleTemplateHtml(pb, protectedRole),
    );
    if (roleError) return `write_slide 失败：${roleError}`;
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

  async _toolApplyRoleTemplate(pb, a) {
    const page = Number(a.page || 0);
    const index = page - 1;
    const role = String(a.role || '').trim().toLowerCase();
    if (index < 0 || index >= pb.slides.length) return `apply_role_template 失败：页码 ${page} 超出范围`;
    if (!['cover', 'catalog', 'chapter', 'content', 'finish'].includes(role)) return `apply_role_template 失败：不支持角色 ${role || '空值'}`;
    const html = this._roleTemplateHtml(pb, role);
    if (!html) return `apply_role_template 失败：未找到 ${role} 角色母版`;
    const commit = await this._commitAgentMutation(pb, () => {
      this._markTemplateInitialized(pb);
      pb.slides[index].html = html;
      pb.slides[index].slide_type = role;
      pb.slides[index].title = String(a.title || pb.slides[index].title || '').trim();
      pb.slides[index].dirty = true;
      pb.manifestDirty = true;
      return { requiredFiles: [pb.slides[index].file] };
    });
    if (!commit.ok) return `apply_role_template 保存失败：${commit.error}。已恢复执行前状态，本轮必须停止。`;
    await this._refreshAgentPlanRevision(pb);
    return `apply_role_template 已将第${page}页初始化为 ${role} 角色母版。`;
  },

  _plannedRoleForPage(pb, page) {
    const active = this._activeDeckPlan;
    if (!active || active.folderPath !== pb?.folderPath || !Array.isArray(active.plan?.slides)) return '';
    const planned = active.plan.slides.find(slide => Number(slide?.page) === Number(page));
    const role = String(planned?.role || planned?.slide_type || '').trim().toLowerCase();
    return role === 'toc' ? 'catalog' : role === 'finish' || role === 'ending' ? 'finish' : role;
  },

  _roleStylesheets(pb, role) {
    const roleFile = pb?.manifest?.agentTemplate?.roles?.find(item => item.slideType === role)?.file;
    const source = roleFile
      ? pb?.slides?.find(slide => slide.file === roleFile)
      : pb?.slides?.find(slide => slide.slide_type === role);
    return this._stylesheetRefs(source?.html);
  },

  _roleTemplateHtml(pb, role) {
    const roleFile = pb?.manifest?.agentTemplate?.roles?.find(item => item.slideType === role)?.file;
    const source = roleFile
      ? pb?.slides?.find(slide => slide.file === roleFile)
      : pb?.slides?.find(slide => slide.slide_type === role);
    return String(source?.html || '');
  },

  _protectedRoleWriteError(role, html, expectedStylesheets = [], originalHtml = '') {
    const source = String(html || '');
    if (['cover', 'catalog', 'chapter', 'finish'].includes(role)) {
      for (const stylesheet of expectedStylesheets) {
        const escaped = String(stylesheet).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (!new RegExp(`<link\\b[^>]*href=["']${escaped}["']`, 'i').test(source)) {
          return `${role} 页面必须保留角色母版样式 ${stylesheet}`;
        }
      }
      const styleBlocks = value => [...String(value || '').matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
        .map(match => match[1].replace(/\s+/g, ' ').trim());
      if (JSON.stringify(styleBlocks(source)) !== JSON.stringify(styleBlocks(originalHtml))) {
        return `${role} 页面不能新增或修改角色母版的内联样式`;
      }
    }
    if (role === 'finish') {
      const visibleText = value => String(value || '')
        .replace(/<!--([\s\S]*?)-->/g, '')
        .replace(/<(?:script|style)\b[\s\S]*?<\/(?:script|style)>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (visibleText(source) !== visibleText(originalHtml)) {
        return '结束页必须保留角色母版的可见内容，背景已有文字时不能叠加正文';
      }
    }
    return '';
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
    const roleError = this._protectedRoleWriteError(
      slideType,
      newSlide.html,
      this._roleStylesheets(pb, slideType),
      this._roleTemplateHtml(pb, slideType),
    );
    if (roleError) return `insert_slide 失败：${roleError}`;
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

  async _toolReadSkillResource(a) {
    if (!a.skill_id || !a.path) return 'read_skill_resource 失败：需提供 skill_id 和 path';
    const document = await this._readSkill({ skillId: a.skill_id, relativePath: a.path });
    return `Skill ${document.info?.name || a.skill_id} 资源 ${a.path}：\n\`\`\`${this._skillFenceLanguage(a.path)}\n${document.content || ''}\n\`\`\``;
  },

  async _toolLoadSkill(a) {
    if (!a.skill_id) return 'load_skill 失败：需提供 skill_id';
    const document = await this._readSkill({ skillId: a.skill_id });
    return [
      `[已加载 SKILL $${document.info?.name || a.skill_id}]`,
      `skill_id: ${document.info?.id || a.skill_id}`,
      `来源: ${document.info?.sourceLabel || ''}`,
      document.files?.length ? `可按需读取的资源: ${document.files.join('、')}` : '无附加资源',
      document.content || '',
    ].join('\n');
  },

  _skillFenceLanguage(path) {
    const extension = String(path || '').split('.').pop().toLowerCase();
    return ({ md: 'markdown', js: 'javascript', ts: 'typescript', py: 'python', sh: 'bash', yml: 'yaml' })[extension] || extension;
  },

  async _toolInspectSlides(pb, a) {
    const allowed = new Set(['font', 'overflow', 'density', 'card', 'copy', 'motion', 'concept-animation', 'quality']);
    const check = String(a.check || '').toLowerCase();
    if (!allowed.has(check)) return `inspect_slides 失败：check 必须为 ${[...allowed].join('/')}`;
    const requested = Array.isArray(a.pages) && a.pages.length
      ? [...new Set(a.pages.map(Number).filter(Number.isInteger))]
      : pb.slides.map((_, index) => index + 1);
    const invalid = requested.filter(page => page < 1 || page > pb.slides.length);
    if (invalid.length) return `inspect_slides 失败：页码 ${invalid.join('、')} 超出范围（共 ${pb.slides.length} 页）`;

    const slides = [];
    for (const page of requested) {
      const slide = pb.slides[page - 1];
      let issues = [];
      try {
        issues = await this._inspectRenderedSlide(pb, slide, check);
      } catch (error) {
        issues = [{ severity: 'error', rule: 'render-failed', message: `渲染检查失败：${String(error)}` }];
      }
      slides.push({
        page,
        title: slide.title || `第 ${page} 页`,
        passed: !issues.some(issue => issue.severity === 'error'),
        issues,
      });
    }
    const issueCount = slides.reduce((total, slide) => total + slide.issues.length, 0);
    const errorCount = slides.reduce((total, slide) => total + slide.issues.filter(issue => issue.severity === 'error').length, 0);
    return JSON.stringify({
      check,
      scope: requested,
      passed: errorCount === 0,
      summary: `检查 ${requested.length} 页，发现 ${errorCount} 个必须修复项、${issueCount - errorCount} 个建议项`,
      errorCount,
      warningCount: issueCount - errorCount,
      slides,
    }, null, 2);
  },

  async _inspectRenderedSlide(pb, slide, check) {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-same-origin');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText = 'position:fixed;left:-12000px;top:0;width:1920px;height:1080px;border:0;visibility:hidden;pointer-events:none;';
    document.body.appendChild(iframe);
    try {
      const baseHref = `${this._editor()._slideProtocolUrl(pb.folderPath).replace(/\/+$/, '')}/`;
      const wrapped = this._editor()._wrapPptHtmlForVisualEditor
        ? this._editor()._wrapPptHtmlForVisualEditor(slide.html || '', baseHref)
        : String(slide.html || '');
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 1800);
        iframe.onload = () => { clearTimeout(timer); resolve(); };
        iframe.srcdoc = wrapped;
      });
      const doc = iframe.contentDocument;
      const win = iframe.contentWindow;
      if (!doc || !win) throw new Error('无法访问检查画布');
      try { await Promise.race([doc.fonts?.ready || Promise.resolve(), new Promise(resolve => setTimeout(resolve, 600))]); } catch (_) { /* ignore font load errors */ }
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return await this._collectSlideInspection(doc, win, slide, check);
    } finally {
      iframe.remove();
    }
  },

  _conceptAnimationSourceIssues(rawHtml) {
    const html = String(rawHtml || '');
    const issues = [];
    const add = (rule, message) => issues.push({ severity: 'error', rule, message });
    const tags = html.match(/<[a-z][^>]*>/gi) || [];
    const attr = (tag, name) => {
      const match = String(tag || '').match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i'));
      return match ? match[1] : '';
    };
    const hasClass = (tag, className) => attr(tag, 'class').split(/\s+/).includes(className);
    const rootTag = tags.find(tag => /\bdata-ppte-concept-animation(?:\s|=|>)/i.test(tag));
    if (!rootTag) {
      add('concept-root-missing', '缺少 data-ppte-concept-animation 标准分步动画根节点');
      return issues;
    }

    const maxStep = Number(attr(rootTag, 'data-max-step'));
    if (!Number.isInteger(maxStep) || maxStep < 3 || maxStep > 6) add('concept-step-count', 'data-max-step 必须为 3-6');
    if (attr(rootTag, 'data-step') !== '0') add('concept-initial-step', '分步动画默认状态必须从 data-step="0" 开始');
    if (!tags.some(tag => hasClass(tag, 'ppte-click-canvas'))) add('concept-stable-canvas', '缺少保持稳定的 .ppte-click-canvas 主画布');
    if (!tags.some(tag => hasClass(tag, 'ppte-step-rail'))) add('concept-step-rail', '缺少底部 .ppte-step-rail 步骤栏');

    const nodeTags = tags.filter(tag => /<button\b/i.test(tag) && hasClass(tag, 'ppte-step-node'));
    const targets = nodeTags.map(tag => Number(attr(tag, 'data-target-step')));
    const mainCount = tags.filter(tag => hasClass(tag, 'ppte-step-main')).length;
    const subCount = tags.filter(tag => hasClass(tag, 'ppte-step-sub')).length;
    const layerCount = tags.filter(tag => attr(tag, 'data-show-from') !== '').length;
    const dotsBlock = html.match(/<div\b[^>]*class=["'][^"']*\bppte-step-dots\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    const dotCount = dotsBlock ? (dotsBlock[1].match(/<span\b/gi) || []).length : 0;
    if (!dotsBlock) add('concept-step-dots', '缺少右下角 .ppte-step-dots 进度点');
    if (Number.isInteger(maxStep)) {
      if (nodeTags.length !== maxStep) add('concept-node-count', `步骤按钮 ${nodeTags.length} 个，应为 ${maxStep} 个`);
      if (dotCount !== maxStep + 1) add('concept-dot-count', `进度点 ${dotCount} 个，应为 ${maxStep + 1} 个（含初始状态）`);
      if (!Array.from({ length: maxStep }, (_, index) => index + 1).every(step => targets.includes(step))) add('concept-step-targets', '步骤按钮必须覆盖从 1 到 data-max-step 的每一步');
      if (mainCount !== maxStep || subCount !== maxStep) add('concept-two-line-node', '每个步骤按钮必须各含一个 .ppte-step-main 和 .ppte-step-sub');
      if (layerCount < maxStep + 1) add('concept-layer-count', '每个认知步骤应有独立 data-show-from 图层，并保留共享画布图层');
    }

    if (!/@media\s*\(prefers-reduced-motion\s*:\s*reduce\)/i.test(html)) add('concept-reduced-motion', '缺少 prefers-reduced-motion 兼容');
    if (!/\.ppte-click-layer\s*\{[^}]*position\s*:\s*absolute/is.test(html) || !/\.ppte-click-layer\.is-visible\s*\{/i.test(html)) add('concept-layer-style', '显隐图层必须使用稳定的绝对定位，并提供 .is-visible 状态');
    if (!/addEventListener\s*\(\s*["']click["']/i.test(html)) add('concept-click-control', '缺少点击推进或步骤按钮交互');
    if (!/addEventListener\s*\(\s*["']keydown["']/i.test(html)) add('concept-keyboard-control', '缺少键盘前进与回退交互');
    if (!/closest\s*\(\s*["']\[data-target-step\]["']\s*\)/i.test(html) || !/dataset\.targetStep/.test(html)) add('concept-direct-step-control', '步骤按钮必须支持点击后直接跳到对应 data-target-step');
    if (!/current\s*\+\s*1/.test(html) || !/current\s*-\s*1/.test(html)) add('concept-single-step-control', '前进或后退一次只能改变一个步骤');
    if (!/ArrowRight/.test(html) || !/PageDown/.test(html) || !/ArrowLeft/.test(html) || !/PageUp/.test(html) || !/["'] ["']/.test(html)) add('concept-key-map', '必须支持 Right/Space/PageDown 前进与 Left/PageUp 回退');
    if (!/current\s*<\s*maxStep/.test(html) || !/current\s*>\s*0/.test(html)) add('concept-boundary-navigation', '键盘拦截必须受当前步骤边界控制，末步放行宿主翻页');
    if (/setInterval\s*\(/i.test(html) || /animation-iteration-count\s*:\s*infinite|animation\s*:[^;}]*\binfinite\b/i.test(html)) add('concept-autoplay-loop', '分步讲解禁止自动播放或无限循环');
    if (/点击继续|单击继续|按空格继续/.test(html)) add('concept-visible-instruction', '页面不得显示“点击继续”等操作提示');
    return issues;
  },

  async _collectSlideInspection(doc, win, slide, check) {
    const issues = [];
    const categories = check === 'quality'
      ? new Set(['font', 'overflow', 'density', 'card', 'copy'])
      : (check === 'concept-animation'
        ? new Set(['font', 'overflow', 'copy', 'motion', 'concept-animation'])
        : new Set([check]));
    const add = (severity, rule, message, sample) => {
      const key = `${rule}|${message}|${sample || ''}`;
      if (issues.some(issue => issue._key === key)) return;
      issues.push({ severity, rule, message, ...(sample ? { sample } : {}), _key: key });
    };
    const visible = element => {
      const style = win.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
    };
    const label = element => {
      const cls = typeof element.className === 'string' && element.className.trim()
        ? `.${element.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
      return `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : cls}`;
    };
    const textElements = [...doc.body.querySelectorAll('*')].filter(element => {
      if (/^(SCRIPT|STYLE|SVG|PATH|DEFS|USE|BR|HR|IMG|VIDEO|CANVAS)$/.test(element.tagName)) return false;
      return [...element.childNodes].some(node => node.nodeType === 3 && String(node.textContent || '').trim()) && visible(element);
    });
    const conceptRoot = categories.has('concept-animation') ? doc.querySelector('[data-ppte-concept-animation]') : null;
    const copyElements = conceptRoot
      ? [conceptRoot, ...conceptRoot.querySelectorAll('*')].filter(element => {
        if (/^(SCRIPT|STYLE|SVG|PATH|DEFS|USE|BR|HR|IMG|VIDEO|CANVAS)$/.test(element.tagName)) return false;
        return [...element.childNodes].some(node => node.nodeType === 3 && String(node.textContent || '').trim());
      })
      : textElements;

    if (categories.has('font')) {
      const auxiliary = /caption|tag|label|marker|page-number|page_number|meta|kicker|eyebrow|footnote|hint|badge|small/i;
      for (const element of textElements) {
        const size = parseFloat(win.getComputedStyle(element).fontSize || '0');
        const minimum = element.tagName === 'H1'
          ? 57.6
          : (/^H[23]$/.test(element.tagName)
            ? 38.4
            : (auxiliary.test(`${element.tagName} ${element.className || ''}`) || element.tagName === 'SMALL' ? 28.8 : 34.56));
        if (size + 0.25 < minimum) {
          add('error', 'font-too-small', `${label(element)} 实际字号 ${(size / 19.2).toFixed(2)}vw，低于 ${(minimum / 19.2).toFixed(1)}vw`, String(element.textContent || '').trim().slice(0, 48));
        }
      }
      const pxDecl = /font-size\s*:\s*(\d+(?:\.\d+)?)px\b/gi;
      for (const style of doc.querySelectorAll('style, [style]')) {
        const source = style.tagName === 'STYLE' ? style.textContent : style.getAttribute('style');
        let match;
        while ((match = pxDecl.exec(String(source || '')))) {
          add('error', 'font-px-unit', `发现 ${match[1]}px 字号声明，PPTE 字号必须使用 vw`, label(style));
        }
      }
      for (const sheet of [...doc.styleSheets]) {
        if (sheet.ownerNode?.tagName === 'STYLE') continue;
        let rules = [];
        try { rules = [...(sheet.cssRules || [])]; } catch (_) { continue; }
        const walkRules = nested => {
          for (const rule of nested) {
            const cssText = String(rule.cssText || '');
            pxDecl.lastIndex = 0;
            let match;
            while ((match = pxDecl.exec(cssText))) {
              add('error', 'font-px-unit', `外部样式中发现 ${match[1]}px 字号声明，PPTE 字号必须使用 vw`, sheet.href || 'stylesheet');
            }
            if (rule.cssRules) walkRules([...rule.cssRules]);
          }
        };
        walkRules(rules);
      }
    }

    if (categories.has('overflow')) {
      const root = doc.documentElement;
      const body = doc.body;
      if (Math.max(root.scrollWidth, body.scrollWidth) > 1922 || Math.max(root.scrollHeight, body.scrollHeight) > 1082) {
        add('error', 'page-overflow', `页面内容尺寸 ${Math.max(root.scrollWidth, body.scrollWidth)}×${Math.max(root.scrollHeight, body.scrollHeight)} 超出 1920×1080 画布`);
      }
      for (const element of [...body.querySelectorAll('*')]) {
        if (!visible(element) || /^(SCRIPT|STYLE|SVG|PATH|DEFS)$/.test(element.tagName)) continue;
        const rect = element.getBoundingClientRect();
        if (rect.left < -2 || rect.top < -2 || rect.right > 1922 || rect.bottom > 1082) {
          add('error', 'element-outside-canvas', `${label(element)} 越出画布边界`, `${Math.round(rect.left)},${Math.round(rect.top)} → ${Math.round(rect.right)},${Math.round(rect.bottom)}`);
        }
      }
      for (const area of doc.querySelectorAll('.content-area')) {
        if (area.scrollHeight > area.clientHeight + 2 || area.scrollWidth > area.clientWidth + 2) {
          add('error', 'content-area-overflow', `.content-area 内容 ${area.scrollWidth}×${area.scrollHeight} 超出可用区 ${area.clientWidth}×${area.clientHeight}`);
        }
        const style = win.getComputedStyle(area);
        if (style.overflow === 'hidden' || style.overflowY === 'hidden') {
          add('error', 'hidden-overflow', '.content-area 使用 overflow:hidden，可能掩盖内容裁切');
        }
      }
    }

    const cards = [...doc.querySelectorAll('.card, [class$="-card"], [class*="-card "], .kpi, .panel, .tile')].filter(visible);
    const cardMetrics = cards.map(card => {
      const rect = card.getBoundingClientRect();
      const children = [...card.children].filter(visible).map(child => child.getBoundingClientRect());
      if (!children.length) return { card, rect, usedHeight: 0, blankRatio: 1 };
      const top = Math.min(...children.map(item => item.top));
      const bottom = Math.max(...children.map(item => item.bottom));
      const usedHeight = Math.max(0, bottom - top);
      return { card, rect, usedHeight, blankRatio: Math.max(0, 1 - usedHeight / Math.max(1, rect.height)) };
    });

    if (categories.has('density') && !['cover', 'chapter', 'finish'].includes(slide.slide_type)) {
      const area = doc.querySelector('.content-area') || doc.body;
      const areaRect = area.getBoundingClientRect();
      const nodes = [...area.children].filter(visible).map(child => child.getBoundingClientRect());
      if (nodes.length) {
        const left = Math.min(...nodes.map(rect => rect.left));
        const top = Math.min(...nodes.map(rect => rect.top));
        const right = Math.max(...nodes.map(rect => rect.right));
        const bottom = Math.max(...nodes.map(rect => rect.bottom));
        const footprint = Math.max(0, right - left) * Math.max(0, bottom - top);
        const ratio = footprint / Math.max(1, areaRect.width * areaRect.height);
        if (ratio < 0.24) add('error', 'content-too-sparse', `内容仅占安全区约 ${Math.round(ratio * 100)}%，页面显得过空`);
      }
      for (const metric of cardMetrics) {
        if (metric.rect.height > 180 && metric.blankRatio > 0.48) {
          add('error', 'card-too-empty', `${label(metric.card)} 高 ${Math.round(metric.rect.height)}px，内部约 ${Math.round(metric.blankRatio * 100)}% 为空白`);
        }
      }
    }

    if (categories.has('card')) {
      for (const metric of cardMetrics) {
        const style = win.getComputedStyle(metric.card);
        if (metric.rect.height > 180 && metric.blankRatio > 0.48) {
          add('error', 'card-too-empty', `${label(metric.card)} 高度明显大于内容`, `空白约 ${Math.round(metric.blankRatio * 100)}%`);
        }
        if (style.borderLeftWidth !== style.borderRightWidth || style.borderTopWidth !== style.borderBottomWidth) {
          add('error', 'card-accent-stripe', `${label(metric.card)} 使用不对称边框，疑似高亮侧边条`);
        }
        if (style.backgroundImage && style.backgroundImage !== 'none' && /gradient/i.test(style.backgroundImage)) {
          add('error', 'card-gradient', `${label(metric.card)} 使用渐变卡片背景`);
        }
      }
      if (cards.length >= 6) add('warn', 'too-many-cards', `本页包含 ${cards.length} 个卡片容器，建议改用表格、流程或关系图`);
    }

    if (categories.has('copy')) {
      const forbidden = /(我们|我会|大家|同学|老师|接下来|下面|先看|再看|最后看|很关键|非常重要|一定要注意|希望大家|课堂上|演示时|讲解时|可以看到)/;
      for (const element of copyElements) {
        const text = String(element.textContent || '').replace(/\s+/g, ' ').trim();
        if (forbidden.test(text)) add('error', 'teacher-facing-copy', `${label(element)} 含课堂或讲师口吻`, text.slice(0, 60));
        if (/[？?]$/.test(text) && !/^(GET|POST|PUT|DELETE|SELECT|curl\b)/i.test(text)) add('error', 'question-copy', `${label(element)} 使用提问式屏显文案`, text.slice(0, 60));
        if (text.length > 45 && !/^(PRE|CODE)$/.test(element.tagName)) add('warn', 'copy-too-long', `${label(element)} 单段 ${text.length} 字，投影阅读负担较高`, text.slice(0, 60));
      }
    }

    if (categories.has('motion')) {
      const source = `${[...doc.querySelectorAll('style')].map(style => style.textContent).join('\n')}\n${[...doc.querySelectorAll('script')].map(script => script.textContent).join('\n')}\n${doc.body.innerHTML}`;
      const meaningful = /@keyframes|\banimation\s*:|data-motion|class=["'][^"']*(?:reveal|step|stage)|addEventListener\s*\(\s*["'](?:click|keydown)|requestAnimationFrame/i.test(source);
      if (!meaningful) add('error', 'motion-missing', '页面未检测到分步揭示、状态转换或可控动画');
    }

    if (categories.has('concept-animation')) {
      for (const issue of this._conceptAnimationSourceIssues(slide.html || '')) add(issue.severity, issue.rule, issue.message);
      const root = doc.querySelector('[data-ppte-concept-animation]');
      if (!root) {
        add('error', 'concept-root-missing', '缺少 data-ppte-concept-animation 标准分步动画根节点');
      } else {
        const maxStep = Number(root.dataset.maxStep);
        const initialStep = Number(root.dataset.step);
        const nodes = [...root.querySelectorAll('[data-target-step]')];
        const targets = nodes.map(node => Number(node.dataset.targetStep));
        const dots = [...root.querySelectorAll('.ppte-step-dots span')];
        const layers = [...root.querySelectorAll('[data-show-from]')];
        if (!Number.isInteger(maxStep) || maxStep < 3 || maxStep > 6) add('error', 'concept-step-count', 'data-max-step 必须为 3-6');
        if (initialStep !== 0) add('error', 'concept-initial-step', '分步动画默认状态必须从 data-step="0" 开始');
        if (!root.querySelector('.ppte-click-canvas')) add('error', 'concept-stable-canvas', '缺少保持稳定的 .ppte-click-canvas 主画布');
        if (!root.matches('.content-area') && !root.closest('.content-area')) add('error', 'concept-content-area', '标准分步动画必须放在现有 .content-area 安全区内');
        if (!root.querySelector('.ppte-step-rail')) add('error', 'concept-step-rail', '缺少底部 .ppte-step-rail 步骤栏');
        if (!root.querySelector('.ppte-step-dots')) add('error', 'concept-step-dots', '缺少右下角 .ppte-step-dots 进度点');
        if (Number.isInteger(maxStep) && nodes.length !== maxStep) add('error', 'concept-node-count', `步骤按钮 ${nodes.length} 个，应为 ${maxStep} 个`);
        if (Number.isInteger(maxStep) && dots.length !== maxStep + 1) add('error', 'concept-dot-count', `进度点 ${dots.length} 个，应为 ${maxStep + 1} 个（含初始状态）`);
        if (Number.isInteger(maxStep) && !Array.from({ length: maxStep }, (_, index) => index + 1).every(step => targets.includes(step))) add('error', 'concept-step-targets', '步骤按钮必须覆盖从 1 到 data-max-step 的每一步');
        for (const node of nodes) {
          if (!node.querySelector('.ppte-step-main') || !node.querySelector('.ppte-step-sub')) add('error', 'concept-two-line-node', '每个步骤按钮必须包含 .ppte-step-main 和 .ppte-step-sub 两行文字');
        }
        if (layers.length < maxStep + 1) add('error', 'concept-layer-count', '每个认知步骤应有独立 data-show-from 图层，并保留共享画布图层');
      }
    }

    if (categories.has('quality') || ['font', 'card', 'copy'].some(category => categories.has(category))) {
      try {
        const lintIssues = window.PpteRules ? await window.PpteRules.lint(slide.html || '') : [];
        for (const issue of lintIssues || []) {
          const rule = String(issue.rule || 'static-rule');
          const lower = rule.toLowerCase();
          const relevant = check === 'quality'
            || (categories.has('font') && /字体|字号|font/.test(rule))
            || (categories.has('card') && /卡片|边条|背景/.test(rule))
            || (categories.has('copy') && /书面|讲师|句号|破折号/.test(rule));
          if (relevant) add(issue.severity === 'error' ? 'error' : 'warn', `static-${lower}`, issue.message, issue.sample);
        }
      } catch (_) { /* rendered checks remain useful without the backend linter */ }
    }

    return issues.map(({ _key, ...issue }) => issue);
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
      const templateId = html.match(/\bdata-template\s*=\s*["']([^"']+)["']/i)?.[1];
      if (templateId) return `template:${templateId}`;
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
    for (let index = 0; index < Math.min(plannedSlides.length, pb.slides.length); index++) {
      const expectedTemplate = String(plannedSlides[index]?.templateId || plannedSlides[index]?.template_id || '').trim();
      if (!expectedTemplate) continue;
      const actualTemplate = String(pb.slides[index]?.html || '').match(/\bdata-template\s*=\s*["']([^"']+)["']/i)?.[1] || '';
      if (actualTemplate !== expectedTemplate) {
        errors.push(`第 ${index + 1} 页实际模板 ${actualTemplate || '未标记'} 与规划 ${expectedTemplate} 不一致`);
      }
    }
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
