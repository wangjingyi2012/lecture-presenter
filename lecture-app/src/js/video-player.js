// video-player.js — Video playback with blob URLs to avoid WebView2 local URL safety checks
const VideoPlayer = {
  objectUrl: '',
  errorEl: null,
  sources: [],
  sourceIndex: 0,
  filePath: '',
  resetting: false,

  init() {
    document.getElementById('video-close').addEventListener('click', () => this.close());
    document.getElementById('video-modal').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
    });

    const video = document.getElementById('video-player');
    this.errorEl = document.createElement('div');
    this.errorEl.className = 'empty-state hidden';
    this.errorEl.innerHTML = '<div class="icon">⚠</div><p></p>';
    document.getElementById('video-container').appendChild(this.errorEl);

    video.addEventListener('error', () => {
      if (this.resetting || (!video.currentSrc && !video.getAttribute('src'))) return;
      const error = video.error;
      if (this._tryNextSource()) return;

      const message = error ? `视频加载失败（错误码 ${error.code}）。可点击下方按钮用系统播放器打开。` : '视频加载失败。可点击下方按钮用系统播放器打开。';
      this._showError(message, this.filePath);
      console.error('Video playback error:', error, 'src:', video.currentSrc || video.src);
    });

    video.addEventListener('loadedmetadata', () => this._hideError());
  },

  async open(title, url, filePath = '') {
    document.getElementById('video-title').textContent = title;
    document.getElementById('video-modal').classList.remove('hidden');
    this.filePath = filePath || '';

    const video = document.getElementById('video-player');
    this._hideError();
    this.resetting = true;
    video.pause();
    video.removeAttribute('src');
    video.load();
    this.resetting = false;

    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = '';
    }

    try {
      const source = await this._createPrimarySource(url, filePath);
      this.sources = [source];
      this.sourceIndex = 0;
      this._loadCurrentSource();
    } catch (e) {
      console.error('Failed to prepare video source:', e);
      this._showError(`视频加载失败：${e.message || e}。可点击下方按钮用系统播放器打开。`, this.filePath);
    }
    video.focus();
  },

  close() {
    const video = document.getElementById('video-player');
    this.resetting = true;
    video.pause();
    video.removeAttribute('src');
    video.load();
    this.resetting = false;
    this._hideError();
    this.sources = [];
    this.sourceIndex = 0;
    this.filePath = '';
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = '';
    }
    document.getElementById('video-modal').classList.add('hidden');
  },

  async _createPrimarySource(url, filePath) {
    if (window.__TAURI__ && window.__TAURI__.core && filePath) {
      const normalizedPath = String(filePath).replace(/\\/g, '/');
      const bytes = await window.__TAURI__.core.invoke('read_file_bytes', { filePath: normalizedPath });
      const blob = new Blob([new Uint8Array(bytes)], { type: this._mimeForPath(normalizedPath) });
      this.objectUrl = URL.createObjectURL(blob);
      return { src: this.objectUrl, label: 'blob' };
    }

    return { src: url, label: 'fallback' };
  },

  _mimeForPath(filePath) {
    const ext = String(filePath || '').split('.').pop().toLowerCase();
    const mimeMap = {
      mp4: 'video/mp4',
      m4v: 'video/mp4',
      mov: 'video/quicktime',
      webm: 'video/webm',
      ogv: 'video/ogg'
    };
    return mimeMap[ext] || 'application/octet-stream';
  },

  _loadCurrentSource() {
    const video = document.getElementById('video-player');
    const current = this.sources[this.sourceIndex];
    if (!current) return false;
    console.log('Loading video source:', current.label, current.src);
    video.src = current.src;
    video.load();
    return true;
  },

  _tryNextSource() {
    if (this.sourceIndex + 1 >= this.sources.length) return false;
    this.sourceIndex += 1;
    this._hideError();
    return this._loadCurrentSource();
  },

  async _openExternal() {
    if (!this.filePath || !window.__TAURI__ || !window.__TAURI__.core) return;
    try {
      await window.__TAURI__.core.invoke('open_external', { path: this.filePath });
    } catch (e) {
      console.error('Failed to open video externally:', e);
    }
  },

  _showError(message, filePath = '') {
    if (!this.errorEl) return;
    this.errorEl.innerHTML = `<div class="icon">⚠</div><p></p>${filePath ? '<button type="button" class="btn secondary">用系统播放器打开</button>' : ''}`;
    this.errorEl.querySelector('p').textContent = message;
    const button = this.errorEl.querySelector('button');
    if (button) button.addEventListener('click', () => this._openExternal());
    this.errorEl.classList.remove('hidden');
  },

  _hideError() {
    if (this.errorEl) this.errorEl.classList.add('hidden');
  }
};
