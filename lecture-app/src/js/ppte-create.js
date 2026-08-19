// ppte-create.js — PPTE template loading, creation, and manual open
window.PpteCreate = {
  // Load templates on init
  _pptTemplates: [],

  async _loadTemplates() {
    if (!window.__TAURI__) return [];
    const templates = [];
    const userKey = window.Auth?.getUser?.()?.id || window.Auth?.getUser?.()?.username || 'anonymous';
    const cacheKey = `ppte_template_catalog_cache:${userKey}`;
    try {
      const builtin = await window.__TAURI__.core.invoke('list_deck_templates_builtin');
      for (const item of builtin || []) {
        templates.push({ ...item, source: 'builtin', section: 'builtin' });
      }
    } catch (e) {
      console.error('Failed to load builtin templates:', e);
    }
    if (window.Auth?.isLoggedIn?.()) {
      try {
        const remote = await window.__TAURI__.core.invoke('deck_templates_fetch_list', {
          serverUrl: window.Auth.serverUrl,
          token: window.Auth.getToken(),
        });
        for (const item of remote?.mine || []) {
          templates.push({ ...item, source: 'custom', section: 'mine' });
        }
        for (const item of remote?.center || []) {
          templates.push({ ...item, source: 'cloud', section: 'center' });
        }
        try {
          localStorage.setItem(cacheKey, JSON.stringify({ mine: remote?.mine || [], center: remote?.center || [] }));
        } catch (_) { /* catalog cache is best-effort */ }
      } catch (e) {
        console.warn('Failed to load remote templates:', e);
        if (/unauthorized|登录已过期/i.test(String(e))) window.Auth?.showLoginModal?.();
        try {
          const cached = JSON.parse(localStorage.getItem(cacheKey) || '{}');
          for (const item of cached.mine || []) templates.push({ ...item, source: 'custom', section: 'mine', cached: true });
          for (const item of cached.center || []) templates.push({ ...item, source: 'cloud', section: 'center', cached: true });
        } catch (_) { /* invalid cache: keep builtins only */ }
      }
    }
    this._pptTemplates = templates;
    return templates;
  },

  _templateKey(template) {
    return `${template.source}:${template.id}`;
  },

  _templateCardHtml(template, selected = false) {
    const sourceLabel = template.source === 'builtin'
      ? '内置'
      : (template.source === 'custom' ? '我的模板' : '模板中心');
    const statusLabels = { private: '私有', pending: '审核中', approved: '已上架', rejected: '未通过' };
    const status = template.section === 'mine' ? statusLabels[template.status] : '';
    return `<button type="button" class="ppte-template-card${selected ? ' selected' : ''}" data-template-key="${this._escapeAttr(this._templateKey(template))}">
      <span class="ppte-template-preview" data-template-preview="${this._escapeAttr(this._templateKey(template))}"><span>正在加载预览…</span></span>
      <span class="ppte-template-card-body">
        <span class="ppte-template-card-title">${this._escapeHtml(template.name || template.package_id || template.id)}</span>
        <span class="ppte-template-card-desc">${this._escapeHtml(template.description || '课件母版')}</span>
        <span class="ppte-template-card-meta"><em>${sourceLabel}</em>${status ? `<em>${status}</em>` : ''}<span>v${this._escapeHtml(template.version || '1.0.0')}</span></span>
      </span>
    </button>`;
  },

  async _loadTemplatePreviews(templates, modal) {
    const token = window.Auth?.getToken?.() || null;
    const serverUrl = window.Auth?.serverUrl || null;
    await Promise.all((templates || []).map(async (template) => {
      if (!template.hasPreview && template.has_preview === false) return;
      const key = this._templateKey(template);
      try {
        const base64 = await window.__TAURI__.core.invoke('get_deck_template_preview', {
          source: template.source,
          templateId: template.id,
          serverUrl,
          token,
          expectedDigest: template.digest || null,
        });
        const target = [...modal.querySelectorAll('[data-template-preview]')]
          .find(item => item.dataset.templatePreview === key);
        if (target && base64) target.innerHTML = `<img alt="${this._escapeAttr(template.name || '模板预览')}" src="data:image/png;base64,${base64}">`;
        else if (target) target.innerHTML = '<span>暂无预览图</span>';
      } catch (e) {
        const target = [...modal.querySelectorAll('[data-template-preview]')]
          .find(item => item.dataset.templatePreview === key);
        if (target) target.innerHTML = '<span>预览加载失败</span>';
      }
    }));
  },

  async _loadEditorTemplateFiles(folderPath, manifest) {
    if (manifest?.agentTemplate?.schemaVersion !== 2) return null;
    try {
      const snapshot = await window.__TAURI__.core.invoke('read_ppte_template_blueprints', { folderPath });
      const files = snapshot?.roles || {};
      const roles = manifest.agentTemplate.roles || {};
      const result = {};
      for (const role of ['cover', 'catalog', 'chapter', 'finish']) {
        const file = roles[role]?.blueprintFile?.split('/').pop();
        if (file && files[file]) result[role] = files[file];
      }
      const content = Array.isArray(roles.content) ? roles.content[0] : roles.content;
      const contentFile = content?.blueprintFile?.split('/').pop();
      if (contentFile && files[contentFile]) result.content = files[contentFile];
      return Object.keys(result).length ? result : null;
    } catch (e) {
      console.warn('Failed to load template blueprints for editor:', e);
      return null;
    }
  },

  // Public method to create PPT-EXTRA (called from course manager)
  async createPptExtra() {
    if (!window.__TAURI__) {
      alert('此功能需要在桌面应用中运行');
      return;
    }

    // Load templates first
    const templates = await this._loadTemplates();
    let giteeConfigured = false;
    try {
      const status = await window.__TAURI__.core.invoke('gitee_token_status');
      giteeConfigured = !!status?.configured;
    } catch (e) {
      console.warn('Failed to read Gitee token status:', e);
    }

    const defaultTemplate = templates.find(item => item.id === 'scholar-blue') || templates[0] || null;
    let selectedTemplateKey = defaultTemplate ? this._templateKey(defaultTemplate) : '';
    const sections = [
      ['builtin', '内置模板'],
      ['mine', '我的模板'],
      ['center', '模板中心'],
    ];
    const templateSections = sections.map(([key, label]) => {
      const items = templates.filter(item => item.section === key);
      if (!items.length && key === 'center') return '';
      let empty = '';
      if (!items.length && key === 'mine') {
        empty = window.Auth?.isLoggedIn?.()
          ? '<div class="ppte-template-empty">还没有上传模板，可前往网页版模板中心上传。</div>'
          : '<div class="ppte-template-empty">登录后可使用自己上传的模板。</div>';
      }
      if (!items.length && key === 'builtin') empty = '<div class="ppte-template-empty">没有找到内置模板。</div>';
      return `<section class="ppte-template-section"><h4>${label}</h4><div class="ppte-template-grid">${items.map(item => this._templateCardHtml(item, this._templateKey(item) === selectedTemplateKey)).join('')}${empty}</div></section>`;
    }).join('');

    const modal = document.createElement('div');
    modal.id = 'ppt-create-modal';
    modal.className = 'ppte-create-overlay';

    modal.innerHTML = `
      <div class="ppte-create-dialog">
        <header class="ppte-create-header">
          <div><h3>创建 PPTE</h3><p>选择一套课件母版，创建后仍可自由编辑每一页。</p></div>
          <button id="ppt-cancel" class="ppte-create-close" aria-label="关闭">×</button>
        </header>
        <div class="ppte-create-body">
          <div class="ppte-create-templates">${templateSections}</div>
          <aside class="ppte-create-form">
            <div class="ppte-create-field"><label>幻灯片名称 <span>*</span></label><input type="text" id="ppt-name" value="我的幻灯片"></div>
            <div class="ppte-create-field"><label>保存位置</label><div class="ppte-create-path"><input type="text" id="ppt-save-path" value="" readonly placeholder="将保存到默认位置"><button id="ppt-browse-path">浏览</button></div></div>
            <label class="ppte-create-sync"><input type="checkbox" id="ppt-sync-gitee" ${giteeConfigured ? '' : 'disabled'}><span>同步到 Gitee 私有仓库<small>${giteeConfigured ? '创建后自动建仓并执行首次备份' : '请先在设置中配置 Gitee Token'}</small></span></label>
            <div class="ppte-create-selected" id="ppt-selected-template">${defaultTemplate ? `已选择：${this._escapeHtml(defaultTemplate.name)}` : '请选择模板'}</div>
            <button id="ppt-create" class="ppte-create-submit" ${defaultTemplate ? '' : 'disabled'}>创建课件</button>
          </aside>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    let targetPath = '';

    modal.querySelectorAll('.ppte-template-card').forEach(card => {
      card.addEventListener('click', () => {
        selectedTemplateKey = card.dataset.templateKey;
        modal.querySelectorAll('.ppte-template-card').forEach(item => item.classList.toggle('selected', item === card));
        const selected = templates.find(item => this._templateKey(item) === selectedTemplateKey);
        modal.querySelector('#ppt-selected-template').textContent = selected ? `已选择：${selected.name}` : '请选择模板';
        modal.querySelector('#ppt-create').disabled = !selected;
      });
    });
    this._loadTemplatePreviews(templates, modal);

    // Event handlers
    document.getElementById('ppt-browse-path').addEventListener('click', async () => {
      try {
        const selected = await window.__TAURI__.core.invoke('pick_folder');
        if (selected) {
          targetPath = selected;
          document.getElementById('ppt-save-path').value = selected;
        }
      } catch (e) {
        if (e !== 'cancelled') alert('选择文件夹失败: ' + e);
      }
    });

    document.getElementById('ppt-cancel').addEventListener('click', () => {
      document.body.removeChild(modal);
    });

    document.getElementById('ppt-create').addEventListener('click', async () => {
      const name = document.getElementById('ppt-name').value.trim();
      if (!name) {
        document.getElementById('ppt-name').focus();
        return;
      }

      const selectedTemplate = templates.find(item => this._templateKey(item) === selectedTemplateKey);
      if (!selectedTemplate) return;
      const folderName = name.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '-') || `PPTE-${Date.now()}`;
      const finalTargetPath = targetPath && targetPath.trim() ? targetPath.trim() : null;
      const syncGitee = !!document.getElementById('ppt-sync-gitee')?.checked;
      const createButton = modal.querySelector('#ppt-create');
      const cancelButton = modal.querySelector('#ppt-cancel');
      createButton.disabled = true;
      cancelButton.disabled = true;
      createButton.textContent = selectedTemplate.source === 'builtin' ? '正在创建…' : '正在下载模板…';

      let folderPath;
      try {
        if (selectedTemplate.source !== 'builtin') {
          await window.__TAURI__.core.invoke('deck_template_download', {
            serverUrl: window.Auth.serverUrl,
            token: window.Auth.getToken(),
            remoteId: selectedTemplate.id,
            expectedDigest: selectedTemplate.digest,
          });
          createButton.textContent = '正在创建…';
        }
        folderPath = await window.__TAURI__.core.invoke('create_ppt_extra_from_template', {
          folderName,
          targetPath: finalTargetPath,
          title: name,
          templateSource: selectedTemplate.source,
          templateId: selectedTemplate.id,
          digest: selectedTemplate.digest || null,
        });
      } catch (e) {
        createButton.disabled = false;
        cancelButton.disabled = false;
        createButton.textContent = '创建课件';
        if (/unauthorized|登录已过期/i.test(String(e))) window.Auth?.showLoginModal?.();
        alert('创建课件失败: ' + e);
        return;
      }

      try {
        const manifestPath = folderPath + '/manifest.json';
        const content = await window.__TAURI__.core.invoke('read_text_file', { filePath: manifestPath });
        const manifest = JSON.parse(content);

        // Load HTML content for each slide
        const slides = manifest.slides || [];
        for (let i = 0; i < slides.length; i++) {
          const slide = slides[i];
          try {
            const htmlPath = folderPath + '/' + slide.file;
            const htmlContent = await window.__TAURI__.core.invoke('read_text_file', { filePath: htmlPath });
            slide.html = htmlContent;
          } catch (e) {
            console.warn('Failed to load HTML for slide:', slide.file, e);
            slide.html = '';
          }
        }

        modal.remove();

        if (syncGitee) {
          try {
            this._showToast('正在生成 Gitee 仓库名...');
            const repoName = await this._suggestGiteeRepoName(name);
            this._showToast('正在创建 Gitee 私有仓库...');
            const repo = await window.__TAURI__.core.invoke('gitee_create_repo', {
              name: repoName,
              description: `PPTE backup for ${name}`
            });
            manifest.gitee = {
              name: repo.name,
              fullName: repo.fullName,
              htmlUrl: repo.htmlUrl,
              cloneUrl: this._stripUrlCredentials(repo.cloneUrl || ''),
              sshUrl: this._stripUrlCredentials(repo.sshUrl || ''),
            };
            await window.__TAURI__.core.invoke('write_text_file', {
              filePath: manifestPath,
              content: JSON.stringify(this._cleanManifestObject(manifest), null, 2),
            });
            const remoteUrl = manifest.gitee.cloneUrl || manifest.gitee.sshUrl || '';
            await window.__TAURI__.core.invoke('ppte_git_init', {
              folderPath,
              remoteUrl,
            });
            try {
              await window.__TAURI__.core.invoke('ppte_git_sync', {
                folderPath,
                message: `Initial PPTE backup: ${name}`,
              });
              this._showToast('已备份到 Gitee');
            } catch (pushError) {
              console.warn('Gitee repo created but initial push failed:', pushError);
              this._showToast('Gitee 仓库已创建，本地 git 已初始化，但首次推送失败', true);
            }
          } catch (giteeError) {
            console.error('Failed to initialize Gitee backup:', giteeError);
            this._showToast('Gitee 备份初始化失败，PPTE 已在本地创建', true);
          }
        }

        await this._addRecentPpte(folderPath, manifest.title || name);
        manifest._fileStats = await this._loadPptFileStats(folderPath, manifest);
        const templateFiles = await this._loadEditorTemplateFiles(folderPath, manifest);
        this._openPptBuilder(folderPath, manifest, templateFiles);
      } catch (e) {
        alert('读取配置失败: ' + e + '\n\n文件已创建在: ' + folderPath);
        return;
      }
    });

    // Do NOT close on backdrop click — only close via cancel button

    // Focus name input
    setTimeout(() => {
      document.getElementById('ppt-name').focus();
      document.getElementById('ppt-name').select();
    }, 100);
  },

  // Open existing PPT-EXTRA for editing
  async openPptExtra() {
    if (!window.__TAURI__) {
      alert('此功能需要在桌面应用中运行');
      return;
    }

    try {
      const folderPath = await window.__TAURI__.core.invoke('pick_folder');
      if (!folderPath) return; // User cancelled

      await this.openPptExtraPath(folderPath);
    } catch (e) {
      if (e !== 'cancelled') {
        alert('打开失败: ' + e);
      }
    }
  },

  async openPptExtraPath(folderPath) {
    if (!window.__TAURI__) {
      throw new Error('此功能需要在桌面应用中运行');
    }

    // Check if manifest.json exists
    const manifestPath = folderPath + '/manifest.json';
    let content;
    try {
      content = await window.__TAURI__.core.invoke('read_text_file', { filePath: manifestPath });
    } catch (e) {
      alert('选择的文件夹不是有效的 PPTE（缺少 manifest.json）');
      return;
    }

    const manifest = JSON.parse(content);
    manifest.slides = this._normalizeManifestSlides(manifest.slides);

    // Load HTML content for each slide
    const slides = manifest.slides || [];
    for (let i = 0; i < slides.length; i++) {
      const slide = slides[i];
      try {
        const htmlPath = folderPath + '/' + slide.file;
        const htmlContent = await window.__TAURI__.core.invoke('read_text_file', { filePath: htmlPath });
        slide.html = htmlContent;
      } catch (e) {
        console.warn('Failed to load HTML for slide:', slide.file, e);
        slide.html = '';
      }
    }

    await this._addRecentPpte(folderPath, manifest.title || '未命名');
    manifest._fileStats = await this._loadPptFileStats(folderPath, manifest);
    const templateFiles = await this._loadEditorTemplateFiles(folderPath, manifest);
    this._openPptBuilder(folderPath, manifest, templateFiles);
  },

  _buildAgentTemplateMetadata(templateName, slides) {
    return {
      schemaVersion: 1,
      name: templateName || '默认模板',
      state: 'starter',
      roles: (Array.isArray(slides) ? slides : []).map((slide, index) => ({
        file: slide?.file || `slide${String(index + 1).padStart(2, '0')}.html`,
        title: slide?.title || `页面 ${index + 1}`,
        slideType: slide?.slide_type || 'content',
      })),
    };
  },

};

if (window.Settings) {
  Object.assign(window.Settings, window.PpteCreate);
}
