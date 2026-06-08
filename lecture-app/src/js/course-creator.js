// course-creator.js — Course creation wizard (full-screen modal)
const CourseCreator = {
  modal: null,
  currentStep: 1,
  sections: [],  // [{ title, description, resources: [{ title, path, url, type }] }]
  editingCourseId: null, // non-null when editing existing course

  init() {
    this.modal = document.getElementById('creator-modal');
    if (!this.modal) return;

    document.getElementById('creator-cancel').addEventListener('click', () => this.close());
    document.getElementById('creator-prev').addEventListener('click', () => this.goStep(1));
    document.getElementById('creator-next').addEventListener('click', () => this.goStep(2));
    document.getElementById('creator-save').addEventListener('click', () => this.save());

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen()) this.close();
    });
  },

  isOpen() {
    return this.modal && !this.modal.classList.contains('hidden');
  },

  open(editCourseId) {
    this.editingCourseId = editCourseId || null;
    this.currentStep = 1;
    this.sections = [];

    if (this.editingCourseId) {
      this._loadExisting(this.editingCourseId);
    } else {
      document.getElementById('creator-course-title').value = '';
      document.getElementById('creator-course-subtitle').value = '';
      document.getElementById('creator-course-instructor').value = '';
    }

    this._updateStepUI();
    this.modal.classList.remove('hidden');
    document.getElementById('sidebar').classList.add('hidden');
    document.getElementById('creator-course-title').focus();
  },

  close() {
    this.modal.classList.add('hidden');
    document.getElementById('sidebar').classList.remove('hidden');
    this.editingCourseId = null;
  },

  goStep(step) {
    if (step === 2) {
      // Validate step 1
      const title = document.getElementById('creator-course-title').value.trim();
      if (!title) {
        document.getElementById('creator-course-title').classList.add('invalid');
        document.getElementById('creator-course-title').focus();
        return;
      }
      document.getElementById('creator-course-title').classList.remove('invalid');
    }
    this.currentStep = step;
    this._updateStepUI();
    if (step === 2) this.renderSections();
  },

  _updateStepUI() {
    document.getElementById('creator-step-1').classList.toggle('active', this.currentStep === 1);
    document.getElementById('creator-step-2').classList.toggle('active', this.currentStep === 2);
    document.getElementById('creator-prev').style.display = this.currentStep === 1 ? 'none' : '';
    document.getElementById('creator-next').style.display = this.currentStep === 1 ? '' : 'none';
    document.getElementById('creator-save').style.display = this.currentStep === 2 ? '' : 'none';
    const info = document.getElementById('creator-step-info');
    info.textContent = `步骤 ${this.currentStep} / 2`;
  },

  _loadExisting(courseId) {
    const data = CourseLoader.courseData;
    if (!data) return;
    document.getElementById('creator-course-title').value = data.title || '';
    document.getElementById('creator-course-subtitle').value = data.subtitle || '';
    document.getElementById('creator-course-instructor').value = data.instructor || '';
    this.sections = (data.sections || []).map(s => ({
      title: s.title,
      description: s.description || '',
      resources: (s.resources || []).map(r => ({ ...r })),
    }));
  },

  // ── Section rendering ──
  renderSections() {
    const container = document.getElementById('creator-sections');
    container.innerHTML = '';

    this.sections.forEach((section, si) => {
      container.appendChild(this._buildSectionCard(section, si));
    });

    // Add section button
    const addBtn = document.createElement('button');
    addBtn.className = 'btn-add-section';
    addBtn.textContent = '+ 添加章节';
    addBtn.addEventListener('click', () => this.addSection());
    container.appendChild(addBtn);
  },

  addSection() {
    this.sections.push({
      title: `章节 ${this.sections.length + 1}`,
      description: '',
      resources: [],
    });
    this.renderSections();
  },

  removeSection(index) {
    if (!confirm('确定删除此章节？')) return;
    this.sections.splice(index, 1);
    this.renderSections();
  },

  _buildSectionCard(section, si) {
    const card = document.createElement('div');
    card.className = 'section-card';
    card.draggable = true;
    card.dataset.sectionIndex = si;

    // Header
    const header = document.createElement('div');
    header.className = 'section-header';
    header.innerHTML = `
      <span class="drag-handle">⠿</span>
      <input type="text" value="${this._escapeAttr(section.title)}" placeholder="章节名称">
      <div class="section-actions">
        <button class="btn-delete-section" title="删除章节">✕</button>
      </div>
    `;

    const titleInput = header.querySelector('input');
    titleInput.addEventListener('input', () => {
      this.sections[si].title = titleInput.value;
    });
    header.querySelector('.btn-delete-section').addEventListener('click', () => this.removeSection(si));
    card.appendChild(header);

    // Resources
    const resList = document.createElement('div');
    resList.className = 'section-resources';
    resList.dataset.sectionIndex = si;

    section.resources.forEach((res, ri) => {
      resList.appendChild(this._buildResourceItem(res, si, ri));
    });
    card.appendChild(resList);

    // Action buttons
    const actions = document.createElement('div');
    actions.className = 'section-add-actions';
    actions.innerHTML = `
      <button class="btn-add-files">+ 添加文件</button>
      <button class="btn-add-folder">+ 添加文件夹</button>
      <button class="btn-add-url">+ 添加链接</button>
    `;
    actions.querySelector('.btn-add-files').addEventListener('click', () => this.pickFiles(si));
    actions.querySelector('.btn-add-folder').addEventListener('click', () => this.pickFolder(si));
    actions.querySelector('.btn-add-url').addEventListener('click', () => this.showUrlInput(si, card));
    card.appendChild(actions);

    // Section drag events
    this._bindSectionDrag(card, si);

    return card;
  },

  _buildResourceItem(res, si, ri) {
    const item = document.createElement('div');
    item.className = 'resource-item';
    item.draggable = true;
    item.dataset.sectionIndex = si;
    item.dataset.resourceIndex = ri;

    const icon = (typeof Icons !== 'undefined' && Icons[res.type]) ? Icons[res.type] : '📄';
    const display = res.path ? res.path.split('/').pop() : (res.url || '');

    item.innerHTML = `
      <span class="res-drag">⠿</span>
      <span class="res-icon">${icon}</span>
      <div class="res-info">
        <div class="res-title" title="点击编辑名称">${this._escapeHtml(res.title)}</div>
        <div class="res-path">${this._escapeHtml(display)}</div>
      </div>
      <span class="res-type">${res.type}</span>
      <button class="res-remove" title="移除">✕</button>
    `;

    // Inline title editing
    const titleEl = item.querySelector('.res-title');
    titleEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'res-title-input';
      input.value = res.title;
      titleEl.replaceWith(input);
      input.focus();
      input.select();

      const commit = () => {
        const val = input.value.trim();
        if (val) this.sections[si].resources[ri].title = val;
        this.renderSections();
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') input.blur();
        if (ev.key === 'Escape') { input.value = res.title; input.blur(); }
      });
    });

    item.querySelector('.res-remove').addEventListener('click', () => {
      this.sections[si].resources.splice(ri, 1);
      this.renderSections();
    });

    this._bindResourceDrag(item, si, ri);
    return item;
  },

  // ── File picker ──
  async pickFiles(sectionIndex) {
    if (!window.__TAURI__) return;
    try {
      const paths = await window.__TAURI__.core.invoke('pick_files');
      paths.forEach(p => {
        const fileName = p.split('/').pop();
        const type = CourseLoader.detectType(p);
        this.sections[sectionIndex].resources.push({
          title: fileName.replace(/\.[^.]+$/, ''),
          path: p,
          type,
        });
      });
      this.renderSections();
    } catch (e) {
      if (e !== 'cancelled') console.error('pick_files error:', e);
    }
  },

  // ── Folder picker ──
  async pickFolder(sectionIndex) {
    if (!window.__TAURI__) return;
    try {
      const folderPath = await window.__TAURI__.core.invoke('pick_folder');
      if (!folderPath) return;

      const folderName = folderPath.replace(/\\/g, '/').split('/').pop();

      // Check if it's a PPT-EXTRA folder (has manifest.json)
      let type = 'folder';
      let title = folderName;

      // Read manifest.json to detect PPT-EXTRA
      try {
        const manifestPath = (folderPath + '/manifest.json').replace(/\\/g, '/');
        const content = await window.__TAURI__.core.invoke('read_text_file', { filePath: manifestPath });
        const manifest = JSON.parse(content);
        type = 'ppt-extra';
        title = manifest.title || folderName;
      } catch (e) {
        // Not a PPT-EXTRA folder, use as regular folder
      }

      this.sections[sectionIndex].resources.push({
        title,
        path: folderPath,
        type,
      });
      this.renderSections();
    } catch (e) {
      if (e !== 'cancelled') console.error('pick_folder error:', e);
    }
  },

  // ── PPT-EXTRA Builder ──
  _pptBuilder: null,

  async createPptExtra(sectionIndex) {
    if (!window.__TAURI__) {
      alert('此功能需要在桌面应用中运行');
      return;
    }

    // Show name input first
    const name = prompt('请输入幻灯片名称：', '我的幻灯片');
    if (!name || !name.trim()) return;
    const folderName = name.trim().replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '-');

    try {
      // Create folder via Tauri
      const folderPath = await window.__TAURI__.core.invoke('create_ppt_extra_folder', {
        folderName: folderName
      });

      // Load and open builder — use read_text_file for reliable cross-platform loading
      const manifestPath = (folderPath + '/manifest.json').replace(/\\/g, '/');
      const content = await window.__TAURI__.core.invoke('read_text_file', { filePath: manifestPath });
      const manifest = JSON.parse(content);

      this._openPptBuilder(sectionIndex, folderPath, manifest);
    } catch (e) {
      console.error('create_ppt_extra_folder error:', e);
      alert('创建失败: ' + e);
    }
  },

  _openPptBuilder(sectionIndex, folderPath, manifest) {
    // Hide sidebar when opening PPT builder
    document.getElementById('sidebar').classList.add('hidden');

    // Create builder modal
    const modal = document.createElement('div');
    modal.id = 'ppt-builder-modal';
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2000;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;';

    this._pptBuilder = {
      sectionIndex,
      folderPath,
      manifest,
      slides: manifest.slides || [],
    };

    this._renderPptBuilder(modal);
    document.body.appendChild(modal);
  },

  _renderPptBuilder(modal) {
    const pb = this._pptBuilder;
    const title = pb.manifest.title || '幻灯片';

    modal.innerHTML = `
      <div style="background:var(--bg-primary);border-radius:12px;width:90%;max-width:900px;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.4);">
        <div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;">
          <div style="display:flex;align-items:center;gap:12px;">
            <span style="font-weight:600;font-size:16px;">编辑幻灯片</span>
            <input type="text" id="ppt-builder-title" value="${this._escapeAttr(title)}"
              style="padding:6px 12px;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);color:var(--text-primary);font-size:14px;width:200px;">
          </div>
          <button id="ppt-builder-close" style="background:none;border:none;color:var(--text-muted);font-size:20px;cursor:pointer;">✕</button>
        </div>
        <div style="flex:1;overflow:auto;padding:20px;" id="ppt-builder-content">
          ${this._renderPptSlidesList()}
        </div>
        <div style="padding:16px 20px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;">
          <div style="display:flex;gap:8px;">
            <button id="ppt-add-slide" style="padding:8px 14px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;">+ 添加页面</button>
          </div>
          <div style="display:flex;gap:12px;">
            <button id="ppt-builder-cancel" style="padding:8px 16px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;">取消</button>
            <button id="ppt-builder-save" style="padding:8px 16px;border-radius:6px;border:none;background:var(--accent);color:#fff;cursor:pointer;">保存</button>
          </div>
        </div>
      </div>
    `;

    // Event handlers
    document.getElementById('ppt-builder-close').onclick = () => this._closePptBuilder(modal);
    document.getElementById('ppt-builder-cancel').onclick = () => this._closePptBuilder(modal);
    document.getElementById('ppt-builder-save').onclick = () => this._savePptExtra(modal);
    document.getElementById('ppt-add-slide').onclick = () => this._addPptSlide();

    // Do NOT close on backdrop click — only close via cancel/close buttons
  },

  _renderPptSlidesList() {
    const pb = this._pptBuilder;
    const slideTypes = [
      { value: 'cover', label: '封面' },
      { value: 'catalog', label: '目录' },
      { value: 'chapter', label: '章节' },
      { value: 'content', label: '内容' },
      { value: 'finish', label: '结束' },
    ];

    let html = '<div style="display:flex;flex-direction:column;gap:8px;">';
    pb.slides.forEach((slide, index) => {
      const typeLabel = slideTypes.find(t => t.value === slide.slide_type)?.label || '内容';
      html += `
        <div class="ppt-slide-item" data-index="${index}" draggable="true" style="display:flex;align-items:center;gap:12px;padding:12px;background:var(--bg-secondary);border-radius:8px;border:1px solid var(--border);cursor:grab;">
          <span class="ppt-slide-drag" style="cursor:grab;color:var(--text-muted);">⠿</span>
          <span style="font-weight:600;min-width:24px;">${index + 1}</span>
          <select class="ppt-slide-type" data-index="${index}" style="padding:6px 10px;border-radius:4px;border:1px solid var(--border);background:var(--bg-primary);color:var(--text-primary);font-size:13px;">
            ${slideTypes.map(t => `<option value="${t.value}" ${t.value === slide.slide_type ? 'selected' : ''}>${t.label}</option>`).join('')}
          </select>
          <input type="text" class="ppt-slide-title" data-index="${index}" value="${this._escapeAttr(slide.title)}"
            placeholder="页面标题" style="flex:1;padding:6px 10px;border-radius:4px;border:1px solid var(--border);background:var(--bg-primary);color:var(--text-primary);font-size:13px;">
          <button class="ppt-slide-delete" data-index="${index}" style="padding:6px 10px;border-radius:4px;border:none;background:#e74c3c;color:#fff;cursor:pointer;font-size:12px;">删除</button>
        </div>
      `;
    });
    html += '</div>';

    if (pb.slides.length === 0) {
      html = '<p style="color:var(--text-muted);text-align:center;padding:40px;">暂无页面，请点击"添加页面"</p>';
    }

    return html;
  },

  _addPptSlide() {
    const pb = this._pptBuilder;
    const newSlide = {
      file: `slide${String(pb.slides.length + 1).padStart(2, '0')}.html`,
      title: `页面 ${pb.slides.length + 1}`,
      slide_type: 'content',
    };
    pb.slides.push(newSlide);
    this._refreshPptBuilder();
  },

  _deletePptSlide(index) {
    if (!confirm('确定删除此页面？')) return;
    const pb = this._pptBuilder;
    pb.slides.splice(index, 1);
    // Renumber files
    pb.slides.forEach((slide, i) => {
      slide.file = `slide${String(i + 1).padStart(2, '0')}.html`;
    });
    this._refreshPptBuilder();
  },

  _refreshPptBuilder() {
    const modal = document.getElementById('ppt-builder-modal');
    if (!modal) return;
    document.getElementById('ppt-builder-content').innerHTML = this._renderPptSlidesList();
    this._bindPptSlideEvents();
  },

  _bindPptSlideEvents() {
    const pb = this._pptBuilder;

    // Type change
    document.querySelectorAll('.ppt-slide-type').forEach(select => {
      select.addEventListener('change', (e) => {
        const index = parseInt(e.target.dataset.index);
        pb.slides[index].slide_type = e.target.value;
      });
    });

    // Title change
    document.querySelectorAll('.ppt-slide-title').forEach(input => {
      input.addEventListener('input', (e) => {
        const index = parseInt(e.target.dataset.index);
        pb.slides[index].title = e.target.value;
      });
    });

    // Delete
    document.querySelectorAll('.ppt-slide-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const index = parseInt(e.target.dataset.index);
        this._deletePptSlide(index);
      });
    });

    // Drag and drop
    this._bindPptSlideDrag();
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
          // Renumber files
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
    const titleInput = document.getElementById('ppt-builder-title');
    const newTitle = titleInput.value.trim() || '幻灯片';

    // Update manifest title
    pb.manifest.title = newTitle;

    // Prepare slide files - we need to read existing files and update them
    const slideFiles = [];
    const slideTypes = {
      cover: 'cover',
      catalog: 'catalog',
      chapter: 'chapter',
      content: 'content',
      finish: 'finish',
    };

    for (let i = 0; i < pb.slides.length; i++) {
      const slide = pb.slides[i];
      const content = this._generateSlideHtml(slide.title, slide.slide_type);
      slideFiles.push([slide.file, content]);
    }

    try {
      await window.__TAURI__.core.invoke('save_ppt_extra', {
        folderPath: pb.folderPath,
        manifestJson: JSON.stringify(pb.manifest, null, 2),
        slideFiles,
      });

      // Add to section resources
      this.sections[pb.sectionIndex].resources.push({
        title: newTitle,
        path: pb.folderPath,
        type: 'ppt-extra',
      });
      this.renderSections();
      this._closePptBuilder(modal);
    } catch (e) {
      console.error('save_ppt_extra error:', e);
      alert('保存失败: ' + e);
    }
  },

  _generateSlideHtml(title, slideType) {
    const escapedTitle = this._escapeHtml(title);

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
    // Restore sidebar visibility
    document.getElementById('sidebar').classList.remove('hidden');
  },

  // ── URL input ──
  showUrlInput(sectionIndex, card) {
    // Remove existing URL input if any
    const existing = card.querySelector('.url-input-row');
    if (existing) { existing.remove(); return; }

    const row = document.createElement('div');
    row.className = 'url-input-row';
    row.innerHTML = `
      <input type="text" placeholder="输入 URL（如 https://example.com）" autofocus>
      <button class="btn-confirm-url">添加</button>
      <button class="btn-cancel-url">取消</button>
    `;

    const input = row.querySelector('input');
    const confirm = () => {
      const url = input.value.trim();
      if (!url) return;
      let hostname = url;
      try { hostname = new URL(url).hostname; } catch {}
      this.sections[sectionIndex].resources.push({
        title: hostname,
        url,
        type: 'url',
      });
      this.renderSections();
    };

    row.querySelector('.btn-confirm-url').addEventListener('click', confirm);
    row.querySelector('.btn-cancel-url').addEventListener('click', () => row.remove());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') confirm();
      if (e.key === 'Escape') row.remove();
    });

    card.querySelector('.section-add-actions').before(row);
    input.focus();
  },

  // ── Section drag ──
  _sectionDragSrc: null,

  _bindSectionDrag(card, si) {
    card.addEventListener('dragstart', (e) => {
      e.stopPropagation();
      this._sectionDragSrc = si;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', si.toString());
      const img = new Image();
      img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
      e.dataTransfer.setDragImage(img, 0, 0);
    });

    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      document.querySelectorAll('.section-card').forEach(el => el.classList.remove('drag-over'));
      this._sectionDragSrc = null;
    });

    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (this._sectionDragSrc !== null && this._sectionDragSrc !== si) {
        card.classList.add('drag-over');
      }
    });

    card.addEventListener('dragleave', () => card.classList.remove('drag-over'));

    card.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this._sectionDragSrc !== null && this._sectionDragSrc !== si) {
        const [moved] = this.sections.splice(this._sectionDragSrc, 1);
        this.sections.splice(si, 0, moved);
        this.renderSections();
      }
      this._sectionDragSrc = null;
    });
  },

  // ── Resource drag ──
  _resDragSrc: null,

  _bindResourceDrag(item, si, ri) {
    // Use drag handle for starting drag
    const dragHandle = item.querySelector('.res-drag');
    if (dragHandle) {
      dragHandle.addEventListener('mousedown', () => {
        item.setAttribute('draggable', 'true');
      });
    }

    item.addEventListener('dragstart', (e) => {
      e.stopPropagation();
      this._resDragSrc = { si, ri };
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', ri.toString());
      // Make drag image centered on cursor
      const img = new Image();
      img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
      e.dataTransfer.setDragImage(img, 0, 0);
    });

    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      document.querySelectorAll('.resource-item').forEach(el => el.classList.remove('drag-over'));
      this._resDragSrc = null;
    });

    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (this._resDragSrc) {
        item.classList.add('drag-over');
      }
    });

    item.addEventListener('dragleave', () => item.classList.remove('drag-over'));

    item.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this._resDragSrc && (this._resDragSrc.si !== si || this._resDragSrc.ri !== ri)) {
        const srcSi = this._resDragSrc.si;
        const srcRi = this._resDragSrc.ri;
        const destSi = si;

        // Get source and destination arrays
        const srcResources = this.sections[srcSi].resources;
        const destResources = srcSi === destSi ? srcResources : this.sections[destSi].resources;

        // Remove from source
        const [moved] = srcResources.splice(srcRi, 1);

        // Calculate destination index
        let destRi = ri;
        if (srcSi === destSi && srcRi < ri) {
          destRi = ri - 1;
        }

        // Insert at destination
        destResources.splice(destRi, 0, moved);

        this.renderSections();
      }
      this._resDragSrc = null;
    });
  },

  // ── Save course ──
  async save() {
    const title = document.getElementById('creator-course-title').value.trim();
    if (!title) {
      this.goStep(1);
      return;
    }

    const subtitle = document.getElementById('creator-course-subtitle').value.trim();
    const instructor = document.getElementById('creator-course-instructor').value.trim();

    // Generate course ID
    const courseId = this.editingCourseId || this._generateId(title);

    // Check ID uniqueness (only for new courses)
    if (!this.editingCourseId) {
      const exists = CourseLoader.appConfig.courses.some(c => c.id === courseId);
      if (exists) {
        alert(`课程 ID "${courseId}" 已存在，请修改课程标题`);
        return;
      }
    }

    // Build v2 course.json
    const courseData = {
      version: 2,
      id: courseId,
      title,
      subtitle,
      instructor,
      sections: this.sections.map(s => ({
        title: s.title,
        description: s.description || '',
        resources: s.resources.map(r => {
          const item = { title: r.title, type: r.type };
          if (r.path) item.path = r.path;
          if (r.url) item.url = r.url;
          return item;
        }),
      })),
    };

    try {
      // Save course.json to app-data/courses/<id>/
      const appDataDir = await CourseLoader.getAppDataDir();
      const coursePath = appDataDir + '/courses/' + courseId;
      await CourseLoader.saveCourseConfig(coursePath, courseData);

      // Update app-config
      const config = CourseLoader.appConfig;
      const entryIndex = config.courses.findIndex(c => c.id === courseId);
      const label = subtitle ? `${title} — ${subtitle}` : title;
      const entry = {
        id: courseId,
        path: coursePath,
        label,
        createdByApp: true,
      };

      if (entryIndex >= 0) {
        config.courses[entryIndex] = entry;
      } else {
        config.courses.push(entry);
      }
      config.lastOpenedCourse = courseId;
      await CourseLoader.saveAppConfig(config);

      // Reload
      Settings.refreshCourseOptions(config);
      await App.loadCourse(courseId);
      Tracker.track('course_create', title);
      this.close();
    } catch (e) {
      alert('保存失败: ' + e);
      console.error('Save course error:', e);
    }
  },

  // ── Utilities ──
  _generateId(title) {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 40)
      || 'course-' + Date.now();
  },

  _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  },

  _escapeAttr(str) {
    return (str || '').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  },
};
