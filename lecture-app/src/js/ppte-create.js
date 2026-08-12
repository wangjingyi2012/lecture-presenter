// ppte-create.js — PPTE template loading, creation, and manual open
window.PpteCreate = {
  // Load templates on init
  _pptTemplates: [],

  async _loadTemplates() {
    if (!window.__TAURI__) return [];
    try {
      const templates = await window.__TAURI__.core.invoke('list_ppt_templates');
      this._pptTemplates = templates || [];
      return this._pptTemplates;
    } catch (e) {
      console.error('Failed to load templates:', e);
      this._pptTemplates = [];
      return [];
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

    // Show custom modal for PPT-EXTRA creation
    const modal = document.createElement('div');
    modal.id = 'ppt-create-modal';
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:3000;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;';

    const templateOptions = templates.length > 0
      ? templates.map(t => `<option value="${this._escapeAttr(t)}" ${t === '安恒' ? 'selected' : ''}>${this._escapeHtml(t)}</option>`).join('')
      : '<option value="">默认模板</option>';

    modal.innerHTML = `
      <div style="background:var(--bg-primary);border-radius:12px;padding:24px;max-width:450px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.4);">
        <h3 style="margin:0 0 16px;font-size:18px;font-weight:600;">创建PPTE</h3>
        <div style="margin-bottom:16px;">
          <label style="display:block;font-size:13px;color:var(--text-secondary);margin-bottom:6px;">选择模板</label>
          <select id="ppt-template-select" style="width:100%;padding:8px 12px;background:var(--bg-secondary);color:var(--text-primary);border:1px solid var(--border);border-radius:6px;font-size:14px;box-sizing:border-box;">
            ${templateOptions}
          </select>
        </div>
        <div style="margin-bottom:16px;">
          <label style="display:block;font-size:13px;color:var(--text-secondary);margin-bottom:6px;">保存位置</label>
          <div style="display:flex;gap:8px;">
            <input type="text" id="ppt-save-path" value="" readonly
              placeholder="将保存到默认位置"
              style="flex:1;padding:8px 12px;background:var(--bg-secondary);color:var(--text-primary);border:1px solid var(--border);border-radius:6px;font-size:14px;">
            <button id="ppt-browse-path" style="padding:8px 14px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;">浏览</button>
          </div>
        </div>
        <div style="margin-bottom:20px;">
          <label style="display:block;font-size:13px;color:var(--text-secondary);margin-bottom:6px;">幻灯片名称 <span style="color:#f85149">*</span></label>
          <input type="text" id="ppt-name" value="我的幻灯片"
            style="width:100%;padding:8px 12px;background:var(--bg-secondary);color:var(--text-primary);border:1px solid var(--border);border-radius:6px;font-size:14px;box-sizing:border-box;">
        </div>
        <label style="display:flex;gap:8px;align-items:flex-start;margin-bottom:20px;color:var(--text-secondary);font-size:13px;line-height:1.45;">
          <input type="checkbox" id="ppt-sync-gitee" ${giteeConfigured ? '' : 'disabled'} style="margin-top:2px;">
          <span>
            同步到 Gitee 私有仓库
            <span style="display:block;color:var(--text-muted);font-size:12px;">${giteeConfigured ? '创建后自动建仓、初始化 git 并执行首次备份' : '请先在设置中配置 Gitee Token'}</span>
          </span>
        </label>
        <div style="display:flex;justify-content:flex-end;gap:10px;">
          <button id="ppt-cancel" style="padding:8px 16px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;">取消</button>
          <button id="ppt-create" style="padding:8px 16px;border-radius:6px;border:none;background:var(--accent);color:#fff;cursor:pointer;">创建</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    let targetPath = '';

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

      const templateName = document.getElementById('ppt-template-select').value;
      const folderName = name.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '-');
      const finalTargetPath = targetPath && targetPath.trim() ? targetPath.trim() : null;
      const syncGitee = !!document.getElementById('ppt-sync-gitee')?.checked;
      document.body.removeChild(modal);

      // Load template files if selected
      let templateFiles = null;
      if (templateName) {
        try {
          templateFiles = await window.__TAURI__.core.invoke('get_template_files', { templateName });
        } catch (e) {
          console.error('Failed to load template:', e);
        }
      }

      // Prepare CSS files from template
      let templateCss = null;
      let templateImages = null;
      let templateHtml = null;
      if (templateFiles) {
        const cssTypes = ['cover', 'catalog', 'chapter', 'content', 'finish'];
        templateCss = [];
        for (const t of cssTypes) {
          const cssKey = t + '_css';
          if (templateFiles[cssKey]) {
            templateCss.push([t + '.css', templateFiles[cssKey]]);
          }
        }
        // Also add main style.css
        if (templateFiles.style) {
          templateCss.push(['style.css', templateFiles.style]);
        }

        // Collect image files
        templateImages = [];
        for (const key in templateFiles) {
          if (key.startsWith('img_') && !key.startsWith('img_data_')) {
            const filename = key.substring(4); // Remove 'img_' prefix
            templateImages.push([filename, templateFiles[key]]);
          }
        }

        // Collect HTML template files
        templateHtml = [];
        for (const t of cssTypes) {
          if (templateFiles[t]) {
            templateHtml.push([t, templateFiles[t]]);
          }
        }
      }

      let folderPath;
      try {
        folderPath = await window.__TAURI__.core.invoke('create_ppt_extra_folder', {
          folderName: folderName,
          targetPath: finalTargetPath,
          templateCss: templateCss,
          templateImages: templateImages,
          templateHtml: templateHtml
        });
      } catch (e) {
        alert('创建文件夹失败: ' + e);
        return;
      }

      try {
        const manifestPath = folderPath + '/manifest.json';
        const content = await window.__TAURI__.core.invoke('read_text_file', { filePath: manifestPath });
        const manifest = JSON.parse(content);

        // A newly created PPTE contains five role templates, not five finished
        // content pages. Persist that distinction so the workbench Agent can
        // bootstrap from a template blueprint instead of guessing from titles.
        manifest.agentTemplate = this._buildAgentTemplateMetadata(templateName, manifest.slides);
        await window.__TAURI__.core.invoke('write_text_file', {
          filePath: manifestPath,
          content: JSON.stringify(manifest, null, 2),
        });

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

        // Remove modal first
        const modal = document.getElementById('ppt-create-modal');
        if (modal && modal.parentNode) {
          modal.parentNode.removeChild(modal);
        }

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
    this._openPptBuilder(folderPath, manifest);
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
