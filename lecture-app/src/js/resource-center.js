// resource-center.js — Browse every page of all local PPTE decks, preview and copy pages into a deck.
window.ResourceCenter = {
  _root: null,
  _mode: null,
  _pb: null,
  _groups: [],
  _selected: new Map(), // pathKey -> { source, files: Set<file> }
  _currentSourceKey: null,
  _targetPath: null,

  init() {
    const btn = document.getElementById('btn-resource-center');
    if (btn) {
      btn.addEventListener('click', () => this.open({ mode: 'main' }));
    }
  },

  isOpen() {
    return !!this._root;
  },

  close() {
    if (this._root?.parentNode) this._root.parentNode.removeChild(this._root);
    this._root = null;
    this._pb = null;
    this._groups = [];
    this._selected = new Map();
    this._currentSourceKey = null;
  },

  async open({ mode, pb } = {}) {
    if (!window.__TAURI__) {
      alert('此功能需要在桌面应用中运行。');
      return;
    }
    this.close();
    this._mode = mode === 'editor' ? 'editor' : 'main';
    this._pb = this._mode === 'editor' ? pb : null;
    if (this._mode === 'editor' && !this._pb) return;
    this._selected = new Map();
    this._buildRoot();
    await this._reloadSources();
  },

  // ── Pure helpers (covered by scripts/test-resource-center.js) ──

  _normalizePathKey(p) {
    return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
  },

  _joinPath(base, rel) {
    const value = String(rel || '').replace(/\\/g, '/');
    if (/^([a-zA-Z]:[\\/]|\/)/.test(String(rel || ''))) return value;
    return `${this._normalizePathKey(base)}/${value.replace(/^\/+/, '')}`;
  },

  // Collect PPTE folders from a raw course.json. Supports:
  // 1. items with a "ppt-extra" field inside any weeks[].resources array
  // 2. the standalone "ppt-extra": [{title, dir}] resource key (week level or top level)
  // 3. v2 sections[].resources flat items with type 'ppt-extra'
  _collectCoursePptePaths(raw, coursePath) {
    const out = [];
    const push = (title, dir) => {
      if (!dir) return;
      out.push({ title: title || '', path: this._joinPath(coursePath, dir) });
    };
    if (!raw || typeof raw !== 'object') return out;

    for (const item of raw['ppt-extra'] || []) {
      push(item?.title, item?.dir);
    }
    for (const section of raw.sections || []) {
      for (const item of section?.resources || []) {
        if (item?.type === 'ppt-extra' && item?.path) push(item.title, item.path);
      }
    }
    for (const week of raw.weeks || []) {
      const resources = week?.resources || {};
      for (const [key, list] of Object.entries(resources)) {
        if (!Array.isArray(list)) continue;
        for (const item of list) {
          if (!item) continue;
          if (key === 'ppt-extra') push(item.title, item.dir);
          else if (item['ppt-extra']) push(item.title, item['ppt-extra']);
        }
      }
    }
    return out;
  },

  _dedupeSources(items) {
    const seen = new Set();
    const out = [];
    for (const item of items || []) {
      const key = this._normalizePathKey(item?.path);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  },

  // Normalize a manifest (schemaVersion 1 or 2) into a flat preview model.
  _parseManifest(json) {
    const manifest = typeof json === 'string' ? JSON.parse(json) : json;
    const slides = Array.isArray(manifest?.slides) ? manifest.slides : [];
    return {
      title: manifest?.title || '',
      schemaVersion: Number.isInteger(manifest?.schemaVersion) ? manifest.schemaVersion : 1,
      hasSharedGroups: Array.isArray(manifest?.sharedGroups) && manifest.sharedGroups.length > 0,
      slides: slides.map((slide, index) => ({
        file: slide?.file || `slide${String(index + 1).padStart(2, '0')}.html`,
        title: slide?.title || `页面 ${index + 1}`,
        slideType: slide?.slide_type || 'content',
      })),
    };
  },

  // Build manifest entries for copied slides. v1 manifests keep the v1 shape ({file, title} only).
  _buildManifestSlideEntries(manifest, slides, idGen) {
    const isV2 = Number.isInteger(manifest?.schemaVersion) && manifest.schemaVersion >= 2;
    const genId = typeof idGen === 'function'
      ? idGen
      : () => `slide_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    return (slides || []).map(slide => {
      if (!isV2) return { file: slide.file, title: slide.title };
      return {
        id: genId(),
        file: slide.file,
        title: slide.title,
        slide_type: slide.slideType || 'content',
      };
    });
  },

  // ── Source collection ──

  async _collectSources() {
    const appConfig = CourseLoader.appConfig || {};
    let groups = [];
    const seen = new Set();
    const addGroup = (label, items) => {
      const sources = [];
      for (const item of items) {
        const key = this._normalizePathKey(item.path);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        sources.push({ path: item.path, title: item.title, available: false, manifest: null });
      }
      if (sources.length) groups.push({ label, sources });
    };

    addGroup('最近打开', (appConfig.recentPpte || [])
      .filter(item => item?.path)
      .map(item => ({ title: item.title, path: item.path })));

    for (const course of appConfig.courses || []) {
      if (!course?.path) continue;
      try {
        const raw = await window.__TAURI__.core.invoke('read_course_config', { coursePath: course.path });
        addGroup(course.label || course.path, this._collectCoursePptePaths(raw, course.path));
      } catch (e) {
        console.warn('ResourceCenter: failed to read course config:', course.path, e);
      }
    }

    // The deck being edited cannot be its own source.
    if (this._mode === 'editor' && this._pb?.folderPath) {
      const selfKey = this._normalizePathKey(this._pb.folderPath);
      for (const group of groups) {
        group.sources = group.sources.filter(s => this._normalizePathKey(s.path) !== selfKey);
      }
      groups = groups.filter(group => group.sources.length);
    }

    await Promise.all(groups.flatMap(group => group.sources.map(async source => {
      try {
        const content = await window.__TAURI__.core.invoke('read_text_file', {
          filePath: `${this._normalizePathKey(source.path)}/manifest.json`,
        });
        source.manifest = this._parseManifest(content);
        if (!source.title) source.title = source.manifest.title;
        source.available = true;
      } catch (_) {
        source.available = false;
      }
    })));
    return groups;
  },

  // ── UI ──

  _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  },

  _escapeAttr(str) {
    return String(str || '').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  },

  _buildRoot() {
    const isEditor = this._mode === 'editor';
    const wrap = document.createElement('div');
    wrap.className = isEditor ? 'rc-shell rc-shell-drawer' : 'rc-shell rc-shell-overlay';
    wrap.innerHTML = `
      <div class="rc-root ${isEditor ? 'rc-root-drawer' : 'rc-root-modal'}" tabindex="-1">
        <div class="rc-header">
          <div class="rc-header-main">
            <div class="rc-title">资源中心</div>
            ${isEditor
              ? `<div class="rc-subtitle">插入到：${this._escapeHtml(this._pb?.manifest?.title || this._pb?.folderPath || '')}</div>`
              : `<div class="rc-target"><label>目标课件：</label><select class="rc-target-select"></select></div>`}
          </div>
          <div class="rc-header-actions">
            <button type="button" class="ppte-editor-button rc-insert-ref" style="display:none;">引用插入</button>
            <button type="button" class="ppte-editor-button ppte-editor-button-primary rc-insert-copy" disabled>拷贝插入</button>
            <button type="button" class="ppte-editor-button rc-close">关闭</button>
          </div>
        </div>
        <div class="rc-body">
          <div class="rc-col rc-sources"><div class="rc-empty">正在读取课件...</div></div>
          <div class="rc-col rc-pages"><div class="rc-empty">请选择左侧课件</div></div>
          <div class="rc-col rc-preview"><iframe class="rc-preview-frame" title="页面预览"></iframe></div>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    this._root = wrap;

    wrap.querySelector('.rc-close').onclick = () => this.close();
    if (!isEditor) {
      wrap.addEventListener('mousedown', (e) => {
        if (e.target === wrap) this.close();
      });
      wrap.querySelector('.rc-target-select').addEventListener('change', (e) => {
        this._targetPath = e.target.value;
      });
    }
    wrap.querySelector('.rc-insert-copy').onclick = () => this._insertCopies();
    wrap.querySelector('.rc-insert-ref').onclick = () => {
      Settings._showInsertSharedGroupModal?.();
    };
    wrap.querySelector('.rc-root').focus();
  },

  async _reloadSources() {
    const container = this._root?.querySelector('.rc-sources');
    if (!container) return;
    container.innerHTML = '<div class="rc-empty">正在读取课件...</div>';
    this._groups = await this._collectSources();
    if (!this._root) return; // closed while loading
    this._renderSources();
    this._renderTargetOptions();
    const first = this._groups.flatMap(g => g.sources).find(s => s.available);
    if (first) this._selectSource(first);
    else this._renderPages();
  },

  _renderSources() {
    const container = this._root?.querySelector('.rc-sources');
    if (!container) return;
    if (!this._groups.length) {
      container.innerHTML = '<div class="rc-empty">未找到任何 PPTE 课件</div>';
      return;
    }
    container.innerHTML = this._groups.map(group => `
      <div class="rc-group">
        <div class="rc-group-label">${this._escapeHtml(group.label)}</div>
        ${group.sources.map(source => {
          const key = this._normalizePathKey(source.path);
          const count = this._selected.get(key)?.files.size || 0;
          return `
          <div class="rc-source ${key === this._currentSourceKey ? 'active' : ''} ${source.available ? '' : 'rc-source-disabled'}"
               data-key="${this._escapeAttr(key)}" title="${this._escapeAttr(source.path)}">
            <div class="rc-source-title">${this._escapeHtml(source.title || source.path)}</div>
            <div class="rc-source-meta">${source.available
              ? `${source.manifest.slides.length} 页${count ? ` · 已选 ${count}` : ''}`
              : '不可用'}</div>
          </div>`;
        }).join('')}
      </div>`).join('');

    container.querySelectorAll('.rc-source').forEach(el => {
      el.onclick = () => {
        const source = this._findSource(el.dataset.key);
        if (source?.available) this._selectSource(source);
      };
    });
  },

  _renderTargetOptions() {
    const select = this._root?.querySelector('.rc-target-select');
    if (!select) return;
    const sources = this._groups.flatMap(g => g.sources).filter(s => s.available);
    select.innerHTML = sources.length
      ? sources.map(s => `<option value="${this._escapeAttr(s.path)}">${this._escapeHtml(s.title || s.path)}</option>`).join('')
      : '<option value="">无可用目标</option>';
    this._targetPath = sources[0]?.path || '';
    select.value = this._targetPath;
  },

  _findSource(key) {
    for (const group of this._groups) {
      const hit = group.sources.find(s => this._normalizePathKey(s.path) === key);
      if (hit) return hit;
    }
    return null;
  },

  _selectSource(source) {
    this._currentSourceKey = this._normalizePathKey(source.path);
    this._renderSources();
    this._renderPages();
    const refBtn = this._root?.querySelector('.rc-insert-ref');
    if (refBtn) {
      const show = this._mode === 'editor' && !!source.manifest?.hasSharedGroups;
      refBtn.style.display = show ? '' : 'none';
    }
    const first = source.manifest?.slides?.[0];
    if (first) this._loadPreview(source, first.file);
  },

  _renderPages() {
    const container = this._root?.querySelector('.rc-pages');
    if (!container) return;
    const source = this._findSource(this._currentSourceKey);
    if (!source) {
      container.innerHTML = '<div class="rc-empty">请选择左侧课件</div>';
      return;
    }
    const selected = this._selected.get(this._currentSourceKey)?.files || new Set();
    container.innerHTML = `
      <div class="rc-pages-header">${this._escapeHtml(source.title || '')} · ${source.manifest.slides.length} 页</div>
      ${source.manifest.slides.map((slide, index) => `
        <label class="rc-page" data-file="${this._escapeAttr(slide.file)}">
          <input type="checkbox" class="rc-page-check" data-file="${this._escapeAttr(slide.file)}" ${selected.has(slide.file) ? 'checked' : ''}>
          <span class="rc-page-num">${index + 1}</span>
          <span class="rc-page-title">${this._escapeHtml(slide.title)}</span>
        </label>`).join('')}`;

    container.querySelectorAll('.rc-page-check').forEach(box => {
      box.addEventListener('change', () => {
        this._toggleSlide(source, box.dataset.file, box.checked);
      });
    });
    container.querySelectorAll('.rc-page').forEach(row => {
      row.addEventListener('click', (e) => {
        if (e.target.classList.contains('rc-page-check')) return;
        e.preventDefault();
        container.querySelectorAll('.rc-page').forEach(r => r.classList.remove('active'));
        row.classList.add('active');
        this._loadPreview(source, row.dataset.file);
      });
    });
  },

  _toggleSlide(source, file, checked) {
    const key = this._normalizePathKey(source.path);
    let entry = this._selected.get(key);
    if (!entry) {
      entry = { source, files: new Set() };
      this._selected.set(key, entry);
    }
    if (checked) entry.files.add(file);
    else entry.files.delete(file);
    if (!entry.files.size) this._selected.delete(key);
    this._updateInsertButton();
    this._renderSources();
  },

  _selectionCount() {
    let count = 0;
    for (const entry of this._selected.values()) count += entry.files.size;
    return count;
  },

  _updateInsertButton() {
    const btn = this._root?.querySelector('.rc-insert-copy');
    if (!btn) return;
    const count = this._selectionCount();
    btn.disabled = count === 0;
    btn.textContent = count ? `拷贝插入 (${count})` : '拷贝插入';
  },

  // Selections in stable order: group order, source order, manifest slide order.
  _orderedSelections() {
    const picks = [];
    for (const group of this._groups) {
      for (const source of group.sources) {
        const entry = this._selected.get(this._normalizePathKey(source.path));
        if (!entry || !source.manifest) continue;
        const slides = source.manifest.slides.filter(slide => entry.files.has(slide.file));
        if (slides.length) picks.push({ source, slides });
      }
    }
    return picks;
  },

  async _loadPreview(source, file) {
    const frame = this._root?.querySelector('.rc-preview-frame');
    if (!frame || !window.__TAURI__) return;
    const slidePath = `${this._normalizePathKey(source.path)}/${file}`;
    // Same platform split as PptExtraViewer: WebView2 needs srcdoc + <base>, WebKit loads slide:// directly.
    if (PptExtraViewer._usesCustomProtocolHost()) {
      try {
        let html = await window.__TAURI__.core.invoke('read_text_file', { filePath: slidePath });
        const dirPath = slidePath.slice(0, slidePath.lastIndexOf('/') + 1);
        html = PptExtraViewer._injectBaseHref(html, PptExtraViewer._assetUrl(dirPath));
        frame.removeAttribute('src');
        frame.srcdoc = html;
      } catch (e) {
        frame.removeAttribute('src');
        frame.srcdoc = `<p style="padding:16px;font-family:sans-serif;">预览失败：${String(e).replace(/</g, '&lt;')}</p>`;
      }
    } else {
      frame.removeAttribute('srcdoc');
      frame.src = PptExtraViewer._assetUrl(slidePath);
    }
  },

  // ── Copy insert ──

  async _insertCopies() {
    if (this._mode === 'editor') return this._insertCopiesEditor();
    return this._insertCopiesMain();
  },

  async _insertCopiesEditor() {
    const pb = this._pb;
    const picks = this._orderedSelections();
    if (!pb || !picks.length) return;
    try {
      const insertAt = Math.min((pb.currentSlideIndex ?? pb.slides.length - 1) + 1, pb.slides.length);
      const newSlides = [];
      for (const pick of picks) {
        const result = await window.__TAURI__.core.invoke('ppte_copy_slides', {
          sourcePath: pick.source.path,
          targetPath: pb.folderPath,
          slideFiles: pick.slides.map(slide => slide.file),
        });
        const byFile = new Map(pick.slides.map(slide => [slide.file, slide]));
        for (const copied of result?.slides || []) {
          const source = byFile.get(copied.sourceFile) || {};
          const html = await window.__TAURI__.core.invoke('read_text_file', {
            filePath: `${pb.folderPath}/${copied.targetFile}`,
          });
          newSlides.push({
            id: Settings._newPpteId('slide'),
            file: copied.targetFile,
            title: source.title || copied.targetFile,
            slide_type: source.slideType || 'content',
            html,
            dirty: false,
            created: false,
          });
        }
      }
      if (!newSlides.length) {
        alert('没有页面被拷贝。');
        return;
      }
      pb.slides.splice(insertAt, 0, ...newSlides);
      pb.manifest.slides = pb.slides;
      pb.currentSlideIndex = insertAt;
      pb.manifestDirty = true;
      const count = newSlides.length;
      this.close();
      Settings._renderPptBuilderInContent();
      Settings._showToast(`已拷贝插入 ${count} 页`);
    } catch (e) {
      console.error('ResourceCenter copy insert failed:', e);
      alert(`拷贝插入失败：${e}`);
    }
  },

  async _insertCopiesMain() {
    const picks = this._orderedSelections();
    const targetPath = this._targetPath;
    if (!picks.length) return;
    if (!targetPath) {
      alert('请选择目标课件。');
      return;
    }
    const openPb = Settings._pptBuilder;
    if (openPb?.folderPath
      && this._normalizePathKey(openPb.folderPath) === this._normalizePathKey(targetPath)) {
      alert('目标课件正在编辑器中打开，请先在编辑器中操作或关闭编辑器。');
      return;
    }
    try {
      const targetRoot = this._normalizePathKey(targetPath);
      const appended = [];
      for (const pick of picks) {
        const result = await window.__TAURI__.core.invoke('ppte_copy_slides', {
          sourcePath: pick.source.path,
          targetPath: targetRoot,
          slideFiles: pick.slides.map(slide => slide.file),
        });
        const byFile = new Map(pick.slides.map(slide => [slide.file, slide]));
        for (const copied of result?.slides || []) {
          const source = byFile.get(copied.sourceFile) || {};
          appended.push({
            file: copied.targetFile,
            title: source.title || copied.targetFile,
            slideType: source.slideType || 'content',
          });
        }
      }
      if (!appended.length) {
        alert('没有页面被拷贝。');
        return;
      }
      const manifestPath = `${targetRoot}/manifest.json`;
      const manifest = JSON.parse(await window.__TAURI__.core.invoke('read_text_file', { filePath: manifestPath }));
      const entries = this._buildManifestSlideEntries(manifest, appended, () => Settings._newPpteId('slide'));
      manifest.slides = (Array.isArray(manifest.slides) ? manifest.slides : []).concat(entries);
      await window.__TAURI__.core.invoke('write_text_file', {
        filePath: manifestPath,
        content: JSON.stringify(manifest, null, 2),
      });
      this._selected = new Map();
      this._updateInsertButton();
      this._renderSources();
      this._renderPages();
      Settings._showToast(`已拷贝插入 ${appended.length} 页到目标课件`);
    } catch (e) {
      console.error('ResourceCenter copy insert failed:', e);
      alert(`拷贝插入失败：${e}`);
    }
  },
};
