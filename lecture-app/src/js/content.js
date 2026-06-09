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
      container.innerHTML = '<p style="color:var(--text-muted);margin-top:16px;">本章节暂无资源</p>';
      return;
    }

    // Render resources in original order (no grouping by type)
    resources.forEach((r, index) => {
      container.appendChild(this._createResourceCard(r, index + 1));
    });
  },

  _createResourceCard(item, index) {
    const type = item.type || 'code';
    const icon = this.TYPE_ICONS[type] || '📄';
    const label = this.TYPE_LABELS[type] || type;

    const card = document.createElement('div');
    card.className = 'resource-card';

    let subtitle = '';
    if (item.path) subtitle = item.path.split('/').pop();
    else if (item.url) {
      try { subtitle = new URL(item.url).hostname; } catch { subtitle = item.url; }
    }

    card.innerHTML = `
      <div class="resource-num">${index}</div>
      <div class="resource-icon">${Icons[type] || icon}</div>
      <div class="resource-info">
        <div class="title">${this._escapeHtml(item.title)}</div>
        <div class="subtitle">${this._escapeHtml(subtitle)}</div>
      </div>
      <div class="resource-type-tag">${label}</div>
    `;

    card.addEventListener('click', () => this._handleClick(item));
    return card;
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
