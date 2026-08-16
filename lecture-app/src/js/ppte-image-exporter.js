// ppte-image-exporter.js — Export PPTE HTML slides as full-page images in a PPTX.
// Each slide is rendered in a hidden iframe, driven to its final step, rasterized
// via html-to-image, and placed as one full-bleed picture per PPTX page.
const PpteImageExporter = {
  slideWidth: 13.333333,
  slideHeight: 7.5,
  renderWidth: 1920,
  renderHeight: 1080,
  maxStepGuard: 40,

  async export(viewer, options = {}) {
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const PptxGen = await this._ensurePptxGen();
    const htmlToImage = this._ensureHtmlToImage();
    if (!viewer || !viewer.slides || viewer.slides.length === 0) {
      throw new Error('没有可导出的 PPTE 幻灯片');
    }

    const pptx = new PptxGen();
    pptx.layout = 'LAYOUT_WIDE';
    pptx.author = 'Lecture Presenter';
    pptx.company = 'Lecture Presenter';
    pptx.subject = viewer.title || 'PPTE Export';
    pptx.title = viewer.title || 'PPTE Export';
    pptx.lang = 'zh-CN';

    let processed = 0;
    for (const slideMeta of viewer.slides) {
      const dataUri = await this._renderSlideImage(viewer, slideMeta, htmlToImage);
      const slide = pptx.addSlide();
      slide.addImage({ data: dataUri, x: 0, y: 0, w: this.slideWidth, h: this.slideHeight });
      processed += 1;
      if (onProgress) onProgress(processed, viewer.slides.length);
    }

    const output = await pptx.write({ outputType: 'arraybuffer', compression: true });
    const bytes = Array.from(new Uint8Array(output));
    const baseName = viewer.manifest?.title || viewer.title || 'PPTE导出';
    const defaultName = `${this._safeFileName(`${baseName}-图片版`)}.pptx`;

    if (window.__TAURI__ && window.__TAURI__.core) {
      return window.__TAURI__.core.invoke('save_pptx_file', { defaultName, bytes });
    }

    const blob = new Blob([output], {
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = defaultName;
    link.click();
    URL.revokeObjectURL(url);
    return defaultName;
  },

  // Renders one slide to a PNG data URI at 2x the 1920x1080 render basis.
  async _renderSlideImage(viewer, slideMeta, htmlToImage) {
    const slidePath = viewer.basePath
      ? this._joinPath(viewer.basePath, slideMeta.file)
      : '';
    const html = await this._readSlideHtml(viewer, slideMeta, slidePath);
    const baseHref = this._baseHref(viewer, slideMeta, slidePath);
    const scriptSourceUrl = viewer.basePath && slidePath && viewer._assetUrl
      ? viewer._assetUrl(slidePath)
      : '';
    const loaded = await this._loadSlideIframe(html, baseHref, slideMeta.file, scriptSourceUrl);
    const basePath = slidePath ? this._dirname(slidePath) : '';

    try {
      const { doc, win } = loaded;
      // Image export keeps the final state, so stepped templates do not lose
      // everything except their first scene.
      await this._driveToFinalStep(doc, win);
      await this._waitForImages(doc);
      await this._settleFrames(win);
      await this._inlineLocalImages(doc, win, basePath);
      return await htmlToImage.toPng(loaded.slideEl, {
        pixelRatio: 2,
        width: this.renderWidth,
        height: this.renderHeight
      });
    } finally {
      loaded.cleanup();
    }
  },

  // html-to-image rasterizes through an SVG foreignObject, which cannot fetch
  // slide:// (or slide.localhost) resources. Inline every local image as a data
  // URI first, otherwise the snapshot renders blank where images should be.
  async _inlineLocalImages(doc, win, basePath) {
    const jobs = [];
    for (const img of Array.from(doc.images || [])) {
      const src = img.currentSrc || img.src;
      if (!src || src.startsWith('data:')) continue;
      jobs.push(this._imageUrlToDataUri(src, basePath).then(data => {
        if (data) img.src = data;
      }));
    }
    for (const el of Array.from(doc.querySelectorAll('*'))) {
      const bg = win.getComputedStyle(el).backgroundImage;
      if (!bg || bg === 'none' || !bg.includes('url(')) continue;
      const urls = [...String(bg).matchAll(/url\((['"]?)(.*?)\1\)/g)]
        .map(match => match[2])
        .filter(url => url && !url.startsWith('data:'));
      if (urls.length === 0) continue;
      jobs.push((async () => {
        let next = bg;
        for (const url of urls) {
          const data = await this._imageUrlToDataUri(url, basePath);
          if (data) next = next.split(url).join(data);
        }
        if (next !== bg) el.style.backgroundImage = next;
      })());
    }
    await Promise.all(jobs);
  },

  async _ensurePptxGen() {
    if (globalThis.PptxGenJS) return globalThis.PptxGenJS;

    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = new URL('vendor/pptxgen.bundle.js', document.baseURI).href;
      script.onload = resolve;
      script.onerror = () => reject(new Error('PPTX 导出库未加载'));
      document.head.appendChild(script);
    });

    if (!globalThis.PptxGenJS) {
      throw new Error('PPTX 导出库未加载');
    }
    return globalThis.PptxGenJS;
  },

  _ensureHtmlToImage() {
    if (globalThis.htmlToImage) return globalThis.htmlToImage;
    throw new Error('截图库未加载');
  },

  async _loadSlideIframe(html, baseHref, label, scriptSourceUrl = '') {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts allow-popups');
    iframe.style.position = 'fixed';
    iframe.style.left = '-10000px';
    iframe.style.top = '0';
    iframe.style.width = `${this.renderWidth}px`;
    iframe.style.height = `${this.renderHeight}px`;
    iframe.style.border = '0';
    iframe.style.opacity = '0';
    iframe.style.pointerEvents = 'none';
    document.body.appendChild(iframe);

    try {
      // Keep the frame same-origin so the snapshot can inspect its DOM, and
      // explicitly allow PPTE scripts so stepped templates can install their
      // keyboard handlers. srcdoc's load event fires after parsing and classic
      // script execution, which is the state rasterizing needs.
      // Tauri production CSP hashes the app's own inline scripts. srcdoc inherits
      // that policy, so PPTE inline scripts must be served as external slide://
      // resources instead of being silently blocked by WebKit.
      const executableHtml = this._externalizeInlineScripts(html, scriptSourceUrl);
      const frameHtml = this._withBaseTag(executableHtml, baseHref);
      await new Promise((resolve, reject) => {
        iframe.onload = resolve;
        iframe.onerror = () => reject(new Error(`无法渲染 ${label || 'slide'}`));
        iframe.srcdoc = frameHtml;
      });
    } catch (err) {
      iframe.remove();
      throw err;
    }

    const doc = iframe.contentDocument;
    const win = iframe.contentWindow;
    if (!doc || !win) {
      iframe.remove();
      throw new Error(`无法访问 ${label || '导出页面'} 的内容`);
    }

    if (doc.fonts && doc.fonts.ready) {
      await doc.fonts.ready.catch(() => {});
    }
    await this._waitForImages(doc);
    await this._settleFrames(win);

    const slideEl = doc.querySelector('.slide') || doc.body;
    return {
      doc,
      win,
      slideEl,
      cleanup: () => iframe.remove()
    };
  },

  _getStepState(doc) {
    if (!doc || typeof doc.querySelector !== 'function') return { step: 0, maxStep: 0 };
    const root = doc.querySelector('[data-template],[data-ppte-concept-animation]');
    if (!root || !root.dataset) return { step: 0, maxStep: 0 };
    const parse = value => {
      const num = parseInt(value, 10);
      return Number.isFinite(num) && num > 0 ? num : 0;
    };
    return {
      step: parse(root.dataset.step),
      maxStep: parse(root.dataset.maxStep)
    };
  },

  // Returns true when the slide consumed the key press (i.e. advanced one step).
  _advanceStep(doc, win) {
    const before = this._getStepState(doc).step;
    const event = new win.KeyboardEvent('keydown', {
      key: 'ArrowRight',
      bubbles: true,
      cancelable: true
    });
    doc.dispatchEvent(event);
    return !!event.defaultPrevented || this._getStepState(doc).step !== before;
  },

  async _driveToFinalStep(doc, win) {
    for (let i = 0; i < this.maxStepGuard; i += 1) {
      if (!this._advanceStep(doc, win)) break;
    }
  },

  _settleFrames(win) {
    const scheduler = typeof globalThis.requestAnimationFrame === 'function'
      ? globalThis.requestAnimationFrame.bind(globalThis)
      : win.requestAnimationFrame.bind(win);
    return new Promise(resolve => scheduler(() => scheduler(resolve)));
  },

  async _readSlideHtml(viewer, slideMeta, slidePath) {
    if (window.__TAURI__ && viewer.basePath && slidePath) {
      return window.__TAURI__.core.invoke('read_text_file', { filePath: slidePath });
    }
    const response = await fetch(`${viewer.baseUrl}/${slideMeta.file}`);
    if (!response.ok) throw new Error(`无法读取 ${slideMeta.file}`);
    return response.text();
  },

  async _waitForImages(doc) {
    const images = Array.from(doc.images || []);
    await Promise.all(images.map(img => {
      if (img.complete) return Promise.resolve();
      if (img.decode) return img.decode().catch(() => {});
      return new Promise(resolve => {
        img.onload = resolve;
        img.onerror = resolve;
      });
    }));
  },

  async _imageUrlToDataUri(src, basePath) {
    if (!src) return '';
    if (src.startsWith('data:')) return src;

    try {
      if (window.__TAURI__ && src.startsWith('slide://')) {
        const filePath = this._filePathFromSlideUrl(src);
        const bytes = await window.__TAURI__.core.invoke('read_file_bytes', { filePath });
        return this._bytesToDataUri(bytes, this._mimeFromPath(filePath));
      }
      if (window.__TAURI__ && src.startsWith('http://slide.localhost/')) {
        const filePath = decodeURIComponent(src.slice('http://slide.localhost'.length));
        const bytes = await window.__TAURI__.core.invoke('read_file_bytes', { filePath });
        return this._bytesToDataUri(bytes, this._mimeFromPath(filePath));
      }
      if (window.__TAURI__ && basePath && !/^[a-z]+:/i.test(src)) {
        const filePath = this._joinPath(basePath, src);
        const bytes = await window.__TAURI__.core.invoke('read_file_bytes', { filePath });
        return this._bytesToDataUri(bytes, this._mimeFromPath(filePath));
      }
      const response = await fetch(src);
      if (!response.ok) return '';
      const blob = await response.blob();
      return await this._blobToDataUri(blob);
    } catch (err) {
      console.warn('PPT image export skipped image:', src, err);
      return '';
    }
  },

  _withBaseTag(html, baseHref) {
    const safeBase = this._escapeHtmlAttr(baseHref);
    const exportStyle = `<style data-ppt-export-style>${this._exportCss()}</style>`;
    if (/<head(\s[^>]*)?>/i.test(html)) {
      return html.replace(/<head(\s[^>]*)?>/i, match => `${match}<base href="${safeBase}">${exportStyle}`);
    }
    return `<base href="${safeBase}">${exportStyle}${html}`;
  },

  _externalizeInlineScripts(html, scriptSourceUrl) {
    if (!scriptSourceUrl) return String(html || '');
    const jsTypes = new Set([
      '', 'module', 'text/javascript', 'application/javascript',
      'text/ecmascript', 'application/ecmascript'
    ]);
    let scriptIndex = 0;
    return String(html || '').replace(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi, (tag, attrs) => {
      const index = scriptIndex++;
      if (/\bsrc\s*=/i.test(attrs)) return tag;
      const typeMatch = String(attrs).match(/\btype\s*=\s*(?:(["'])(.*?)\1|([^\s>]+))/i);
      const type = (typeMatch ? (typeMatch[2] ?? typeMatch[3] ?? '') : '').trim().toLowerCase();
      if (!jsTypes.has(type)) return tag;
      const separator = scriptSourceUrl.includes('?') ? '&' : '?';
      const src = `${scriptSourceUrl}${separator}ppte-export-script=${index}`;
      return `<script${attrs} src="${this._escapeHtmlAttr(src)}"></script>`;
    });
  },

  // Snapshots only need final states: kill transitions/animations so stepped
  // captures settle immediately, and hide presentation chrome (step rails,
  // progress dots) that only makes sense inside the interactive viewer.
  // Chrome selectors are scoped under [data-template] so custom slides are untouched.
  _exportCss() {
    return [
      '*,*::before,*::after{transition:none!important;animation:none!important}',
      '[data-template] .step-rail,[data-template] .term-rail,[data-template] .progress,[data-template] .scene-progress,[data-ppte-concept-animation] .ppte-step-rail,[data-ppte-concept-animation] .ppte-step-dots{visibility:hidden!important}'
    ].join('\n');
  },

  _baseHref(viewer, slideMeta, slidePath) {
    if (viewer.basePath && slidePath && viewer._assetUrl) {
      return viewer._assetUrl(this._dirname(slidePath) + '/');
    }
    const parts = String(slideMeta.file || '').split('/');
    parts.pop();
    const relDir = parts.length ? `/${parts.join('/')}` : '';
    return `${viewer.baseUrl}${relDir}/`;
  },

  _bytesToDataUri(bytes, mime) {
    const binary = Array.from(bytes, byte => String.fromCharCode(byte)).join('');
    return `data:${mime};base64,${btoa(binary)}`;
  },

  _blobToDataUri(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  },

  _filePathFromSlideUrl(src) {
    const url = new URL(src);
    return decodeURIComponent(url.pathname);
  },

  _mimeFromPath(path) {
    const ext = String(path).split('.').pop().toLowerCase();
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'gif') return 'image/gif';
    if (ext === 'svg') return 'image/svg+xml';
    if (ext === 'webp') return 'image/webp';
    return 'image/png';
  },

  _joinPath(base, rel) {
    return `${String(base).replace(/\/+$/, '')}/${String(rel).replace(/^\/+/, '')}`.replace(/\\/g, '/');
  },

  _dirname(path) {
    const normalized = String(path).replace(/\\/g, '/');
    return normalized.slice(0, normalized.lastIndexOf('/'));
  },

  _safeFileName(name) {
    return String(name).replace(/[\\/:*?"<>|]/g, '_').trim() || 'PPTE导出';
  },

  _escapeHtmlAttr(value) {
    return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }
};
