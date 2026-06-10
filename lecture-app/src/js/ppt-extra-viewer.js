// ppt-extra-viewer.js — Display HTML slides in a PPT-like viewer with Speaker Mode
const PptExtraViewer = {
  modal: null,
  title: '',
  baseUrl: '',     // asset:// URL for iframe src
  basePath: '',    // raw filesystem path for Tauri commands
  slides: [],
  manifest: null,
  currentIndex: 0,
  isPlaying: false,

  // Speaker mode state
  isSpeakerMode: false,
  audienceWindow: null,
  notes: {},       // { slideIndex: "note content" }
  timer: {
    start: null,
    elapsed: 0,
    interval: null,
    running: false
  },

  init() {
    this.modal = document.getElementById('ppt-extra-modal');
    if (!this.modal) return;

    document.getElementById('ppt-extra-close').addEventListener('click', () => this.close());
    document.getElementById('ppt-extra-export').addEventListener('click', () => this.exportToPpt());
    document.getElementById('ppt-extra-play').addEventListener('click', () => this.togglePlayMode());
    document.getElementById('ppt-extra-speaker').addEventListener('click', () => this.toggleSpeakerMode());

    // Speaker mode controls
    document.getElementById('speaker-exit').addEventListener('click', () => this.exitSpeakerMode());

    // Listen for open-file/open-url requests from slide iframes
    window.addEventListener('message', (e) => this._handleSlideOpenMessage(e.data, e.source));
    if (window.__TAURI__ && window.__TAURI__.event) {
      window.__TAURI__.event.listen('audience-navigate', (event) => {
        if (!this.isSpeakerMode) return;
        this._handleNavigationAction(event.payload);
      }).catch(e => console.warn('Failed to listen audience navigation:', e));
    }
    document.getElementById('speaker-prev').addEventListener('click', () => this.prev());
    document.getElementById('speaker-prev-fast').addEventListener('click', () => this.prev());
    document.getElementById('speaker-next').addEventListener('click', () => this.next());
    document.getElementById('speaker-next-fast').addEventListener('click', () => this.next());
    document.querySelector('.speaker-current-frame').addEventListener('click', (e) => {
      if (!this.isSpeakerMode || e.defaultPrevented || e.button !== 0) return;
      this.next();
    });
    document.getElementById('speaker-timer-toggle').addEventListener('click', () => this.toggleTimer());
    document.getElementById('speaker-toggle-audience').addEventListener('click', () => this.toggleAudienceFullscreen());
    document.getElementById('speaker-notes-toggle').addEventListener('click', () => this.toggleNotesMode());

    // Auto-save notes when leaving edit mode
    document.getElementById('speaker-notes-edit').addEventListener('blur', () => this.saveCurrentNote());

    // Keyboard navigation
    document.addEventListener('keydown', (e) => {
      if (!this.isOpen()) return;
      // Ignore shortcuts when typing in editable areas
      const isEditing = e.target.isContentEditable || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';
      if (e.key === 'Escape') {
        if (this.isSpeakerMode) this.exitSpeakerMode();
        else this.close();
      }
      if (isEditing) return;
      if (this._handleNavigationKey(e)) return;
      if (e.key === 'f' || e.key === 'F') this.togglePlayMode();
      if (e.key === 's' || e.key === 'S') this.toggleSpeakerMode();
    });
  },

  isOpen() {
    return this.modal && !this.modal.classList.contains('hidden');
  },

  async open(title, baseUrl, basePath) {
    this.title = title;
    this.baseUrl = baseUrl;
    this.basePath = basePath || '';
    this.manifest = null;
    this.currentIndex = 0;
    this.isPlaying = false;
    this.isSpeakerMode = false;
    this.modal.classList.remove('playing-mode', 'speaker-mode');
    document.getElementById('ppt-extra-speaker').style.display = '';
    document.getElementById('speaker-view').classList.add('hidden');
    document.getElementById('ppt-extra-toc').style.display = '';
    document.getElementById('ppt-extra-container').style.display = '';

    // Load manifest — prefer Tauri read_text_file (reliable on all platforms)
    try {
      let manifest;
      if (window.__TAURI__ && this.basePath) {
        const manifestPath = (this.basePath + '/manifest.json').replace(/\\/g, '/');
        try {
          const content = await window.__TAURI__.core.invoke('read_text_file', { filePath: manifestPath });
          manifest = JSON.parse(content);
        } catch (fsErr) {
          console.warn('Tauri read manifest failed, falling back to fetch:', fsErr);
          const manifestUrl = baseUrl + '/manifest.json';
          const response = await fetch(manifestUrl);
          if (!response.ok) throw new Error('manifest not found');
          manifest = await response.json();
        }
      } else {
        // Fallback to fetch (for browser dev mode)
        const manifestUrl = baseUrl + '/manifest.json';
        const response = await fetch(manifestUrl);
        if (!response.ok) throw new Error('manifest not found');
        manifest = await response.json();
      }
      this.manifest = manifest;
      this.slides = manifest.slides || [];
    } catch (e) {
      console.error('Failed to load manifest:', e);
      alert('无法加载幻灯片清单 (manifest.json)');
      return;
    }

    if (this.slides.length === 0) {
      alert('没有找到幻灯片');
      return;
    }

    this.renderTOC();
    this.updateUI();
    this.modal.classList.remove('hidden');

    // Preload notes in background, store promise for speaker mode to await.
    this._notesReady = this.preloadNotes().then(() => {
      if (this.isSpeakerMode) this.updateSpeakerNotes();
    });
  },

  async preloadNotes() {
    this.notes = {};

    for (let i = 0; i < this.slides.length; i++) {
      const slide = this.slides[i];
      const noteFileName = this._noteFileNameForSlide(slide);

      // Try 1: Tauri read_text_file (fastest, works with correct basePath)
      if (window.__TAURI__ && this.basePath) {
        const notePath = (this.basePath + '/' + noteFileName).replace(/\\/g, '/');
        try {
          const noteContent = await window.__TAURI__.core.invoke('read_text_file', { filePath: notePath });
          this.notes[i] = noteContent;
          continue;
        } catch (e) {
          // Tauri read failed — file may not exist or basePath is wrong; fall through to fetch
        }
      }

      // Try 2: fetch via baseUrl (works when basePath is unavailable or wrong)
      if (this.baseUrl) {
        try {
          const noteUrl = this.baseUrl + '/' + noteFileName;
          const response = await fetch(noteUrl);
          if (response.ok) {
            const noteContent = await response.text();
            this.notes[i] = noteContent;
            continue;
          }
        } catch (e) {
          // Fetch may fail for file protocols or missing notes; keep an empty note below.
        }
      }

      // Note file not found via any method
      this.notes[i] = '';
    }
  },

  renderTOC() {
    const list = document.getElementById('ppt-extra-toc-list');
    list.innerHTML = '';

    this.slides.forEach((slide, index) => {
      const li = document.createElement('li');
      li.dataset.index = index;
      li.innerHTML = `<span class="toc-page-num">${index + 1}</span>${this._escapeHtml(slide.title || '无标题')}<span style="margin-left:auto;font-size:11px;color:var(--text-muted);flex-shrink:0;padding-left:6px;">${this._escapeHtml(slide.file || '')}</span>`;
      li.addEventListener('click', () => {
        this.currentIndex = index;
        this.updateUI();
      });
      list.appendChild(li);
    });
  },

  updateUI() {
    const slide = this.slides[this.currentIndex];
    document.getElementById('ppt-extra-title').textContent = this.title;

    // Update TOC selection
    const tocItems = document.querySelectorAll('#ppt-extra-toc-list li');
    tocItems.forEach((item, index) => {
      item.classList.toggle('active', index === this.currentIndex);
    });

    // Load slide in iframe. Windows WebView2 needs srcdoc with http://slide.localhost;
    // macOS WebKit loads the registered slide:// protocol directly and needs it for subresources.
    const iframe = document.getElementById('ppt-extra-iframe');
    if (window.__TAURI__ && this.basePath && this._usesCustomProtocolHost()) {
      this._loadSlideFrame(iframe, slide);
    } else {
      iframe.removeAttribute('srcdoc');
      iframe.src = window.__TAURI__ && this.basePath
        ? this.getSlideUrl(this.currentIndex)
        : this.baseUrl + '/' + slide.file;
      iframe.addEventListener('load', () => this._installFrameNavigation(iframe), { once: true });
    }

    // Update speaker view if active
    if (this.isSpeakerMode) {
      this.updateSpeakerView();
    }
  },

  updateSpeakerView() {
    const slide = this.slides[this.currentIndex];
    const nextIndex = Math.min(this.currentIndex + 1, this.slides.length - 1);
    const nextSlide = this.slides[nextIndex];

    // Current slide iframe
    const currentFrame = document.getElementById('speaker-current-slide');
    if (window.__TAURI__ && this.basePath && this._usesCustomProtocolHost()) {
      this._loadSlideFrame(currentFrame, slide);
    } else {
      currentFrame.removeAttribute('srcdoc');
      currentFrame.src = window.__TAURI__ && this.basePath
        ? this.getSlideUrl(this.currentIndex)
        : this.baseUrl + '/' + slide.file;
      currentFrame.addEventListener('load', () => this._installFrameNavigation(currentFrame), { once: true });
    }

    // Next slide iframe
    const nextFrame = document.getElementById('speaker-next-slide');
    if (window.__TAURI__ && this.basePath && this._usesCustomProtocolHost()) {
      this._loadSlideFrame(nextFrame, nextSlide);
    } else {
      nextFrame.removeAttribute('srcdoc');
      nextFrame.src = window.__TAURI__ && this.basePath
        ? this.getSlideUrl(nextIndex)
        : this.baseUrl + '/' + nextSlide.file;
      nextFrame.addEventListener('load', () => this._installFrameNavigation(nextFrame), { once: true });
    }

    this.updateSpeakerNotes();

    // Page info
    document.getElementById('speaker-page-info').textContent =
      `${this.currentIndex + 1} / ${this.slides.length}`;

    // Update audience window
    this.updateAudienceSlide(this.currentIndex);
  },

  updateSpeakerNotes() {
    const noteContent = this.notes[this.currentIndex] || '';
    const preview = document.getElementById('speaker-notes-preview');
    const editor = document.getElementById('speaker-notes-edit');

    if (this._notesEditing) {
      // Stay in edit mode, just update textarea content
      editor.value = noteContent;
    } else {
      // Update preview
      if (window.marked && noteContent) {
        preview.innerHTML = window.marked.parse(noteContent);
      } else {
        preview.textContent = noteContent || '';
      }
    }
  },

  // Build slide protocol URL that preserves path separators for correct relative resource resolution.
  // The built-in asset protocol (convertFileSrc) encodes / to %2F, breaking relative URLs.
  // Our custom "slide" protocol in Rust handles paths with real slashes.
  _assetUrl(filePath) {
    const normalizedPath = String(filePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const segments = normalizedPath.split('/');
    const encoded = segments.map(s => encodeURIComponent(s)).join('/');
    if (this._usesCustomProtocolHost()) {
      return 'http://slide.localhost/' + encoded;
    }
    return 'slide://localhost/' + encoded;
  },

  _usesCustomProtocolHost() {
    const platform = (navigator.platform || '').toLowerCase();
    const userAgent = (navigator.userAgent || '').toLowerCase();
    return platform.includes('win') || userAgent.includes('windows');
  },

  _slidePath(slide) {
    return (this.basePath + '/' + slide.file).replace(/\\/g, '/');
  },

  _slideBaseUrl(slidePath) {
    const slash = slidePath.lastIndexOf('/');
    const dirPath = slash >= 0 ? slidePath.slice(0, slash + 1) : slidePath;
    return this._assetUrl(dirPath);
  },

  async _loadSlideFrame(frame, slide) {
    if (!frame || !slide) return;
    const slidePath = this._slidePath(slide);
    const slideUrl = this._assetUrl(slidePath);
    const baseUrl = this._slideBaseUrl(slidePath);

    frame.dataset.slideUrl = slideUrl;
    frame.removeAttribute('src');

    try {
      let html = await window.__TAURI__.core.invoke('read_text_file', { filePath: slidePath });
      html = this._injectBaseHref(html, baseUrl);
      frame.srcdoc = html;
      frame.addEventListener('load', () => this._installFrameNavigation(frame), { once: true });
    } catch (e) {
      console.warn('Tauri read slide failed, falling back to protocol URL:', e, slidePath);
      frame.removeAttribute('srcdoc');
      frame.src = slideUrl;
      frame.addEventListener('load', () => this._installFrameNavigation(frame), { once: true });
    }
  },

  _injectBaseHref(html, baseUrl) {
    const base = `<base href="${this._escapeHtml(baseUrl)}">`;
    if (/<base\b[^>]*>/i.test(html)) {
      return html.replace(/<base\b[^>]*>/i, base);
    }
    if (/<head[^>]*>/i.test(html)) {
      return html.replace(/<head([^>]*)>/i, `<head$1>${base}`);
    }
    return `${base}${html}`;
  },

  getSlideUrl(index) {
    const slide = this.slides[index];
    if (window.__TAURI__ && this.basePath) {
      const slidePath = (this.basePath + '/' + slide.file).replace(/\\/g, '/');
      return this._assetUrl(slidePath);
    }
    return this.baseUrl + '/' + slide.file;
  },

  async _handleSlideOpenMessage(data, source) {
    if (!data) return;
    if (data.type === 'slide-navigate') {
      if (!this.isOpen() || !this._isSlideMessageSource(source)) return;
      this._handleNavigationAction(data.direction || data.action);
      return;
    }

    if (data.type !== 'open-file' && data.type !== 'open-resource') return;
    if (!this.isOpen() || !this._isSlideMessageSource(source)) return;

    if (data.url) {
      const url = String(data.url).trim();
      if (!/^https?:\/\//i.test(url)) {
        console.warn('Blocked unsupported slide URL:', url);
        return;
      }
      await this._openExternal(url);
      return;
    }

    if (!data.path || !this.basePath) return;
    const relativePath = String(data.path).replace(/\\/g, '/');
    if (relativePath.startsWith('/') || relativePath.split('/').includes('..')) {
      console.warn('Blocked unsafe slide resource path:', relativePath);
      return;
    }

    const filePath = (this.basePath + '/' + relativePath).replace(/\\/g, '/');
    await this._openExternal(filePath);
  },

  _isSlideMessageSource(source) {
    return [
      'ppt-extra-iframe',
      'speaker-current-slide',
      'speaker-next-slide'
    ].some(id => {
      const frame = document.getElementById(id);
      return frame && frame.contentWindow === source;
    });
  },

  async _openExternal(pathOrUrl) {
    if (window.__TAURI__ && window.__TAURI__.core) {
      try {
        await window.__TAURI__.core.invoke('open_external', { path: pathOrUrl });
      } catch (err) {
        console.error('Failed to open slide resource:', err, pathOrUrl);
      }
      return;
    }
    window.open(pathOrUrl, '_blank');
  },

  _handleNavigationKey(e) {
    const key = e.key;
    if (key === 'ArrowLeft' || key === 'PageUp') {
      e.preventDefault();
      this.prev();
      return true;
    }
    if (key === 'ArrowRight' || key === 'PageDown' || key === ' ' || key === 'Spacebar' || key === 'Enter') {
      e.preventDefault();
      this.next();
      return true;
    }
    return false;
  },

  _handleNavigationAction(action) {
    if (action === 'prev' || action === 'previous' || action === 'back') {
      this.prev();
      return;
    }
    this.next();
  },

  _installFrameNavigation(frame) {
    try {
      const doc = frame.contentDocument || frame.contentWindow.document;
      if (!doc || doc.__pptNavigationInstalled) return;
      doc.__pptNavigationInstalled = true;

      doc.addEventListener('keydown', (e) => {
        if (this._isEditableTarget(e.target)) return;
        const direction = this._navigationDirectionFromKey(e.key);
        if (!direction) return;
        e.preventDefault();
        frame.contentWindow.parent.postMessage({ type: 'slide-navigate', direction }, '*');
      }, true);

      doc.addEventListener('click', (e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
        if (this._isInteractiveClickTarget(e.target)) return;
        e.preventDefault();
        frame.contentWindow.parent.postMessage({ type: 'slide-navigate', direction: 'next' }, '*');
      }, true);
    } catch (e) {
      console.warn('Unable to install slide frame navigation:', e);
    }
  },

  _isEditableTarget(target) {
    if (!target) return false;
    const tag = target.tagName;
    return target.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  },

  _navigationDirectionFromKey(key) {
    if (key === 'ArrowLeft' || key === 'PageUp') return 'prev';
    if (key === 'ArrowRight' || key === 'PageDown' || key === ' ' || key === 'Spacebar' || key === 'Enter') return 'next';
    return '';
  },

  _isInteractiveClickTarget(target) {
    if (!target || !target.closest) return false;
    return !!target.closest('a, button, input, textarea, select, label, [contenteditable="true"], [data-no-slide-nav]');
  },

  async exportToPpt() {
    const btn = document.getElementById('ppt-extra-export');
    const originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = '导出中...';

    try {
      const savedPath = await PptePptExporter.export(this);
      if (savedPath) {
        alert(`PPT 导出完成：\n${savedPath}`);
      }
    } catch (e) {
      if (String(e).includes('cancelled')) return;
      console.error('PPTE export failed:', e);
      alert(`导出 PPT 失败：${e.message || e}`);
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
    }
  },

  _lastSavedIndex: -1,

  saveCurrentNote() {
    if (!window.__TAURI__ || !this.basePath || !this.isSpeakerMode) return;
    // Only save from editor when in edit mode; otherwise trust in-memory notes
    const index = this.currentIndex;
    const content = this._notesEditing
      ? document.getElementById('speaker-notes-edit').value
      : this.notes[index] || '';

    // Only save if content changed
    if (this.notes[index] === content) return;
    this.notes[index] = content;
    this._writeNote(index, content);
  },

  _writeNote(index, content) {
    if (!window.__TAURI__ || !this.basePath) return;
    const slide = this.slides[index];
    const notePath = (this.basePath + '/' + this._noteFileNameForSlide(slide)).replace(/\\/g, '/');
    window.__TAURI__.core.invoke('write_text_file', { filePath: notePath, content }).catch(e => {
      console.error('Failed to save note:', e);
    });
  },

  togglePlayMode() {
    this.isPlaying = !this.isPlaying;
    this.modal.classList.toggle('playing-mode', this.isPlaying);
    const playBtn = document.getElementById('ppt-extra-play');
    playBtn.innerHTML = this.isPlaying
      ? '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>'
      : '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5,3 19,12 5,21" fill="currentColor"/></svg>';
  },

  _notesEditing: false,

  toggleNotesMode() {
    this._setNotesMode(this._notesEditing ? 'preview' : 'edit');
  },

  _setNotesMode(mode) {
    const preview = document.getElementById('speaker-notes-preview');
    const editor = document.getElementById('speaker-notes-edit');
    const btn = document.getElementById('speaker-notes-toggle');

    if (mode === 'edit') {
      this._notesEditing = true;
      preview.classList.add('hidden');
      editor.classList.remove('hidden');
      editor.value = this.notes[this.currentIndex] || '';
      editor.focus();
      btn.textContent = '预览';
    } else {
      // Save before switching to preview
      if (this._notesEditing) {
        const content = editor.value;
        if (this.notes[this.currentIndex] !== content) {
          this.notes[this.currentIndex] = content;
          this._writeNote(this.currentIndex, content);
        }
      }
      this._notesEditing = false;
      editor.classList.add('hidden');
      preview.classList.remove('hidden');
      const noteContent = this.notes[this.currentIndex] || '';
      if (window.marked && noteContent) {
        preview.innerHTML = window.marked.parse(noteContent);
      } else {
        preview.textContent = noteContent;
      }
      btn.textContent = '编辑';
    }
  },

  async toggleSpeakerMode() {
    if (this.isSpeakerMode) {
      this.exitSpeakerMode();
    } else {
      await this.enterSpeakerMode();
    }
  },

  async enterSpeakerMode() {
    this.isSpeakerMode = true;
    document.getElementById('ppt-extra-speaker').style.display = 'none';
    document.getElementById('ppt-extra-toc').style.display = 'none';
    document.getElementById('ppt-extra-container').style.display = 'none';
    document.getElementById('speaker-view').classList.remove('hidden');
    document.getElementById('speaker-title').textContent = this.title;

    // Ensure notes are loaded before showing speaker view
    if (this._notesReady) await this._notesReady;

    // Open audience window
    await this.openAudienceWindow();

    // Update speaker view
    this.updateSpeakerView();
  },

  exitSpeakerMode() {
    this.isSpeakerMode = false;
    this.stopTimer();
    document.getElementById('ppt-extra-speaker').style.display = '';
    document.getElementById('ppt-extra-toc').style.display = '';
    document.getElementById('ppt-extra-container').style.display = '';
    document.getElementById('speaker-view').classList.add('hidden');

    // Close audience window
    this.closeAudienceWindow();
  },

  async openAudienceWindow() {
    if (!window.__TAURI__) return;
    try {
      const slideUrl = this.getSlideUrl(this.currentIndex);
      await window.__TAURI__.core.invoke('open_audience_window', {
        slideUrl,
        title: this.title || 'Slides'
      });
    } catch (e) {
      console.error('Failed to open audience window:', e);
    }
  },

  async closeAudienceWindow() {
    if (!window.__TAURI__) return;
    try {
      await window.__TAURI__.core.invoke('close_audience_window');
    } catch (e) {
      console.error('Failed to close audience window:', e);
    }
  },

  async updateAudienceSlide(index) {
    if (!window.__TAURI__ || !this.isSpeakerMode) return;
    try {
      const slideUrl = this.getSlideUrl(index);
      await window.__TAURI__.core.invoke('emit_slide_change', { slideUrl });
    } catch (e) {
      console.error('Failed to update audience slide:', e);
    }
  },

  async toggleAudienceFullscreen() {
    if (!window.__TAURI__) return;
    try {
      const { WebviewWindow } = window.__TAURI__.window;
      const audienceWin = new WebviewWindow('audience');
      const isFullscreen = await audienceWin.isFullscreen();
      await audienceWin.setFullscreen(!isFullscreen);
    } catch (e) {
      console.error('Failed to toggle audience fullscreen:', e);
    }
  },

  prev() {
    if (this.currentIndex > 0) {
      if (this.isSpeakerMode) this.saveCurrentNote();
      this.currentIndex--;
      this.updateUI();
    }
  },

  next() {
    if (this.currentIndex < this.slides.length - 1) {
      if (this.isSpeakerMode) this.saveCurrentNote();
      this.currentIndex++;
      this.updateUI();
    }
  },

  // Timer functions
  startTimer() {
    if (this.timer.running) return;
    this.timer.start = Date.now() - (this.timer.elapsed * 1000);
    this.timer.running = true;
    this.timer.interval = setInterval(() => {
      this.timer.elapsed = Math.floor((Date.now() - this.timer.start) / 1000);
      this.updateTimerDisplay();
    }, 1000);
    document.getElementById('speaker-timer-toggle').textContent = '⏸';
  },

  stopTimer() {
    if (!this.timer.running) return;
    clearInterval(this.timer.interval);
    this.timer.running = false;
    document.getElementById('speaker-timer-toggle').textContent = '▶';
  },

  toggleTimer() {
    if (this.timer.running) {
      this.stopTimer();
    } else {
      this.startTimer();
    }
  },

  updateTimerDisplay() {
    document.getElementById('speaker-timer').textContent = this.formatTime(this.timer.elapsed);
  },

  formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  },

  close() {
    this.isPlaying = false;
    this.modal.classList.remove('playing-mode');
    document.getElementById('ppt-extra-play').innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5,3 19,12 5,21" fill="currentColor"/></svg>';

    if (this.isSpeakerMode) {
      this.exitSpeakerMode();
    }

    this.modal.classList.add('hidden');
    const iframe = document.getElementById('ppt-extra-iframe');
    iframe.src = 'about:blank';
    this.slides = [];
    this.currentIndex = 0;
    this.notes = {};
    this.stopTimer();
    this.timer.elapsed = 0;
    this.updateTimerDisplay();
  },

  _noteFileNameForSlide(slide) {
    const explicitNote = slide.note || slide.notes || slide.speakerNote || slide.speakerNotes;
    if (explicitNote) return String(explicitNote).replace(/\\/g, '/');

    const file = String(slide.file || '');
    return file.replace(/\.html?$/i, '.note');
  },

  _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  },
};
