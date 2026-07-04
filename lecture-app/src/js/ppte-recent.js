// ppte-recent.js — Recent PPTE list rendering and opening
window.PpteRecent = {
  _loadRecentPpte() {
    const appConfig = CourseLoader.appConfig || {};
    const recent = appConfig.recentPpte || [];
    const container = document.getElementById('ppte-recent-items');
    if (recent.length === 0) {
      container.innerHTML = '<p class="ppte-empty-state">暂无最近打开的 PPTE</p>';
      return;
    }
    container.innerHTML = recent.map((item, idx) => `
      <div class="ppte-recent-item" data-path="${this._escapeAttr(item.path)}">
        <div class="ppte-recent-content">
          <div class="ppte-recent-title">${this._escapeHtml(item.title)}</div>
          <div class="ppte-recent-path">${this._escapeHtml(item.path)}</div>
        </div>
        <button class="ppte-recent-delete" data-index="${idx}" title="删除">×</button>
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
      manifest._fileStats = await this._loadPptFileStats(folderPath, manifest);
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
};

if (window.Settings) {
  Object.assign(window.Settings, window.PpteRecent);
}
