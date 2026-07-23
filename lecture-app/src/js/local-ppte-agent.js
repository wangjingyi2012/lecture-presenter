// local-ppte-agent.js — admin-only desktop bridge for the private local PPTE Agent
window.LocalPpteAgent = {
  appConfig: null,
  pollTimer: null,
  currentJobDir: '',
  currentOutputDir: '',
  openedCompletedJob: '',
  outlineMode: 'text',
  outlineFile: null,
  references: [],
  referenceSequence: 0,

  init(appConfig) {
    this.appConfig = appConfig || window.CourseLoader?.appConfig || {};
    this._injectWorkbenchEntry();
    this.refreshAccess();
  },

  refreshAccess() {
    const button = document.getElementById('ppte-local-agent-btn');
    if (!button) return;
    const isAdmin = !!window.Auth?.isAdmin?.();
    button.classList.toggle('hidden', !isAdmin);
    button.disabled = !isAdmin;
    if (!isAdmin && document.getElementById('local-ppte-agent-modal')) this.close();
  },

  _injectWorkbenchEntry() {
    if (document.getElementById('ppte-local-agent-btn')) return;
    const cloudButton = document.getElementById('ppte-cloud-btn');
    const primary = cloudButton?.parentElement || document.querySelector('.ppte-workbench-primary');
    if (!primary) return;
    const button = document.createElement('button');
    button.id = 'ppte-local-agent-btn';
    button.className = 'ppte-workbench-action ppte-local-agent-entry hidden';
    button.innerHTML = `
      <span class="ppte-action-icon">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4"/><path d="M12 18v4"/><path d="M4.93 4.93l2.83 2.83"/><path d="M16.24 16.24l2.83 2.83"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="M4.93 19.07l2.83-2.83"/><path d="M16.24 7.76l2.83-2.83"/><circle cx="12" cy="12" r="4"/></svg>
      </span>
      <span class="ppte-action-copy">
        <strong>本地 Agent 实验室 <em>ADMIN</em></strong>
        <span>在本机运行私有编排器，用于规则和质量测试。</span>
      </span>`;
    button.addEventListener('click', () => this.open());
    primary.appendChild(button);
  },

  async open() {
    if (!window.Auth?.isAdmin?.()) {
      alert('本地 Agent 实验室仅对管理员开放');
      return;
    }
    this.close();
    this.outlineMode = 'text';
    this.outlineFile = null;
    this.references = [];
    this.referenceSequence = 0;
    const modal = document.createElement('div');
    modal.id = 'local-ppte-agent-modal';
    modal.className = 'local-agent-modal';
    modal.innerHTML = `
      <div class="local-agent-shell" role="dialog" aria-modal="true" aria-label="本地 PPTE Agent 实验室">
        <header class="local-agent-header">
          <div><span class="local-agent-kicker">ADMIN LAB</span><h2>本地 PPTE Agent</h2><p>核心规则只在本机运行，不会进入公开安装包。</p></div>
          <button id="local-agent-close" class="local-agent-icon-btn" type="button" title="关闭" aria-label="关闭">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </header>
        <div class="local-agent-body">
          <section class="local-agent-form">
            <label class="local-agent-toggle"><input id="local-agent-enabled" type="checkbox"><span>启用本地实验执行器</span></label>
            <label><span>Agent 目录</span><div class="local-agent-path-row"><input id="local-agent-path" type="text" placeholder="选择本机私有 Agent 目录"><button id="local-agent-pick-agent" type="button">浏览</button></div></label>
            <label><span>课件标题</span><input id="local-agent-title" type="text" placeholder="例如：AI Agent 实战课程"></label>
            <section class="local-agent-input-section">
              <div class="local-agent-section-head"><div><strong>页面大纲</strong><span>只使用一个主大纲来源</span></div><div class="local-agent-segmented"><button class="active" data-outline-mode="text" type="button">粘贴大纲</button><button data-outline-mode="file" type="button">选择文件</button></div></div>
              <div id="local-agent-outline-text-pane"><textarea id="local-agent-outline" rows="5" placeholder="每行一个页面主题，Agent 会先重新规划整套叙事"></textarea></div>
              <div id="local-agent-outline-file-pane" class="hidden">
                <button id="local-agent-pick-outline" class="local-agent-dashed-btn" type="button">选择 .md / .txt / .docx / .pdf 大纲文件</button>
                <div id="local-agent-outline-file-card" class="local-agent-file-card hidden"></div>
              </div>
            </section>
            <section class="local-agent-input-section">
              <div class="local-agent-section-head"><div><strong>参考资料</strong><span>可多选，并分别指定内容、视觉或互动用途</span></div><span id="local-agent-reference-count" class="local-agent-count">0 项</span></div>
              <div class="local-agent-reference-actions">
                <button id="local-agent-add-files" type="button">＋ 文件</button>
                <button id="local-agent-add-folder" type="button">＋ 文件夹</button>
                <button id="local-agent-add-ppte" type="button">＋ 已有 PPTE</button>
              </div>
              <div id="local-agent-reference-list" class="local-agent-reference-list"><p>还没有参考资料。PPTE 默认只参考视觉与互动，不会自动带入旧事实。</p></div>
              <details class="local-agent-paste-reference"><summary>粘贴一段临时资料</summary><div><textarea id="local-agent-pasted-reference" rows="3" placeholder="粘贴必须保留的事实、原文或课程要求"></textarea><button id="local-agent-add-pasted" type="button">添加为内容资料</button></div></details>
            </section>
            <div class="local-agent-row">
              <label><span>目标页数</span><input id="local-agent-slide-count" type="number" min="3" max="60" step="1" value="12"><small>包含封面和总结，Agent 必须严格生成该页数</small></label>
              <label><span>制作方式</span><select id="local-agent-mode"><option value="autopilot">全自动</option><option value="guided">分步确认</option></select></label>
            </div>
            <div class="local-agent-row local-agent-row-output">
              <label><span>保存到</span><div class="local-agent-path-row"><input id="local-agent-output-parent" type="text" readonly placeholder="选择父目录"><button id="local-agent-pick-output" type="button">浏览</button></div></label>
            </div>
            <div id="local-agent-form-error" class="local-agent-error"></div>
            <button id="local-agent-start" class="local-agent-primary" type="button">开始制作</button>
          </section>
          <aside class="local-agent-status">
            <div class="local-agent-status-head"><div><span>任务状态</span><strong id="local-agent-status-label">尚未启动</strong></div><span id="local-agent-progress-text">0 / 0</span></div>
            <div class="local-agent-progress"><i id="local-agent-progress-bar"></i></div>
            <p id="local-agent-status-message">填写左侧内容后开始制作。关闭窗口不会终止任务。</p>
            <section class="local-agent-source-summary"><div><span>资料预检</span><strong id="local-agent-source-summary">1 个主大纲 · 0 项参考资料</strong></div><p>启动后 Agent 会解析、去重并记录逐页引用。</p></section>
            <section class="local-agent-memory-plan">
              <div class="local-agent-memory-head"><span>认知反转记忆点</span><strong id="local-agent-memory-count">等待规划</strong></div>
              <div id="local-agent-memory-list" class="local-agent-memory-list"><p>Agent 会从每 10 页中选择约 2 个关键概念，先设计讲解反转，再制作页面。</p></div>
            </section>
            <div id="local-agent-stage-list" class="local-agent-stage-list"></div>
            <div class="local-agent-job-meta"><span>任务目录</span><code id="local-agent-job-dir">—</code><span>输出目录</span><code id="local-agent-output-dir">—</code></div>
            <div class="local-agent-actions">
              <button id="local-agent-approve-plan" class="hidden" type="button">批准计划并继续</button>
              <button id="local-agent-approve-style" class="hidden" type="button">批准样片并继续</button>
              <button id="local-agent-resume" class="hidden" type="button">恢复任务</button>
              <button id="local-agent-open-output" class="hidden" type="button">打开生成的 PPTE</button>
            </div>
          </aside>
        </div>
        <aside id="local-agent-ppte-picker" class="local-agent-ppte-picker hidden" aria-label="选择已有 PPTE">
          <div class="local-agent-picker-head"><div><strong>选择已有 PPTE</strong><span>来自演讲宝最近打开列表，也可以浏览其他文件夹</span></div><button id="local-agent-close-ppte-picker" class="local-agent-icon-btn" type="button">×</button></div>
          <input id="local-agent-ppte-search" type="search" placeholder="搜索课件标题或路径">
          <div id="local-agent-ppte-options" class="local-agent-ppte-options"></div>
          <div class="local-agent-picker-footer"><span id="local-agent-ppte-selected-count">已选择 0 项</span><div><button id="local-agent-browse-ppte" type="button">浏览其他文件夹</button><button id="local-agent-confirm-ppte" class="local-agent-primary" type="button">添加参考</button></div></div>
        </aside>
      </div>`;
    document.body.appendChild(modal);
    this._bindModal();
    await this._loadRuntimeStatus();
    const lastJob = localStorage.getItem('local_ppte_agent_last_job') || '';
    if (lastJob) {
      this.currentJobDir = lastJob;
      this._startPolling();
    }
  },

  close() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    document.removeEventListener('keydown', this._escapeHandler);
    document.getElementById('local-ppte-agent-modal')?.remove();
  },

  _bindModal() {
    const enabled = document.getElementById('local-agent-enabled');
    const pathInput = document.getElementById('local-agent-path');
    enabled.checked = this.appConfig?.localPpteAgentEnabled === true;
    pathInput.value = this.appConfig?.localPpteAgentPath || '';
    enabled.onchange = async () => {
      try {
        await this._saveSettings();
        await this._loadRuntimeStatus();
      } catch (e) {
        this._setError(`保存设置失败：${e}`);
      }
    };
    pathInput.onchange = async () => {
      try {
        await this._saveSettings();
        await this._loadRuntimeStatus();
      } catch (e) {
        this._setError(`保存设置失败：${e}`);
      }
    };
    document.getElementById('local-agent-close').onclick = () => this.close();
    document.getElementById('local-ppte-agent-modal').addEventListener('click', (event) => {
      if (event.target.id === 'local-ppte-agent-modal') this.close();
    });
    document.getElementById('local-agent-pick-agent').onclick = async () => {
      try {
        const selected = await window.__TAURI__.core.invoke('pick_folder');
        if (selected) {
          pathInput.value = selected;
          await this._saveSettings();
          await this._loadRuntimeStatus();
        }
      } catch (e) {
        if (e !== 'cancelled') this._setError(String(e));
      }
    };
    document.getElementById('local-agent-pick-output').onclick = async () => {
      try {
        const selected = await window.__TAURI__.core.invoke('pick_folder');
        if (selected) document.getElementById('local-agent-output-parent').value = selected;
      } catch (e) {
        if (e !== 'cancelled') this._setError(String(e));
      }
    };
    document.querySelectorAll('[data-outline-mode]').forEach(button => {
      button.onclick = () => this._setOutlineMode(button.dataset.outlineMode);
    });
    document.getElementById('local-agent-outline').oninput = () => this._updateSourceSummary();
    document.getElementById('local-agent-pick-outline').onclick = async () => {
      try {
        const selected = await window.__TAURI__.core.invoke('pick_reference_file');
        if (selected) this._setOutlineFile(selected);
      } catch (e) {
        if (e !== 'cancelled') this._setError(String(e));
      }
    };
    document.getElementById('local-agent-add-files').onclick = async () => {
      try {
        const files = await window.__TAURI__.core.invoke('pick_reference_files');
        (files || []).forEach(file => this._addReference({ kind: 'file', path: file, name: this._basename(file), useFor: ['content'] }));
      } catch (e) {
        if (e !== 'cancelled') this._setError(String(e));
      }
    };
    document.getElementById('local-agent-add-folder').onclick = async () => {
      try {
        const folder = await window.__TAURI__.core.invoke('pick_folder');
        if (folder) this._addReference({ kind: 'folder', path: folder, name: this._basename(folder), useFor: ['content'] });
      } catch (e) {
        if (e !== 'cancelled') this._setError(String(e));
      }
    };
    document.getElementById('local-agent-add-ppte').onclick = () => this._openPptePicker();
    document.getElementById('local-agent-close-ppte-picker').onclick = () => this._closePptePicker();
    document.getElementById('local-agent-ppte-search').oninput = event => this._renderPpteOptions(event.target.value);
    document.getElementById('local-agent-confirm-ppte').onclick = () => this._confirmPpteSelection();
    document.getElementById('local-agent-browse-ppte').onclick = async () => {
      try {
        const folder = await window.__TAURI__.core.invoke('pick_folder');
        if (folder) {
          this._addReference({ kind: 'ppte-local', path: folder, name: this._basename(folder), useFor: ['visual', 'interaction'] });
          this._closePptePicker();
        }
      } catch (e) {
        if (e !== 'cancelled') this._setError(String(e));
      }
    };
    document.getElementById('local-agent-add-pasted').onclick = () => {
      const textarea = document.getElementById('local-agent-pasted-reference');
      const text = textarea.value.trim();
      if (!text) return;
      this._addReference({ kind: 'text', name: `粘贴资料 ${this.referenceSequence + 1}`, text, useFor: ['content'] });
      textarea.value = '';
      textarea.closest('details').open = false;
    };
    document.getElementById('local-agent-reference-list').onclick = event => {
      const removeButton = event.target.closest('[data-remove-reference]');
      if (removeButton) return this._removeReference(removeButton.dataset.removeReference);
      const roleButton = event.target.closest('[data-reference-role]');
      if (roleButton) this._toggleReferenceRole(roleButton.dataset.referenceId, roleButton.dataset.referenceRole);
    };
    document.getElementById('local-agent-start').onclick = () => this._startJob();
    document.getElementById('local-agent-approve-plan').onclick = () => this._runAction('approve-plan');
    document.getElementById('local-agent-approve-style').onclick = () => this._runAction('approve-style');
    document.getElementById('local-agent-resume').onclick = () => this._runAction('resume');
    document.getElementById('local-agent-open-output').onclick = () => this._openOutput();
    document.addEventListener('keydown', this._escapeHandler);
    this._renderReferences();
  },

  _escapeHandler(event) {
    if (event.key !== 'Escape') return;
    const picker = document.getElementById('local-agent-ppte-picker');
    if (picker && !picker.classList.contains('hidden')) window.LocalPpteAgent._closePptePicker();
    else window.LocalPpteAgent.close();
  },

  async _loadRuntimeStatus() {
    const message = document.getElementById('local-agent-status-message');
    if (!window.__TAURI__) {
      message.textContent = '本地 Agent 只能在桌面应用中运行。';
      return;
    }
    try {
      const status = await window.__TAURI__.core.invoke('local_ppte_agent_status');
      message.textContent = status.message + (status.node_path ? ` · ${status.node_path}` : '');
    } catch (e) {
      message.textContent = `运行环境检查失败：${e}`;
    }
  },

  async _saveSettings() {
    if (!this.appConfig) this.appConfig = window.CourseLoader?.appConfig || {};
    this.appConfig.localPpteAgentEnabled = document.getElementById('local-agent-enabled').checked;
    this.appConfig.localPpteAgentPath = document.getElementById('local-agent-path').value.trim();
    await CourseLoader.saveAppConfig(this.appConfig);
  },

  _setOutlineMode(mode) {
    if (!['text', 'file'].includes(mode)) return;
    this.outlineMode = mode;
    document.querySelectorAll('[data-outline-mode]').forEach(button => button.classList.toggle('active', button.dataset.outlineMode === mode));
    document.getElementById('local-agent-outline-text-pane').classList.toggle('hidden', mode !== 'text');
    document.getElementById('local-agent-outline-file-pane').classList.toggle('hidden', mode !== 'file');
    this._updateSourceSummary();
  },

  _setOutlineFile(filePath) {
    this.outlineFile = { kind: 'file', path: filePath, name: this._basename(filePath) };
    this._setOutlineMode('file');
    const card = document.getElementById('local-agent-outline-file-card');
    card.classList.remove('hidden');
    card.innerHTML = `<div><strong>${this._escape(this.outlineFile.name)}</strong><span>${this._escape(filePath)}</span></div><em>启动后解析</em><button id="local-agent-clear-outline-file" type="button" title="移除">×</button>`;
    document.getElementById('local-agent-clear-outline-file').onclick = () => {
      this.outlineFile = null;
      card.classList.add('hidden');
      card.innerHTML = '';
      this._updateSourceSummary();
    };
    this._updateSourceSummary();
  },

  _addReference(reference) {
    if (this.references.length >= 20) {
      this._setError('参考资料最多添加 20 项');
      return;
    }
    if (reference.path && this.references.some(item => item.path === reference.path)) {
      this._setError(`已经添加过：${reference.path}`);
      return;
    }
    this.referenceSequence += 1;
    this.references.push({ id: `ref-${this.referenceSequence}`, ...reference, useFor: [...new Set(reference.useFor || ['content'])] });
    this._setError('');
    this._renderReferences();
  },

  _removeReference(id) {
    this.references = this.references.filter(item => item.id !== id);
    this._renderReferences();
  },

  _toggleReferenceRole(id, role) {
    const reference = this.references.find(item => item.id === id);
    if (!reference || !['content', 'visual', 'interaction'].includes(role)) return;
    if (reference.useFor.includes(role)) {
      if (reference.useFor.length === 1) {
        this._setError('每项参考资料至少保留一个用途');
        return;
      }
      reference.useFor = reference.useFor.filter(item => item !== role);
    } else {
      reference.useFor.push(role);
    }
    this._setError('');
    this._renderReferences();
  },

  _renderReferences() {
    const container = document.getElementById('local-agent-reference-list');
    if (!container) return;
    const count = document.getElementById('local-agent-reference-count');
    if (count) count.textContent = `${this.references.length} 项`;
    if (!this.references.length) {
      container.innerHTML = '<p>还没有参考资料。PPTE 默认只参考视觉与互动，不会自动带入旧事实。</p>';
      this._updateSourceSummary();
      return;
    }
    const labels = { file: '文件', folder: '目录', 'ppte-local': 'PPTE', text: '文字' };
    const roleLabels = { content: '内容', visual: '视觉', interaction: '互动' };
    container.innerHTML = this.references.map(reference => {
      const detail = reference.path || String(reference.text || '').slice(0, 100);
      return `<article class="local-agent-reference-card">
        <span class="local-agent-reference-type">${labels[reference.kind] || '资料'}</span>
        <div class="local-agent-reference-copy"><strong>${this._escape(reference.name)}</strong><span>${this._escape(detail)}</span></div>
        <div class="local-agent-reference-roles">${Object.entries(roleLabels).map(([role, label]) => `<button type="button" class="${reference.useFor.includes(role) ? 'active' : ''}" data-reference-id="${reference.id}" data-reference-role="${role}">${label}</button>`).join('')}</div>
        <button class="local-agent-reference-remove" type="button" data-remove-reference="${reference.id}" title="移除">×</button>
      </article>`;
    }).join('');
    this._updateSourceSummary();
  },

  _openPptePicker() {
    const recent = [...(window.CourseLoader?.appConfig?.recentPpte || this.appConfig?.recentPpte || [])];
    const seen = new Set();
    this._pptePickerItems = recent.filter(item => item?.path && !seen.has(item.path) && seen.add(item.path));
    const picker = document.getElementById('local-agent-ppte-picker');
    picker.classList.remove('hidden');
    document.getElementById('local-agent-ppte-search').value = '';
    this._renderPpteOptions('');
    document.getElementById('local-agent-ppte-search').focus();
  },

  _closePptePicker() {
    document.getElementById('local-agent-ppte-picker')?.classList.add('hidden');
  },

  _renderPpteOptions(query = '') {
    const container = document.getElementById('local-agent-ppte-options');
    const needle = query.trim().toLowerCase();
    const selectedPaths = new Set(this.references.filter(item => item.kind === 'ppte-local').map(item => item.path));
    const visible = (this._pptePickerItems || []).map((item, index) => ({ ...item, index })).filter(item => !needle || `${item.title} ${item.path}`.toLowerCase().includes(needle));
    if (!visible.length) {
      container.innerHTML = '<p class="local-agent-picker-empty">没有匹配的最近 PPTE，可使用“浏览其他文件夹”。</p>';
      this._updatePpteSelectedCount();
      return;
    }
    container.innerHTML = visible.map(item => `<label class="local-agent-ppte-option"><input type="checkbox" data-ppte-index="${item.index}" ${selectedPaths.has(item.path) ? 'checked' : ''}><span><strong>${this._escape(item.title || this._basename(item.path))}</strong><small>${this._escape(item.path)}</small></span></label>`).join('');
    container.querySelectorAll('input').forEach(input => input.onchange = () => this._updatePpteSelectedCount());
    this._updatePpteSelectedCount();
  },

  _updatePpteSelectedCount() {
    const checked = document.querySelectorAll('#local-agent-ppte-options input:checked').length;
    const target = document.getElementById('local-agent-ppte-selected-count');
    if (target) target.textContent = `已选择 ${checked} 项`;
  },

  _confirmPpteSelection() {
    const selectedIndexes = new Set([...document.querySelectorAll('#local-agent-ppte-options input:checked')].map(input => Number(input.dataset.ppteIndex)));
    const pickerPaths = new Set((this._pptePickerItems || []).map(item => item.path));
    this.references = this.references.filter(item => item.kind !== 'ppte-local' || !pickerPaths.has(item.path));
    for (const index of selectedIndexes) {
      const item = this._pptePickerItems[index];
      if (item && !this.references.some(reference => reference.path === item.path)) {
        this.referenceSequence += 1;
        this.references.push({ id: `ref-${this.referenceSequence}`, kind: 'ppte-local', path: item.path, name: item.title || this._basename(item.path), useFor: ['visual', 'interaction'] });
      }
    }
    this._renderReferences();
    this._closePptePicker();
  },

  _updateSourceSummary() {
    const target = document.getElementById('local-agent-source-summary');
    if (!target) return;
    const textOutlineReady = this.outlineMode === 'text' && Boolean(document.getElementById('local-agent-outline')?.value.trim());
    const outlineReady = this.outlineMode === 'file' ? Boolean(this.outlineFile) : textOutlineReady;
    target.textContent = `${outlineReady ? 1 : 0} 个主大纲 · ${this.references.length} 项参考资料`;
  },

  _basename(filePath) {
    return String(filePath || '').split(/[\\/]/).filter(Boolean).pop() || '未命名资料';
  },

  async _startJob() {
    this._setError('');
    const title = document.getElementById('local-agent-title').value.trim();
    const outline = document.getElementById('local-agent-outline').value.trim();
    const outputParent = document.getElementById('local-agent-output-parent').value.trim();
    const mode = document.getElementById('local-agent-mode').value;
    const targetSlideCount = Number(document.getElementById('local-agent-slide-count').value);
    const outlineReady = this.outlineMode === 'file' ? Boolean(this.outlineFile) : Boolean(outline);
    if (!title || !outlineReady || !outputParent) {
      this._setError('请填写标题、大纲并选择保存目录');
      return;
    }
    if (!Number.isInteger(targetSlideCount) || targetSlideCount < 3 || targetSlideCount > 60) {
      this._setError('目标页数必须是 3～60 之间的整数，并包含封面和总结');
      return;
    }
    if (!document.getElementById('local-agent-enabled').checked) {
      this._setError('请先启用本地实验执行器');
      return;
    }
    if (!document.getElementById('local-agent-path').value.trim()) {
      this._setError('请选择本机私有 Agent 目录');
      return;
    }
    const safeName = title.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '-').replace(/-+/g, '-').slice(0, 60) || 'PPTE';
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
    const outputDir = `${outputParent.replace(/[\\/]$/, '')}/${safeName}-Agent-${stamp}`;
    const brief = {
      contractVersion: 'ppte-reference-brief-v2',
      title,
      outlineSource: this.outlineMode === 'file'
        ? { kind: 'file', path: this.outlineFile.path, name: this.outlineFile.name }
        : { kind: 'text', text: outline, name: '粘贴大纲' },
      references: this.references.map(reference => ({
        id: reference.id,
        kind: reference.kind,
        name: reference.name,
        ...(reference.path ? { path: reference.path } : {}),
        ...(reference.text ? { text: reference.text } : {}),
        useFor: reference.useFor,
      })),
      targetSlideCount,
      outputDir,
      mode,
    };
    const start = document.getElementById('local-agent-start');
    start.disabled = true;
    start.textContent = '正在启动...';
    try {
      await this._saveSettings();
      const launch = await window.__TAURI__.core.invoke('local_ppte_agent_start', {
        brief,
        authToken: window.Auth.getToken() || ''
      });
      this.currentJobDir = launch.job_dir;
      this.currentOutputDir = launch.output_dir;
      localStorage.setItem('local_ppte_agent_last_job', launch.job_dir);
      document.getElementById('local-agent-job-dir').textContent = launch.job_dir;
      document.getElementById('local-agent-output-dir').textContent = launch.output_dir;
      this._setStatus('解析资料', `Agent 进程 ${launch.pid} 已启动，正在解析 ${this.references.length} 项参考资料并规划 ${targetSlideCount} 页。`);
      this._startPolling();
    } catch (e) {
      this._setError(String(e));
    } finally {
      start.disabled = false;
      start.textContent = '开始制作';
    }
  },

  async _runAction(action) {
    if (!this.currentJobDir) return;
    this._setError('');
    const actionButtons = ['local-agent-approve-plan', 'local-agent-approve-style', 'local-agent-resume']
      .map(id => document.getElementById(id))
      .filter(Boolean);
    actionButtons.forEach(button => { button.disabled = true; });
    try {
      const launch = await window.__TAURI__.core.invoke('local_ppte_agent_action', {
        jobDir: this.currentJobDir,
        action,
        authToken: window.Auth.getToken() || ''
      });
      this.currentOutputDir = launch.output_dir || this.currentOutputDir;
      this._setStatus('正在继续', `Agent 进程 ${launch.pid} 已启动。`);
      this._startPolling();
    } catch (e) {
      this._setError(String(e));
    } finally {
      actionButtons.forEach(button => { button.disabled = false; });
    }
  },

  _startPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this._pollJob();
    this.pollTimer = setInterval(() => this._pollJob(), 1500);
  },

  async _pollJob() {
    if (!this.currentJobDir || !document.getElementById('local-ppte-agent-modal')) return;
    try {
      const job = await window.__TAURI__.core.invoke('local_ppte_agent_read_job', { jobDir: this.currentJobDir });
      this._renderJob(job);
    } catch (e) {
      document.getElementById('local-agent-status-message').textContent = '任务正在初始化，等待 job.json...';
    }
  },

  _renderJob(job) {
    this.currentOutputDir = job.outputDir || this.currentOutputDir;
    const total = job.plan?.slides?.length || job.brief?.targetSlideCount || 0;
    const completed = Object.values(job.slides || {}).filter(item => item.approved).length;
    const percent = total ? Math.round((completed / total) * 100) : 0;
    const label = this._statusLabel(job.status);
    this._setStatus(label, job.error?.message || job.events?.[job.events.length - 1]?.message || '任务处理中');
    document.getElementById('local-agent-progress-text').textContent = `${completed} / ${total}`;
    document.getElementById('local-agent-progress-bar').style.width = `${percent}%`;
    document.getElementById('local-agent-job-dir').textContent = job.jobDir || this.currentJobDir;
    document.getElementById('local-agent-output-dir').textContent = job.outputDir || '—';
    if (job.referenceSummary) {
      const sourceSummary = document.getElementById('local-agent-source-summary');
      sourceSummary.textContent = `1 个主大纲 · ${job.referenceSummary.selected || 0} 项参考 · ${Number(job.referenceSummary.totalCharacters || 0).toLocaleString()} 字`;
    }
    const stageList = document.getElementById('local-agent-stage-list');
    stageList.innerHTML = (job.events || []).slice(-7).reverse().map(event => `<div><span>${this._escape(event.message)}</span><time>${this._formatTime(event.at)}</time></div>`).join('');
    this._renderMemoryPlan(job);
    document.getElementById('local-agent-approve-plan').classList.toggle('hidden', job.status !== 'AWAITING_PLAN_APPROVAL');
    document.getElementById('local-agent-approve-style').classList.toggle('hidden', job.status !== 'AWAITING_STYLE_APPROVAL');
    document.getElementById('local-agent-resume').classList.toggle('hidden', job.status !== 'FAILED_RETRYABLE');
    document.getElementById('local-agent-open-output').classList.toggle('hidden', job.status !== 'COMPLETED');
    if (job.status === 'COMPLETED' && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  },

  _renderMemoryPlan(job) {
    const count = document.getElementById('local-agent-memory-count');
    const list = document.getElementById('local-agent-memory-list');
    if (!count || !list) return;
    const moments = (job.plan?.slides || []).filter(slide => slide.memoryMoment?.enabled);
    if (!job.plan) {
      count.textContent = '等待规划';
      return;
    }
    const verified = Number(job.qualitySummary?.interactionStatesVerified);
    count.textContent = Number.isFinite(verified)
      ? `${moments.length} 个 · ${verified} 个三态通过`
      : `${moments.length} 个 / ${job.plan.slides.length} 页`;
    if (!moments.length) {
      list.innerHTML = '<p>这套计划还没有记忆点。若不是刻意关闭，建议不要批准。</p>';
      return;
    }
    list.innerHTML = moments.map(slide => {
      const moment = slide.memoryMoment;
      const trigger = moment.trigger?.instruction || moment.trigger?.type || '触发揭示';
      return `<article class="local-agent-memory-card">
        <div><span>第 ${Number(slide.position) || '—'} 页</span><em>${this._escape(moment.patternName || moment.patternId)}</em></div>
        <h4>${this._escape(slide.title)}</h4>
        <p><b>开始</b>${this._escape(moment.initialState)}</p>
        <p><b>操作</b>${this._escape(trigger)}</p>
        <p><b>揭示</b>${this._escape(moment.revealState)}</p>
        <strong>${this._escape(moment.teachingPayoff)}</strong>
      </article>`;
    }).join('');
  },

  async _openOutput() {
    if (!this.currentOutputDir) return;
    try {
      await window.PpteCreate.openPptExtraPath(this.currentOutputDir);
      this.openedCompletedJob = this.currentJobDir;
      this.close();
    } catch (e) {
      this._setError(`打开生成课件失败：${e}`);
    }
  },

  _setStatus(label, message) {
    const labelElement = document.getElementById('local-agent-status-label');
    const messageElement = document.getElementById('local-agent-status-message');
    if (labelElement) labelElement.textContent = label;
    if (messageElement) messageElement.textContent = message;
  },

  _setError(message) {
    const el = document.getElementById('local-agent-form-error');
    if (el) el.textContent = message || '';
  },

  _statusLabel(status) {
    return ({ CREATED: '已创建', PLANNING: '规划中', PLAN_APPROVED: '计划已批准', STYLE_PROTOTYPING: '制作样片', STYLE_APPROVED: '样片已批准', GENERATING: '逐页制作中', DECK_REVIEWING: '整套审稿中', REPAIRING: '定向返修中', FINALIZING: '正在组装', AWAITING_PLAN_APPROVAL: '等待计划确认', AWAITING_STYLE_APPROVAL: '等待样片确认', FAILED_RETRYABLE: '可恢复失败', COMPLETED: '制作完成' })[status] || status || '未知状态';
  },

  _formatTime(value) {
    if (!value) return '';
    try { return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch { return ''; }
  },

  _escape(value) {
    return String(value || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
};
