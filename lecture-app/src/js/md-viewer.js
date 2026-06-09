// md-viewer.js — Markdown file viewer using marked.js
const MdViewer = {
  init() {
    document.getElementById('md-close').addEventListener('click', () => this.close());
    document.getElementById('md-modal').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
    });
  },

  async open(title, url, filePath = '') {
    document.getElementById('md-title').textContent = title;
    document.getElementById('md-modal').classList.remove('hidden');
    document.getElementById('md-modal').focus();

    const body = document.getElementById('md-body');
    body.innerHTML = '<div class="empty-state"><p>加载中...</p></div>';

    try {
      let text;
      if (window.__TAURI__ && window.__TAURI__.core && filePath) {
        text = await window.__TAURI__.core.invoke('read_text_file', {
          filePath: String(filePath).replace(/\\/g, '/')
        });
      } else {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        text = await response.text();
      }
      body.innerHTML = marked.parse(text);
    } catch (e) {
      console.error('Failed to load markdown:', e);
      body.innerHTML = `<div class="empty-state"><div class="icon">⚠</div><p>无法加载文件: ${e.message}</p></div>`;
    }
  },

  close() {
    document.getElementById('md-modal').classList.add('hidden');
  }
};
