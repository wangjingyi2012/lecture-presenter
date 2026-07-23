// dev-settings.js — Developer settings, template center, prompts, and updater config
window.DevSettings = {
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

    this.initAiSettings(appConfig);
    this.initGiteeSettings();
    this.initCaptionSettings(appConfig);

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

};

if (window.Settings) {
  Object.assign(window.Settings, window.DevSettings);
}
