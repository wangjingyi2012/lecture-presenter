// content.js — Render section resources in the main content area (v2 schema)
const Content = {
  coursePath: '',
  isAbsolutePath: false, // true for user-created courses with absolute paths

  TYPE_ICONS: {
    pdf: 'pdf', ppt: 'ppt', video: 'video', md: 'md', html: 'html',
    url: 'url', code: 'code', assignment: 'assignment', 'ppt-extra': 'ppt-extra',
  },

  TYPE_LABELS: {
    pdf: 'Slides / PDF', ppt: 'Slides', video: 'Videos', md: 'Documents',
    html: 'Web Pages', url: 'Links', code: 'Source Code', assignment: 'Assignments',
    'ppt-extra': 'Interactive Slides',
  },

  render(section) {
    document.getElementById('week-title').textContent = section.title;
    document.getElementById('week-description').textContent = section.description || '';

    const container = document.getElementById('resources');
    container.innerHTML = '';

    const resources = section.resources || [];
    if (resources.length === 0) {
      container.innerHTML = '<p class="resource-empty">本章节暂无资源</p>';
      return;
    }

    const summary = document.createElement('div');
    summary.className = 'resource-toolbar';
    const counts = this._countResources(resources);
    summary.innerHTML = `
      <div>
        <div class="resource-toolbar-title">章节资源</div>
        <div class="resource-toolbar-subtitle">${resources.length} 个资源 · ${this._escapeHtml(counts)}</div>
      </div>
    `;
    container.appendChild(summary);

    const list = document.createElement('div');
    list.className = 'resource-list';
    container.appendChild(list);

    // Render resources in original order.
    resources.forEach((r, index) => {
      list.appendChild(this._createResourceCard(r, index + 1));
    });
  },

  _createResourceCard(item, index) {
    const type = item.type || 'code';
    const label = this.TYPE_LABELS[type] || type;

    const card = document.createElement('div');
    card.className = `resource-card resource-card-${this._safeClass(type)}`;

    let subtitle = '';
    if (item.path) subtitle = item.path.split('/').pop();
    else if (item.url) {
      try { subtitle = new URL(item.url).hostname; } catch { subtitle = item.url; }
    }

    card.innerHTML = `
      <div class="resource-num">${index}</div>
      <div class="resource-icon">${Icons[type] || Icons.code}</div>
      <div class="resource-info">
        <div class="resource-title-row">
          <div class="title">${this._escapeHtml(item.title)}</div>
        </div>
        <div class="subtitle">${this._escapeHtml(subtitle)}</div>
      </div>
      <div class="resource-type-tag">${label}</div>
    `;

    card.addEventListener('click', () => this._handleClick(item));
    return card;
  },

  _countResources(resources) {
    const counts = resources.reduce((acc, item) => {
      const type = item.type || 'code';
      acc[type] = (acc[type] || 0) + 1;
      return acc;
    }, {});
    return Object.entries(counts)
      .map(([type, count]) => `${this.TYPE_LABELS[type] || type} ${count}`)
      .join(' / ');
  },

  _safeClass(type) {
    return String(type || 'code').replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
  },

  async _handleClick(item) {
    Tracker.track('resource_open', item.title || item.file || item.url || '');
    // URL — open externally. Many sites block embedding in iframes via
    // X-Frame-Options or frame-ancestors, so the system browser is more reliable.
    if (item.url) {
      let url = item.url;
      if (!/^https?:\/\//i.test(url)) {
        url = 'https://' + url;
      }
      await this._shellOpen(url);
      return;
    }

    if (!item.path) return;

    const type = item.type || 'code';
    const fullPath = this.isAbsolutePath ? item.path : this.coursePath + '/' + item.path;

    // Check file existence for absolute paths (user-created courses)
    if (this.isAbsolutePath && window.__TAURI__) {
      try {
        await window.__TAURI__.core.invoke('resolve_asset_path', {
          coursePath: '', relativePath: item.path
        });
      } catch {
        alert(`文件未找到：\n${item.path}\n\n文件可能已被移动或删除。`);
        return;
      }
    }

    // Assignment — open directory
    if (type === 'assignment') {
      await this._shellOpen(fullPath);
      return;
    }

    // PPT — open with system default app
    if (type === 'ppt') {
      await this._shellOpen(fullPath);
      return;
    }

    // PPT-EXTRA — HTML slides viewer
    if (type === 'ppt-extra') {
      const assetUrl = this.isAbsolutePath
        ? CourseLoader.resolveAbsoluteUrl(item.path)
        : CourseLoader.resolveAssetUrl(this.coursePath, item.path);
      // Pass raw filesystem path for reliable manifest loading via Tauri command
      const rawPath = this.isAbsolutePath ? item.path : (this.coursePath + '/' + item.path);
      PptExtraViewer.open(item.title, assetUrl, rawPath);
      return;
    }

    // Resolve asset URL
    const assetUrl = this.isAbsolutePath
      ? CourseLoader.resolveAbsoluteUrl(item.path)
      : CourseLoader.resolveAssetUrl(this.coursePath, item.path);

    // HTML — iframe viewer
    if (type === 'html') {
      HtmlViewer.open(item.title, assetUrl);
      return;
    }

    // Markdown / JSON / YAML
    if (type === 'md') {
      MdViewer.open(item.title, assetUrl, fullPath);
      return;
    }

    // PDF
    if (type === 'pdf') {
      PdfViewer.open(item.title, assetUrl);
      return;
    }

    // Video
    if (type === 'video') {
      VideoPlayer.open(item.title, assetUrl, fullPath);
      return;
    }

    // Code — open in code viewer
    if (type === 'code') {
      CodeViewer.open(item.title, fullPath);
      return;
    }
  },

  async _shellOpen(pathOrUrl) {
    if (window.__TAURI__) {
      try {
        await window.__TAURI__.core.invoke('open_external', { path: pathOrUrl });
      } catch (e) {
        console.error('open_external failed:', e, 'path:', pathOrUrl);
      }
    } else {
      window.open(pathOrUrl, '_blank');
    }
  },

  _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  },
};
