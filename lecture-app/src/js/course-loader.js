// course-loader.js — Load course config via Tauri commands or fetch fallback
const CourseLoader = {
  appConfig: null,
  courseData: null,

  // File extension → resource type mapping
  EXT_TYPE_MAP: {
    '.pdf': 'pdf', '.ppt': 'ppt', '.pptx': 'ppt',
    '.mp4': 'video', '.mov': 'video', '.webm': 'video',
    '.md': 'md', '.json': 'md', '.yml': 'md', '.yaml': 'md',
    '.html': 'html', '.htm': 'html',
    '.py': 'code', '.js': 'code', '.ts': 'code', '.rs': 'code',
    '.java': 'code', '.go': 'code', '.c': 'code', '.cpp': 'code',
    '.h': 'code', '.css': 'code', '.sh': 'code', '.sql': 'code',
    '.ppt-extra': 'ppt-extra', '.ppe': 'ppt-extra',
  },

  detectType(filePath) {
    const ext = '.' + filePath.split('.').pop().toLowerCase();
    return this.EXT_TYPE_MAP[ext] || 'code';
  },

  // ── v1 → v2 normalizer ──
  // Converts v1 course.json (weeks + categorized resources) to v2 (sections + flat resources)
  // Does NOT modify the original object; returns a new v2 object
  normalizeToV2(raw) {
    if (raw.version === 2) return raw;

    const sections = (raw.weeks || []).map(week => {
      const res = week.resources || {};
      const items = [];

      (res.slides || []).forEach(r => {
        if (r['ppt-extra']) {
          items.push({ title: r.title, path: r['ppt-extra'], type: 'ppt-extra' });
        } else {
          items.push({ title: r.title, path: r.file, url: r.url, type: r.file ? this.detectType(r.file) : 'url' });
        }
      });
      (res.videos || []).forEach(r =>
        items.push({ title: r.title, path: r.file, url: r.url, type: 'video' })
      );
      (res.readings || []).forEach(r => {
        if (r['ppt-extra']) {
          items.push({ title: r.title, path: r['ppt-extra'], type: 'ppt-extra' });
        } else {
          items.push({ title: r.title, path: r.file, url: r.url, type: r.file ? this.detectType(r.file) : 'url' });
        }
      });
      (res.assignments || []).forEach(r =>
        items.push({ title: r.title, path: r.dir, type: 'assignment' })
      );
      (res.sourceCode || []).forEach(r =>
        items.push({ title: r.title, path: r.file, url: r.url, type: r.file ? this.detectType(r.file) : 'url' })
      );

      return {
        title: week.title,
        description: week.description || '',
        resources: items,
      };
    });

    return {
      version: 2,
      id: raw.id,
      title: raw.title,
      subtitle: raw.subtitle || '',
      instructor: raw.instructor || '',
      sections,
    };
  },

  async loadAppConfig() {
    try {
      if (window.__TAURI__) {
        this.appConfig = await window.__TAURI__.core.invoke('read_app_config');
      } else {
        const resp = await fetch('app-config.json');
        this.appConfig = await resp.json();
      }
      return this.appConfig;
    } catch (e) {
      console.error('Failed to load app config:', e);
      this.appConfig = { courses: [], lastOpenedCourse: '', theme: 'dark', fontSize: 18 };
      return this.appConfig;
    }
  },

  async loadCourse(courseId) {
    const entry = this.appConfig.courses.find(c => c.id === courseId);
    if (!entry) throw new Error('Course not found: ' + courseId);

    try {
      let raw;
      if (window.__TAURI__) {
        raw = await window.__TAURI__.core.invoke('read_course_config', { coursePath: entry.path });
      } else {
        const candidates = this._courseJsonCandidatesForWeb(entry);
        let lastError = null;
        for (const url of candidates) {
          try {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            raw = await resp.json();
            break;
          } catch (err) {
            lastError = err;
          }
        }
        if (!raw) {
          throw lastError || new Error('Could not load course.json in web fallback mode');
        }
      }
      // Always normalize to v2 in memory
      this.courseData = this.normalizeToV2(raw);
      return this.courseData;
    } catch (e) {
      console.error('Failed to load course:', e);
      throw e;
    }
  },

  getCoursePath(courseId) {
    const entry = this.appConfig.courses.find(c => c.id === courseId);
    return entry ? entry.path : '';
  },

  resolveAssetUrl(coursePath, relativePath) {
    if (window.__TAURI__) {
      // Normalize to forward slashes for consistent asset:// URLs on all platforms
      const fullPath = (coursePath + '/' + relativePath).replace(/\\/g, '/');
      return window.__TAURI__.core.convertFileSrc(fullPath);
    }
    const base = this._webBasePath(coursePath);
    const normalizedRelative = String(relativePath || '').replace(/^\/+/, '');
    return base ? `${base}/${normalizedRelative}` : normalizedRelative;
  },

  // Resolve absolute path to asset URL (for v2 courses with absolute paths)
  resolveAbsoluteUrl(absolutePath) {
    if (window.__TAURI__) {
      return window.__TAURI__.core.convertFileSrc(absolutePath.replace(/\\/g, '/'));
    }
    return absolutePath;
  },

  async saveAppConfig(config) {
    this.appConfig = config;
    try {
      if (window.__TAURI__) {
        await window.__TAURI__.core.invoke('save_app_config', { configJson: JSON.stringify(config, null, 2) });
        console.log('App config saved:', config);
      }
    } catch (e) {
      console.error('Could not save app config:', e);
    }
  },

  async saveCourseConfig(coursePath, courseData) {
    const json = JSON.stringify(courseData, null, 2);
    try {
      if (window.__TAURI__) {
        await window.__TAURI__.core.invoke('save_course_config', { coursePath, configJson: json });
      }
    } catch (e) {
      console.error('Failed to save course config:', e);
      throw e;
    }
  },

  async getAppDataDir() {
    if (window.__TAURI__) {
      return await window.__TAURI__.core.invoke('get_app_data_dir');
    }
    return '';
  },

  _webBasePath(coursePath) {
    const raw = String(coursePath || '').trim().replace(/\\/g, '/');
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw.replace(/\/+$/, '');
    if (!raw.startsWith('/')) return raw.replace(/\/+$/, '');

    // In pure web fallback, absolute local filesystem paths are not directly fetch-able.
    // We fall back to a sibling folder reference by using the last path segment.
    const segments = raw.split('/').filter(Boolean);
    const folderName = segments[segments.length - 1];
    return folderName ? `../${encodeURIComponent(folderName)}` : '';
  },

  _courseJsonCandidatesForWeb(entry) {
    const candidates = [];
    const pushCandidate = (url) => {
      if (!url || candidates.includes(url)) return;
      candidates.push(url);
    };
    const toCourseJson = (base) => {
      const normalized = String(base || '').replace(/\/+$/, '');
      if (!normalized) return '';
      return normalized.endsWith('.json') ? normalized : `${normalized}/course.json`;
    };

    if (entry && entry.webPath) {
      pushCandidate(toCourseJson(entry.webPath));
    }
    if (entry && entry.path) {
      const base = this._webBasePath(entry.path);
      pushCandidate(toCourseJson(base));
    }
    // Last resort for local demos.
    pushCandidate('course.json');
    return candidates;
  },
};
