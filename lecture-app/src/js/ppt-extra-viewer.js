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
  isPlayMenuOpen: false,
  isExportMenuOpen: false,
  _slideEditableFocus: false,
  _watchUnlisten: null,
  _reloadSeq: 0,

  // Speaker mode state
  isSpeakerMode: false,
  audienceWindow: null,
  annotator: null,
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
    window.LiveCaption?.initMain?.();

    document.getElementById('ppt-extra-close').addEventListener('click', () => this.close());
    document.getElementById('ppt-extra-refresh').addEventListener('click', () => this.refreshCurrentSlide());
    document.getElementById('ppt-extra-export').addEventListener('click', (e) => {
      e.stopPropagation();
      this.setExportMenuOpen(!this.isExportMenuOpen);
    });
    document.querySelectorAll('#ppt-export-menu [data-export-mode]').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        this.setExportMenuOpen(false);
        this.exportToPpt(item.dataset.exportMode);
      });
    });
    document.addEventListener('click', (e) => {
      if (this.isExportMenuOpen && !(e.target.closest && e.target.closest('.ppt-export-wrap'))) {
        this.setExportMenuOpen(false);
      }
    });
    document.getElementById('ppt-extra-play').addEventListener('click', () => this.togglePlayMode());
    document.getElementById('ppt-extra-speaker').addEventListener('click', () => this.toggleSpeakerMode());
    document.getElementById('ppt-extra-annotate').addEventListener('click', () => {
      this.toggleAnnotator();
    });
    document.getElementById('ppt-play-menu-toggle').addEventListener('click', (e) => {
      e.stopPropagation();
      this.setPlayMenuOpen(!this.isPlayMenuOpen);
    });
    document.getElementById('ppt-play-exit').addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.isPlaying) this.togglePlayMode();
    });
    document.getElementById('ppt-play-annotate').addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleAnnotator();
      this._restorePlayFocus();
    });
    // Keep keyboard navigation inside slide frames instead of stealing focus back
    // after every click. Frame-level handlers below forward navigation keys to
    // the parent, while editable controls keep normal text input focus.

    // Transient annotation overlay over the slide iframe (memory-only, discarded on close)
    if (window.PpteAnnotator) {
      this.annotator = PpteAnnotator.create({
        container: document.getElementById('ppt-extra-container'),
        isAvailable: () => this.isOpen() && !this.isSpeakerMode,
        onActiveChange: (active) => {
          this.updateAnnotatorButtons(active);
        }
      });
    }

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
      setTimeout(() => {
        if (this._slideEditableFocus) return;
        if (this._frameHasEditableFocus(document.getElementById('speaker-current-slide'))) return;
        this.next();
      }, 80);
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
        else if (this.isExportMenuOpen) this.setExportMenuOpen(false);
        else if (this.isPlayMenuOpen) this.setPlayMenuOpen(false);
        else if (this.isPlaying) this.togglePlayMode();
        else this.close();
        e.preventDefault();
        return;
      }
      if (isEditing) return;
      if (this._handleNavigationKey(e)) return;
      if (e.key === 'f' || e.key === 'F') this.togglePlayMode();
      if (e.key === 's' || e.key === 'S') this.toggleSpeakerMode();
      if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault();
        window.LiveCaption?.toggle?.();
      }
    });
  },

  isOpen() {
    return this.modal && !this.modal.classList.contains('hidden');
  },

  async open(title, baseUrl, basePath) {
    await this._stopWatchingPpte();
    await window.LiveCaption?.stop?.();
    this.title = title;
    this.baseUrl = baseUrl;
    this.basePath = basePath || '';
    this.manifest = null;
    this.currentIndex = 0;
    this.isPlaying = false;
    this.isSpeakerMode = false;
    this.isPlayMenuOpen = false;
    this.isExportMenuOpen = false;
    this._slideEditableFocus = false;
    this._reloadSeq = 0;
    if (this.annotator) this.annotator.reset();
    this.modal.classList.remove('playing-mode', 'speaker-mode');
    this.setPlayMenuOpen(false);
    this.setExportMenuOpen(false);
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
    await this._startWatchingPpte();

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

  async _startWatchingPpte() {
    if (!window.__TAURI__ || !window.__TAURI__.event || !this.basePath) return;
    try {
      if (this._watchUnlisten) await this._stopWatchingPpte();
      this._watchUnlisten = await window.__TAURI__.event.listen('ppte-file-changed', (event) => {
        this._handlePpteFileChanged(event.payload).catch(e => {
          console.warn('Failed to handle PPTE file change:', e);
        });
      });
      await window.__TAURI__.core.invoke('watch_ppte_folder', { folderPath: this.basePath });
    } catch (e) {
      console.warn('Failed to watch PPTE folder:', e);
    }
  },

  async _stopWatchingPpte() {
    const folderPath = this.basePath;
    if (this._watchUnlisten) {
      try {
        this._watchUnlisten();
      } catch (e) {
        console.warn('Failed to remove PPTE watch listener:', e);
      }
      this._watchUnlisten = null;
    }
    if (window.__TAURI__ && folderPath) {
      try {
        await window.__TAURI__.core.invoke('unwatch_ppte_folder', { folderPath });
      } catch (e) {
        console.warn('Failed to unwatch PPTE folder:', e);
      }
    }
  },

  _normalizePpteRelativePath(path) {
    return String(path || '').replace(/\\/g, '/').replace(/^\/+/, '');
  },

  async _handlePpteFileChanged(payload) {
    if (!payload || !this.isOpen() || !this.basePath) return;
    const changedFolder = String(payload.folderPath || '').replace(/\\/g, '/');
    const currentFolder = String(this.basePath || '').replace(/\\/g, '/');
    if (changedFolder !== currentFolder) return;

    const files = (payload.files || []).map(path => this._normalizePpteRelativePath(path));
    if (files.length === 0) return;

    if (files.includes('manifest.json')) {
      await this._reloadManifest();
      this.refreshCurrentSlide();
      return;
    }

    const currentSlide = this.slides[this.currentIndex];
    const currentFile = this._normalizePpteRelativePath(currentSlide?.file);
    const currentNote = this._normalizePpteRelativePath(this._noteFileNameForSlide(currentSlide || {}));
    if (currentFile && files.includes(currentFile)) {
      this.refreshCurrentSlide();
    }
    if (currentNote && files.includes(currentNote) && !this._notesEditing) {
      await this._reloadNote(this.currentIndex);
      this.updateSpeakerNotes();
    }
  },

  async _reloadManifest() {
    if (!window.__TAURI__ || !this.basePath) return;
    const manifestPath = (this.basePath + '/manifest.json').replace(/\\/g, '/');
    const content = await window.__TAURI__.core.invoke('read_text_file', { filePath: manifestPath });
    const manifest = JSON.parse(content);
    this.manifest = manifest;
    this.slides = manifest.slides || [];
    this.currentIndex = Math.min(this.currentIndex, Math.max(0, this.slides.length - 1));
    this.renderTOC();
  },

  async _reloadNote(index) {
    if (!window.__TAURI__ || !this.basePath || !this.slides[index]) return;
    const notePath = (this.basePath + '/' + this._noteFileNameForSlide(this.slides[index])).replace(/\\/g, '/');
    try {
      this.notes[index] = await window.__TAURI__.core.invoke('read_text_file', { filePath: notePath });
    } catch (e) {
      this.notes[index] = '';
    }
  },

  refreshCurrentSlide() {
    if (!this.isOpen() || this.slides.length === 0) return;
    const token = this._nextReloadToken();
    const mainFrame = document.getElementById('ppt-extra-iframe');
    this._reloadFrame(mainFrame, this.currentIndex, { bustCache: true, token });

    if (this.isSpeakerMode) {
      const currentFrame = document.getElementById('speaker-current-slide');
      const nextFrame = document.getElementById('speaker-next-slide');
      const nextIndex = Math.min(this.currentIndex + 1, this.slides.length - 1);
      this._reloadFrame(currentFrame, this.currentIndex, { bustCache: true, token });
      this._reloadFrame(nextFrame, nextIndex, { bustCache: true, token });
      this.updateAudienceSlide(this.currentIndex, { bustCache: true, token });
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
    if (this.annotator) this.annotator.setPage(this.currentIndex);

    // Update TOC selection
    const tocItems = document.querySelectorAll('#ppt-extra-toc-list li');
    tocItems.forEach((item, index) => {
      item.classList.toggle('active', index === this.currentIndex);
    });

    const iframe = document.getElementById('ppt-extra-iframe');
    this._reloadFrame(iframe, this.currentIndex);

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
    this._reloadFrame(currentFrame, this.currentIndex);

    // Next slide iframe
    const nextFrame = document.getElementById('speaker-next-slide');
    this._reloadFrame(nextFrame, nextIndex);

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

  _withCacheBust(url, token) {
    if (!token) return url;
    return `${url}${url.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}`;
  },

  _nextReloadToken() {
    this._reloadSeq += 1;
    return String(this._reloadSeq);
  },

  _reloadFrame(frame, index, options = {}) {
    if (!frame || index < 0 || index >= this.slides.length) return;
    const slide = this.slides[index];
    const token = options.bustCache ? (options.token || this._nextReloadToken()) : '';

    // Windows WebView2 needs srcdoc with http://slide.localhost;
    // macOS WebKit loads the registered slide:// protocol directly and needs it for subresources.
    if (window.__TAURI__ && this.basePath && this._usesCustomProtocolHost()) {
      this._loadSlideFrame(frame, slide, { bustCache: !!options.bustCache, token });
      return;
    }

    frame.removeAttribute('srcdoc');
    frame.src = window.__TAURI__ && this.basePath
      ? this.getSlideUrl(index, { bustCache: !!options.bustCache, token })
      : this._withCacheBust(this.baseUrl + '/' + slide.file, token);
    frame.addEventListener('load', () => this._installFrameNavigation(frame), { once: true });
  },

  async _loadSlideFrame(frame, slide, options = {}) {
    if (!frame || !slide) return;
    const slidePath = this._slidePath(slide);
    const token = options.bustCache ? (options.token || this._nextReloadToken()) : '';
    const slideUrl = this._withCacheBust(this._assetUrl(slidePath), token);
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

  getSlideUrl(index, options = {}) {
    const slide = this.slides[index];
    if (window.__TAURI__ && this.basePath) {
      const slidePath = (this.basePath + '/' + slide.file).replace(/\\/g, '/');
      return this._withCacheBust(this._assetUrl(slidePath), options.bustCache ? options.token : '');
    }
    return this._withCacheBust(this.baseUrl + '/' + slide.file, options.bustCache ? options.token : '');
  },

  async _handleSlideOpenMessage(data, source) {
    if (!data) return;
    if (data.type === 'slide-navigate') {
      if (!this.isOpen() || !this._isSlideMessageSource(source)) return;
      this._handleNavigationAction(data.direction || data.action);
      return;
    }
    if (data.type === 'slide-shortcut') {
      if (!this.isOpen() || !this._isSlideMessageSource(source)) return;
      this._handleSlideShortcut(data.action);
      return;
    }
    if (data.type === 'slide-edit-focus') {
      if (!this.isOpen() || !this._isSlideMessageSource(source)) return;
      this._slideEditableFocus = !!data.active;
      if (!this._slideEditableFocus && this.isPlaying) {
        setTimeout(() => this._restorePlayFocus(), 120);
      }
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

  _handleSlideShortcut(action) {
    if (action === 'play') {
      this.togglePlayMode();
      return;
    }
    if (action === 'annotate') {
      this.toggleAnnotator();
      this._restorePlayFocus();
      return;
    }
    if (action === 'speaker') {
      this.toggleSpeakerMode();
      return;
    }
    if (action === 'caption') {
      window.LiveCaption?.toggle?.();
      return;
    }
    if (action === 'escape') {
      if (this.isPlayMenuOpen) this.setPlayMenuOpen(false);
      else if (this.isPlaying) this.togglePlayMode();
      else this.close();
    }
  },

  _handleNavigationAction(action) {
    if (action === 'prev' || action === 'previous' || action === 'back') {
      this.prev();
      return;
    }
    this.next();
  },

  _restorePlayFocus() {
    if (!this.isOpen() || !this.isPlaying) return;
    if (this._slideEditableFocus) return;
    if (this._hasEditableFocusInSlideFrames()) return;
    const anchor = document.getElementById('ppt-extra-focus-anchor');
    if (anchor) anchor.focus({ preventScroll: true });
  },

  _hasEditableFocusInSlideFrames() {
    return ['ppt-extra-iframe', 'speaker-current-slide', 'speaker-next-slide'].some(id => {
      const frame = document.getElementById(id);
      return this._frameHasEditableFocus(frame);
    });
  },

  _frameHasEditableFocus(frame) {
    try {
      const doc = frame && (frame.contentDocument || frame.contentWindow?.document);
      if (!doc || !doc.hasFocus()) return false;
      return this._isEditableTarget(doc.activeElement);
    } catch (e) {
      return false;
    }
  },

  _installFrameNavigation(frame) {
    try {
      const doc = frame.contentDocument || frame.contentWindow.document;
      if (!doc || doc.__pptNavigationInstalled) return;
      doc.__pptNavigationInstalled = true;

      doc.addEventListener('keydown', (e) => {
        if (this._isEditableTarget(e.target)) return;
        const shortcut = this._slideShortcutFromKey(e);
        if (shortcut) {
          e.preventDefault();
          frame.contentWindow.parent.postMessage({ type: 'slide-shortcut', action: shortcut }, '*');
          return;
        }
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

      doc.addEventListener('pointerdown', (e) => {
        frame.contentWindow.parent.postMessage({
          type: 'slide-edit-focus',
          active: this._isEditableTarget(e.target)
        }, '*');
      }, true);

      doc.addEventListener('focusin', (e) => {
        if (!this._isEditableTarget(e.target)) return;
        frame.contentWindow.parent.postMessage({ type: 'slide-edit-focus', active: true }, '*');
      }, true);

      doc.addEventListener('focusout', (e) => {
        if (!this._isEditableTarget(e.target)) return;
        frame.contentWindow.parent.postMessage({ type: 'slide-edit-focus', active: false }, '*');
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

  _slideShortcutFromKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return '';
    if (e.key === 'f' || e.key === 'F') return 'play';
    if (e.key === 'p' || e.key === 'P') return 'annotate';
    if (e.key === 's' || e.key === 'S') return 'speaker';
    if (e.key === 'c' || e.key === 'C') return 'caption';
    if (e.key === 'Escape') return 'escape';
    return '';
  },

  _isInteractiveClickTarget(target) {
    if (!target || !target.closest) return false;
    return !!target.closest('a, button, input, textarea, select, label, [contenteditable="true"], [data-no-slide-nav]');
  },

  setExportMenuOpen(open) {
    this.isExportMenuOpen = !!open;
    const menu = document.getElementById('ppt-export-menu');
    if (menu) menu.classList.toggle('hidden', !this.isExportMenuOpen);
    const btn = document.getElementById('ppt-extra-export');
    if (btn) btn.setAttribute('aria-expanded', this.isExportMenuOpen ? 'true' : 'false');
    if (this.isExportMenuOpen) this._refreshExportMenuQuota();
  },

  // Refreshes the editable-mode menu descriptions with the live quota.
  async _refreshExportMenuQuota() {
    const descs = document.querySelectorAll('#ppt-export-menu [data-export-editable] .ppt-export-menu-desc');
    if (!descs.length) return;
    const setText = text => descs.forEach(desc => { desc.textContent = text; });
    if (!window.Auth?.isLoggedIn?.()) {
      setText('登录后可用');
      return;
    }
    try {
      const quota = await this._fetchPptxExportQuota();
      if (quota.unauthorized) {
        setText('登录后可用');
        return;
      }
      const remaining = Number.isFinite(quota.remaining) ? quota.remaining : '?';
      setText(`可编辑 · 本月剩 ${remaining} 次`);
    } catch (e) {
      setText('可编辑导出');
    }
  },

  async _fetchPptxExportQuota() {
    const serverUrl = (window.Auth?.serverUrl || 'https://design.hz-study-system.com').replace(/\/+$/, '');
    const token = window.Auth?.getToken?.() || '';
    const response = await fetch(`${serverUrl}/api/web/desktop/pptx-export/quota`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (response.status === 401) return { unauthorized: true };
    if (!response.ok) throw new Error(`导出额度查询失败（${response.status}）`);
    return response.json();
  },

  async exportToPpt(mode) {
    // Every PPTX export requires an account; the editable modes additionally
    // consume the monthly quota checked in _exportEditablePptx.
    if (!window.Auth?.isLoggedIn?.()) {
      window.Auth?.showLoginModal?.();
      return;
    }

    const btn = document.getElementById('ppt-extra-export');
    const originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = '导出中...';

    try {
      const savedPath = mode === 'image'
        ? await this._exportImagePptx(btn)
        : await this._exportEditablePptx(mode, btn);
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

  _exportImagePptx(btn) {
    return PpteImageExporter.export(this, {
      onProgress: (done, total) => {
        btn.textContent = `导出中 ${done}/${total}`;
      }
    });
  },

  // Editable export renders on the server: check quota, then hand the PPTE
  // directory to the export_pptx_editable command which packs, uploads and
  // saves the returned pptx through a save dialog.
  async _exportEditablePptx(mode, btn) {
    const quota = await this._fetchPptxExportQuota();
    if (quota.unauthorized) {
      window.Auth?.showLoginModal?.();
      return null;
    }
    if (!(quota.remaining > 0)) {
      const used = Number.isFinite(quota.used) ? quota.used : '?';
      const limit = Number.isFinite(quota.limit) ? quota.limit : '?';
      alert(`本月可编辑导出额度已用完（${used}/${limit}），升级会员可获得更多额度。`);
      const membershipUrl = window.Auth?.membershipUrl || 'https://design.hz-study-system.com/membership';
      if (confirm('是否前往会员页面了解详情？')) {
        if (window.__TAURI__?.shell?.open) window.__TAURI__.shell.open(membershipUrl);
        else window.open(membershipUrl, '_blank', 'noopener');
      }
      return null;
    }

    btn.textContent = '上传并生成中…';
    const baseName = this.manifest?.title || this.title || 'PPTE导出';
    const suffix = mode === 'steps' ? '-分步版' : mode === 'animate' ? '-动画版' : '';
    const defaultName = `${String(`${baseName}${suffix}`).replace(/[\\/:*?"<>|]/g, '_').trim() || 'PPTE导出'}.pptx`;
    const serverUrl = (window.Auth?.serverUrl || 'https://design.hz-study-system.com').replace(/\/+$/, '');
    try {
      return await window.__TAURI__.core.invoke('export_pptx_editable', {
        dirPath: this.basePath,
        mode,
        token: window.Auth?.getToken?.() || '',
        serverUrl,
        defaultName
      });
    } catch (e) {
      const message = String(e && e.message ? e.message : e);
      if (message.startsWith('unauthorized:')) {
        window.Auth?.showLoginModal?.();
        return null;
      }
      throw e;
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

  toggleAnnotator() {
    if (this.annotator) this.annotator.toggle();
  },

  updateAnnotatorButtons(active) {
    const headerBtn = document.getElementById('ppt-extra-annotate');
    const playBtn = document.getElementById('ppt-play-annotate');
    if (headerBtn) headerBtn.classList.toggle('annotating', active);
    if (playBtn) playBtn.classList.toggle('annotating', active);
  },

  setPlayMenuOpen(open) {
    this.isPlayMenuOpen = !!(open && this.isPlaying);
    const controls = document.getElementById('ppt-play-controls');
    const toggle = document.getElementById('ppt-play-menu-toggle');
    if (controls) controls.classList.toggle('menu-open', this.isPlayMenuOpen);
    if (toggle) toggle.setAttribute('aria-expanded', this.isPlayMenuOpen ? 'true' : 'false');
  },

  togglePlayMode() {
    this.isPlaying = !this.isPlaying;
    this.modal.classList.toggle('playing-mode', this.isPlaying);
    this.setPlayMenuOpen(false);
    if (this.isPlaying) setTimeout(() => this._restorePlayFocus(), 0);
    const playBtn = document.getElementById('ppt-extra-play');
    playBtn.innerHTML = this.isPlaying
      ? '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>'
      : '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5,3 19,12 5,21" fill="currentColor"/></svg>';
    if (!this.isPlaying) window.LiveCaption?.stop?.();
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
    this.setPlayMenuOpen(false);
    if (this.annotator) this.annotator.setActive(false);
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
    window.LiveCaption?.stop?.();
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

  async updateAudienceSlide(index, options = {}) {
    if (!window.__TAURI__ || !this.isSpeakerMode) return;
    try {
      const slideUrl = this.getSlideUrl(index, options);
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
    this._stopWatchingPpte();
    window.LiveCaption?.stop?.();
    this.isPlaying = false;
    this.modal.classList.remove('playing-mode');
    this.setPlayMenuOpen(false);
    this.setExportMenuOpen(false);
    document.getElementById('ppt-extra-play').innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5,3 19,12 5,21" fill="currentColor"/></svg>';

    if (this.isSpeakerMode) {
      this.exitSpeakerMode();
    }

    this.modal.classList.add('hidden');
    if (this.annotator) this.annotator.reset();
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
