// code-viewer.js — Code viewer modal with syntax highlighting and terminal execution
const CodeViewer = {
  MAX_HIGHLIGHT_SIZE: 50 * 1024, // 50KB — skip highlighting for large files
  _currentFilePath: '',
  _currentCode: '',
  _currentLang: '',

  LANG_MAP: {
    py: 'python', js: 'javascript', ts: 'typescript', rs: 'rust',
    java: 'java', go: 'go', c: 'c', cpp: 'cpp', h: 'c',
    css: 'css', sh: 'bash', sql: 'sql', json: 'json',
    yml: 'yaml', yaml: 'yaml', rb: 'ruby', swift: 'swift',
    kt: 'kotlin', php: 'php', r: 'r', lua: 'lua',
  },

  RUNNABLE_EXTS: ['py', 'sh'],

  init() {
    this._bindEvents();
  },

  _bindEvents() {
    document.getElementById('code-close').addEventListener('click', () => this.close());
    document.getElementById('code-copy').addEventListener('click', () => this._copyCode());
    document.getElementById('code-open-external').addEventListener('click', () => this._openExternal());
    document.getElementById('code-run').addEventListener('click', () => this._runInTerminal());
    document.getElementById('code-modal').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
      if ((e.metaKey || e.ctrlKey) && e.key === 'r') {
        e.preventDefault();
        if (!document.getElementById('code-run').classList.contains('hidden')) {
          this._runInTerminal();
        }
      }
    });
  },

  async open(title, filePath) {
    this._currentFilePath = filePath;
    const ext = filePath.split('.').pop().toLowerCase();
    this._currentLang = this.LANG_MAP[ext] || ext;

    // Update header
    document.getElementById('code-title').textContent = title;
    document.getElementById('code-lang-tag').textContent = this._currentLang;

    // Show/hide run button
    const runBtn = document.getElementById('code-run');
    if (this.RUNNABLE_EXTS.includes(ext)) {
      runBtn.classList.remove('hidden');
    } else {
      runBtn.classList.add('hidden');
    }

    // Show modal and loading state
    const modal = document.getElementById('code-modal');
    modal.classList.remove('hidden');
    modal.focus();
    document.getElementById('code-body').innerHTML = '<div class="code-loading">加载中...</div>';

    // Read file content
    try {
      const bytes = await this._readFile(filePath);
      this._currentCode = new TextDecoder('utf-8').decode(new Uint8Array(bytes));
      this._renderCode();
    } catch (e) {
      document.getElementById('code-body').innerHTML =
        `<div class="code-error">无法读取文件：${e}</div>`;
    }
  },

  _renderCode() {
    const body = document.getElementById('code-body');
    const lines = this._currentCode.split('\n');
    const isLargeFile = this._currentCode.length > this.MAX_HIGHLIGHT_SIZE;

    // Build line numbers
    const lineNums = lines.map((_, i) => `<span>${i + 1}</span>`).join('\n');

    let highlightedCode;
    if (isLargeFile || typeof hljs === 'undefined') {
      // Plain text for large files or if hljs not loaded
      highlightedCode = this._escapeHtml(this._currentCode);
    } else {
      try {
        const result = hljs.highlight(this._currentCode, {
          language: this._currentLang,
          ignoreIllegals: true,
        });
        highlightedCode = result.value;
      } catch {
        highlightedCode = this._escapeHtml(this._currentCode);
      }
    }

    body.innerHTML = `
      <div class="code-line-numbers">${lineNums}</div>
      <pre class="code-content"><code>${highlightedCode}</code></pre>
    `;

    if (isLargeFile) {
      body.insertAdjacentHTML('beforeend',
        '<div class="code-large-file-notice">大文件 — 已跳过语法高亮</div>');
    }
  },

  close() {
    document.getElementById('code-modal').classList.add('hidden');
    this._currentCode = '';
    this._currentFilePath = '';
  },

  isOpen() {
    return !document.getElementById('code-modal').classList.contains('hidden');
  },

  async _readFile(filePath) {
    if (window.__TAURI__) {
      return await window.__TAURI__.core.invoke('read_file_bytes', { filePath });
    }
    const resp = await fetch(filePath);
    const buf = await resp.arrayBuffer();
    return Array.from(new Uint8Array(buf));
  },

  async _copyCode() {
    try {
      await navigator.clipboard.writeText(this._currentCode);
      const btn = document.getElementById('code-copy');
      const orig = btn.textContent;
      btn.textContent = '已复制';
      setTimeout(() => { btn.textContent = orig; }, 1500);
    } catch (e) {
      console.error('Copy failed:', e);
    }
  },

  async _openExternal() {
    if (window.__TAURI__) {
      try {
        await window.__TAURI__.core.invoke('open_external', { path: this._currentFilePath });
      } catch (e) {
        console.error('open_external failed:', e);
      }
    }
  },

  async _runInTerminal() {
    if (!this._currentFilePath) return;

    try {
      const config = CourseLoader.appConfig || {};
      let terminal = config.terminal;
      let pythonPath = config.pythonPath;

      // Auto-detect if not configured
      if (!terminal) {
        terminal = await window.__TAURI__.core.invoke('detect_terminal');
      }
      if (!pythonPath) {
        pythonPath = await window.__TAURI__.core.invoke('detect_python');
      }

      await window.__TAURI__.core.invoke('run_in_terminal', {
        filePath: this._currentFilePath,
        terminal,
        pythonPath,
      });
    } catch (e) {
      console.error('Run in terminal failed:', e);
      alert('运行失败：' + e);
    }
  },

  _escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  },
};
