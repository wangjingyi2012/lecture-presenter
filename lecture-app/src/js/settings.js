// settings.js — Theme, font size, course switching, presentation mode
window.Settings = {
  _ppteList: [],

  init(appConfig) {
    this.applyTheme(appConfig.theme || 'dark');
    this.applyFontSize(appConfig.fontSize || 18);
    this.initCourseSelect(appConfig);
    this.initControls(appConfig);
    this.initDevSettings(appConfig);
    this.initKeyboardShortcuts();
  },

  async loadPpteList() {
    if (!window.__TAURI__) return [];
    try {
      const appDataDir = await window.__TAURI__.core.invoke('get_app_data_dir');
      const pptDir = appDataDir + '/ppt-extra';
      // List directories in ppt-extra folder
      // For now, return empty and let user browse
      return [];
    } catch (e) {
      console.error('Failed to load PPTE list:', e);
      return [];
    }
  },

  renderPpteList() {
    const ppteList = document.getElementById('ppte-list');
    if (!ppteList) return;

    if (this._ppteList.length === 0) {
      ppteList.innerHTML = '<li style="color:var(--text-muted);font-size:12px;padding:12px 16px;">暂无PPTE</li>';
      return;
    }

    ppteList.innerHTML = this._ppteList.map((ppte, idx) => `
      <li data-index="${idx}">
        <span>${this._escapeHtml(ppte.title)}</span>
      </li>
    `).join('');

    // Add click handlers
    ppteList.querySelectorAll('li').forEach(li => {
      li.addEventListener('click', async () => {
        const idx = parseInt(li.dataset.index);
        await this.openPpteForEdit(this._ppteList[idx]);
      });
    });
  },

  // Switch between views
  showCourseView() {
    document.getElementById('content-scroll').style.display = 'block';
    document.getElementById('ppte-management').classList.add('hidden');
    document.getElementById('ppte-editor').classList.add('hidden');
    document.getElementById('sidebar').classList.remove('hidden');
  },

  showPpteManagement() {
    document.getElementById('content-scroll').style.display = 'none';
    document.getElementById('ppte-management').classList.remove('hidden');
    document.getElementById('ppte-editor').classList.add('hidden');
    document.getElementById('sidebar').classList.add('hidden');
    this._loadRecentPpte();
  },

  _loadRecentPpte() {
    const appConfig = CourseLoader.appConfig || {};
    const recent = appConfig.recentPpte || [];
    const container = document.getElementById('ppte-recent-items');
    if (recent.length === 0) {
      container.innerHTML = '<p style="color:var(--text-muted);font-size:14px;">暂无最近打开的 PPTE</p>';
      return;
    }
    container.innerHTML = recent.map((item, idx) => `
      <div class="ppte-recent-item" data-path="${this._escapeAttr(item.path)}" style="padding:12px;border:1px solid var(--border);border-radius:8px;display:flex;align-items:center;gap:12px;transition:background 0.15s;">
        <div style="flex:1;cursor:pointer;min-width:0;" class="ppte-recent-content">
          <div style="font-weight:500;font-size:14px;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${this._escapeHtml(item.title)}</div>
          <div style="font-size:12px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${this._escapeHtml(item.path)}</div>
        </div>
        <button class="ppte-recent-delete" data-index="${idx}" style="padding:4px 8px;border:none;background:none;color:var(--text-muted);cursor:pointer;border-radius:4px;font-size:16px;" title="删除">✕</button>
      </div>
    `).join('');

    container.querySelectorAll('.ppte-recent-content').forEach(el => {
      el.addEventListener('click', () => this._openRecentPpte(el.parentElement.dataset.path));
    });

    container.querySelectorAll('.ppte-recent-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._deleteRecentPpte(parseInt(btn.dataset.index));
      });
    });
  },

  async _deleteRecentPpte(index) {
    const appConfig = CourseLoader.appConfig || {};
    if (!appConfig.recentPpte) return;
    appConfig.recentPpte.splice(index, 1);
    await CourseLoader.saveAppConfig(appConfig);
    this._loadRecentPpte();
  },

  async _openRecentPpte(folderPath) {
    try {
      const manifestPath = folderPath + '/manifest.json';
      const content = await window.__TAURI__.core.invoke('read_text_file', { filePath: manifestPath });
      const manifest = JSON.parse(content);
      manifest.slides = this._normalizeManifestSlides(manifest.slides);
      const slides = manifest.slides || [];
      for (let i = 0; i < slides.length; i++) {
        const slide = slides[i];
        try {
          const htmlPath = folderPath + '/' + slide.file;
          const htmlContent = await window.__TAURI__.core.invoke('read_text_file', { filePath: htmlPath });
          slide.html = htmlContent;
        } catch (e) {
          slide.html = '';
        }
      }
      this._openPptBuilder(folderPath, manifest);
    } catch (e) {
      alert('打开失败: ' + e);
    }
  },

  async _addRecentPpte(folderPath, title) {
    const appConfig = CourseLoader.appConfig || {};
    if (!appConfig.recentPpte) appConfig.recentPpte = [];
    appConfig.recentPpte = appConfig.recentPpte.filter(item => item.path !== folderPath);
    appConfig.recentPpte.unshift({ path: folderPath, title });
    if (appConfig.recentPpte.length > 100) appConfig.recentPpte = appConfig.recentPpte.slice(0, 100);
    await CourseLoader.saveAppConfig(appConfig);
  },

  showPpteEditor() {
    if (document.getElementById('content-scroll')) {
      document.getElementById('content-scroll').style.display = 'none';
    }
    if (document.getElementById('ppte-management')) {
      document.getElementById('ppte-management').classList.add('hidden');
    }
    if (document.getElementById('ppte-editor')) {
      document.getElementById('ppte-editor').classList.remove('hidden');
    }
    document.getElementById('sidebar').classList.add('hidden');
  },

  applyTheme(theme) {
    document.body.dataset.theme = theme;
    // Sync highlight.js theme
    const hljsLink = document.getElementById('hljs-theme');
    if (hljsLink) {
      hljsLink.href = theme === 'dark'
        ? 'vendor/highlight-github-dark.min.css'
        : 'vendor/highlight-github.min.css';
    }
  },

  applyFontSize(size) {
    document.documentElement.style.setProperty('--font-size', size + 'px');
  },

  initCourseSelect(appConfig) {
    this.refreshCourseOptions(appConfig);
    const select = document.getElementById('course-select');
    select.addEventListener('change', async () => {
      Tracker.track('course_switch', select.value);
      CourseLoader.appConfig.lastOpenedCourse = select.value;
      await CourseLoader.saveAppConfig(CourseLoader.appConfig);
      await App.loadCourse(select.value);
    });
  },

  refreshCourseOptions(appConfig) {
    const select = document.getElementById('course-select');
    select.innerHTML = '';
    appConfig.courses.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.label;
      if (c.id === appConfig.lastOpenedCourse) opt.selected = true;
      select.appendChild(opt);
    });
  },

  initControls(appConfig) {
    document.getElementById('btn-theme').addEventListener('click', () => {
      const current = document.body.dataset.theme;
      const next = current === 'dark' ? 'light' : 'dark';
      this.applyTheme(next);
      Tracker.track('theme_change', next);
      appConfig.theme = next;
      CourseLoader.saveAppConfig(appConfig);
    });

    document.getElementById('btn-font-up').addEventListener('click', () => {
      const current = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--font-size'));
      const next = Math.min(current + 2, 28);
      this.applyFontSize(next);
      appConfig.fontSize = next;
      CourseLoader.saveAppConfig(appConfig);
    });

    document.getElementById('btn-font-down').addEventListener('click', () => {
      const current = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--font-size'));
      const next = Math.max(current - 2, 12);
      this.applyFontSize(next);
      appConfig.fontSize = next;
      CourseLoader.saveAppConfig(appConfig);
    });

    document.getElementById('btn-add-course').addEventListener('click', () => {
      CourseManager.open();
    });

    // PPTE button in titlebar
    const ppteBtn = document.getElementById('btn-ppte');
    if (ppteBtn) {
      ppteBtn.onclick = () => {
        this.showPpteManagement();
      };
    }

    // PPTE management view buttons
    const ppteBackBtn = document.getElementById('ppte-back-to-course');
    if (ppteBackBtn) {
      ppteBackBtn.onclick = () => this.showCourseView();
    }

    const ppteCreateBtn = document.getElementById('ppte-create-btn');
    if (ppteCreateBtn) {
      ppteCreateBtn.onclick = () => {
        this.createPptExtra();
      };
    }

    const ppteOpenBtn = document.getElementById('ppte-open-btn');
    if (ppteOpenBtn) {
      ppteOpenBtn.onclick = () => {
        this.openPptExtra();
      };
    }

    document.getElementById('ppte-editor-back')?.addEventListener('click', () => {
      this.showPpteManagement();
    });

    // PPTE editor play/speaker buttons: bind once globally (independent of editor rerender flow)
    const runPpteMode = async (mode) => {
      const editor = document.getElementById('ppte-editor');
      if (!editor || editor.classList.contains('hidden') || !this._pptBuilder) return;
      this._showToast(mode === 'play' ? '正在打开播放...' : '正在打开演讲...');
      await this._pptPlayMode(mode);
    };

    const playBtn2 = document.getElementById('ppt-play-btn2');
    if (playBtn2 && !playBtn2.dataset.boundGlobal) {
      playBtn2.dataset.boundGlobal = 'true';
      playBtn2.addEventListener('click', () => runPpteMode('play'));
    }

    const speakerBtn2 = document.getElementById('ppt-speaker-btn2');
    if (speakerBtn2 && !speakerBtn2.dataset.boundGlobal) {
      speakerBtn2.dataset.boundGlobal = 'true';
      speakerBtn2.addEventListener('click', () => runPpteMode('speaker'));
    }

    // About modal
    this.initAboutModal();
  },

  initAboutModal() {
    const aboutModal = document.getElementById('about-modal');
    if (!aboutModal) return;

    const openAbout = () => aboutModal.classList.remove('hidden');
    const closeAbout = () => aboutModal.classList.add('hidden');

    document.getElementById('btn-about')?.addEventListener('click', openAbout);
    document.getElementById('about-modal-close')?.addEventListener('click', closeAbout);
    document.getElementById('about-modal-overlay')?.addEventListener('click', closeAbout);

    // Close on Escape key
    aboutModal.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeAbout();
    });

    // Website link handler
    const websiteLink = document.getElementById('about-website-link');
    if (websiteLink) {
      websiteLink.addEventListener('click', (e) => {
        e.preventDefault();
        const url = websiteLink.dataset.url;
        if (window.__TAURI__?.shell?.open) {
          window.__TAURI__.shell.open(url);
        } else {
          window.open(url, '_blank');
        }
      });
    }
  },

  initDevSettings(appConfig) {
    const body = document.getElementById('dev-settings-body');
    const terminalSelect = document.getElementById('setting-terminal');
    const pythonInput = document.getElementById('setting-python-path');
    const settingsModal = document.getElementById('settings-modal');

    // Settings modal open/close
    document.getElementById('btn-settings').addEventListener('click', () => {
      settingsModal.classList.remove('hidden');
    });
    document.getElementById('settings-modal-close').addEventListener('click', () => {
      settingsModal.classList.add('hidden');
    });
    document.getElementById('settings-modal-overlay').addEventListener('click', () => {
      settingsModal.classList.add('hidden');
    });

    // Load saved values
    if (appConfig.terminal) terminalSelect.value = appConfig.terminal;
    if (appConfig.pythonPath) pythonInput.value = appConfig.pythonPath;

    // Save on change
    terminalSelect.addEventListener('change', () => {
      appConfig.terminal = terminalSelect.value || undefined;
      CourseLoader.saveAppConfig(appConfig);
    });

    pythonInput.addEventListener('change', () => {
      appConfig.pythonPath = pythonInput.value || undefined;
      CourseLoader.saveAppConfig(appConfig);
    });

    // Auto-detect buttons
    document.getElementById('setting-detect-terminal').addEventListener('click', async () => {
      if (!window.__TAURI__) return;
      const detected = await window.__TAURI__.core.invoke('detect_terminal');
      terminalSelect.value = detected;
      appConfig.terminal = detected;
      CourseLoader.saveAppConfig(appConfig);
    });

    document.getElementById('setting-detect-python').addEventListener('click', async () => {
      if (!window.__TAURI__) return;
      const detected = await window.__TAURI__.core.invoke('detect_python');
      pythonInput.value = detected;
      appConfig.pythonPath = detected;
      CourseLoader.saveAppConfig(appConfig);
    });

    // PPT-EXTRA prompt
    document.getElementById('btn-show-ppt-prompt').addEventListener('click', () => {
      const prompt = `# Lecture Presenter - PPT-EXTRA 格式生成指南

你是为 **Lecture Presenter** 桌面应用生成幻灯片内容。这是一款用于展示课程材料的桌面应用（基于 Tauri + Rust），用户群体是学习在线课程的学生。

## 应用背景

Lecture Presenter 支持多种课程资源格式，其中 **PPT-EXTRA** 是一种用 HTML 模拟 PPT 翻页效果的格式。它的特点是：
- 用户点击"Interactive Slides"后会打开一个全屏的幻灯片查看器
- 左右箭头键或点击按钮可以翻页
- 用户不会意识到他们看的是 HTML 页面，应该感觉像在使用真正的 PPT

## 目录结构

PPT-EXTRA 是一个**文件夹**，包含以下文件：

\`\`\`
my-ppt-course/           # 文件夹名称（可自定义）
├── manifest.json        # 幻灯片清单（必填）
├── slide01.html         # 第1页（必填）
├── slide02.html         # 第2页
├── slide03.html         # 第3页
└── ...                  # 更多幻灯片页面
\`\`\`

### manifest.json 格式（必填）

\`\`\`json
{
  "title": "演示标题",
  "slides": [
    { "file": "slide01.html", "title": "封面" },
    { "file": "slide02.html", "title": "目录" },
    { "file": "slide03.html", "title": "章节一" },
    { "file": "slide04.html", "title": "章节二" },
    { "file": "slide05.html", "title": "总结" }
  ]
}
\`\`\`

- **title**: 幻灯片集合的标题
- **slides**: 数组，每个元素包含：
- **file**: HTML 文件名（必填）
  - **title**: 该页标题（可选，用于显示）

## 你的任务

请为 Lecture Presenter 生成一个完整的 PPT-EXTRA 课件文件夹，包含：

1. manifest.json - 幻灯片清单
2. slide01.html - 封面页
3. slide02.html - 目录页
4. slide03.html - 内容页（示例）
5. slide04.html - 结束页

根据你想要的课程主题生成相应的内容。`;

      // Create modal
      const modal = document.createElement('div');
      modal.id = 'ppt-prompt-modal';
      modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2000;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;';
      modal.innerHTML = `
        <div style="background:var(--bg-primary);border-radius:12px;max-width:700px;max-height:80vh;width:90%;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.4);">
          <div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;">
            <span style="font-weight:600;font-size:16px;">PPT-EXTRA 基础提示词</span>
            <button id="ppt-prompt-close" style="background:none;border:none;color:var(--text-muted);font-size:20px;cursor:pointer;">✕</button>
          </div>
          <div style="flex:1;overflow:auto;padding:20px;">
            <textarea id="ppt-prompt-text" style="width:100%;height:400px;font-family:monospace;font-size:13px;padding:12px;border:1px solid var(--border);border-radius:6px;background:var(--bg-secondary);color:var(--text-primary);resize:vertical;">${prompt}</textarea>
          </div>
          <div style="padding:16px 20px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:12px;">
            <button id="ppt-prompt-copy" style="padding:8px 16px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;">复制到剪贴板</button>
            <button id="ppt-prompt-close-btn" style="padding:8px 16px;border-radius:6px;border:none;background:var(--accent);color:#fff;cursor:pointer;">关闭</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);

      // Event handlers
      const closeModal = () => {
        document.body.removeChild(modal);
      };
      document.getElementById('ppt-prompt-close').onclick = closeModal;
      document.getElementById('ppt-prompt-close-btn').onclick = closeModal;
      document.getElementById('ppt-prompt-copy').onclick = () => {
        const textarea = document.getElementById('ppt-prompt-text');
        textarea.select();
        document.execCommand('copy');
        document.getElementById('ppt-prompt-copy').textContent = '已复制!';
        setTimeout(() => {
          document.getElementById('ppt-prompt-copy').textContent = '复制到剪贴板';
        }, 2000);
      };
      modal.onclick = (e) => {
        if (e.target === modal) closeModal();
      };
    });

    // Template Center - Browse template folder
    const templatePathInput = document.getElementById('setting-template-path');
    if (appConfig.templatePath) templatePathInput.value = appConfig.templatePath;

    templatePathInput.addEventListener('change', () => {
      appConfig.templatePath = templatePathInput.value || undefined;
      CourseLoader.saveAppConfig(appConfig);
    });

    document.getElementById('setting-browse-template').addEventListener('click', async () => {
      if (!window.__TAURI__) return;
      try {
        const selected = await window.__TAURI__.core.invoke('pick_folder');
        if (selected) {
          templatePathInput.value = selected;
          appConfig.templatePath = selected;
          CourseLoader.saveAppConfig(appConfig);
        }
      } catch (e) {
        if (e !== 'cancelled') alert('选择文件夹失败: ' + e);
      }
    });

    document.getElementById('setting-export-template').addEventListener('click', async () => {
      if (!window.__TAURI__) return;
      try {
        const result = await window.__TAURI__.core.invoke('export_template');
        if (result === 'ok') {
          alert('模板导出成功！');
        }
      } catch (e) {
        if (e !== 'cancelled') alert('导出模板失败: ' + e);
      }
    });

    // AI Configuration
    const aiProviderSelect = document.getElementById('setting-ai-provider');
    const aiApiKeyInput = document.getElementById('setting-ai-apikey');
    const aiApiTypeSelect = document.getElementById('setting-ai-api-type');
    const aiBaseUrlInput = document.getElementById('setting-ai-baseurl');
    const aiModelInput = document.getElementById('setting-ai-model');
    const aiTestBtn = document.getElementById('setting-ai-test');
    const aiHint = document.getElementById('setting-ai-hint');

    if (appConfig.aiProvider) aiProviderSelect.value = appConfig.aiProvider;
    if (appConfig.aiApiKey) aiApiKeyInput.value = appConfig.aiApiKey;
    if (appConfig.aiApiType) aiApiTypeSelect.value = appConfig.aiApiType;
    if (appConfig.aiBaseUrl) aiBaseUrlInput.value = appConfig.aiBaseUrl;
    if (appConfig.aiModel) aiModelInput.value = appConfig.aiModel;

    aiProviderSelect.addEventListener('change', async () => {
      appConfig.aiProvider = aiProviderSelect.value || undefined;
      if (aiProviderSelect.value === 'deepseek') {
        appConfig.aiApiType = 'openai-chat';
        appConfig.aiBaseUrl = 'https://api.deepseek.com';
        appConfig.aiModel = 'deepseek-chat';
      } else if (aiProviderSelect.value === 'minimax') {
        appConfig.aiApiType = 'anthropic-messages';
        appConfig.aiBaseUrl = 'https://api.minimaxi.com/anthropic/v1';
        appConfig.aiModel = 'MiniMax-M2.5';
      } else if (aiProviderSelect.value === 'custom') {
        appConfig.aiApiType = appConfig.aiApiType || 'openai-chat';
        appConfig.aiModel = appConfig.aiModel || 'gpt-5.5';
      }
      aiApiTypeSelect.value = appConfig.aiApiType || 'openai-chat';
      aiBaseUrlInput.value = appConfig.aiBaseUrl || '';
      aiModelInput.value = appConfig.aiModel || '';
      await CourseLoader.saveAppConfig(appConfig);
      updateApiSettingsVisibility();
    });

    aiApiKeyInput.addEventListener('input', async () => {
      appConfig.aiApiKey = aiApiKeyInput.value || undefined;
      await CourseLoader.saveAppConfig(appConfig);
    });

    aiApiTypeSelect.addEventListener('change', async () => {
      appConfig.aiApiType = aiApiTypeSelect.value || undefined;
      await CourseLoader.saveAppConfig(appConfig);
    });

    aiBaseUrlInput.addEventListener('change', async () => {
      appConfig.aiBaseUrl = aiBaseUrlInput.value.trim() || undefined;
      await CourseLoader.saveAppConfig(appConfig);
    });

    aiModelInput.addEventListener('change', async () => {
      appConfig.aiModel = aiModelInput.value.trim() || undefined;
      await CourseLoader.saveAppConfig(appConfig);
    });

    aiTestBtn.addEventListener('click', async () => {
      if (!window.__TAURI__) return;
      const provider = aiProviderSelect.value;
      const apiKey = provider === 'lectureai' ? (window.Auth?.getToken() || '') : aiApiKeyInput.value.trim();
      if (!provider || (provider !== 'lectureai' && !apiKey)) {
        aiHint.textContent = '请先选择提供商并填写 API Key';
        return;
      }
      aiTestBtn.disabled = true;
      aiTestBtn.textContent = '测试中...';
      aiHint.textContent = '正在测试 AI 配置...';
      try {
        const result = await window.__TAURI__.core.invoke('test_ai_config', {
          provider,
          apiKey,
          apiType: aiApiTypeSelect.value,
          baseUrl: aiBaseUrlInput.value.trim() || undefined,
          model: aiModelInput.value.trim() || undefined
        });
        aiHint.textContent = `测试成功：${String(result).slice(0, 80)}`;
      } catch (e) {
        aiHint.textContent = `测试失败：${e}`;
      } finally {
        aiTestBtn.disabled = false;
        aiTestBtn.textContent = '测试';
      }
    });

    // Show/hide API settings based on provider.
    const updateApiSettingsVisibility = () => {
      const apiKeyRow = aiApiKeyInput.parentElement;
      if (apiKeyRow) {
        apiKeyRow.style.display = aiProviderSelect.value === 'lectureai' ? 'none' : '';
      }
      document.querySelectorAll('.ai-custom-row').forEach(row => {
        row.style.display = aiProviderSelect.value === 'custom' ? '' : 'none';
      });
      if (aiHint) {
        if (aiProviderSelect.value === 'custom') {
          aiHint.textContent = '自定义 API 支持 OpenAI Chat Completions、Responses 和 Anthropic Messages';
        } else if (aiProviderSelect.value === 'lectureai') {
          aiHint.textContent = 'LectureAI 使用当前登录账号，无需 API Key';
        } else {
          aiHint.textContent = '选择AI提供商并配置API Key';
        }
      }
    };
    updateApiSettingsVisibility();
    aiProviderSelect.addEventListener('change', () => {
      updateApiSettingsVisibility();
    });

    // Update Server Configuration
    const updateServerInput = document.getElementById('setting-update-server');
    if (appConfig.updateServer) updateServerInput.value = appConfig.updateServer;

    updateServerInput.addEventListener('change', async () => {
      appConfig.updateServer = updateServerInput.value || undefined;
      appConfig.autoCheckUpdate = true;
      await CourseLoader.saveAppConfig(appConfig);
      alert('更新服务器配置已保存,请重启应用生效');
    });
  },

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

        await this._addRecentPpte(folderPath, manifest.title || name);
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
      this._openPptBuilder(folderPath, manifest);
    } catch (e) {
      if (e !== 'cancelled') {
        alert('打开失败: ' + e);
      }
    }
  },

  // PPT-EXTRA Builder (standalone)
  _pptBuilder: null,
  _pptVisualEditor: null,

  _openPptBuilder(folderPath, manifest, templateFiles = null) {
    manifest.slides = this._normalizeManifestSlides(manifest.slides);

    // Use main content area instead of modal
    this._pptBuilder = {
      folderPath,
      manifest,
      slides: manifest.slides || [],
      templateFiles,
    };

    // Switch to PPTE editor view
    this.showPpteEditor();

    // Render the editor in main content
    this._renderPptBuilderInContent();

    // Add save button handler
    setTimeout(() => {
      const saveBtn = document.getElementById('ppt-save-btn');
      if (saveBtn) {
        saveBtn.onclick = () => this._savePptExtra();
      }

      const reorderBtn = document.getElementById('ppt-reorder-btn');
      if (reorderBtn) {
        reorderBtn.onclick = () => this._showReorderModal();
      }

      const editConfigBtn = document.getElementById('ppt-edit-config-btn');
      if (editConfigBtn) {
        editConfigBtn.onclick = () => this._editPptConfig();
      }

      // Add Cmd+S keyboard shortcut
      if (!this._pptSaveKeyHandler) {
        this._pptSaveKeyHandler = (e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 's') {
            e.preventDefault();
            const editor = document.getElementById('ppte-editor');
            if (editor && !editor.classList.contains('hidden')) {
              this._savePptExtra();
            }
          }
        };
        document.addEventListener('keydown', this._pptSaveKeyHandler);
      }
    }, 100);
  },

  _renderPptBuilderInContent() {
    const pb = this._pptBuilder;
    if (!pb) return;
    if (this._pptVisualEditor) this._closePptVisualEditor(false);

    pb.slides = this._normalizeManifestSlides(pb.slides);
    pb.manifest.slides = pb.slides;

    if (pb.currentSlideIndex === undefined) {
      pb.currentSlideIndex = 0;
    }

    const pageItems = document.getElementById('ppte-page-items');
    if (pageItems) {
      // 保存滚动位置
      const scrollTop = pageItems.scrollTop;
      pageItems.innerHTML = this._renderPageListHtml();
      // 恢复滚动位置
      pageItems.scrollTop = scrollTop;
    }

    this._bindPptEditorEvents();
    this._bindPageListDrag();

    const titleInput = document.getElementById('ppt-current-title');
    if (titleInput) {
      titleInput.value = pb.slides[pb.currentSlideIndex]?.title || '';
    }

    const htmlTextarea = document.getElementById('ppt-current-html');
    if (htmlTextarea) {
      htmlTextarea.value = pb.slides[pb.currentSlideIndex]?.html || '';
    }
  },

  _renderPageListHtml() {
    const pb = this._pptBuilder;
    return pb.slides.map((slide, idx) => `
      <li data-index="${idx}" class="${idx === pb.currentSlideIndex ? 'active' : ''}" style="padding:12px 16px;cursor:pointer;display:flex;align-items:center;gap:8px;">
        <span class="drag-handle" style="cursor:grab;color:var(--text-muted);font-size:14px;user-select:none;flex-shrink:0;">⠿</span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${this._escapeHtml(slide.title)}</span>
        <span style="font-size:11px;color:var(--text-muted);flex-shrink:0;">${this._escapeHtml(slide.file || '')}</span>
      </li>
    `).join('');
  },

  _bindPptEditorEvents() {
    const pb = this._pptBuilder;

    const pageItems = document.getElementById('ppte-page-items');
    if (pageItems) {
      // Use onclick assignment to avoid stacking listeners (no cloneNode needed)
      pageItems.onclick = (e) => {
        const li = e.target.closest('li');
        if (li) {
          const idx = parseInt(li.dataset.index);
          pb.currentSlideIndex = idx;
          this._renderPptBuilderInContent();
        }
      };
    }

    const addBtn = document.getElementById('ppte-add-page');
    if (addBtn) {
      addBtn.onclick = () => this._addPptSlide();
    }

    const titleInput = document.getElementById('ppt-current-title');
    if (titleInput) {
      titleInput.oninput = (e) => {
        const cur = this._pptBuilder;
        if (!cur) return;
        cur.slides[cur.currentSlideIndex].title = e.target.value;
        const pageItems = document.getElementById('ppte-page-items');
        if (pageItems) pageItems.innerHTML = this._renderPageListHtml();
      };
    }

    const htmlTextarea = document.getElementById('ppt-current-html');
    if (htmlTextarea) {
      htmlTextarea.oninput = (e) => {
        const cur = this._pptBuilder;
        if (!cur) return;
        cur.slides[cur.currentSlideIndex].html = e.target.value;
      };
    }

    const deleteBtn = document.getElementById('ppt-delete-current');
    if (deleteBtn) {
      // Reset confirm state when rebinding (e.g. switching PPTE)
      deleteBtn.textContent = '删除';
      deleteBtn.style.background = '#e74c3c';
      let confirmPending = false;
      let confirmTimer = null;
      deleteBtn.onclick = () => {
        const cur = this._pptBuilder;
        if (!cur) return;
        if (cur.slides.length <= 1) {
          alert('至少需要保留一个页面');
          return;
        }
        if (!confirmPending) {
          // First click — enter confirm state
          confirmPending = true;
          deleteBtn.textContent = '确认删除？';
          deleteBtn.style.background = '#c0392b';
          clearTimeout(confirmTimer);
          confirmTimer = setTimeout(() => {
            confirmPending = false;
            deleteBtn.textContent = '删除';
            deleteBtn.style.background = '#e74c3c';
          }, 3000);
        } else {
          // Second click — actually delete
          confirmPending = false;
          clearTimeout(confirmTimer);
          deleteBtn.textContent = '删除';
          deleteBtn.style.background = '#e74c3c';
          cur.slides.splice(cur.currentSlideIndex, 1);
          // Renumber slide files
          cur.slides.forEach((slide, i) => {
            slide.file = `slide${String(i + 1).padStart(2, '0')}.html`;
          });
          if (cur.currentSlideIndex >= cur.slides.length) {
            cur.currentSlideIndex = cur.slides.length - 1;
          }
          this._renderPptBuilderInContent();
        }
      };
    }

    const aiChatBtn = document.getElementById('ppt-ai-chat-btn');
    if (aiChatBtn) {
      aiChatBtn.onclick = () => this._showAiChat();
    }

    const visualBtn = document.getElementById('ppt-visual-edit-btn');
    if (visualBtn) {
      visualBtn.onclick = () => this._openPptVisualEditor();
    }

    const previewBtn = document.getElementById('ppt-preview-btn');

    // Helper: save all files before opening viewer
    const saveAndOpen = async (mode) => {
      const slide = pb.slides[pb.currentSlideIndex];
      const htmlTextarea = document.getElementById('ppt-current-html');
      if (htmlTextarea) slide.html = htmlTextarea.value;

      const filesToSave = pb.slides.map(s => [
        s.file,
        s.html || this._generateSlideHtml(s.title, s.slide_type),
      ]);
      if (pb.templateFiles) {
        const cssTypes = ['cover', 'catalog', 'chapter', 'content', 'finish'];
        for (const t of cssTypes) {
          const cssKey = t + '_css';
          if (pb.templateFiles[cssKey]) filesToSave.push([t + '.css', pb.templateFiles[cssKey]]);
        }
        if (pb.templateFiles.style) filesToSave.push(['style.css', pb.templateFiles.style]);
        for (const key in pb.templateFiles) {
          if (key.startsWith('img_') && !key.startsWith('img_data_')) {
            filesToSave.push([key.substring(4), pb.templateFiles[key]]);
          }
        }
      }

      const manifest = {
        title: pb.manifest?.title || 'Slides',
        slides: pb.slides.map(s => ({
          file: s.file,
          title: s.title || '未命名',
          slide_type: s.slide_type || 'content',
        })),
      };

      await window.__TAURI__.core.invoke('save_ppt_extra', {
        folderPath: pb.folderPath,
        manifestJson: JSON.stringify(manifest, null, 2),
        slideFiles: filesToSave,
      });

      const assetUrl = window.__TAURI__.core.convertFileSrc(pb.folderPath);
      const title = mode === 'preview' ? (slide.title || '未命名') : manifest.title;
      await PptExtraViewer.open(title, assetUrl, pb.folderPath);

      if (mode === 'play') PptExtraViewer.togglePlayMode();
      if (mode === 'speaker') await PptExtraViewer.toggleSpeakerMode();
    };

    if (previewBtn) {
      previewBtn.onclick = async () => {
        try {
          await saveAndOpen('preview');
        } catch (e) {
          console.error('PPTE preview failed:', e);
          this._showToast('预览失败', true);
        }
      };
    }

    const playBtn2 = document.getElementById('ppt-play-btn2');
    if (playBtn2) {
      playBtn2.onclick = async () => {
        this._showToast('正在打开播放...');
        await this._pptPlayMode('play');
      };
    }

    const speakerBtn2 = document.getElementById('ppt-speaker-btn2');
    if (speakerBtn2) {
      speakerBtn2.onclick = async () => {
        this._showToast('正在打开演讲...');
        await this._pptPlayMode('speaker');
      };
    }
  },

  async _pptPlayMode(mode) {
    const pb = this._pptBuilder;
    if (!pb || !pb.slides || pb.slides.length === 0) return;

    const slide = pb.slides[pb.currentSlideIndex];
    const htmlTextarea = document.getElementById('ppt-current-html');
    if (htmlTextarea) slide.html = htmlTextarea.value;

    const filesToSave = pb.slides.map(s => [
      s.file,
      s.html || this._generateSlideHtml(s.title, s.slide_type),
    ]);
    if (pb.templateFiles) {
      const cssTypes = ['cover', 'catalog', 'chapter', 'content', 'finish'];
      for (const t of cssTypes) {
        const cssKey = t + '_css';
        if (pb.templateFiles[cssKey]) filesToSave.push([t + '.css', pb.templateFiles[cssKey]]);
      }
      if (pb.templateFiles.style) filesToSave.push(['style.css', pb.templateFiles.style]);
      for (const key in pb.templateFiles) {
        if (key.startsWith('img_') && !key.startsWith('img_data_')) {
          filesToSave.push([key.substring(4), pb.templateFiles[key]]);
        }
      }
    }

    const manifest = {
      title: pb.manifest?.title || 'Slides',
      slides: pb.slides.map(s => ({
        file: s.file,
        title: s.title || '未命名',
        slide_type: s.slide_type || 'content',
      })),
    };

    try {
      await window.__TAURI__.core.invoke('save_ppt_extra', {
        folderPath: pb.folderPath,
        manifestJson: JSON.stringify(manifest, null, 2),
        slideFiles: filesToSave,
      });
      const assetUrl = window.__TAURI__.core.convertFileSrc(pb.folderPath);
      await PptExtraViewer.open(manifest.title, assetUrl, pb.folderPath);
      if (mode === 'play') PptExtraViewer.togglePlayMode();
      if (mode === 'speaker') await PptExtraViewer.toggleSpeakerMode();
    } catch (e) {
      console.error('PPTE action failed:', mode, e);
      this._showToast((mode === 'play' ? '播放' : '演讲') + '失败', true);
    }
  },

  _slideProtocolUrl(filePath) {
    const normalized = String(filePath || '').replace(/\\/g, '/');
    const encoded = normalized.split('/').map(segment => encodeURIComponent(segment)).join('/');
    const prefix = normalized.startsWith('/') ? '' : '/';
    return `slide://localhost${prefix}${encoded}`;
  },

  _wrapPptHtmlForVisualEditor(html, baseHref) {
    const content = String(html || '');
    const baseTag = `<base href="${this._escapeAttr(baseHref)}">`;
    if (/<head[^>]*>/i.test(content)) {
      return content.replace(/<head[^>]*>/i, (m) => `${m}\n${baseTag}`);
    }
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">${baseTag}</head><body>${content}</body></html>`;
  },

  _openPptVisualEditor() {
    const pb = this._pptBuilder;
    if (!pb || !pb.slides || pb.slides.length === 0) return;

    const slide = pb.slides[pb.currentSlideIndex];
    const htmlTextarea = document.getElementById('ppt-current-html');
    if (htmlTextarea) slide.html = htmlTextarea.value;

    this._closePptVisualEditor(false);

    const modal = document.createElement('div');
    modal.className = 'ppt-visual-modal';
    modal.innerHTML = `
      <div class="ppt-visual-shell" role="dialog" aria-label="PPTE 可视化调整">
        <div class="ppt-visual-header">
          <div>
            <div class="ppt-visual-header-title">可视化调整：${this._escapeHtml(slide.title || '未命名')}</div>
            <div class="ppt-visual-header-desc">点击元素后可拖拽位置，右侧面板可精确修改像素值（支持方向键微调）</div>
          </div>
          <div class="ppt-visual-actions">
            <button id="ppt-visual-apply-btn" class="ppt-visual-btn">应用到编辑器</button>
            <button id="ppt-visual-apply-close-btn" class="ppt-visual-btn primary">应用并关闭</button>
            <button id="ppt-visual-close-btn" class="ppt-visual-btn">关闭</button>
          </div>
        </div>
        <div class="ppt-visual-body">
          <div class="ppt-visual-canvas-wrap">
            <iframe id="ppt-visual-iframe" class="ppt-visual-canvas"
              sandbox="allow-same-origin allow-scripts allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation allow-forms"></iframe>
          </div>
          <aside class="ppt-visual-side">
            <div class="ppt-visual-side-scroll">
              <div class="ppt-visual-block">
                <div class="ppt-visual-label">当前元素</div>
                <div id="ppt-visual-selected" class="ppt-visual-selected">未选择</div>
              </div>
              <div class="ppt-visual-block">
                <div class="ppt-visual-label">位置与尺寸 (px)</div>
                <div class="ppt-visual-grid">
                  <label class="ppt-visual-field"><span>X</span><input id="ppt-visual-left" type="number" step="1"></label>
                  <label class="ppt-visual-field"><span>Y</span><input id="ppt-visual-top" type="number" step="1"></label>
                  <label class="ppt-visual-field"><span>宽度</span><input id="ppt-visual-width" type="number" step="1"></label>
                  <label class="ppt-visual-field"><span>高度</span><input id="ppt-visual-height" type="number" step="1"></label>
                  <label class="ppt-visual-field"><span>字体大小</span><input id="ppt-visual-font-size" type="number" step="1"></label>
                </div>
              </div>
              <div class="ppt-visual-block">
                <div class="ppt-visual-tip">拖拽会改写元素内联样式（left/top）。若元素原来是 static，会自动改为 relative 以支持位移。</div>
                <div class="ppt-visual-tip">方向键每次移动 1px，Shift + 方向键 每次移动 10px。</div>
              </div>
            </div>
          </aside>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const iframe = modal.querySelector('#ppt-visual-iframe');
    const baseHref = `${this._slideProtocolUrl(pb.folderPath).replace(/\/+$/, '')}/`;
    const htmlContent = slide.html || this._generateSlideHtml(slide.title, slide.slide_type);
    iframe.srcdoc = this._wrapPptHtmlForVisualEditor(htmlContent, baseHref);

    const state = {
      modal,
      iframe,
      pb,
      selectedEl: null,
      dragging: false,
      dragStartX: 0,
      dragStartY: 0,
      startLeft: 0,
      startTop: 0,
      syncingInspector: false,
      inputs: {
        left: modal.querySelector('#ppt-visual-left'),
        top: modal.querySelector('#ppt-visual-top'),
        width: modal.querySelector('#ppt-visual-width'),
        height: modal.querySelector('#ppt-visual-height'),
        fontSize: modal.querySelector('#ppt-visual-font-size'),
      },
      selectedLabel: modal.querySelector('#ppt-visual-selected'),
      canvasHandlers: null,
      keydownHandler: null,
    };
    this._pptVisualEditor = state;

    const bindInput = (input, key) => {
      if (!input) return;
      input.addEventListener('input', () => this._applyPptVisualField(state, key, input.value));
    };
    bindInput(state.inputs.left, 'left');
    bindInput(state.inputs.top, 'top');
    bindInput(state.inputs.width, 'width');
    bindInput(state.inputs.height, 'height');
    bindInput(state.inputs.fontSize, 'fontSize');

    modal.querySelector('#ppt-visual-close-btn').addEventListener('click', () => this._closePptVisualEditor(false));
    modal.querySelector('#ppt-visual-apply-btn').addEventListener('click', () => this._applyPptVisualChanges(state));
    modal.querySelector('#ppt-visual-apply-close-btn').addEventListener('click', () => this._closePptVisualEditor(true));

    modal.addEventListener('click', (e) => {
      if (e.target === modal) this._closePptVisualEditor(false);
    });

    state.keydownHandler = (e) => {
      if (!this._pptVisualEditor || this._pptVisualEditor !== state) return;
      if (!state.selectedEl) return;
      const tag = e.target && e.target.tagName ? e.target.tagName : '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      const step = e.shiftKey ? 10 : 1;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        this._nudgePptVisualSelection(state, -step, 0);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        this._nudgePptVisualSelection(state, step, 0);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this._nudgePptVisualSelection(state, 0, -step);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        this._nudgePptVisualSelection(state, 0, step);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this._closePptVisualEditor(false);
      }
    };
    document.addEventListener('keydown', state.keydownHandler);

    iframe.addEventListener('load', () => this._bindPptVisualCanvas(state), { once: true });
  },

  _closePptVisualEditor(apply) {
    const state = this._pptVisualEditor;
    if (!state) return;

    if (apply) this._applyPptVisualChanges(state);

    if (state.canvasHandlers && state.iframe && state.iframe.contentDocument) {
      const doc = state.iframe.contentDocument;
      doc.removeEventListener('click', state.canvasHandlers.click, true);
      doc.removeEventListener('mousedown', state.canvasHandlers.mousedown, true);
      doc.removeEventListener('mousemove', state.canvasHandlers.mousemove, true);
      doc.removeEventListener('mouseup', state.canvasHandlers.mouseup, true);
    }
    if (state.keydownHandler) {
      document.removeEventListener('keydown', state.keydownHandler);
    }
    if (state.modal && state.modal.parentNode) {
      state.modal.parentNode.removeChild(state.modal);
    }
    this._pptVisualEditor = null;
  },

  _bindPptVisualCanvas(state) {
    const doc = state.iframe.contentDocument;
    if (!doc) return;

    if (doc.head) {
      const style = doc.createElement('style');
      style.textContent = `
        [data-ppt-visual-selected="1"] {
          outline: 2px solid #3b82f6 !important;
          outline-offset: 2px !important;
          cursor: move !important;
        }
      `;
      doc.head.appendChild(style);
    }

    const findTarget = (eventTarget) => {
      let el = eventTarget;
      while (el && el !== doc.documentElement) {
        if (this._pickPptVisualElement(el)) return el;
        el = el.parentElement;
      }
      return null;
    };

    const clickHandler = (e) => {
      const target = findTarget(e.target);
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      this._selectPptVisualElement(state, target);
    };

    const mousedownHandler = (e) => {
      if (e.button !== 0) return;
      const target = findTarget(e.target);
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      this._selectPptVisualElement(state, target);

      this._ensurePptVisualPositioned(target);
      state.dragging = true;
      state.dragStartX = e.clientX;
      state.dragStartY = e.clientY;
      state.startLeft = parseFloat(target.style.left) || 0;
      state.startTop = parseFloat(target.style.top) || 0;
      doc.body.style.userSelect = 'none';
    };

    const mousemoveHandler = (e) => {
      if (!state.dragging || !state.selectedEl) return;
      e.preventDefault();
      const dx = e.clientX - state.dragStartX;
      const dy = e.clientY - state.dragStartY;
      state.selectedEl.style.left = `${Math.round(state.startLeft + dx)}px`;
      state.selectedEl.style.top = `${Math.round(state.startTop + dy)}px`;
      this._syncPptVisualInspector(state);
    };

    const mouseupHandler = () => {
      if (!state.dragging) return;
      state.dragging = false;
      if (doc.body) doc.body.style.userSelect = '';
      this._syncPptVisualInspector(state);
    };

    doc.addEventListener('click', clickHandler, true);
    doc.addEventListener('mousedown', mousedownHandler, true);
    doc.addEventListener('mousemove', mousemoveHandler, true);
    doc.addEventListener('mouseup', mouseupHandler, true);

    state.canvasHandlers = {
      click: clickHandler,
      mousedown: mousedownHandler,
      mousemove: mousemoveHandler,
      mouseup: mouseupHandler,
    };
  },

  _pickPptVisualElement(el) {
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toUpperCase();
    return !['HTML', 'BODY', 'HEAD', 'META', 'TITLE', 'LINK', 'STYLE', 'SCRIPT', 'BASE'].includes(tag);
  },

  _selectPptVisualElement(state, el) {
    if (!el) return;
    if (state.selectedEl) state.selectedEl.removeAttribute('data-ppt-visual-selected');
    state.selectedEl = el;
    state.selectedEl.setAttribute('data-ppt-visual-selected', '1');
    this._syncPptVisualInspector(state);
  },

  _syncPptVisualInspector(state) {
    if (!state.selectedEl) {
      if (state.selectedLabel) state.selectedLabel.textContent = '未选择';
      return;
    }
    const el = state.selectedEl;
    const win = el.ownerDocument.defaultView;
    const computed = win.getComputedStyle(el);

    const left = parseFloat(el.style.left) || 0;
    const top = parseFloat(el.style.top) || 0;
    const width = parseFloat(el.style.width) || parseFloat(computed.width) || 0;
    const height = parseFloat(el.style.height) || parseFloat(computed.height) || 0;
    const fontSize = parseFloat(el.style.fontSize) || parseFloat(computed.fontSize) || 0;

    const name = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.className ? '.' + String(el.className).trim().replace(/\s+/g, '.') : ''}`;
    if (state.selectedLabel) state.selectedLabel.textContent = name || el.tagName.toLowerCase();

    state.syncingInspector = true;
    state.inputs.left.value = Math.round(left);
    state.inputs.top.value = Math.round(top);
    state.inputs.width.value = Math.round(width);
    state.inputs.height.value = Math.round(height);
    state.inputs.fontSize.value = Math.round(fontSize);
    state.syncingInspector = false;
  },

  _applyPptVisualField(state, key, rawValue) {
    if (!state || !state.selectedEl || state.syncingInspector) return;
    const value = parseFloat(rawValue);
    if (!Number.isFinite(value)) return;

    const el = state.selectedEl;
    if (key === 'left' || key === 'top') {
      this._ensurePptVisualPositioned(el);
    }

    if (key === 'left') el.style.left = `${value}px`;
    if (key === 'top') el.style.top = `${value}px`;
    if (key === 'width') el.style.width = `${Math.max(1, value)}px`;
    if (key === 'height') el.style.height = `${Math.max(1, value)}px`;
    if (key === 'fontSize') el.style.fontSize = `${Math.max(1, value)}px`;

    this._syncPptVisualInspector(state);
  },

  _nudgePptVisualSelection(state, dx, dy) {
    if (!state || !state.selectedEl) return;
    this._ensurePptVisualPositioned(state.selectedEl);
    const left = (parseFloat(state.selectedEl.style.left) || 0) + dx;
    const top = (parseFloat(state.selectedEl.style.top) || 0) + dy;
    state.selectedEl.style.left = `${left}px`;
    state.selectedEl.style.top = `${top}px`;
    this._syncPptVisualInspector(state);
  },

  _ensurePptVisualPositioned(el) {
    if (!el) return;
    const computed = el.ownerDocument.defaultView.getComputedStyle(el);
    if (computed.position === 'static') {
      el.style.position = 'relative';
    }
  },

  _serializePptVisualDoc(doc) {
    const doctype = doc.doctype ? `<!DOCTYPE ${doc.doctype.name}>` : '<!DOCTYPE html>';
    return `${doctype}\n${doc.documentElement.outerHTML}`;
  },

  _applyPptVisualChanges(state) {
    if (!state || !state.pb || !state.iframe || !state.iframe.contentDocument) return;
    const html = this._serializePptVisualDoc(state.iframe.contentDocument);
    const pb = state.pb;
    const idx = pb.currentSlideIndex;
    if (idx === undefined || !pb.slides[idx]) return;
    pb.slides[idx].html = html;
    const htmlTextarea = document.getElementById('ppt-current-html');
    if (htmlTextarea) htmlTextarea.value = html;
    this._showToast('已应用可视化调整');
  },

  closePptEditor() {
    this._closePptVisualEditor(false);
    this.showCourseView();
    // Optionally hide PPTE section
    // this.hidePpteSection();
  },

  _renderPageList() {
    const pb = this._pptBuilder;
    const slideTypes = [
      { value: 'cover', label: '封面' },
      { value: 'catalog', label: '目录' },
      { value: 'chapter', label: '章节' },
      { value: 'content', label: '内容' },
      { value: 'finish', label: '结束' },
    ];

    let html = '<div style="display:flex;flex-direction:column;gap:4px;">';
    pb.slides.forEach((slide, index) => {
      const isActive = index === pb.currentSlideIndex;
      const typeLabel = slideTypes.find(t => t.value === slide.slide_type)?.label || '内容';
      html += `
        <div class="ppt-page-item ${isActive ? 'active' : ''}" data-index="${index}"
          style="padding:10px 12px;border-radius:6px;cursor:pointer;background:${isActive ? 'var(--accent-bg)' : 'transparent'};border-left:3px solid ${isActive ? 'var(--accent)' : 'transparent'};">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:12px;color:var(--text-muted);min-width:20px;">${index + 1}</span>
            <span style="font-size:13px;color:var(--text-primary);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${this._escapeHtml(slide.title)}</span>
            <span style="font-size:10px;color:var(--text-muted);background:var(--bg-tertiary);padding:2px 6px;border-radius:3px;">${typeLabel}</span>
          </div>
        </div>
      `;
    });
    html += '</div>';

    if (pb.slides.length === 0) {
      html = '<p style="color:var(--text-muted);text-align:center;padding:20px;font-size:13px;">暂无页面</p>';
    }

    return html;
  },

  _renderPageEditor() {
    const pb = this._pptBuilder;
    if (!pb.slides || pb.slides.length === 0) {
      return '<p style="color:var(--text-muted);text-align:center;padding:40px;">请添加页面开始编辑</p>';
    }

    const slide = pb.slides[pb.currentSlideIndex];

    return `
      <div style="display:flex;flex-direction:column;gap:16px;height:100%;">
        <div style="display:flex;gap:16px;align-items:flex-end;">
          <div style="flex:1;">
            <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px;">页面标题</label>
            <input type="text" id="ppt-current-title" value="${this._escapeAttr(slide.title)}"
              style="width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:6px;background:var(--bg-secondary);color:var(--text-primary);font-size:14px;box-sizing:border-box;">
          </div>
          <button id="ppt-preview-btn" style="padding:8px 16px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;font-size:13px;margin-bottom:0;">预览</button>
          <button id="ppt-play-btn" style="padding:8px 16px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;font-size:13px;margin-bottom:0;">▶ 播放</button>
          <button id="ppt-speaker-btn" style="padding:8px 16px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;font-size:13px;margin-bottom:0;display:flex;align-items:center;gap:4px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M12 17v4"/><circle cx="12" cy="10" r="3"/></svg> 演讲</button>
          <button id="ppt-delete-current" style="padding:8px 14px;border-radius:6px;border:none;background:#e74c3c;color:#fff;cursor:pointer;font-size:13px;margin-bottom:0;">删除页面</button>
        </div>
        <div style="flex:1;display:flex;flex-direction:column;min-height:0;">
          <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:8px;">HTML 内容（可直接编辑）</label>
          <textarea id="ppt-current-html" style="flex:1;width:100%;padding:12px;border:1px solid var(--border);border-radius:6px;background:var(--bg-tertiary);color:var(--text-primary);font-family:monospace;font-size:13px;line-height:1.5;resize:none;box-sizing:border-box;"
            placeholder="在此输入HTML内容...">${this._escapeAttr(slide.html || '')}</textarea>
        </div>
      </div>
    `;
  },

  _bindPageListEvents(modal) {
    const pb = this._pptBuilder;

    modal.querySelectorAll('.ppt-page-item').forEach(item => {
      item.addEventListener('click', () => {
        const index = parseInt(item.dataset.index);
        pb.currentSlideIndex = index;
        this._renderPptBuilderInContent();
      });
    });

    // Title and type change
    const titleInput = modal.querySelector('#ppt-current-title');
    if (titleInput) {
      titleInput.addEventListener('input', (e) => {
        pb.slides[pb.currentSlideIndex].title = e.target.value;
        this._refreshPageList();
      });
    }

    // HTML content change
    const htmlTextarea = modal.querySelector('#ppt-current-html');
    if (htmlTextarea) {
      htmlTextarea.addEventListener('input', (e) => {
        pb.slides[pb.currentSlideIndex].html = e.target.value;
      });
    }

    // Delete current page (two-step: click once to arm, click again to delete)
    const deleteBtn = modal.querySelector('#ppt-delete-current');
    if (deleteBtn) {
      let confirmPending = false;
      let confirmTimer = null;
      deleteBtn.addEventListener('click', () => {
        if (pb.slides.length <= 1) {
          alert('至少需要保留一个页面');
          return;
        }
        if (!confirmPending) {
          confirmPending = true;
          deleteBtn.textContent = '确认删除？';
          deleteBtn.style.background = '#c0392b';
          clearTimeout(confirmTimer);
          confirmTimer = setTimeout(() => {
            confirmPending = false;
            deleteBtn.textContent = '删除页面';
            deleteBtn.style.background = '#e74c3c';
          }, 3000);
        } else {
          confirmPending = false;
          clearTimeout(confirmTimer);
          deleteBtn.textContent = '删除页面';
          deleteBtn.style.background = '#e74c3c';
          pb.slides.splice(pb.currentSlideIndex, 1);
          pb.slides.forEach((slide, i) => {
            slide.file = `slide${String(i + 1).padStart(2, '0')}.html`;
          });
          if (pb.currentSlideIndex >= pb.slides.length) {
            pb.currentSlideIndex = pb.slides.length - 1;
          }
          this._refreshPptBuilder();
        }
      });
    }

    // Preview button
    const previewBtn = modal.querySelector('#ppt-preview-btn');
    if (previewBtn) {
      previewBtn.addEventListener('click', async () => {
        const slide = pb.slides[pb.currentSlideIndex];
        // Save current HTML first
        const htmlTextarea = modal.querySelector('#ppt-current-html');
        if (htmlTextarea) {
          slide.html = htmlTextarea.value;
        }

        // Save to temp file
        const tempFileName = 'preview_temp.html';
        try {
          // Collect all files to save including CSS
          const filesToSave = [[tempFileName, slide.html]];

          // Also save CSS files from template if available
          if (pb.templateFiles) {
            const cssTypes = ['cover', 'catalog', 'chapter', 'content', 'finish'];
            for (const t of cssTypes) {
              const cssKey = t + '_css';
              if (pb.templateFiles[cssKey]) {
                filesToSave.push([t + '.css', pb.templateFiles[cssKey]]);
              }
            }
            // Also save main style.css
            if (pb.templateFiles.style) {
              filesToSave.push(['style.css', pb.templateFiles.style]);
            }
            // Also save image files
            for (const key in pb.templateFiles) {
              if (key.startsWith('img_') && !key.startsWith('img_data_')) {
                const filename = key.substring(4);
                filesToSave.push([filename, pb.templateFiles[key]]);
              }
            }
          }

          await window.__TAURI__.core.invoke('save_ppt_extra', {
            folderPath: pb.folderPath,
            manifestJson: this._cleanManifestJson(pb.manifest),
            slideFiles: filesToSave,
          });

          // Close editor modal first
          modal.classList.add('hidden');

          // Use PptExtraViewer for preview (better CSS/image support)
          const folderPath = pb.folderPath;
          const assetUrl = window.__TAURI__.core.convertFileSrc(folderPath);

          // Store editor state to restore later
          pb._editorWasOpen = true;

          PptExtraViewer.open(slide.title, assetUrl, folderPath);

          // Add one-time listener to restore editor when preview closes
          const restoreEditor = () => {
            document.getElementById('ppt-extra-close').removeEventListener('click', restoreEditor);
            document.removeEventListener('keydown', escHandler);
            if (pb._editorWasOpen) {
              modal.classList.remove('hidden');
              pb._editorWasOpen = false;
            }
          };
          const escHandler = (e) => {
            if (e.key === 'Escape') {
              restoreEditor();
            }
          };
          document.getElementById('ppt-extra-close').addEventListener('click', restoreEditor);
          document.addEventListener('keydown', escHandler);
        } catch (e) {
          console.error('Preview error:', e);
          alert('预览失败: ' + e);
          modal.classList.remove('hidden');
        }
      });
    }

    // Play button — open full PPTE in play mode
    const playBtn = modal.querySelector('#ppt-play-btn');
    if (playBtn) {
      playBtn.addEventListener('click', async () => {
        try {
          await this._savePptBeforeAction(pb, modal);
          const assetUrl = window.__TAURI__.core.convertFileSrc(pb.folderPath);
          await PptExtraViewer.open(pb.manifest.title || 'Slides', assetUrl, pb.folderPath);
          PptExtraViewer.togglePlayMode();
        } catch (e) {
          console.error('Play error:', e);
          alert('播放失败: ' + e);
          modal.classList.remove('hidden');
        }
      });
    }

    // Speaker button — open full PPTE in speaker mode
    const speakerBtn = modal.querySelector('#ppt-speaker-btn');
    if (speakerBtn) {
      speakerBtn.addEventListener('click', async () => {
        try {
          await this._savePptBeforeAction(pb, modal);
          const assetUrl = window.__TAURI__.core.convertFileSrc(pb.folderPath);
          await PptExtraViewer.open(pb.manifest.title || 'Slides', assetUrl, pb.folderPath);
          await PptExtraViewer.toggleSpeakerMode();
        } catch (e) {
          console.error('Speaker mode error:', e);
          alert('演讲模式失败: ' + e);
          modal.classList.remove('hidden');
        }
      });
    }
  },

  // Helper: save all PPTE files before play/speaker action
  async _savePptBeforeAction(pb, modal) {
    const slide = pb.slides[pb.currentSlideIndex];
    const htmlTextarea = modal.querySelector('#ppt-current-html');
    if (htmlTextarea) slide.html = htmlTextarea.value;

    const filesToSave = pb.slides.map(s => [s.file, s.html]);
    if (pb.templateFiles) {
      const cssTypes = ['cover', 'catalog', 'chapter', 'content', 'finish'];
      for (const t of cssTypes) {
        const cssKey = t + '_css';
        if (pb.templateFiles[cssKey]) filesToSave.push([t + '.css', pb.templateFiles[cssKey]]);
      }
      if (pb.templateFiles.style) filesToSave.push(['style.css', pb.templateFiles.style]);
      for (const key in pb.templateFiles) {
        if (key.startsWith('img_') && !key.startsWith('img_data_')) {
          filesToSave.push([key.substring(4), pb.templateFiles[key]]);
        }
      }
    }
    await window.__TAURI__.core.invoke('save_ppt_extra', {
      folderPath: pb.folderPath,
      manifestJson: this._cleanManifestJson(pb.manifest),
      slideFiles: filesToSave,
    });
    modal.classList.add('hidden');
    pb._editorWasOpen = true;
  },

  _refreshPptBuilder() {
    const modal = document.getElementById('ppt-builder-modal');
    if (!modal) return;

    // Update page list
    const pageList = modal.querySelector('#ppt-page-list');
    if (pageList) {
      pageList.innerHTML = this._renderPageList();
    }

    // Update editor
    const pageEditor = modal.querySelector('#ppt-page-editor');
    if (pageEditor) {
      pageEditor.innerHTML = this._renderPageEditor();
    }

    // Rebind events
    this._bindPageListEvents(modal);
  },

  _refreshPageList() {
    const modal = document.getElementById('ppt-builder-modal');
    if (!modal) return;
    const pageList = modal.querySelector('#ppt-page-list');
    if (pageList) {
      pageList.innerHTML = this._renderPageList();
    }
  },

  _addPptSlide() {
    const pb = this._pptBuilder;

    // Show type selection modal
    const self = this;
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:3100;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;';
    modal.innerHTML = `
      <div style="background:var(--bg-primary);border-radius:12px;padding:24px;max-width:400px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.4);">
        <h3 style="margin:0 0 16px;font-size:18px;font-weight:600;">选择页面类型</h3>
        <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:20px;">
          <button class="ppt-type-btn" data-type="cover" style="padding:12px 16px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;text-align:left;font-size:14px;display:flex;align-items:center;gap:10px;">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9h6v6H9z"/></svg>封面</button>
          <button class="ppt-type-btn" data-type="catalog" style="padding:12px 16px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;text-align:left;font-size:14px;display:flex;align-items:center;gap:10px;">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h16M4 18h10"/></svg>目录</button>
          <button class="ppt-type-btn" data-type="chapter" style="padding:12px 16px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;text-align:left;font-size:14px;display:flex;align-items:center;gap:10px;">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/></svg>章节</button>
          <button class="ppt-type-btn" data-type="content" style="padding:12px 16px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;text-align:left;font-size:14px;display:flex;align-items:center;gap:10px;">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/></svg>内容</button>
          <button class="ppt-type-btn" data-type="finish" style="padding:12px 16px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;text-align:left;font-size:14px;display:flex;align-items:center;gap:10px;">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/></svg>结束</button>
        </div>
        <button id="ppt-type-cancel" style="width:100%;padding:10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;">取消</button>
      </div>
    `;

    document.body.appendChild(modal);

    // Handle type selection
    modal.querySelectorAll('.ppt-type-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const slideType = btn.dataset.type;
        const typeLabels = {
          cover: '封面',
          catalog: '目录',
          chapter: '章节',
          content: '内容',
          finish: '结束'
        };
        const newSlide = {
          file: `slide${String(pb.slides.length + 1).padStart(2, '0')}.html`,
          title: `${typeLabels[slideType]} ${pb.slides.length + 1}`,
          slide_type: slideType,
          html: self._generateSlideHtml(`${typeLabels[slideType]} ${pb.slides.length + 1}`, slideType),
        };
        pb.slides.push(newSlide);
        pb.currentSlideIndex = pb.slides.length - 1;
        document.body.removeChild(modal);
        self._renderPptBuilderInContent();
      });
    });

    // Cancel
    document.getElementById('ppt-type-cancel').addEventListener('click', () => {
      document.body.removeChild(modal);
    });

    modal.addEventListener('click', (e) => {
      if (e.target === modal) document.body.removeChild(modal);
    });
  },

  _deletePptSlide(index) {
    if (!confirm('确定删除此页面？')) return;
    const pb = this._pptBuilder;
    pb.slides.splice(index, 1);
    pb.slides.forEach((slide, i) => {
      slide.file = `slide${String(i + 1).padStart(2, '0')}.html`;
    });
    if (pb.currentSlideIndex >= pb.slides.length) {
      pb.currentSlideIndex = pb.slides.length - 1;
    }
    this._renderPptBuilderInContent();
  },

  _refreshPptBuilder() {
    const modal = document.getElementById('ppt-builder-modal');
    if (!modal) return;

    // Update page list
    const pageList = modal.querySelector('#ppt-page-list');
    if (pageList) {
      pageList.innerHTML = this._renderPageList();
    }

    // Update editor
    const pageEditor = modal.querySelector('#ppt-page-editor');
    if (pageEditor) {
      pageEditor.innerHTML = this._renderPageEditor();
    }

    // Rebind events
    this._bindPageListEvents(modal);
  },

  _bindPptSlideDrag() {
    const items = document.querySelectorAll('.ppt-slide-item');
    let dragSrc = null;

    items.forEach(item => {
      item.addEventListener('dragstart', (e) => {
        dragSrc = parseInt(item.dataset.index);
        item.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', dragSrc.toString());
        const img = new Image();
        img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
        e.dataTransfer.setDragImage(img, 0, 0);
      });

      item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
        items.forEach(i => i.classList.remove('drag-over'));
      });

      item.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (dragSrc !== null && dragSrc !== parseInt(item.dataset.index)) {
          item.classList.add('drag-over');
        }
      });

      item.addEventListener('dragleave', () => item.classList.remove('drag-over'));

      item.addEventListener('drop', (e) => {
        e.preventDefault();
        const destIndex = parseInt(item.dataset.index);
        if (dragSrc !== null && dragSrc !== destIndex) {
          const pb = this._pptBuilder;
          const [moved] = pb.slides.splice(dragSrc, 1);
          pb.slides.splice(destIndex, 0, moved);
          pb.slides.forEach((slide, i) => {
            slide.file = `slide${String(i + 1).padStart(2, '0')}.html`;
          });
          this._refreshPptBuilder();
        }
        dragSrc = null;
      });
    });
  },

  async _savePptExtra(modal) {
    const pb = this._pptBuilder;
    if (!pb) return;

    // 保存当前正在编辑的页面内容
    const currentTitleInput = document.getElementById('ppt-current-title');
    const currentHtmlTextarea = document.getElementById('ppt-current-html');
    if (currentTitleInput && currentHtmlTextarea && pb.slides[pb.currentSlideIndex]) {
      pb.slides[pb.currentSlideIndex].title = currentTitleInput.value.trim() || '未命名';
      pb.slides[pb.currentSlideIndex].html = currentHtmlTextarea.value;
    }

    // Try to get title from various sources
    let newTitle = '幻灯片';
    const titleInput = document.getElementById('ppt-builder-title');
    if (titleInput) {
      newTitle = titleInput.value.trim() || '幻灯片';
    } else {
      const editorTitle = document.getElementById('ppte-editor-title');
      if (editorTitle) {
        newTitle = pb.manifest.title || '幻灯片';
      }
    }

    pb.manifest.title = newTitle;

    const slideFiles = [];
    for (let i = 0; i < pb.slides.length; i++) {
      const slide = pb.slides[i];
      const content = slide.html || this._generateSlideHtml(slide.title, slide.slide_type);
      slideFiles.push([slide.file, content]);
    }

    try {
      await window.__TAURI__.core.invoke('save_ppt_extra', {
        folderPath: pb.folderPath,
        manifestJson: this._cleanManifestJson(pb.manifest),
        slideFiles,
      });

      this._showToast('已保存');
      if (modal) {
        this._closePptBuilder(modal);
      }
    } catch (e) {
      console.error('save_ppt_extra error:', e);
      this._showToast('保存失败', true);
    }
  },

  /** Return a clean manifest object (no runtime `html` field) for serialization */
  _cleanManifestJson(manifest) {
    return JSON.stringify({
      title: manifest.title,
      slides: (manifest.slides || []).map(({ file, title, slide_type }) => ({
        file, title, slide_type
      }))
    }, null, 2);
  },

  _showToast(message, isError = false) {
    const toast = document.createElement('div');
    toast.textContent = message;
    toast.style.cssText = `position:fixed;top:20px;right:20px;padding:8px 16px;border-radius:4px;background:${isError ? 'rgba(231,76,60,0.9)' : 'rgba(46,204,113,0.9)'};color:#fff;font-size:13px;z-index:10000;box-shadow:0 2px 6px rgba(0,0,0,0.2);`;
    document.body.appendChild(toast);
    setTimeout(() => document.body.removeChild(toast), 1000);
  },

  _generateSlideHtml(title, slideType) {
    const pb = this._pptBuilder;
    const templateFiles = pb && pb.templateFiles;
    const escapedTitle = this._escapeHtml(title);

    // Check if we have a template for this slide type
    if (templateFiles && templateFiles[slideType]) {
      let html = templateFiles[slideType];
      // Get CSS content if available
      const cssKey = slideType + '_css';
      const cssContent = templateFiles[cssKey];

      // Replace placeholder title with actual title
      html = html.replace(/标题|PLACEHOLDER_TITLE/g, escapedTitle);

      // Inject CSS inline if available
      if (cssContent) {
        // Replace <link rel="stylesheet" href="..."> with inline <style>
        html = html.replace(/<link[^>]*rel=["']stylesheet["'][^>]*>/g, '');
        html = html.replace(/<\/head>/, `<style>${cssContent}</style></head>`);
      }

      return html;
    }

    // Fallback to default templates
    switch (slideType) {
      case 'cover':
        return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    html, body { margin: 0; padding: 0; width: 100vw; height: 100vh; overflow: hidden; display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); color: #fff; }
    .slide { width: min(100vw, 177.78vh); height: min(100vh, 56.25vw); max-width: 100vw; max-height: 100vh; padding: 60px; box-sizing: border-box; display: flex; flex-direction: column; justify-content: center; text-align: center; }
    h1 { font-size: 3.5em; margin-bottom: 0.3em; font-weight: 300; letter-spacing: 2px; }
    p { font-size: 1.5em; color: #aaa; margin-top: 20px; }
  </style>
</head>
<body>
  <div class="slide">
    <h1>${escapedTitle}</h1>
    <p>副标题 | 作者</p>
  </div>
</body>
</html>`;

      case 'catalog':
        return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    html, body { margin: 0; padding: 0; width: 100vw; height: 100vh; overflow: hidden; display: flex; align-items: center; justify-content: center; background: #fff; color: #333; }
    .slide { width: min(100vw, 177.78vh); height: min(100vh, 56.25vw); max-width: 100vw; max-height: 100vh; padding: 60px; box-sizing: border-box; display: flex; flex-direction: column; }
    h2 { font-size: 2.5em; border-bottom: 3px solid #4a90d9; padding-bottom: 15px; margin-bottom: 40px; }
    ul { list-style: none; padding: 0; margin: 0; }
    li { font-size: 1.4em; padding: 12px 0; border-bottom: 1px solid #eee; }
    li:before { content: "▶"; color: #4a90d9; margin-right: 15px; }
  </style>
</head>
<body>
  <div class="slide">
    <h2>${escapedTitle}</h2>
    <ul>
      <li>第一章：介绍</li>
      <li>第二章：基础知识</li>
      <li>第三章：核心内容</li>
      <li>第四章：实践应用</li>
    </ul>
  </div>
</body>
</html>`;

      case 'chapter':
        return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    html, body { margin: 0; padding: 0; width: 100vw; height: 100vh; overflow: hidden; display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, #4a90d9 0%, #357abd 100%); color: #fff; }
    .slide { width: min(100vw, 177.78vh); height: min(100vh, 56.25vw); max-width: 100vw; max-height: 100vh; padding: 60px; box-sizing: border-box; display: flex; flex-direction: column; justify-content: center; }
    h2 { font-size: 3em; margin-bottom: 20px; }
    p { font-size: 1.5em; opacity: 0.9; }
  </style>
</head>
<body>
  <div class="slide">
    <h2>${escapedTitle}</h2>
    <p>章节副标题</p>
  </div>
</body>
</html>`;

      case 'content':
        return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    html, body { margin: 0; padding: 0; width: 100vw; height: 100vh; overflow: hidden; display: flex; align-items: center; justify-content: center; background: #f5f7fa; color: #333; }
    .slide { width: min(100vw, 177.78vh); height: min(100vh, 56.25vw); max-width: 100vw; max-height: 100vh; padding: 60px; box-sizing: border-box; display: flex; flex-direction: column; }
    h3 { font-size: 2em; margin-bottom: 30px; color: #4a90d9; }
    p { font-size: 1.3em; line-height: 1.8; margin: 10px 0; }
    code { background: #e8eef5; padding: 3px 8px; border-radius: 4px; font-family: monospace; color: #e74c3c; }
  </style>
</head>
<body>
  <div class="slide">
    <h3>${escapedTitle}</h3>
    <p>在这里添加您的内容...</p>
  </div>
</body>
</html>`;

      case 'finish':
      default:
        return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    html, body { margin: 0; padding: 0; width: 100vw; height: 100vh; overflow: hidden; display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, #2d3436 0%, #636e72 100%); color: #fff; }
    .slide { width: min(100vw, 177.78vh); height: min(100vh, 56.25vw); max-width: 100vw; max-height: 100vh; padding: 60px; box-sizing: border-box; display: flex; flex-direction: column; justify-content: center; text-align: center; }
    h2 { font-size: 3em; margin-bottom: 30px; }
    p { font-size: 1.5em; color: #aaa; }
  </style>
</head>
<body>
  <div class="slide">
    <h2>${escapedTitle}</h2>
    <p>Q&A</p>
  </div>
</body>
</html>`;
    }
  },

  _closePptBuilder(modal) {
    this._pptBuilder = null;
    if (modal && modal.parentNode) {
      modal.parentNode.removeChild(modal);
    }
  },

  _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  },

  _addAiMessage(container, role, content) {
    const msg = document.createElement('div');
    msg.style.cssText = `display:flex;gap:8px;${role === 'user' ? 'justify-content:flex-end;' : ''}`;
    msg.innerHTML = `
      <div style="max-width:80%;padding:12px 16px;border-radius:12px;background:${role === 'user' ? 'var(--accent)' : 'var(--bg-secondary)'};color:${role === 'user' ? '#fff' : 'var(--text-primary)'};font-size:14px;line-height:1.6;box-shadow:0 2px 4px rgba(0,0,0,0.1);">
        <div class="ai-msg-content"></div>
      </div>
    `;
    container.appendChild(msg);
    const contentDiv = msg.querySelector('.ai-msg-content');
    if (content) {
      this._renderAiContent(contentDiv, content, role);
    }
    container.scrollTop = container.scrollHeight;
    return msg;
  },

  _renderAiContent(contentDiv, text, role) {
    if (role === 'user') {
      contentDiv.style.whiteSpace = 'pre-wrap';
      contentDiv.textContent = text;
      return;
    }

    const codeMatch = text.match(/```html\n([\s\S]*?)\n```/);
    if (codeMatch) {
      const htmlCode = codeMatch[1];
      const beforeCode = text.substring(0, codeMatch.index);
      const afterCode = text.substring(codeMatch.index + codeMatch[0].length);

      contentDiv.innerHTML = '';

      if (beforeCode.trim()) {
        const beforeDiv = document.createElement('div');
        beforeDiv.innerHTML = window.marked ? window.marked.parse(beforeCode) : beforeCode;
        contentDiv.appendChild(beforeDiv);
      }

      const codeBlock = document.createElement('div');
      codeBlock.style.cssText = 'margin:8px 0;';
      const pre = document.createElement('pre');
      pre.style.cssText = 'background:var(--bg-tertiary);padding:12px;border-radius:6px;overflow-x:auto;margin:0;border:1px solid var(--border);';
      const code = document.createElement('code');
      code.className = 'language-html';
      code.textContent = htmlCode;
      pre.appendChild(code);
      codeBlock.appendChild(pre);

      if (window.hljs) {
        window.hljs.highlightElement(code);
      }

      const btn = document.createElement('button');
      btn.textContent = '应用此代码';
      btn.style.cssText = 'margin-top:8px;padding:6px 12px;border-radius:4px;border:1px solid var(--accent);background:transparent;color:var(--accent);cursor:pointer;font-size:12px;';

      const pb = this._pptBuilder;
      const self = this;
      btn.onclick = function() {
        if (confirm('确定要替换当前页面的HTML代码吗？')) {
          pb.slides[pb.currentSlideIndex].html = htmlCode;
          self._renderPptBuilderInContent();
        }
      };
      codeBlock.appendChild(btn);
      contentDiv.appendChild(codeBlock);

      if (afterCode.trim()) {
        const afterDiv = document.createElement('div');
        afterDiv.innerHTML = window.marked ? window.marked.parse(afterCode) : afterCode;
        contentDiv.appendChild(afterDiv);
      }
    } else {
      contentDiv.innerHTML = window.marked ? window.marked.parse(text) : text.replace(/\n/g, '<br>');
    }
  },

  async _callAi(appConfig, userMsg, currentHtml) {
    const provider = appConfig.aiProvider;
    const apiKey = provider === 'lectureai'
        ? (window.Auth?.getToken() || '')
        : appConfig.aiApiKey;

    const systemPrompt = `你是一个HTML幻灯片编辑助手。用户会告诉你如何修改当前页面,你需要返回修改后的完整HTML代码。
当前页面HTML:
\`\`\`html
${currentHtml}
\`\`\`

请根据用户要求修改HTML,并用\`\`\`html\`\`\`包裹返回完整代码。`;

    try {
      Tracker.track('ai_call', provider);
      const result = await window.__TAURI__.core.invoke('call_ai', {
        provider,
        apiKey,
        apiType: appConfig.aiApiType,
        baseUrl: appConfig.aiBaseUrl,
        model: appConfig.aiModel,
        systemPrompt,
        userMsg
      });
      return result;
    } catch (e) {
      throw new Error(`AI调用失败: ${e}`);
    }
  },

  _showReorderModal() {
    const pb = this._pptBuilder;
    if (!pb) return;

    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:3100;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;';
    modal.innerHTML = `
      <div style="background:var(--bg-primary);border-radius:12px;width:500px;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.4);">
        <div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;">
          <span style="font-weight:600;font-size:16px;">调整页面顺序</span>
          <button id="reorder-close" style="background:none;border:none;color:var(--text-muted);font-size:20px;cursor:pointer;">✕</button>
        </div>
        <div id="reorder-list" style="flex:1;overflow-y:auto;padding:12px;"></div>
        <div style="padding:16px 20px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;">
          <button id="reorder-done" style="padding:8px 16px;border-radius:6px;border:none;background:var(--accent);color:#fff;cursor:pointer;">完成</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    this._renderReorderList();

    const close = () => {
      document.body.removeChild(modal);
      this._renderPptBuilderInContent();
    };
    document.getElementById('reorder-close').onclick = close;
    document.getElementById('reorder-done').onclick = close;
    modal.onclick = (e) => {
      if (e.target === modal) close();
    };
  },

  _showAiChat() {
    const pb = this._pptBuilder;
    if (!pb) return;

    const appConfig = CourseLoader.appConfig || {};
    if (!appConfig.aiProvider || (appConfig.aiProvider !== 'lectureai' && !appConfig.aiApiKey)) {
      alert('请先在开发者设置中配置AI');
      return;
    }

    if (appConfig.aiProvider === 'custom' && (!appConfig.aiBaseUrl || !appConfig.aiApiType)) {
      alert('请先在开发者设置中配置自定义 AI 的 API 类型和 Base URL');
      return;
    }

    if (!pb.chatHistory) pb.chatHistory = {};
    if (!pb.chatHistory[pb.currentSlideIndex]) pb.chatHistory[pb.currentSlideIndex] = [];

    const sidebar = document.createElement('div');
    sidebar.id = 'ai-sidebar';
    sidebar.style.cssText = 'position:fixed;top:0;right:-500px;width:500px;height:100vh;background:var(--bg-primary);border-left:1px solid var(--border);z-index:3100;display:flex;flex-direction:column;transition:right 0.3s ease;box-shadow:-4px 0 20px rgba(0,0,0,0.2);';
    sidebar.innerHTML = `
      <div style="padding:16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;">
        <span style="font-weight:600;">AI助手</span>
        <button id="ai-close" style="background:none;border:none;color:var(--text-muted);font-size:20px;cursor:pointer;">✕</button>
      </div>
      <div id="ai-messages" style="flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px;"></div>
      <div style="padding:16px;border-top:1px solid var(--border);">
        <div style="display:flex;gap:8px;">
          <input type="text" id="ai-input" placeholder="告诉AI如何修改..." style="flex:1;padding:10px;border:1px solid var(--border);border-radius:6px;background:var(--bg-secondary);color:var(--text-primary);">
          <button id="ai-send" style="padding:10px 20px;border-radius:6px;border:none;background:var(--accent);color:#fff;cursor:pointer;">发送</button>
        </div>
      </div>
    `;

    document.body.appendChild(sidebar);
    setTimeout(() => sidebar.style.right = '0', 10);

    const close = () => {
      sidebar.style.right = '-500px';
      setTimeout(() => document.body.removeChild(sidebar), 300);
    };
    document.getElementById('ai-close').onclick = close;

    const input = document.getElementById('ai-input');
    const sendBtn = document.getElementById('ai-send');
    const messagesDiv = document.getElementById('ai-messages');

    const history = pb.chatHistory[pb.currentSlideIndex];
    history.forEach(msg => this._addAiMessage(messagesDiv, msg.role, msg.content));

    const sendMessage = async () => {
      const userMsg = input.value.trim();
      if (!userMsg) return;

      input.value = '';
      sendBtn.disabled = true;
      input.disabled = true;

      this._addAiMessage(messagesDiv, 'user', userMsg);
      history.push({ role: 'user', content: userMsg });

      const assistantMsg = this._addAiMessage(messagesDiv, 'assistant', '');
      const contentDiv = assistantMsg.querySelector('.ai-msg-content');
      let fullText = '';
      let renderTimer = null;

      try {
        const unlisten = await window.__TAURI__.event.listen('ai-stream-chunk', (event) => {
          fullText += event.payload;

          if (renderTimer) clearTimeout(renderTimer);
          renderTimer = setTimeout(() => {
            this._renderAiContent(contentDiv, fullText, 'assistant');
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
          }, 50);
        });

        await window.__TAURI__.event.listen('ai-stream-done', () => {
          unlisten();
          if (renderTimer) clearTimeout(renderTimer);
          history.push({ role: 'assistant', content: fullText });
          this._renderAiContent(contentDiv, fullText, 'assistant');
          sendBtn.disabled = false;
          input.disabled = false;
          input.focus();
        });

        Tracker.track('ai_call', appConfig.aiProvider);
        await window.__TAURI__.core.invoke('call_ai_stream', {
          provider: appConfig.aiProvider,
          apiKey: appConfig.aiProvider === 'lectureai' ? (window.Auth?.getToken() || '') : appConfig.aiApiKey,
          apiType: appConfig.aiApiType,
          baseUrl: appConfig.aiBaseUrl,
          model: appConfig.aiModel,
          systemPrompt: `你是HTML幻灯片编辑助手。当前页面:\n\`\`\`html\n${pb.slides[pb.currentSlideIndex].html}\n\`\`\`\n\n请根据用户要求修改HTML,用\`\`\`html\`\`\`包裹返回完整代码。`,
          userMsg
        });
      } catch (e) {
        const errMsg = String(e);
        contentDiv.textContent = errMsg;
        contentDiv.style.color = 'var(--text-muted)';
        history.push({ role: 'assistant', content: errMsg });
        sendBtn.disabled = false;
        input.disabled = false;
      }
    };

    sendBtn.onclick = sendMessage;
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    };

    input.focus();
  },

  _renderReorderList() {
    const pb = this._pptBuilder;
    const container = document.getElementById('reorder-list');
    container.innerHTML = pb.slides.map((slide, idx) => `
      <div class="reorder-item" data-index="${idx}" style="display:flex;align-items:center;gap:12px;padding:12px;background:var(--bg-secondary);border-radius:8px;margin-bottom:8px;border:1px solid var(--border);">
        <span style="cursor:grab;color:var(--text-muted);font-size:16px;">⠿</span>
        <span style="font-weight:600;min-width:30px;">${idx + 1}</span>
        <span style="flex:1;">${this._escapeHtml(slide.title)}</span>
        <div style="display:flex;gap:4px;">
          <button class="btn-up" data-index="${idx}" style="padding:4px 8px;border:none;background:var(--bg-hover);color:var(--text-primary);cursor:pointer;border-radius:4px;" ${idx === 0 ? 'disabled style="opacity:0.3;"' : ''}>▲</button>
          <button class="btn-down" data-index="${idx}" style="padding:4px 8px;border:none;background:var(--bg-hover);color:var(--text-primary);cursor:pointer;border-radius:4px;" ${idx === pb.slides.length - 1 ? 'disabled style="opacity:0.3;"' : ''}>▼</button>
        </div>
      </div>
    `).join('');

    // Bind events
    container.querySelectorAll('.btn-up').forEach(btn => {
      btn.onclick = () => {
        const idx = parseInt(btn.dataset.index);
        if (idx > 0) {
          [pb.slides[idx - 1], pb.slides[idx]] = [pb.slides[idx], pb.slides[idx - 1]];
          this._renderReorderList();
        }
      };
    });

    container.querySelectorAll('.btn-down').forEach(btn => {
      btn.onclick = () => {
        const idx = parseInt(btn.dataset.index);
        if (idx < pb.slides.length - 1) {
          [pb.slides[idx], pb.slides[idx + 1]] = [pb.slides[idx + 1], pb.slides[idx]];
          this._renderReorderList();
        }
      };
    });
  },

  _editPptConfig() {
    const pb = this._pptBuilder;
    if (!pb) return;

    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:3100;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;';

    const configText = this._cleanManifestJson(pb.manifest);

    modal.innerHTML = `
      <div style="background:var(--bg-primary);border-radius:12px;width:90%;max-width:900px;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.4);">
        <div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;">
          <div>
            <div style="font-weight:600;font-size:16px;">编辑配置文件</div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">manifest.json - 修改后点击保存生效</div>
          </div>
          <button id="config-close" style="background:none;border:none;color:var(--text-muted);font-size:20px;cursor:pointer;">✕</button>
        </div>
        <div style="flex:1;overflow:auto;padding:20px;background:var(--bg-secondary);">
          <textarea id="config-editor" style="width:100%;min-height:500px;padding:16px;border:1px solid var(--border);border-radius:8px;background:var(--bg-tertiary);color:var(--text-primary);font-family:'Monaco','Menlo','Courier New',monospace;font-size:13px;line-height:1.6;resize:vertical;box-sizing:border-box;tab-size:2;">${this._escapeHtml(configText)}</textarea>
        </div>
        <div style="padding:16px 20px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;">
          <div style="font-size:13px;color:var(--text-muted);">提示：修改title、slides数组等字段</div>
          <div style="display:flex;gap:12px;">
            <button id="config-cancel" style="padding:8px 16px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;">取消</button>
            <button id="config-save" style="padding:8px 16px;border-radius:6px;border:none;background:var(--accent);color:#fff;cursor:pointer;">保存</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    const close = () => document.body.removeChild(modal);
    document.getElementById('config-close').onclick = close;
    document.getElementById('config-cancel').onclick = close;
    document.getElementById('config-save').onclick = () => {
      try {
        const newManifest = JSON.parse(document.getElementById('config-editor').value);
        // Build a map of file -> html from old slides to restore runtime html content
        const htmlMap = {};
        for (const s of (pb.slides || [])) {
          if (s.file && s.html !== undefined) htmlMap[s.file] = s.html;
        }
        pb.manifest = newManifest;
        pb.slides = newManifest.slides || [];
        // Restore in-memory html for slides that still reference the same file
        for (const s of pb.slides) {
          if (s.file && s.file in htmlMap) s.html = htmlMap[s.file];
        }
        if (pb.currentSlideIndex >= pb.slides.length) {
          pb.currentSlideIndex = Math.max(0, pb.slides.length - 1);
        }
        this._renderPptBuilderInContent();
        close();
      } catch (e) {
        alert('JSON格式错误: ' + e.message);
      }
    };

    modal.onclick = (e) => {
      if (e.target === modal) close();
    };
  },

  _bindPageListDrag() {
    const container = document.getElementById('ppte-page-items');
    if (!container || container.dataset.dragBound) return;
    container.dataset.dragBound = 'true';

    let dragState = null; // { srcIndex, ghost, indicator }

    const getItemAtY = (y) => {
      const items = container.querySelectorAll('li');
      for (const li of items) {
        const rect = li.getBoundingClientRect();
        if (y >= rect.top && y <= rect.bottom) {
          const mid = rect.top + rect.height / 2;
          return { li, index: parseInt(li.dataset.index), above: y < mid };
        }
      }
      // Below all items — target last item, insert below
      if (items.length > 0) {
        const last = items[items.length - 1];
        return { li: last, index: parseInt(last.dataset.index), above: false };
      }
      return null;
    };

    const onMouseMove = (e) => {
      if (!dragState) return;
      e.preventDefault();

      // Move ghost
      dragState.ghost.style.top = (e.clientY - dragState.offsetY) + 'px';
      dragState.ghost.style.left = (e.clientX - dragState.offsetX) + 'px';

      // Update indicator
      const target = getItemAtY(e.clientY);
      container.querySelectorAll('li').forEach(li => {
        li.classList.remove('drag-over-above', 'drag-over-below');
      });
      if (target && target.index !== dragState.srcIndex) {
        target.li.classList.add(target.above ? 'drag-over-above' : 'drag-over-below');
      }
    };

    const onMouseUp = (e) => {
      if (!dragState) return;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);

      // Clean up ghost
      if (dragState.ghost.parentNode) dragState.ghost.parentNode.removeChild(dragState.ghost);

      // Clean up indicators and dragging class
      container.querySelectorAll('li').forEach(li => {
        li.classList.remove('dragging', 'drag-over-above', 'drag-over-below');
      });

      // Perform reorder
      const target = getItemAtY(e.clientY);
      if (target && target.index !== dragState.srcIndex) {
        let destIndex = target.index;
        const srcIndex = dragState.srcIndex;
        // Adjust destination for above/below
        if (!target.above && destIndex < srcIndex) destIndex++;
        else if (target.above && destIndex > srcIndex) destIndex--;

        const pb = this._pptBuilder;
        const [moved] = pb.slides.splice(srcIndex, 1);
        pb.slides.splice(destIndex, 0, moved);
        pb.slides.forEach((slide, i) => {
          slide.file = `slide${String(i + 1).padStart(2, '0')}.html`;
        });
        pb.currentSlideIndex = destIndex;
        this._renderPptBuilderInContent();
      }

      dragState = null;
    };

    container.addEventListener('mousedown', (e) => {
      const handle = e.target.closest('.drag-handle');
      if (!handle) return;
      const li = handle.closest('li');
      if (!li) return;

      e.preventDefault();
      const srcIndex = parseInt(li.dataset.index);
      const rect = li.getBoundingClientRect();

      // Create ghost element
      const ghost = li.cloneNode(true);
      ghost.classList.remove('active');
      ghost.style.cssText = `
        position: fixed;
        top: ${rect.top}px;
        left: ${rect.left}px;
        width: ${rect.width}px;
        height: ${rect.height}px;
        background: var(--bg-secondary);
        border: 1px solid var(--accent);
        border-radius: 6px;
        opacity: 0.85;
        z-index: 9999;
        pointer-events: none;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 12px 16px;
        font-size: 13px;
        color: var(--text-primary);
        box-sizing: border-box;
        list-style: none;
      `;
      document.body.appendChild(ghost);

      li.classList.add('dragging');

      dragState = {
        srcIndex,
        ghost,
        offsetY: e.clientY - rect.top,
        offsetX: e.clientX - rect.left,
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  },

  _escapeAttr(str) {
    return (str || '').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  },

  _normalizeManifestSlides(slides) {
    const rawSlides = Array.isArray(slides) ? slides : [];
    return rawSlides.map((slide, index) => {
      if (typeof slide === 'string') {
        return {
          file: slide,
          title: `页面 ${index + 1}`,
          slide_type: 'content',
          html: '',
        };
      }
      return {
        file: slide?.file || `slide${String(index + 1).padStart(2, '0')}.html`,
        title: slide?.title || `页面 ${index + 1}`,
        slide_type: slide?.slide_type || 'content',
        html: slide?.html || '',
      };
    });
  },

  initKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Cmd+1-9: jump to section (0-indexed)
      if (e.metaKey && !e.shiftKey && e.key >= '1' && e.key <= '9') {
        e.preventDefault();
        Sidebar.selectSection(parseInt(e.key) - 1);
      }

      // Cmd+0: section 10 (index 9)
      if (e.metaKey && !e.shiftKey && e.key === '0') {
        e.preventDefault();
        Sidebar.selectSection(9);
      }

      // Cmd+Shift+P: presentation mode
      if (e.metaKey && e.shiftKey && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault();
        document.body.classList.toggle('presentation-mode');
      }

      // Escape: close modals (priority order)
      if (e.key === 'Escape') {
        if (CourseCreator.isOpen()) {
          CourseCreator.close();
        } else if (CourseManager.isOpen()) {
          CourseManager.close();
        } else if (CodeViewer.isOpen()) {
          CodeViewer.close();
        } else if (HtmlViewer.isOpen()) {
          HtmlViewer.close();
        } else if (PptExtraViewer.isOpen()) {
          PptExtraViewer.close();
        } else if (!document.getElementById('pdf-modal').classList.contains('hidden')) {
          PdfViewer.close();
        } else if (!document.getElementById('video-modal').classList.contains('hidden')) {
          VideoPlayer.close();
        }
      }
    });
  }
};
