// ppte-ppt-exporter.js — Export PPTE HTML slides to editable PPTX objects.
const PptePptExporter = {
  slideWidth: 13.333333,
  slideHeight: 7.5,
  renderWidth: 1920,
  renderHeight: 1080,
  maxStepGuard: 40,

  async export(viewer, options = {}) {
    const mode = ['steps', 'animate'].includes(options.mode) ? options.mode : 'static';
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const PptxGen = await this._ensurePptxGen();
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
    let pptxSlideCount = 0;
    const animationSlides = [];
    for (const slideMeta of viewer.slides) {
      const result = await this._renderSlides(viewer, slideMeta, mode);
      for (const rendered of result.snapshots) {
        await this._addRenderedSlide(pptx, rendered);
        pptxSlideCount += 1;
      }
      if (result.clicks && result.clicks.length > 0) {
        animationSlides.push({ slide: pptxSlideCount, clicks: result.clicks });
      }
      processed += 1;
      if (onProgress) onProgress(processed, viewer.slides.length);
    }

    const output = await pptx.write({ outputType: 'arraybuffer', compression: true });
    const bytes = Array.from(new Uint8Array(output));
    const baseName = viewer.manifest?.title || viewer.title || 'PPTE导出';
    const suffix = mode === 'steps' ? '-分步版' : mode === 'animate' ? '-动画版' : '';
    const defaultName = `${this._safeFileName(`${baseName}${suffix}`)}.pptx`;

    if (window.__TAURI__ && window.__TAURI__.core) {
      const payload = { defaultName, bytes };
      if (mode === 'animate' && animationSlides.length > 0) {
        payload.animation = animationSlides;
      }
      return window.__TAURI__.core.invoke('save_pptx_file', payload);
    }

    if (mode === 'animate') {
      console.warn('PPT export: 浏览器模式不支持动画注入，已导出静态内容');
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

  async _addRenderedSlide(pptx, rendered) {
    const slide = pptx.addSlide();
    const bgColor = this._cssColorToHex(rendered.backgroundColor) || 'FFFFFF';
    slide.background = { color: bgColor };

    if (rendered.backgroundImage) {
      const data = await this._imageUrlToDataUri(rendered.backgroundImage, rendered.basePath);
      if (data) {
        slide.addImage({ data, x: 0, y: 0, w: this.slideWidth, h: this.slideHeight });
      }
    }

    const shapeType = (pptx.ShapeType && pptx.ShapeType.rect) || 'rect';
    const roundRectType = (pptx.ShapeType && pptx.ShapeType.roundRect) || 'roundRect';
    for (const item of rendered.shapes) {
      slide.addShape(item.rounded ? roundRectType : shapeType, {
        ...item.box,
        fill: item.fill,
        line: item.line,
        transparency: item.transparency,
        objectName: item.name
      });
    }

    for (const item of rendered.images) {
      const data = await this._imageUrlToDataUri(item.src, rendered.basePath);
      if (!data) continue;
      slide.addImage({
        data,
        ...item.box,
        rotate: item.rotate || 0,
        altText: item.alt || '',
        objectName: item.name
      });
    }

    for (const item of rendered.texts) {
      slide.addText(item.text, {
        ...item.box,
        color: item.color,
        fontFace: item.fontFace,
        fontSize: item.fontSize,
        bold: item.bold,
        italic: item.italic,
        underline: item.underline,
        breakLine: false,
        fit: 'shrink',
        margin: 0,
        align: item.align,
        valign: 'top',
        lineSpacingMultiple: item.lineHeightMultiple,
        wrap: true,
        objectName: item.name
      });
    }
  },

  // Renders one source slide into native snapshots.
  // Stepped templates expose data-step/data-max-step on their [data-template] root and
  // consume ArrowRight keydowns (preventDefault) until the final step, which is the
  // same contract the viewer navigation and template audits rely on.
  // Returns { snapshots, clicks } — clicks is only set in animate mode and describes
  // per-click enter/exit shape groups for the native PPTX timing injection.
  async _renderSlides(viewer, slideMeta, mode) {
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
      const capture = () => this._extractSnapshot(loaded, basePath);

      if (mode === 'animate') {
        const stepSnapshots = await this._collectStepSnapshots(doc, win, capture);
        const plan = this._buildAnimationPlan(stepSnapshots);
        return { snapshots: [this._mergeAnimatedSnapshot(stepSnapshots, plan)], clicks: plan.clicks };
      }

      if (mode === 'steps') {
        return { snapshots: await this._collectStepSnapshots(doc, win, capture), clicks: null };
      }

      // Static export keeps the final state, so stepped templates do not lose
      // everything except their first scene.
      await this._driveToFinalStep(doc, win);
      await this._waitForImages(doc);
      await this._settleFrames(win);
      return { snapshots: [await capture()], clicks: null };
    } finally {
      loaded.cleanup();
    }
  },

  // Merges per-step snapshots into one object list with per-click enter/exit groups.
  // Object identity is the stamped data-ppt-export-id; the content signature ignores
  // the box so pure位移 does not split an object, while text/color changes produce
  // exit+enter variant pairs. Pure function — covered by test-ppt-exporter-animate.js.
  _buildAnimationPlan(stepSnapshots) {
    const kinds = ['shapes', 'images', 'texts'];
    const lastStep = stepSnapshots.length - 1;
    const byKey = new Map();

    stepSnapshots.forEach((snap, step) => {
      for (const kind of kinds) {
        for (const item of snap[kind] || []) {
          if (item.exportId == null) continue;
          const key = `${kind}:${item.exportId}`;
          let entry = byKey.get(key);
          if (!entry) {
            entry = { kind, exportId: Number(item.exportId) || 0, runs: [] };
            byKey.set(key, entry);
          }
          const sig = this._animationSignature(item);
          const lastRun = entry.runs[entry.runs.length - 1];
          if (lastRun && lastRun.end === step - 1 && lastRun.sig === sig) {
            lastRun.end = step;
            lastRun.item = item; // keep the latest (most settled) box
          } else {
            entry.runs.push({ sig, start: step, end: step, item });
          }
        }
      }
    });

    const kindRank = { shapes: 0, images: 1, texts: 2 };
    const entries = Array.from(byKey.values())
      .sort((a, b) => kindRank[a.kind] - kindRank[b.kind] || a.exportId - b.exportId);

    const objects = [];
    const clicks = Array.from({ length: Math.max(lastStep, 0) }, () => ({ enter: [], exit: [] }));
    let nameSeq = 0;

    for (const entry of entries) {
      for (const run of entry.runs) {
        const enterStep = run.start > 0 ? run.start : null;
        const exitStep = run.end < lastStep ? run.end + 1 : null;
        const animated = enterStep !== null || exitStep !== null;
        const name = animated ? `pptr${++nameSeq}` : undefined;
        objects.push({ kind: entry.kind, name, item: { ...run.item, name } });
        if (exitStep !== null) clicks[exitStep - 1].exit.push(name);
        if (enterStep !== null) clicks[enterStep - 1].enter.push(name);
      }
    }

    return { objects, clicks };
  },

  // Identity fields per kind, excluding box (position shifts must not split objects).
  _animationSignature(item) {
    const { box, exportId, name, ...rest } = item;
    return JSON.stringify(rest);
  },

  _mergeAnimatedSnapshot(stepSnapshots, plan) {
    const last = stepSnapshots[stepSnapshots.length - 1];
    const merged = {
      basePath: last.basePath,
      backgroundColor: last.backgroundColor,
      backgroundImage: last.backgroundImage,
      shapes: [],
      images: [],
      texts: []
    };
    for (const obj of plan.objects) {
      merged[obj.kind].push(obj.item);
    }
    return merged;
  },

  async _collectStepSnapshots(doc, win, capture) {
    const snapshots = [await capture()];
    let lastStep = this._getStepState(doc).step;
    let stalls = 0;
    while (snapshots.length < this.maxStepGuard) {
      if (!this._advanceStep(doc, win)) break;
      const step = this._getStepState(doc).step;
      stalls = step === lastStep ? stalls + 1 : 0;
      lastStep = step;
      if (stalls >= 2) break;
      await this._waitForImages(doc);
      await this._settleFrames(win);
      snapshots.push(await capture());
    }
    return snapshots;
  },

  async _driveToFinalStep(doc, win) {
    for (let i = 0; i < this.maxStepGuard; i += 1) {
      if (!this._advanceStep(doc, win)) break;
    }
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
      // Keep the frame same-origin so native-object extraction can inspect its
      // DOM, and explicitly allow PPTE scripts so stepped templates can install
      // their keyboard handlers. srcdoc's load event fires after parsing and
      // classic script execution, which is the state snapshotting needs.
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
    // Stamp every element so animate mode can track visibility across steps.
    slideEl.querySelectorAll('*').forEach((el, index) => {
      el.setAttribute('data-ppt-export-id', String(index));
    });
    return {
      doc,
      win,
      slideEl,
      slideRect: slideEl.getBoundingClientRect(),
      cleanup: () => iframe.remove()
    };
  },

  async _extractSnapshot(loaded, basePath) {
    const { doc, win, slideEl, slideRect } = loaded;
    return {
      basePath,
      backgroundColor: this._firstOpaqueColor([
        win.getComputedStyle(slideEl).backgroundColor,
        win.getComputedStyle(doc.body).backgroundColor,
        win.getComputedStyle(doc.documentElement).backgroundColor
      ]),
      backgroundImage: this._backgroundImageUrl([
        win.getComputedStyle(slideEl).backgroundImage,
        win.getComputedStyle(doc.body).backgroundImage,
        win.getComputedStyle(doc.documentElement).backgroundImage
      ]),
      shapes: this._extractShapes(doc, win, slideEl, slideRect),
      images: await this._extractImages(doc, win, slideEl, slideRect),
      texts: this._extractTexts(doc, win, slideEl, slideRect)
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

  _extractShapes(doc, win, slideEl, slideRect) {
    const shapes = [];
    for (const el of Array.from(slideEl.querySelectorAll('*'))) {
      if (!this._isVisibleElement(el, win)) continue;
      if (['IMG', 'SVG', 'SCRIPT', 'STYLE', 'LINK', 'META'].includes(el.tagName)) continue;
      if (this._isExportIgnored(el)) continue;

      const style = win.getComputedStyle(el);
      const fillColor = this._parseCssColor(style.backgroundColor);
      const borderWidth = parseFloat(style.borderTopWidth) || 0;
      const borderColor = this._parseCssColor(style.borderTopColor);
      const hasFill = fillColor && fillColor.a > 0.02;
      const hasBorder = borderWidth > 0 && borderColor && borderColor.a > 0.02;
      if (!hasFill && !hasBorder) continue;

      const box = this._boxToPpt(el.getBoundingClientRect(), slideRect);
      if (!box || box.w < 0.04 || box.h < 0.04) continue;
      if (box.x <= 0.01 && box.y <= 0.01 && box.w >= this.slideWidth - 0.02 && box.h >= this.slideHeight - 0.02) {
        continue;
      }

      const radius = parseFloat(style.borderTopLeftRadius) || 0;
      shapes.push({
        box,
        rounded: radius > 2,
        exportId: el.getAttribute('data-ppt-export-id'),
        fill: hasFill
          ? { color: this._rgbToHex(fillColor), transparency: Math.round((1 - fillColor.a) * 100) }
          : { color: 'FFFFFF', transparency: 100 },
        line: hasBorder
          ? { color: this._rgbToHex(borderColor), transparency: Math.round((1 - borderColor.a) * 100), width: Math.max(0.25, borderWidth * 0.75) }
          : { color: 'FFFFFF', transparency: 100 }
      });
    }
    return shapes;
  },

  async _extractImages(doc, win, slideEl, slideRect) {
    const images = [];
    for (const img of Array.from(slideEl.querySelectorAll('img'))) {
      if (!this._isVisibleElement(img, win) || this._isExportIgnored(img)) continue;
      const box = this._boxToPpt(img.getBoundingClientRect(), slideRect);
      if (!box || box.w < 0.04 || box.h < 0.04) continue;
      images.push({
        box,
        src: img.currentSrc || img.src,
        alt: img.alt || '',
        exportId: img.getAttribute('data-ppt-export-id')
      });
    }

    for (const svg of Array.from(slideEl.querySelectorAll('svg'))) {
      if (!this._isVisibleElement(svg, win) || this._isExportIgnored(svg)) continue;
      const box = this._boxToPpt(svg.getBoundingClientRect(), slideRect);
      if (!box || box.w < 0.04 || box.h < 0.04) continue;
      images.push({
        box,
        src: this._svgToDataUri(svg, win),
        alt: svg.getAttribute('aria-label') || '',
        exportId: svg.getAttribute('data-ppt-export-id')
      });
    }
    return images;
  },

  _extractTexts(doc, win, slideEl, slideRect) {
    const texts = [];
    const seen = new Set();
    const selector = [
      '[data-ppt-role="title"]',
      '[data-ppt-role="text"]',
      '.slide-title',
      '.page-title',
      '.page-subtitle',
      '.title',
      '.subtitle',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'p',
      'li',
      'blockquote',
      'pre',
      'code',
      'td',
      'th',
      'span',
      'div'
    ].join(',');

    for (const el of Array.from(slideEl.querySelectorAll(selector))) {
      if (seen.has(el) || !this._isVisibleElement(el, win) || this._isExportIgnored(el)) continue;
      if (['SCRIPT', 'STYLE', 'SVG'].includes(el.tagName)) continue;
      if (this._isIconOnly(el)) continue;
      if (!this._shouldExportTextElement(el)) continue;
      // Root-most wins: when an ancestor was already exported (e.g. <p> wrapping
      // inline <span>s), skip the descendant so texts never stack on each other.
      if (this._hasExportedAncestor(el, slideEl, seen)) continue;

      const text = this._cleanText(el.innerText || el.textContent || '');
      if (!text) continue;

      const box = this._boxToPpt(el.getBoundingClientRect(), slideRect);
      if (!box || box.w < 0.04 || box.h < 0.04) continue;

      const style = win.getComputedStyle(el);
      const color = this._cssColorToHex(style.color) || '222222';
      const fontSize = Math.max(6, Math.round((parseFloat(style.fontSize) || 16) * 0.75));
      const lineHeightPx = parseFloat(style.lineHeight);
      const fontSizePx = parseFloat(style.fontSize) || 16;
      const lineHeightMultiple = Number.isFinite(lineHeightPx)
        ? Math.max(0.8, Math.min(2.5, lineHeightPx / fontSizePx))
        : 1.15;

      texts.push({
        text,
        box,
        color,
        fontFace: this._fontFamily(style.fontFamily),
        fontSize,
        bold: this._isBold(style.fontWeight),
        italic: style.fontStyle === 'italic' || style.fontStyle === 'oblique',
        underline: style.textDecorationLine.includes('underline'),
        align: this._textAlign(style.textAlign),
        lineHeightMultiple,
        exportId: el.getAttribute('data-ppt-export-id')
      });
      seen.add(el);
    }
    return texts;
  },

  _hasExportedAncestor(el, slideEl, seen) {
    let node = el.parentElement;
    while (node && node !== slideEl) {
      if (seen.has(node)) return true;
      node = node.parentElement;
    }
    return false;
  },

  _shouldExportTextElement(el) {
    if (el.dataset.pptRole === 'title' || el.dataset.pptRole === 'text') return true;
    if (/^(H[1-6]|P|LI|BLOCKQUOTE|PRE|CODE|TD|TH)$/i.test(el.tagName)) return true;

    // Class tokens must match as whole words (hyphen/underscore separated) —
    // a plain substring match lets layout containers like "story-stage" (contains
    // "tag") swallow their entire subtree as one giant duplicated text box.
    const tokens = String(el.className || '').split(/\s+/);
    if (tokens.some(token => /(^|[-_])(title|subtitle|heading|label|tag|desc|text|number|caption)([-_]|$)/i.test(token))) return true;

    const ownText = Array.from(el.childNodes)
      .filter(node => node.nodeType === Node.TEXT_NODE)
      .map(node => node.textContent.trim())
      .join('');
    if (!ownText) return false;

    const hasTextChild = Array.from(el.children).some(child => {
      if (['BR', 'SCRIPT', 'STYLE'].includes(child.tagName)) return false;
      return this._cleanText(child.innerText || child.textContent || '').length > 0;
    });
    return !hasTextChild;
  },

  _isVisibleElement(el, win) {
    const style = win.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1;
  },

  _isExportIgnored(el) {
    return el.closest('.img-overlay, .hidden, [data-ppt-export="ignore"]');
  },

  _isIconOnly(el) {
    const className = String(el.className || '');
    if (/(icon|emoji)/i.test(className)) return true;
    const text = this._cleanText(el.innerText || el.textContent || '');
    // Arrow glyphs are real content in flow templates, never treat them as icons.
    if (/^[→←↑↓↔↕⇒⇐⇑⇓↗↘↙↖]+$/.test(text)) return false;
    return text.length <= 2 && /[^\p{L}\p{N}\s.,;:!?'"()[\]{}<>/\\|+-]/u.test(text);
  },

  _boxToPpt(rect, slideRect) {
    const left = Math.max(rect.left, slideRect.left);
    const top = Math.max(rect.top, slideRect.top);
    const right = Math.min(rect.right, slideRect.right);
    const bottom = Math.min(rect.bottom, slideRect.bottom);
    if (right <= left || bottom <= top) return null;

    const scaleX = this.slideWidth / slideRect.width;
    const scaleY = this.slideHeight / slideRect.height;
    return {
      x: this._round((left - slideRect.left) * scaleX),
      y: this._round((top - slideRect.top) * scaleY),
      w: this._round((right - left) * scaleX),
      h: this._round((bottom - top) * scaleY)
    };
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
      console.warn('PPT export skipped image:', src, err);
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

  _backgroundImageUrl(values) {
    for (const value of values) {
      const url = this._extractCssUrl(value);
      if (url) return url;
    }
    return '';
  },

  _extractCssUrl(value) {
    if (!value || value === 'none') return '';
    const matches = [...String(value).matchAll(/url\((['"]?)(.*?)\1\)/g)];
    return matches.length ? matches[0][2] : '';
  },

  _firstOpaqueColor(values) {
    for (const value of values) {
      const parsed = this._parseCssColor(value);
      if (parsed && parsed.a > 0.02) return value;
    }
    return 'rgb(255, 255, 255)';
  },

  _parseCssColor(value) {
    if (!value || value === 'transparent') return null;
    const rgba = String(value).match(/rgba?\(([^)]+)\)/i);
    if (rgba) {
      const parts = rgba[1].split(',').map(part => part.trim());
      return {
        r: Number(parts[0]),
        g: Number(parts[1]),
        b: Number(parts[2]),
        a: parts[3] === undefined ? 1 : Number(parts[3])
      };
    }
    const hex = String(value).trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (hex) {
      const full = hex[1].length === 3
        ? hex[1].split('').map(ch => ch + ch).join('')
        : hex[1];
      return {
        r: parseInt(full.slice(0, 2), 16),
        g: parseInt(full.slice(2, 4), 16),
        b: parseInt(full.slice(4, 6), 16),
        a: 1
      };
    }
    return null;
  },

  _cssColorToHex(value) {
    const parsed = this._parseCssColor(value);
    return parsed ? this._rgbToHex(parsed) : '';
  },

  _rgbToHex(color) {
    return [color.r, color.g, color.b]
      .map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
  },

  _fontFamily(value) {
    const first = String(value || '').split(',')[0].trim().replace(/^["']|["']$/g, '');
    return first || 'Microsoft YaHei';
  },

  _isBold(weight) {
    if (weight === 'bold' || weight === 'bolder') return true;
    const numeric = Number(weight);
    return Number.isFinite(numeric) && numeric >= 600;
  },

  _textAlign(value) {
    if (value === 'center') return 'center';
    if (value === 'right' || value === 'end') return 'right';
    if (value === 'justify') return 'justify';
    return 'left';
  },

  _cleanText(text) {
    return String(text || '').replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  },

  // Serializes an SVG into a self-contained data URI. Two things break when an
  // svg is lifted out of its document: class/var()-based styling (lost with the
  // stylesheet) and url(#id) references to defs living in OTHER svg elements
  // (e.g. shared arrow markers). Inline computed presentation attributes and
  // copy referenced defs into the clone so arrows keep their look.
  _svgToDataUri(svg, win) {
    const clone = svg.cloneNode(true);
    if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

    const PRESENTATION_PROPS = [
      'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linecap',
      'stroke-linejoin', 'stroke-dasharray', 'stroke-opacity', 'opacity',
      'marker-start', 'marker-mid', 'marker-end'
    ];
    const inlineInto = (srcRoot, dstRoot) => {
      const srcEls = [srcRoot, ...Array.from(srcRoot.querySelectorAll('*'))];
      const dstEls = [dstRoot, ...Array.from(dstRoot.querySelectorAll('*'))];
      srcEls.forEach((srcEl, i) => {
        const dstEl = dstEls[i];
        if (!dstEl || !dstEl.setAttribute) return;
        const style = win.getComputedStyle(srcEl);
        for (const prop of PRESENTATION_PROPS) {
          let value = style.getPropertyValue(prop);
          if (value && value.toLowerCase() === 'currentcolor') {
            value = style.getPropertyValue('color');
          }
          // Set explicit "none" too: an inlined ancestor value would otherwise
          // cascade down and override the element's intended none.
          if (value && value !== '') dstEl.setAttribute(prop, value);
        }
      });
    };
    inlineInto(svg, clone);

    const referencedIds = new Set();
    for (const el of [clone, ...Array.from(clone.querySelectorAll('*'))]) {
      for (const attr of Array.from(el.attributes || [])) {
        const match = String(attr.value).match(/url\(\s*["']?#([^)"'\s]+)["']?\s*\)/);
        if (match) referencedIds.add(match[1]);
      }
    }
    if (referencedIds.size > 0) {
      const doc = svg.ownerDocument;
      let defs = clone.querySelector('defs');
      for (const id of referencedIds) {
        if (clone.querySelector(`[id="${id}"]`)) continue;
        const defEl = doc.getElementById(id);
        if (!defEl) continue;
        if (!defs) {
          defs = doc.createElementNS('http://www.w3.org/2000/svg', 'defs');
          clone.insertBefore(defs, clone.firstChild);
        }
        const defClone = defEl.cloneNode(true);
        inlineInto(defEl, defClone);
        defs.appendChild(defClone);
      }
    }

    const text = new XMLSerializer().serializeToString(clone);
    return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(text)))}`;
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
  },

  _round(value) {
    return Math.round(value * 1000) / 1000;
  }
};
