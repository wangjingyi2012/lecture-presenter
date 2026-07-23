// ppte-editor.js — PPTE editor, save conflict handling, and live reload integration
window.PpteEditor = {
  _ppteWatchUnlisten: null,

  _joinPptPath(folderPath, filename) {
    return (String(folderPath || '').replace(/[\\/]+$/, '') + '/' + String(filename || '').replace(/^[\\/]+/, '')).replace(/\\/g, '/');
  },

  async _loadPptFileStats(folderPath, manifest) {
    if (!window.__TAURI__) return {};
    const slides = this._normalizeManifestSlides(manifest?.slides);
    const relPaths = ['manifest.json', ...slides.map(s => s.file).filter(Boolean)];
    const uniqueRelPaths = [...new Set(relPaths)];
    const fullPaths = uniqueRelPaths.map(path => this._joinPptPath(folderPath, path));
    const stats = await window.__TAURI__.core.invoke('stat_files', { paths: fullPaths });
    const byRelPath = {};
    stats.forEach((stat, index) => {
      byRelPath[uniqueRelPaths[index]] = {
        path: uniqueRelPaths[index],
        exists: !!stat.exists,
        mtimeMs: stat.mtimeMs ?? null,
        size: stat.size ?? null,
        contentHash: stat.contentHash ?? null,
      };
    });
    return byRelPath;
  },

  _expectedStatsForSave(pb, slideFiles) {
    const fileStats = pb.fileStats || {};
    const paths = ['manifest.json', ...slideFiles.map(([filename]) => filename)].filter(Boolean);
    return [...new Set(paths)].map(path => {
      const stat = fileStats[path] || { path, exists: false, mtimeMs: null, size: null, contentHash: null };
      return {
        path,
        exists: !!stat.exists,
        mtimeMs: stat.mtimeMs ?? null,
        size: stat.size ?? null,
        contentHash: stat.contentHash ?? null,
      };
    });
  },

  async _refreshPptFileStats(pb, paths) {
    if (!pb || !window.__TAURI__) return;
    const uniquePaths = [...new Set(paths.filter(Boolean))];
    if (uniquePaths.length === 0) return;
    const fullPaths = uniquePaths.map(path => this._joinPptPath(pb.folderPath, path));
    const stats = await window.__TAURI__.core.invoke('stat_files', { paths: fullPaths });
    if (!pb.fileStats) pb.fileStats = {};
    stats.forEach((stat, index) => {
      const relPath = uniquePaths[index];
      pb.fileStats[relPath] = {
        path: relPath,
        exists: !!stat.exists,
        mtimeMs: stat.mtimeMs ?? null,
        size: stat.size ?? null,
        contentHash: stat.contentHash ?? null,
      };
    });
  },

  _markCurrentSlideFromEditor(pb) {
    if (!pb || !pb.slides || !pb.slides[pb.currentSlideIndex]) return;
    const slide = pb.slides[pb.currentSlideIndex];
    const titleInput = document.getElementById('ppt-current-title');
    const htmlTextarea = document.getElementById('ppt-current-html');
    if (titleInput) {
      const title = titleInput.value.trim() || '未命名';
      if (slide.title !== title) {
        slide.title = title;
        pb.manifestDirty = true;
      }
    }
    if (htmlTextarea && slide.html !== htmlTextarea.value) {
      slide.html = htmlTextarea.value;
      slide.dirty = true;
    }
  },

  _collectPptSlideFiles(pb, forceAll = false) {
    const slideFiles = [];
    for (const slide of (pb.slides || [])) {
      if (!forceAll && !slide.dirty && !slide.created) continue;
      slideFiles.push([
        slide.file,
        slide.html || this._generateSlideHtml(slide.title, slide.slide_type),
      ]);
    }
    if (pb.templateFiles && (forceAll || pb.templateFilesDirty)) {
      const cssTypes = ['cover', 'catalog', 'chapter', 'content', 'finish'];
      for (const t of cssTypes) {
        const cssKey = t + '_css';
        if (pb.templateFiles[cssKey]) slideFiles.push([t + '.css', pb.templateFiles[cssKey]]);
      }
      if (pb.templateFiles.style) slideFiles.push(['style.css', pb.templateFiles.style]);
      for (const key in pb.templateFiles) {
        if (key.startsWith('img_') && !key.startsWith('img_data_')) {
          slideFiles.push([key.substring(4), pb.templateFiles[key]]);
        }
      }
    }
    return slideFiles;
  },

  async _reloadPptBuilderFromDisk(pb) {
    const manifestPath = this._joinPptPath(pb.folderPath, 'manifest.json');
    const content = await window.__TAURI__.core.invoke('read_text_file', { filePath: manifestPath });
    const manifest = JSON.parse(content);
    manifest.slides = this._normalizeManifestSlides(manifest.slides);
    const manifestUpgraded = this._ensurePpteStableIds?.(manifest) || false;
    for (const slide of manifest.slides) {
      try {
        slide.html = await window.__TAURI__.core.invoke('read_text_file', {
          filePath: this._joinPptPath(pb.folderPath, slide.file),
        });
      } catch (e) {
        slide.html = '';
      }
      slide.dirty = false;
      slide.created = false;
    }
    pb.manifest = manifest;
    pb.slides = manifest.slides;
    pb.sharedSelection = new Set();
    pb.linkedGroupStatuses = {};
    pb.currentSlideIndex = Math.min(pb.currentSlideIndex || 0, Math.max(0, pb.slides.length - 1));
    pb.fileStats = await this._loadPptFileStats(pb.folderPath, manifest);
    pb.manifestDirty = manifestUpgraded;
    this._renderPptBuilderInContent();
    setTimeout(() => this._checkLinkedGroups?.({ silent: true }), 0);
  },

  async _handlePptSaveConflicts(pb, conflicts, retrySave) {
    const list = conflicts.join('\n');
    const choice = prompt(
      `以下文件在编辑期间被外部修改过，已停止保存，未覆盖磁盘内容：\n\n${list}\n\n输入 1：保留磁盘版本（放弃编辑器内未保存修改）\n输入 2：用我的版本覆盖\n留空或其它内容：取消保存`,
      ''
    );
    if (choice === '1') {
      await this._reloadPptBuilderFromDisk(pb);
      this._showToast('已重新载入磁盘版本');
      return { cancelled: true };
    }
    if (choice === '2') {
      return retrySave();
    }
    return { cancelled: true };
  },

  async _savePptBuilderData(pb, options = {}) {
    if (!pb) return { skipped: true };
    this._markCurrentSlideFromEditor(pb);

    const forceAll = !!options.forceAll;
    const forceOverwrite = !!options.forceOverwrite;
    const slideFiles = options.slideFiles || this._collectPptSlideFiles(pb, forceAll);
    const shouldSave = forceAll || forceOverwrite || pb.manifestDirty || slideFiles.length > 0;
    if (!shouldSave) return { skipped: true };

    const saveOnce = async (withoutExpected = false) => {
      const result = await window.__TAURI__.core.invoke('save_ppt_extra', {
        folderPath: pb.folderPath,
        manifestJson: this._cleanManifestJson(pb.manifest),
        slideFiles,
        expectedMtimes: withoutExpected ? null : this._expectedStatsForSave(pb, slideFiles),
      });
      return result || { saved: [], conflicts: [] };
    };

    let result = await saveOnce(forceOverwrite);
    if (result.conflicts && result.conflicts.length > 0) {
      result = await this._handlePptSaveConflicts(pb, result.conflicts, () => saveOnce(true));
      if (result.cancelled) return result;
    }

    await this._refreshPptFileStats(pb, ['manifest.json', ...slideFiles.map(([filename]) => filename)]);
    for (const slide of (pb.slides || [])) {
      if (slideFiles.some(([filename]) => filename === slide.file)) {
        slide.dirty = false;
        slide.created = false;
      }
    }
    pb.manifestDirty = false;
    pb.templateFilesDirty = false;
    return result;
  },

  async _startPptEditorWatch(pb) {
    if (!window.__TAURI__ || !window.__TAURI__.event || !pb?.folderPath) return;
    try {
      await this._stopPptEditorWatch();
      this._ppteWatchUnlisten = await window.__TAURI__.event.listen('ppte-file-changed', (event) => {
        this._handlePptEditorFileChanged(event.payload).catch(e => {
          console.warn('Failed to handle PPTE editor file change:', e);
        });
      });
      await window.__TAURI__.core.invoke('watch_ppte_folder', { folderPath: pb.folderPath });
    } catch (e) {
      console.warn('Failed to watch PPTE editor folder:', e);
      if (this._ppteWatchUnlisten) {
        this._ppteWatchUnlisten();
        this._ppteWatchUnlisten = null;
      }
    }
  },

  async _stopPptEditorWatch() {
    const folderPath = this._pptBuilder?.folderPath;
    if (this._ppteWatchUnlisten) {
      try {
        this._ppteWatchUnlisten();
      } catch (e) {
        console.warn('Failed to remove PPTE editor watch listener:', e);
      }
      this._ppteWatchUnlisten = null;
    }
    if (window.__TAURI__ && folderPath) {
      try {
        await window.__TAURI__.core.invoke('unwatch_ppte_folder', { folderPath });
      } catch (e) {
        console.warn('Failed to unwatch PPTE editor folder:', e);
      }
    }
  },

  _normalizePpteRelativePath(path) {
    return String(path || '').replace(/\\/g, '/').replace(/^\/+/, '');
  },

  async _handlePptEditorFileChanged(payload) {
    const pb = this._pptBuilder;
    if (!pb || !payload) return;
    const changedFolder = String(payload.folderPath || '').replace(/\\/g, '/');
    const currentFolder = String(pb.folderPath || '').replace(/\\/g, '/');
    if (changedFolder !== currentFolder) return;

    const files = (payload.files || []).map(path => this._normalizePpteRelativePath(path));
    if (files.length === 0) return;

    if (files.includes('manifest.json')) {
      if (pb.manifestDirty) {
        this._showToast('manifest.json 已被外部修改，当前编辑器也有未保存改动', true);
        return;
      }
      await this._reloadPptBuilderFromDisk(pb);
      this._showToast('已载入外部更新');
      return;
    }

    let updatedCurrent = false;
    let blockedByDirty = false;
    for (let i = 0; i < pb.slides.length; i++) {
      const slide = pb.slides[i];
      if (!files.includes(this._normalizePpteRelativePath(slide.file))) continue;
      if (slide.dirty) {
        blockedByDirty = true;
        continue;
      }
      try {
        slide.html = await window.__TAURI__.core.invoke('read_text_file', {
          filePath: this._joinPptPath(pb.folderPath, slide.file),
        });
        await this._refreshPptFileStats(pb, [slide.file]);
        if (i === pb.currentSlideIndex) updatedCurrent = true;
      } catch (e) {
        console.warn('Failed to reload externally changed slide:', slide.file, e);
      }
    }

    if (updatedCurrent) {
      const textarea = document.getElementById('ppt-current-html');
      if (textarea && pb.slides[pb.currentSlideIndex]) {
        textarea.value = pb.slides[pb.currentSlideIndex].html || '';
      }
      this._showToast('当前页已载入外部更新');
    }
    if (blockedByDirty) {
      this._showToast('外部修改了有未保存改动的页面，已保留编辑器内容', true);
    }
  },

  // PPT-EXTRA Builder (standalone)
  _pptBuilder: null,
  _pptVisualEditor: null,

  _openPptBuilder(folderPath, manifest, templateFiles = null) {
    manifest.slides = this._normalizeManifestSlides(manifest.slides);
    const manifestUpgraded = this._ensurePpteStableIds?.(manifest) || false;

    // Use main content area instead of modal
    this._pptBuilder = {
      folderPath,
      manifest,
      slides: manifest.slides || [],
      templateFiles,
      fileStats: manifest._fileStats || {},
      manifestDirty: manifestUpgraded,
      templateFilesDirty: !!templateFiles,
      sharedSelection: new Set(),
      linkedGroupStatuses: {},
    };
    delete manifest._fileStats;

    // Switch to PPTE editor view
    this.showPpteEditor();

    // Render the editor in main content
    this._renderPptBuilderInContent();
    this._startPptEditorWatch(this._pptBuilder);
    setTimeout(() => this._checkLinkedGroups?.({ silent: true }), 0);

    // Add save button handler
    setTimeout(() => {
      const saveBtn = document.getElementById('ppt-save-btn');
      if (saveBtn) {
        saveBtn.onclick = () => this._savePptExtra();
      }

      const reorderBtn = document.getElementById('ppt-reorder-btn');
      if (reorderBtn) {
        reorderBtn.onclick = () => this._showReorderModal();
      }

      const editConfigBtn = document.getElementById('ppt-edit-config-btn');
      if (editConfigBtn) {
        editConfigBtn.onclick = () => this._editPptConfig();
      }

      const giteeBackupBtn = document.getElementById('ppt-gitee-backup-btn');
      if (giteeBackupBtn) {
        giteeBackupBtn.onclick = () => this._backupPptToGitee(giteeBackupBtn);
      }

      const sharedManageBtn = document.getElementById('ppt-shared-manage-btn');
      if (sharedManageBtn) {
        sharedManageBtn.onclick = () => this._showSharedGroupsManager?.();
      }

      // Add Cmd+S keyboard shortcut
      if (!this._pptSaveKeyHandler) {
        this._pptSaveKeyHandler = (e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 's') {
            e.preventDefault();
            const editor = document.getElementById('ppte-editor');
            if (editor && !editor.classList.contains('hidden')) {
              this._savePptExtra();
            }
          }
        };
        document.addEventListener('keydown', this._pptSaveKeyHandler);
      }
    }, 100);
  },

  _renderPptBuilderInContent() {
    const pb = this._pptBuilder;
    if (!pb) return;
    if (this._pptVisualEditor) this._closePptVisualEditor(false);

    pb.slides = this._normalizeManifestSlides(pb.slides);
    pb.manifest.slides = pb.slides;

    if (pb.currentSlideIndex === undefined) {
      pb.currentSlideIndex = 0;
    }

    const pageItems = document.getElementById('ppte-page-items');
    if (pageItems) {
      // 保存滚动位置
      const scrollTop = pageItems.scrollTop;
      pageItems.innerHTML = this._renderPageListHtml();
      // 恢复滚动位置
      pageItems.scrollTop = scrollTop;
    }

    this._bindPptEditorEvents();
    this._bindPageListDrag();

    const titleInput = document.getElementById('ppt-current-title');
    if (titleInput) {
      titleInput.value = pb.slides[pb.currentSlideIndex]?.title || '';
    }

    const htmlTextarea = document.getElementById('ppt-current-html');
    if (htmlTextarea) {
      htmlTextarea.value = pb.slides[pb.currentSlideIndex]?.html || '';
    }
  },

  _renderPageListHtml() {
    const pb = this._pptBuilder;
    const sharedSlideIds = new Set((pb.manifest.sharedGroups || []).flatMap(group => group.slideIds || []));
    return pb.slides.map((slide, idx) => {
      const linked = slide.linkedFrom;
      const status = linked ? pb.linkedGroupStatuses?.[linked.groupId] : null;
      const statusLabel = this._sharedGroupStatusLabel?.(status?.state) || '';
      return `
      <li data-index="${idx}" data-slide-id="${this._escapeAttr(slide.id || '')}" class="${idx === pb.currentSlideIndex ? 'active' : ''} ${linked ? 'ppte-linked-slide' : ''}" style="padding:12px 16px;cursor:pointer;display:flex;align-items:center;gap:8px;">
        <input class="ppte-share-select" data-share-select="${this._escapeAttr(slide.id || '')}" type="checkbox" ${pb.sharedSelection?.has(slide.id) ? 'checked' : ''} ${linked ? 'disabled' : ''} title="选择为共享页面组">
        <span class="drag-handle" style="cursor:${linked ? 'not-allowed' : 'grab'};color:var(--text-muted);font-size:14px;user-select:none;flex-shrink:0;">⠿</span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${this._escapeHtml(slide.title)}</span>
        ${sharedSlideIds.has(slide.id) ? '<span class="ppte-shared-badge ppte-shared-source">源</span>' : ''}
        ${linked ? `<span class="ppte-shared-badge ${status?.state === 'update_available' ? 'ppte-shared-update' : ''}">${this._escapeHtml(statusLabel || '共享')}</span>` : ''}
        <span style="font-size:11px;color:var(--text-muted);flex-shrink:0;">${this._escapeHtml(slide.file || '')}</span>
      </li>
    `;
    }).join('');
  },

  _bindPptEditorEvents() {
    const pb = this._pptBuilder;

    const pageItems = document.getElementById('ppte-page-items');
    if (pageItems) {
      // Use onclick assignment to avoid stacking listeners (no cloneNode needed)
      pageItems.onclick = (e) => {
        if (e.target.closest('[data-share-select]')) return;
        const li = e.target.closest('li');
        if (li) {
          const idx = parseInt(li.dataset.index);
          pb.currentSlideIndex = idx;
          this._renderPptBuilderInContent();
        }
      };
      pageItems.onchange = (e) => {
        const checkbox = e.target.closest('[data-share-select]');
        if (!checkbox) return;
        if (!pb.sharedSelection) pb.sharedSelection = new Set();
        if (checkbox.checked) pb.sharedSelection.add(checkbox.dataset.shareSelect);
        else pb.sharedSelection.delete(checkbox.dataset.shareSelect);
      };
    }

    const addBtn = document.getElementById('ppte-add-page');
    if (addBtn) {
      addBtn.onclick = () => this._addPptSlide();
    }

    const createSharedBtn = document.getElementById('ppte-create-shared-group');
    if (createSharedBtn) {
      createSharedBtn.onclick = () => this._createSharedGroupFromSelection?.();
    }

    const insertSharedBtn = document.getElementById('ppte-insert-shared-group');
    if (insertSharedBtn) {
      insertSharedBtn.onclick = () => this._showInsertSharedGroupModal?.();
    }

    const titleInput = document.getElementById('ppt-current-title');
    if (titleInput) {
      titleInput.disabled = !!pb.slides[pb.currentSlideIndex]?.linkedFrom;
      titleInput.oninput = (e) => {
        const cur = this._pptBuilder;
        if (!cur) return;
        cur.slides[cur.currentSlideIndex].title = e.target.value;
        cur.manifestDirty = true;
        const pageItems = document.getElementById('ppte-page-items');
        if (pageItems) pageItems.innerHTML = this._renderPageListHtml();
      };
    }

    const htmlTextarea = document.getElementById('ppt-current-html');
    if (htmlTextarea) {
      htmlTextarea.disabled = !!pb.slides[pb.currentSlideIndex]?.linkedFrom;
      htmlTextarea.title = htmlTextarea.disabled ? '共享页面请在源 PPTE 中编辑，或先断开引用' : '';
      htmlTextarea.oninput = (e) => {
        const cur = this._pptBuilder;
        if (!cur) return;
        cur.slides[cur.currentSlideIndex].html = e.target.value;
        cur.slides[cur.currentSlideIndex].dirty = true;
      };
    }

    const deleteBtn = document.getElementById('ppt-delete-current');
    if (deleteBtn) {
      // Reset confirm state when rebinding (e.g. switching PPTE)
      deleteBtn.textContent = '删除';
      deleteBtn.style.background = '#e74c3c';
      let confirmPending = false;
      let confirmTimer = null;
      deleteBtn.onclick = () => {
        const cur = this._pptBuilder;
        if (!cur) return;
        if (cur.slides[cur.currentSlideIndex]?.linkedFrom) {
          this._showToast('共享页面不能单独删除，请先断开引用', true);
          return;
        }
        const sourceGroups = (cur.manifest.sharedGroups || [])
          .filter(group => (group.slideIds || []).includes(cur.slides[cur.currentSlideIndex]?.id));
        if (sourceGroups.length) {
          this._showToast('此页面是共享真源，请先在“共享页面”中取消共享', true);
          return;
        }
        if (cur.slides.length <= 1) {
          alert('至少需要保留一个页面');
          return;
        }
        if (!confirmPending) {
          // First click — enter confirm state
          confirmPending = true;
          deleteBtn.textContent = '确认删除？';
          deleteBtn.style.background = '#c0392b';
          clearTimeout(confirmTimer);
          confirmTimer = setTimeout(() => {
            confirmPending = false;
            deleteBtn.textContent = '删除';
            deleteBtn.style.background = '#e74c3c';
          }, 3000);
        } else {
          // Second click — actually delete
          confirmPending = false;
          clearTimeout(confirmTimer);
          deleteBtn.textContent = '删除';
          deleteBtn.style.background = '#e74c3c';
          cur.slides.splice(cur.currentSlideIndex, 1);
          cur.manifestDirty = true;
          if (cur.currentSlideIndex >= cur.slides.length) {
            cur.currentSlideIndex = cur.slides.length - 1;
          }
          this._renderPptBuilderInContent();
        }
      };
    }

    const aiChatBtn = document.getElementById('ppt-ai-chat-btn');
    if (aiChatBtn) {
      aiChatBtn.disabled = !!pb.slides[pb.currentSlideIndex]?.linkedFrom;
      aiChatBtn.onclick = () => this._showAiChat();
    }

    const resourcesBtn = document.getElementById('ppt-resources-btn');
    if (resourcesBtn) {
      resourcesBtn.onclick = () => this._showPpteResources();
    }

    const visualBtn = document.getElementById('ppt-visual-edit-btn');
    if (visualBtn) {
      visualBtn.disabled = !!pb.slides[pb.currentSlideIndex]?.linkedFrom;
      visualBtn.onclick = () => this._openPptVisualEditor();
    }

    const previewBtn = document.getElementById('ppt-preview-btn');

    // Helper: save all files before opening viewer
    const saveAndOpen = async (mode) => {
      const slide = pb.slides[pb.currentSlideIndex];
      const result = await this._savePptBuilderData(pb);
      if (result.cancelled) return;

      const assetUrl = window.__TAURI__.core.convertFileSrc(pb.folderPath);
      const title = mode === 'preview' ? (slide.title || '未命名') : (pb.manifest?.title || 'Slides');
      await PptExtraViewer.open(title, assetUrl, pb.folderPath);

      if (mode === 'play') PptExtraViewer.togglePlayMode();
      if (mode === 'speaker') await PptExtraViewer.toggleSpeakerMode();
    };

    if (previewBtn) {
      previewBtn.onclick = async () => {
        try {
          await saveAndOpen('preview');
        } catch (e) {
          console.error('PPTE preview failed:', e);
          this._showToast('预览失败', true);
        }
      };
    }

    const playBtn2 = document.getElementById('ppt-play-btn2');
    if (playBtn2) {
      playBtn2.onclick = async () => {
        this._showToast('正在打开播放...');
        await this._pptPlayMode('play');
      };
    }

    const speakerBtn2 = document.getElementById('ppt-speaker-btn2');
    if (speakerBtn2) {
      speakerBtn2.onclick = async () => {
        this._showToast('正在打开演讲...');
        await this._pptPlayMode('speaker');
      };
    }
  },

  async _pptPlayMode(mode) {
    const pb = this._pptBuilder;
    if (!pb || !pb.slides || pb.slides.length === 0) return;

    try {
      const result = await this._savePptBuilderData(pb);
      if (result.cancelled) return;
      const assetUrl = window.__TAURI__.core.convertFileSrc(pb.folderPath);
      await PptExtraViewer.open(pb.manifest?.title || 'Slides', assetUrl, pb.folderPath);
      if (mode === 'play') PptExtraViewer.togglePlayMode();
      if (mode === 'speaker') await PptExtraViewer.toggleSpeakerMode();
    } catch (e) {
      console.error('PPTE action failed:', mode, e);
      this._showToast((mode === 'play' ? '播放' : '演讲') + '失败', true);
    }
  },

  async _showPpteResources() {
    const pb = this._pptBuilder;
    if (!pb || !window.__TAURI__) return;

    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;right:0;bottom:0;width:min(520px,92vw);z-index:3200;background:var(--bg-primary);border-left:1px solid var(--border);box-shadow:-8px 0 24px rgba(0,0,0,0.25);display:flex;flex-direction:column;';
    modal.innerHTML = `
      <div style="padding:14px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:12px;">
        <div style="min-width:0;">
          <div style="font-size:15px;font-weight:600;color:var(--text-primary);">资源</div>
          <div style="font-size:12px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${this._escapeHtml(pb.folderPath)}</div>
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0;">
          <button id="ppte-res-import" style="padding:5px 10px;border-radius:4px;border:none;background:var(--accent);color:#fff;cursor:pointer;font-size:12px;">导入</button>
          <button id="ppte-res-open-folder" style="padding:5px 10px;border-radius:4px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;font-size:12px;">目录</button>
          <button id="ppte-res-refresh" style="padding:5px 10px;border-radius:4px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;font-size:12px;">刷新</button>
          <button id="ppte-res-close" style="padding:5px 10px;border-radius:4px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;font-size:12px;">关闭</button>
        </div>
      </div>
      <div id="ppte-res-summary" style="padding:10px 16px;border-bottom:1px solid var(--border);font-size:12px;color:var(--text-secondary);"></div>
      <div id="ppte-res-list" style="flex:1;overflow:auto;padding:8px;"></div>
    `;
    document.body.appendChild(modal);

    const close = () => {
      if (modal.parentNode) modal.parentNode.removeChild(modal);
    };
    modal.querySelector('#ppte-res-close').onclick = close;
    modal.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
    });

    const refresh = async () => {
      const list = modal.querySelector('#ppte-res-list');
      const summary = modal.querySelector('#ppte-res-summary');
      list.innerHTML = '<div style="padding:16px;color:var(--text-muted);font-size:13px;">正在读取资源...</div>';
      try {
        const resources = await window.__TAURI__.core.invoke('list_ppte_resources', {
          folderPath: pb.folderPath,
        });
        this._renderPpteResources(list, summary, resources || []);
      } catch (e) {
        list.innerHTML = `<div style="padding:16px;color:#f85149;font-size:13px;">读取失败：${this._escapeHtml(String(e))}</div>`;
      }
    };
    modal.querySelector('#ppte-res-refresh').onclick = refresh;
    modal.querySelector('#ppte-res-open-folder').onclick = async () => {
      try {
        await window.__TAURI__.core.invoke('open_external', { path: pb.folderPath });
      } catch (e) {
        this._showToast('打开目录失败', true);
      }
    };
    modal.querySelector('#ppte-res-import').onclick = async () => {
      try {
        const files = await window.__TAURI__.core.invoke('pick_files');
        if (!files || files.length === 0) return;
        const imported = await window.__TAURI__.core.invoke('import_ppte_resources', {
          folderPath: pb.folderPath,
          sourcePaths: files,
        });
        await refresh();
        if (imported?.length) {
          this._showToast(`已导入 ${imported.length} 个资源`);
        }
      } catch (e) {
        if (e !== 'cancelled') {
          this._showToast(`导入失败：${e}`, true);
        }
      }
    };
    await refresh();
  },

  _renderPpteResources(container, summary, resources) {
    const grouped = resources.reduce((acc, item) => {
      const kind = item.kind || 'other';
      if (!acc[kind]) acc[kind] = [];
      acc[kind].push(item);
      return acc;
    }, {});
    const totalSize = resources.reduce((sum, item) => sum + (item.size || 0), 0);
    summary.textContent = `${resources.length} 个文件 · ${this._formatBytes(totalSize)}`;

    const labels = {
      manifest: '配置',
      slide: '页面',
      note: '笔记',
      style: '样式',
      image: '图片',
      script: '脚本',
      other: '其他',
    };
    const order = ['manifest', 'slide', 'note', 'style', 'image', 'script', 'other'];
    const html = order
      .filter(kind => grouped[kind]?.length)
      .map(kind => `
        <section style="margin-bottom:10px;">
          <div style="padding:8px 8px 6px;font-size:12px;font-weight:600;color:var(--text-secondary);">${labels[kind] || kind} · ${grouped[kind].length}</div>
          ${grouped[kind].map(item => this._renderPpteResourceItem(item)).join('')}
        </section>
      `).join('');
    container.innerHTML = html || '<div style="padding:16px;color:var(--text-muted);font-size:13px;">未找到资源文件</div>';

    container.querySelectorAll('[data-copy-path]').forEach(btn => {
      btn.onclick = async () => {
        const value = btn.dataset.copyPath;
        try {
          await navigator.clipboard.writeText(value);
          this._showToast('已复制路径');
        } catch (e) {
          this._showToast('复制失败', true);
        }
      };
    });
    container.querySelectorAll('[data-open-path]').forEach(btn => {
      btn.onclick = async () => {
        const relPath = btn.dataset.openPath;
        const fullPath = this._joinPptPath(this._pptBuilder.folderPath, relPath);
        try {
          await window.__TAURI__.core.invoke('open_external', { path: fullPath });
        } catch (e) {
          this._showToast('打开失败', true);
        }
      };
    });
  },

  _renderPpteResourceItem(item) {
    const path = String(item.path || '');
    return `
      <div style="display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:8px;align-items:center;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--bg-secondary);margin-bottom:6px;">
        <div style="min-width:0;">
          <div style="font-size:13px;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${this._escapeHtml(path)}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${this._escapeHtml(item.kind || 'other')} · ${this._formatBytes(item.size || 0)}</div>
        </div>
        <button data-copy-path="${this._escapeAttr(path)}" style="padding:4px 8px;border-radius:4px;border:1px solid var(--border);background:var(--bg-primary);color:var(--text-primary);cursor:pointer;font-size:12px;">复制</button>
        <button data-open-path="${this._escapeAttr(path)}" style="padding:4px 8px;border-radius:4px;border:1px solid var(--border);background:var(--bg-primary);color:var(--text-primary);cursor:pointer;font-size:12px;">打开</button>
      </div>
    `;
  },

  _formatBytes(size) {
    const value = Number(size || 0);
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  },

  async _backupPptToGitee(button = null) {
    const pb = this._pptBuilder;
    if (!pb || !window.__TAURI__) return;

    const originalText = button?.textContent || '';
    if (button) {
      button.disabled = true;
      button.textContent = '备份中...';
    }

    try {
      const saveResult = await this._savePptBuilderData(pb);
      if (saveResult.cancelled) return;

      const gitInfo = await window.__TAURI__.core.invoke('ppte_git_info', {
        folderPath: pb.folderPath,
      });
      if (gitInfo?.isRepo) {
        if (gitInfo.originUrl && !pb.manifest.gitee?.cloneUrl && !pb.manifest.gitee?.sshUrl) {
          pb.manifest.gitee = {
            name: this._repoNameFromRemoteUrl(gitInfo.originUrl) || pb.manifest.title || 'PPTE',
            fullName: null,
            htmlUrl: null,
            cloneUrl: this._stripUrlCredentials(gitInfo.originUrl),
            sshUrl: null,
          };
          await window.__TAURI__.core.invoke('write_text_file', {
            filePath: this._joinPptPath(pb.folderPath, 'manifest.json'),
            content: JSON.stringify(this._cleanManifestObject(pb.manifest), null, 2),
          });
          pb.fileStats = await this._loadPptFileStats(pb.folderPath, pb.manifest);
        }
      }

      if (!gitInfo?.isRepo && !pb.manifest.gitee?.cloneUrl && !pb.manifest.gitee?.sshUrl) {
        const status = await window.__TAURI__.core.invoke('gitee_token_status');
        if (!status?.configured) {
          this._showToast('请先在设置中配置 Gitee Token', true);
          return;
        }
        this._showToast('正在生成 Gitee 仓库名...');
        const repoName = await this._suggestGiteeRepoName(pb.manifest.title || 'PPTE');
        this._showToast('正在创建 Gitee 私有仓库...');
        const repo = await window.__TAURI__.core.invoke('gitee_create_repo', {
          name: repoName,
          description: `PPTE backup for ${pb.manifest.title || 'PPTE'}`
        });
        pb.manifest.gitee = {
          name: repo.name,
          fullName: repo.fullName,
          htmlUrl: repo.htmlUrl,
          cloneUrl: repo.cloneUrl,
          sshUrl: repo.sshUrl,
        };
        await window.__TAURI__.core.invoke('write_text_file', {
          filePath: this._joinPptPath(pb.folderPath, 'manifest.json'),
          content: JSON.stringify(this._cleanManifestObject(pb.manifest), null, 2),
        });
        pb.fileStats = await this._loadPptFileStats(pb.folderPath, pb.manifest);
      }

      const originalCloneUrl = pb.manifest.gitee?.cloneUrl;
      const originalSshUrl = pb.manifest.gitee?.sshUrl;
      if (pb.manifest.gitee) {
        pb.manifest.gitee.cloneUrl = this._stripUrlCredentials(originalCloneUrl || '');
        pb.manifest.gitee.sshUrl = this._stripUrlCredentials(originalSshUrl || '');
      }
      if (pb.manifest.gitee && (pb.manifest.gitee.cloneUrl !== originalCloneUrl || pb.manifest.gitee.sshUrl !== originalSshUrl)) {
        await window.__TAURI__.core.invoke('write_text_file', {
          filePath: this._joinPptPath(pb.folderPath, 'manifest.json'),
          content: JSON.stringify(this._cleanManifestObject(pb.manifest), null, 2),
        });
        pb.fileStats = await this._loadPptFileStats(pb.folderPath, pb.manifest);
      }

      await window.__TAURI__.core.invoke('ppte_git_init', {
        folderPath: pb.folderPath,
        remoteUrl: gitInfo?.isRepo ? null : (pb.manifest.gitee?.cloneUrl || pb.manifest.gitee?.sshUrl || null),
      });
      const result = await window.__TAURI__.core.invoke('ppte_git_sync', {
        folderPath: pb.folderPath,
        message: `Backup PPTE: ${pb.manifest.title || 'Slides'}`,
      });
      this._showToast(result?.pushed ? '已备份到 Gitee' : '已完成本地备份');
    } catch (e) {
      console.error('Gitee backup failed:', e);
      this._showToast(`Gitee 备份失败：${e}`, true);
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = originalText || '备份到Gitee';
      }
    }
  },

  _slideProtocolUrl(filePath) {
    const normalized = String(filePath || '').replace(/\\/g, '/');
    const encoded = normalized.split('/').map(segment => encodeURIComponent(segment)).join('/');
    const prefix = normalized.startsWith('/') ? '' : '/';
    return `slide://localhost${prefix}${encoded}`;
  },

  _stripUrlCredentials(url) {
    const value = String(url || '').trim();
    if (value.startsWith('git@gitee.com:')) {
      return `https://gitee.com/${value.slice('git@gitee.com:'.length)}`;
    }
    if (value.startsWith('ssh://git@gitee.com/')) {
      return `https://gitee.com/${value.slice('ssh://git@gitee.com/'.length)}`;
    }
    const schemeIndex = value.indexOf('://');
    if (schemeIndex === -1) return value;
    const authorityStart = schemeIndex + 3;
    const pathIndex = value.indexOf('/', authorityStart);
    const authorityEnd = pathIndex === -1 ? value.length : pathIndex;
    const authority = value.slice(authorityStart, authorityEnd);
    const atIndex = authority.lastIndexOf('@');
    if (atIndex === -1) return value;
    return value.slice(0, authorityStart) + authority.slice(atIndex + 1) + value.slice(authorityEnd);
  },

  _sanitizeRepoNameCandidate(name) {
    return String(name || '')
      .trim()
      .toLowerCase()
      .replace(/[`"'“”‘’]/g, '')
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[.-]+|[.-]+$/g, '')
      .slice(0, 80);
  },

  _repoNameFromRemoteUrl(url) {
    const value = this._stripUrlCredentials(url);
    const withoutGit = value.endsWith('.git') ? value.slice(0, -4) : value;
    const parts = withoutGit.split(/[/:]/).filter(Boolean);
    return parts[parts.length - 1] || '';
  },

  async _suggestGiteeRepoName(title) {
    const fallback = this._sanitizeRepoNameCandidate(title);
    const appConfig = CourseLoader.appConfig || {};
    if (!appConfig.aiProvider || (appConfig.aiProvider !== 'lectureai' && !appConfig.aiApiKey)) {
      return fallback || String(title || 'ppte-backup');
    }

    try {
      const result = await window.__TAURI__.core.invoke('call_ai', {
        provider: appConfig.aiProvider,
        apiKey: appConfig.aiProvider === 'lectureai' ? (window.Auth?.getToken() || '') : appConfig.aiApiKey,
        apiType: appConfig.aiApiType,
        baseUrl: appConfig.aiBaseUrl,
        model: appConfig.aiModel,
        systemPrompt: '你是仓库命名助手。请把中文课件标题转换成简短、可读的英文 Git 仓库名。只返回一个名字。只能使用小写英文字母、数字、连字符、下划线或点。不要解释。',
        userMsg: `课件标题：${title}\n返回一个 Gitee 仓库名。`
      });
      return this._sanitizeRepoNameCandidate(result) || fallback || String(title || 'ppte-backup');
    } catch (e) {
      console.warn('Failed to suggest Gitee repo name with AI:', e);
      return fallback || String(title || 'ppte-backup');
    }
  },

  _wrapPptHtmlForVisualEditor(html, baseHref) {
    const content = String(html || '');
    const baseTag = `<base href="${this._escapeAttr(baseHref)}">`;
    if (/<head[^>]*>/i.test(content)) {
      return content.replace(/<head[^>]*>/i, (m) => `${m}\n${baseTag}`);
    }
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">${baseTag}</head><body>${content}</body></html>`;
  },

  _openPptVisualEditor() {
    const pb = this._pptBuilder;
    if (!pb || !pb.slides || pb.slides.length === 0) return;

    const slide = pb.slides[pb.currentSlideIndex];
    const htmlTextarea = document.getElementById('ppt-current-html');
    if (htmlTextarea) slide.html = htmlTextarea.value;

    this._closePptVisualEditor(false);

    const modal = document.createElement('div');
    modal.className = 'ppt-visual-modal';
    modal.innerHTML = `
      <div class="ppt-visual-shell" role="dialog" aria-label="PPTE 可视化调整">
        <div class="ppt-visual-header">
          <div>
            <div class="ppt-visual-header-title">可视化调整：${this._escapeHtml(slide.title || '未命名')}</div>
            <div class="ppt-visual-header-desc">点击元素后可拖拽位置，右侧面板可精确修改像素值（支持方向键微调）</div>
          </div>
          <div class="ppt-visual-actions">
            <button id="ppt-visual-apply-btn" class="ppt-visual-btn">应用到编辑器</button>
            <button id="ppt-visual-apply-close-btn" class="ppt-visual-btn primary">应用并关闭</button>
            <button id="ppt-visual-close-btn" class="ppt-visual-btn">关闭</button>
          </div>
        </div>
        <div class="ppt-visual-body">
          <div class="ppt-visual-canvas-wrap">
            <iframe id="ppt-visual-iframe" class="ppt-visual-canvas"
              sandbox="allow-same-origin allow-scripts allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation allow-forms"></iframe>
          </div>
          <aside class="ppt-visual-side">
            <div class="ppt-visual-side-scroll">
              <div class="ppt-visual-block">
                <div class="ppt-visual-label">当前元素</div>
                <div id="ppt-visual-selected" class="ppt-visual-selected">未选择</div>
              </div>
              <div class="ppt-visual-block">
                <div class="ppt-visual-label">位置与尺寸 (px)</div>
                <div class="ppt-visual-grid">
                  <label class="ppt-visual-field"><span>X</span><input id="ppt-visual-left" type="number" step="1"></label>
                  <label class="ppt-visual-field"><span>Y</span><input id="ppt-visual-top" type="number" step="1"></label>
                  <label class="ppt-visual-field"><span>宽度</span><input id="ppt-visual-width" type="number" step="1"></label>
                  <label class="ppt-visual-field"><span>高度</span><input id="ppt-visual-height" type="number" step="1"></label>
                  <label class="ppt-visual-field"><span>字体大小</span><input id="ppt-visual-font-size" type="number" step="1"></label>
                </div>
              </div>
              <div class="ppt-visual-block">
                <div class="ppt-visual-tip">拖拽会改写元素内联样式（left/top）。若元素原来是 static，会自动改为 relative 以支持位移。</div>
                <div class="ppt-visual-tip">方向键每次移动 1px，Shift + 方向键 每次移动 10px。</div>
              </div>
            </div>
          </aside>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const iframe = modal.querySelector('#ppt-visual-iframe');
    const baseHref = `${this._slideProtocolUrl(pb.folderPath).replace(/\/+$/, '')}/`;
    const htmlContent = slide.html || this._generateSlideHtml(slide.title, slide.slide_type);
    iframe.srcdoc = this._wrapPptHtmlForVisualEditor(htmlContent, baseHref);

    const state = {
      modal,
      iframe,
      pb,
      selectedEl: null,
      dragging: false,
      dragStartX: 0,
      dragStartY: 0,
      startLeft: 0,
      startTop: 0,
      syncingInspector: false,
      inputs: {
        left: modal.querySelector('#ppt-visual-left'),
        top: modal.querySelector('#ppt-visual-top'),
        width: modal.querySelector('#ppt-visual-width'),
        height: modal.querySelector('#ppt-visual-height'),
        fontSize: modal.querySelector('#ppt-visual-font-size'),
      },
      selectedLabel: modal.querySelector('#ppt-visual-selected'),
      canvasHandlers: null,
      keydownHandler: null,
    };
    this._pptVisualEditor = state;

    const bindInput = (input, key) => {
      if (!input) return;
      input.addEventListener('input', () => this._applyPptVisualField(state, key, input.value));
    };
    bindInput(state.inputs.left, 'left');
    bindInput(state.inputs.top, 'top');
    bindInput(state.inputs.width, 'width');
    bindInput(state.inputs.height, 'height');
    bindInput(state.inputs.fontSize, 'fontSize');

    modal.querySelector('#ppt-visual-close-btn').addEventListener('click', () => this._closePptVisualEditor(false));
    modal.querySelector('#ppt-visual-apply-btn').addEventListener('click', () => this._applyPptVisualChanges(state));
    modal.querySelector('#ppt-visual-apply-close-btn').addEventListener('click', () => this._closePptVisualEditor(true));

    modal.addEventListener('click', (e) => {
      if (e.target === modal) this._closePptVisualEditor(false);
    });

    state.keydownHandler = (e) => {
      if (!this._pptVisualEditor || this._pptVisualEditor !== state) return;
      if (!state.selectedEl) return;
      const tag = e.target && e.target.tagName ? e.target.tagName : '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      const step = e.shiftKey ? 10 : 1;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        this._nudgePptVisualSelection(state, -step, 0);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        this._nudgePptVisualSelection(state, step, 0);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this._nudgePptVisualSelection(state, 0, -step);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        this._nudgePptVisualSelection(state, 0, step);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this._closePptVisualEditor(false);
      }
    };
    document.addEventListener('keydown', state.keydownHandler);

    iframe.addEventListener('load', () => this._bindPptVisualCanvas(state), { once: true });
  },

  _closePptVisualEditor(apply) {
    const state = this._pptVisualEditor;
    if (!state) return;

    if (apply) this._applyPptVisualChanges(state);

    if (state.canvasHandlers && state.iframe && state.iframe.contentDocument) {
      const doc = state.iframe.contentDocument;
      doc.removeEventListener('click', state.canvasHandlers.click, true);
      doc.removeEventListener('mousedown', state.canvasHandlers.mousedown, true);
      doc.removeEventListener('mousemove', state.canvasHandlers.mousemove, true);
      doc.removeEventListener('mouseup', state.canvasHandlers.mouseup, true);
    }
    if (state.keydownHandler) {
      document.removeEventListener('keydown', state.keydownHandler);
    }
    if (state.modal && state.modal.parentNode) {
      state.modal.parentNode.removeChild(state.modal);
    }
    this._pptVisualEditor = null;
  },

  _bindPptVisualCanvas(state) {
    const doc = state.iframe.contentDocument;
    if (!doc) return;

    if (doc.head) {
      const style = doc.createElement('style');
      style.textContent = `
        [data-ppt-visual-selected="1"] {
          outline: 2px solid #3b82f6 !important;
          outline-offset: 2px !important;
          cursor: move !important;
        }
      `;
      doc.head.appendChild(style);
    }

    const findTarget = (eventTarget) => {
      let el = eventTarget;
      while (el && el !== doc.documentElement) {
        if (this._pickPptVisualElement(el)) return el;
        el = el.parentElement;
      }
      return null;
    };

    const clickHandler = (e) => {
      const target = findTarget(e.target);
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      this._selectPptVisualElement(state, target);
    };

    const mousedownHandler = (e) => {
      if (e.button !== 0) return;
      const target = findTarget(e.target);
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      this._selectPptVisualElement(state, target);

      this._ensurePptVisualPositioned(target);
      state.dragging = true;
      state.dragStartX = e.clientX;
      state.dragStartY = e.clientY;
      state.startLeft = parseFloat(target.style.left) || 0;
      state.startTop = parseFloat(target.style.top) || 0;
      doc.body.style.userSelect = 'none';
    };

    const mousemoveHandler = (e) => {
      if (!state.dragging || !state.selectedEl) return;
      e.preventDefault();
      const dx = e.clientX - state.dragStartX;
      const dy = e.clientY - state.dragStartY;
      state.selectedEl.style.left = `${Math.round(state.startLeft + dx)}px`;
      state.selectedEl.style.top = `${Math.round(state.startTop + dy)}px`;
      this._syncPptVisualInspector(state);
    };

    const mouseupHandler = () => {
      if (!state.dragging) return;
      state.dragging = false;
      if (doc.body) doc.body.style.userSelect = '';
      this._syncPptVisualInspector(state);
    };

    doc.addEventListener('click', clickHandler, true);
    doc.addEventListener('mousedown', mousedownHandler, true);
    doc.addEventListener('mousemove', mousemoveHandler, true);
    doc.addEventListener('mouseup', mouseupHandler, true);

    state.canvasHandlers = {
      click: clickHandler,
      mousedown: mousedownHandler,
      mousemove: mousemoveHandler,
      mouseup: mouseupHandler,
    };
  },

  _pickPptVisualElement(el) {
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toUpperCase();
    return !['HTML', 'BODY', 'HEAD', 'META', 'TITLE', 'LINK', 'STYLE', 'SCRIPT', 'BASE'].includes(tag);
  },

  _selectPptVisualElement(state, el) {
    if (!el) return;
    if (state.selectedEl) state.selectedEl.removeAttribute('data-ppt-visual-selected');
    state.selectedEl = el;
    state.selectedEl.setAttribute('data-ppt-visual-selected', '1');
    this._syncPptVisualInspector(state);
  },

  _syncPptVisualInspector(state) {
    if (!state.selectedEl) {
      if (state.selectedLabel) state.selectedLabel.textContent = '未选择';
      return;
    }
    const el = state.selectedEl;
    const win = el.ownerDocument.defaultView;
    const computed = win.getComputedStyle(el);

    const left = parseFloat(el.style.left) || 0;
    const top = parseFloat(el.style.top) || 0;
    const width = parseFloat(el.style.width) || parseFloat(computed.width) || 0;
    const height = parseFloat(el.style.height) || parseFloat(computed.height) || 0;
    const fontSize = parseFloat(el.style.fontSize) || parseFloat(computed.fontSize) || 0;

    const name = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.className ? '.' + String(el.className).trim().replace(/\s+/g, '.') : ''}`;
    if (state.selectedLabel) state.selectedLabel.textContent = name || el.tagName.toLowerCase();

    state.syncingInspector = true;
    state.inputs.left.value = Math.round(left);
    state.inputs.top.value = Math.round(top);
    state.inputs.width.value = Math.round(width);
    state.inputs.height.value = Math.round(height);
    state.inputs.fontSize.value = Math.round(fontSize);
    state.syncingInspector = false;
  },

  _applyPptVisualField(state, key, rawValue) {
    if (!state || !state.selectedEl || state.syncingInspector) return;
    const value = parseFloat(rawValue);
    if (!Number.isFinite(value)) return;

    const el = state.selectedEl;
    if (key === 'left' || key === 'top') {
      this._ensurePptVisualPositioned(el);
    }

    if (key === 'left') el.style.left = `${value}px`;
    if (key === 'top') el.style.top = `${value}px`;
    if (key === 'width') el.style.width = `${Math.max(1, value)}px`;
    if (key === 'height') el.style.height = `${Math.max(1, value)}px`;
    if (key === 'fontSize') el.style.fontSize = `${Math.max(1, value)}px`;

    this._syncPptVisualInspector(state);
  },

  _nudgePptVisualSelection(state, dx, dy) {
    if (!state || !state.selectedEl) return;
    this._ensurePptVisualPositioned(state.selectedEl);
    const left = (parseFloat(state.selectedEl.style.left) || 0) + dx;
    const top = (parseFloat(state.selectedEl.style.top) || 0) + dy;
    state.selectedEl.style.left = `${left}px`;
    state.selectedEl.style.top = `${top}px`;
    this._syncPptVisualInspector(state);
  },

  _ensurePptVisualPositioned(el) {
    if (!el) return;
    const computed = el.ownerDocument.defaultView.getComputedStyle(el);
    if (computed.position === 'static') {
      el.style.position = 'relative';
    }
  },

  _serializePptVisualDoc(doc) {
    const doctype = doc.doctype ? `<!DOCTYPE ${doc.doctype.name}>` : '<!DOCTYPE html>';
    return `${doctype}\n${doc.documentElement.outerHTML}`;
  },

  _applyPptVisualChanges(state) {
    if (!state || !state.pb || !state.iframe || !state.iframe.contentDocument) return;
    const html = this._serializePptVisualDoc(state.iframe.contentDocument);
    const pb = state.pb;
    const idx = pb.currentSlideIndex;
    if (idx === undefined || !pb.slides[idx]) return;
    pb.slides[idx].html = html;
    pb.slides[idx].dirty = true;
    const htmlTextarea = document.getElementById('ppt-current-html');
    if (htmlTextarea) htmlTextarea.value = html;
    this._showToast('已应用可视化调整');
  },

  closePptEditor() {
    this._closePptVisualEditor(false);
    this._stopPptEditorWatch();
    this.showCourseView();
    // Optionally hide PPTE section
    // this.hidePpteSection();
  },

  _renderPageList() {
    const pb = this._pptBuilder;
    const slideTypes = [
      { value: 'cover', label: '封面' },
      { value: 'catalog', label: '目录' },
      { value: 'chapter', label: '章节' },
      { value: 'content', label: '内容' },
      { value: 'finish', label: '结束' },
    ];

    let html = '<div style="display:flex;flex-direction:column;gap:4px;">';
    pb.slides.forEach((slide, index) => {
      const isActive = index === pb.currentSlideIndex;
      const typeLabel = slideTypes.find(t => t.value === slide.slide_type)?.label || '内容';
      html += `
        <div class="ppt-page-item ${isActive ? 'active' : ''}" data-index="${index}"
          style="padding:10px 12px;border-radius:6px;cursor:pointer;background:${isActive ? 'var(--accent-bg)' : 'transparent'};border-left:3px solid ${isActive ? 'var(--accent)' : 'transparent'};">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:12px;color:var(--text-muted);min-width:20px;">${index + 1}</span>
            <span style="font-size:13px;color:var(--text-primary);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${this._escapeHtml(slide.title)}</span>
            <span style="font-size:10px;color:var(--text-muted);background:var(--bg-tertiary);padding:2px 6px;border-radius:3px;">${typeLabel}</span>
          </div>
        </div>
      `;
    });
    html += '</div>';

    if (pb.slides.length === 0) {
      html = '<p style="color:var(--text-muted);text-align:center;padding:20px;font-size:13px;">暂无页面</p>';
    }

    return html;
  },

  _renderPageEditor() {
    const pb = this._pptBuilder;
    if (!pb.slides || pb.slides.length === 0) {
      return '<p style="color:var(--text-muted);text-align:center;padding:40px;">请添加页面开始编辑</p>';
    }

    const slide = pb.slides[pb.currentSlideIndex];

    return `
      <div style="display:flex;flex-direction:column;gap:16px;height:100%;">
        <div style="display:flex;gap:16px;align-items:flex-end;">
          <div style="flex:1;">
            <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:4px;">页面标题</label>
            <input type="text" id="ppt-current-title" value="${this._escapeAttr(slide.title)}"
              style="width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:6px;background:var(--bg-secondary);color:var(--text-primary);font-size:14px;box-sizing:border-box;">
          </div>
          <button id="ppt-preview-btn" style="padding:8px 16px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;font-size:13px;margin-bottom:0;">预览</button>
          <button id="ppt-play-btn" style="padding:8px 16px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;font-size:13px;margin-bottom:0;">▶ 播放</button>
          <button id="ppt-speaker-btn" style="padding:8px 16px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;font-size:13px;margin-bottom:0;display:flex;align-items:center;gap:4px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M12 17v4"/><circle cx="12" cy="10" r="3"/></svg> 演讲</button>
          <button id="ppt-delete-current" style="padding:8px 14px;border-radius:6px;border:none;background:#e74c3c;color:#fff;cursor:pointer;font-size:13px;margin-bottom:0;">删除页面</button>
        </div>
        <div style="flex:1;display:flex;flex-direction:column;min-height:0;">
          <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:8px;">HTML 内容（可直接编辑）</label>
          <textarea id="ppt-current-html" style="flex:1;width:100%;padding:12px;border:1px solid var(--border);border-radius:6px;background:var(--bg-tertiary);color:var(--text-primary);font-family:monospace;font-size:13px;line-height:1.5;resize:none;box-sizing:border-box;"
            placeholder="在此输入HTML内容...">${this._escapeAttr(slide.html || '')}</textarea>
        </div>
      </div>
    `;
  },

  _bindPageListEvents(modal) {
    const pb = this._pptBuilder;

    modal.querySelectorAll('.ppt-page-item').forEach(item => {
      item.addEventListener('click', () => {
        const index = parseInt(item.dataset.index);
        pb.currentSlideIndex = index;
        this._renderPptBuilderInContent();
      });
    });

    // Title and type change
    const titleInput = modal.querySelector('#ppt-current-title');
    if (titleInput) {
      titleInput.disabled = !!pb.slides[pb.currentSlideIndex]?.linkedFrom;
      titleInput.addEventListener('input', (e) => {
        pb.slides[pb.currentSlideIndex].title = e.target.value;
        pb.manifestDirty = true;
        this._refreshPageList();
      });
    }

    // HTML content change
    const htmlTextarea = modal.querySelector('#ppt-current-html');
    if (htmlTextarea) {
      htmlTextarea.disabled = !!pb.slides[pb.currentSlideIndex]?.linkedFrom;
      htmlTextarea.addEventListener('input', (e) => {
        pb.slides[pb.currentSlideIndex].html = e.target.value;
        pb.slides[pb.currentSlideIndex].dirty = true;
      });
    }

    // Delete current page (two-step: click once to arm, click again to delete)
    const deleteBtn = modal.querySelector('#ppt-delete-current');
    if (deleteBtn) {
      let confirmPending = false;
      let confirmTimer = null;
      deleteBtn.addEventListener('click', () => {
        const currentSlide = pb.slides[pb.currentSlideIndex];
        if (currentSlide?.linkedFrom) {
          this._showToast('共享页面不能单独删除，请先断开引用', true);
          return;
        }
        if ((pb.manifest.sharedGroups || []).some(group => (group.slideIds || []).includes(currentSlide?.id))) {
          this._showToast('此页面是共享真源，请先取消共享', true);
          return;
        }
        if (pb.slides.length <= 1) {
          alert('至少需要保留一个页面');
          return;
        }
        if (!confirmPending) {
          confirmPending = true;
          deleteBtn.textContent = '确认删除？';
          deleteBtn.style.background = '#c0392b';
          clearTimeout(confirmTimer);
          confirmTimer = setTimeout(() => {
            confirmPending = false;
            deleteBtn.textContent = '删除页面';
            deleteBtn.style.background = '#e74c3c';
          }, 3000);
        } else {
          confirmPending = false;
          clearTimeout(confirmTimer);
          deleteBtn.textContent = '删除页面';
          deleteBtn.style.background = '#e74c3c';
          pb.slides.splice(pb.currentSlideIndex, 1);
          pb.manifestDirty = true;
          if (pb.currentSlideIndex >= pb.slides.length) {
            pb.currentSlideIndex = pb.slides.length - 1;
          }
          this._refreshPptBuilder();
        }
      });
    }

    // Preview button
    const previewBtn = modal.querySelector('#ppt-preview-btn');
    if (previewBtn) {
      previewBtn.addEventListener('click', async () => {
        const slide = pb.slides[pb.currentSlideIndex];
        // Save current HTML first
        const htmlTextarea = modal.querySelector('#ppt-current-html');
        if (htmlTextarea) {
          slide.html = htmlTextarea.value;
        }

        // Save to temp file
        const tempFileName = 'preview_temp.html';
        try {
          // Collect all files to save including CSS
          const filesToSave = [[tempFileName, slide.html]];

          // Also save CSS files from template if available
          if (pb.templateFiles) {
            const cssTypes = ['cover', 'catalog', 'chapter', 'content', 'finish'];
            for (const t of cssTypes) {
              const cssKey = t + '_css';
              if (pb.templateFiles[cssKey]) {
                filesToSave.push([t + '.css', pb.templateFiles[cssKey]]);
              }
            }
            // Also save main style.css
            if (pb.templateFiles.style) {
              filesToSave.push(['style.css', pb.templateFiles.style]);
            }
            // Also save image files
            for (const key in pb.templateFiles) {
              if (key.startsWith('img_') && !key.startsWith('img_data_')) {
                const filename = key.substring(4);
                filesToSave.push([filename, pb.templateFiles[key]]);
              }
            }
          }

          const result = await this._savePptBuilderData(pb, { slideFiles });
          if (result.cancelled) return;

          // Close editor modal first
          modal.classList.add('hidden');

          // Use PptExtraViewer for preview (better CSS/image support)
          const folderPath = pb.folderPath;
          const assetUrl = window.__TAURI__.core.convertFileSrc(folderPath);

          // Store editor state to restore later
          pb._editorWasOpen = true;

          PptExtraViewer.open(slide.title, assetUrl, folderPath);

          // Add one-time listener to restore editor when preview closes
          const restoreEditor = () => {
            document.getElementById('ppt-extra-close').removeEventListener('click', restoreEditor);
            document.removeEventListener('keydown', escHandler);
            if (pb._editorWasOpen) {
              modal.classList.remove('hidden');
              pb._editorWasOpen = false;
            }
          };
          const escHandler = (e) => {
            if (e.key === 'Escape') {
              restoreEditor();
            }
          };
          document.getElementById('ppt-extra-close').addEventListener('click', restoreEditor);
          document.addEventListener('keydown', escHandler);
        } catch (e) {
          console.error('Preview error:', e);
          alert('预览失败: ' + e);
          modal.classList.remove('hidden');
        }
      });
    }

    // Play button — open full PPTE in play mode
    const playBtn = modal.querySelector('#ppt-play-btn');
    if (playBtn) {
      playBtn.addEventListener('click', async () => {
        try {
          const saved = await this._savePptBeforeAction(pb, modal);
          if (!saved) return;
          const assetUrl = window.__TAURI__.core.convertFileSrc(pb.folderPath);
          await PptExtraViewer.open(pb.manifest.title || 'Slides', assetUrl, pb.folderPath);
          PptExtraViewer.togglePlayMode();
        } catch (e) {
          console.error('Play error:', e);
          alert('播放失败: ' + e);
          modal.classList.remove('hidden');
        }
      });
    }

    // Speaker button — open full PPTE in speaker mode
    const speakerBtn = modal.querySelector('#ppt-speaker-btn');
    if (speakerBtn) {
      speakerBtn.addEventListener('click', async () => {
        try {
          const saved = await this._savePptBeforeAction(pb, modal);
          if (!saved) return;
          const assetUrl = window.__TAURI__.core.convertFileSrc(pb.folderPath);
          await PptExtraViewer.open(pb.manifest.title || 'Slides', assetUrl, pb.folderPath);
          await PptExtraViewer.toggleSpeakerMode();
        } catch (e) {
          console.error('Speaker mode error:', e);
          alert('演讲模式失败: ' + e);
          modal.classList.remove('hidden');
        }
      });
    }
  },

  // Helper: save all PPTE files before play/speaker action
  async _savePptBeforeAction(pb, modal) {
    const slide = pb.slides[pb.currentSlideIndex];
    const htmlTextarea = modal.querySelector('#ppt-current-html');
    if (htmlTextarea && slide.html !== htmlTextarea.value) {
      slide.html = htmlTextarea.value;
      slide.dirty = true;
    }
    const result = await this._savePptBuilderData(pb);
    if (result.cancelled) return false;
    modal.classList.add('hidden');
    pb._editorWasOpen = true;
    return true;
  },

  _refreshPptBuilder() {
    const modal = document.getElementById('ppt-builder-modal');
    if (!modal) return;

    // Update page list
    const pageList = modal.querySelector('#ppt-page-list');
    if (pageList) {
      pageList.innerHTML = this._renderPageList();
    }

    // Update editor
    const pageEditor = modal.querySelector('#ppt-page-editor');
    if (pageEditor) {
      pageEditor.innerHTML = this._renderPageEditor();
    }

    // Rebind events
    this._bindPageListEvents(modal);
  },

  _refreshPageList() {
    const modal = document.getElementById('ppt-builder-modal');
    if (!modal) return;
    const pageList = modal.querySelector('#ppt-page-list');
    if (pageList) {
      pageList.innerHTML = this._renderPageList();
    }
  },

  _addPptSlide() {
    const pb = this._pptBuilder;

    // Show type selection modal
    const self = this;
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:3100;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;';
    modal.innerHTML = `
      <div style="background:var(--bg-primary);border-radius:12px;padding:24px;max-width:400px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.4);">
        <h3 style="margin:0 0 16px;font-size:18px;font-weight:600;">选择页面类型</h3>
        <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:20px;">
          <button class="ppt-type-btn" data-type="cover" style="padding:12px 16px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;text-align:left;font-size:14px;display:flex;align-items:center;gap:10px;">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9h6v6H9z"/></svg>封面</button>
          <button class="ppt-type-btn" data-type="catalog" style="padding:12px 16px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;text-align:left;font-size:14px;display:flex;align-items:center;gap:10px;">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h16M4 18h10"/></svg>目录</button>
          <button class="ppt-type-btn" data-type="chapter" style="padding:12px 16px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;text-align:left;font-size:14px;display:flex;align-items:center;gap:10px;">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/></svg>章节</button>
          <button class="ppt-type-btn" data-type="content" style="padding:12px 16px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;text-align:left;font-size:14px;display:flex;align-items:center;gap:10px;">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/></svg>内容</button>
          <button class="ppt-type-btn" data-type="finish" style="padding:12px 16px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;text-align:left;font-size:14px;display:flex;align-items:center;gap:10px;">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/></svg>结束</button>
        </div>
        <button id="ppt-type-cancel" style="width:100%;padding:10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;">取消</button>
      </div>
    `;

    document.body.appendChild(modal);

    // Handle type selection
    modal.querySelectorAll('.ppt-type-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const slideType = btn.dataset.type;
        const typeLabels = {
          cover: '封面',
          catalog: '目录',
          chapter: '章节',
          content: '内容',
          finish: '结束'
        };
        const newSlide = {
          id: self._newPpteId?.('slide'),
          file: self._nextPpteSlideFile(pb),
          title: `${typeLabels[slideType]} ${pb.slides.length + 1}`,
          slide_type: slideType,
          html: self._generateSlideHtml(`${typeLabels[slideType]} ${pb.slides.length + 1}`, slideType),
          dirty: true,
          created: true,
        };
        pb.slides.push(newSlide);
        pb.manifestDirty = true;
        pb.currentSlideIndex = pb.slides.length - 1;
        document.body.removeChild(modal);
        self._renderPptBuilderInContent();
      });
    });

    // Cancel
    document.getElementById('ppt-type-cancel').addEventListener('click', () => {
      document.body.removeChild(modal);
    });

    modal.addEventListener('click', (e) => {
      if (e.target === modal) document.body.removeChild(modal);
    });
  },

  _deletePptSlide(index) {
    const pb = this._pptBuilder;
    const slide = pb?.slides?.[index];
    if (slide?.linkedFrom) {
      this._showToast('共享页面不能单独删除，请先断开引用', true);
      return;
    }
    if ((pb?.manifest?.sharedGroups || []).some(group => (group.slideIds || []).includes(slide?.id))) {
      this._showToast('此页面是共享真源，请先取消共享', true);
      return;
    }
    if (!confirm('确定删除此页面？')) return;
    pb.slides.splice(index, 1);
    pb.manifestDirty = true;
    if (pb.currentSlideIndex >= pb.slides.length) {
      pb.currentSlideIndex = pb.slides.length - 1;
    }
    this._renderPptBuilderInContent();
  },

  _refreshPptBuilder() {
    const modal = document.getElementById('ppt-builder-modal');
    if (!modal) return;

    // Update page list
    const pageList = modal.querySelector('#ppt-page-list');
    if (pageList) {
      pageList.innerHTML = this._renderPageList();
    }

    // Update editor
    const pageEditor = modal.querySelector('#ppt-page-editor');
    if (pageEditor) {
      pageEditor.innerHTML = this._renderPageEditor();
    }

    // Rebind events
    this._bindPageListEvents(modal);
  },

  _bindPptSlideDrag() {
    const items = document.querySelectorAll('.ppt-slide-item');
    let dragSrc = null;

    items.forEach(item => {
      item.addEventListener('dragstart', (e) => {
        dragSrc = parseInt(item.dataset.index);
        if (this._pptBuilder?.slides?.[dragSrc]?.linkedFrom) {
          e.preventDefault();
          dragSrc = null;
          this._showToast('共享页面组请在“共享页面”中整组移动', true);
          return;
        }
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
          if (pb.slides[destIndex]?.linkedFrom) {
            this._showToast('共享页面组请在“共享页面”中整组移动', true);
            dragSrc = null;
            return;
          }
          const [moved] = pb.slides.splice(dragSrc, 1);
          pb.slides.splice(destIndex, 0, moved);
          this._refreshPptBuilder();
        }
        dragSrc = null;
      });
    });
  },

  async _savePptExtra(modal) {
    const pb = this._pptBuilder;
    if (!pb) return;

    // 保存当前正在编辑的页面内容
    const currentTitleInput = document.getElementById('ppt-current-title');
    const currentHtmlTextarea = document.getElementById('ppt-current-html');
    if (currentTitleInput && currentHtmlTextarea && pb.slides[pb.currentSlideIndex]) {
      pb.slides[pb.currentSlideIndex].title = currentTitleInput.value.trim() || '未命名';
      pb.slides[pb.currentSlideIndex].html = currentHtmlTextarea.value;
    }

    // Try to get title from various sources
    let newTitle = '幻灯片';
    const titleInput = document.getElementById('ppt-builder-title');
    if (titleInput) {
      newTitle = titleInput.value.trim() || '幻灯片';
    } else {
      const editorTitle = document.getElementById('ppte-editor-title');
      if (editorTitle) {
        newTitle = pb.manifest.title || '幻灯片';
      }
    }

    if (pb.manifest.title !== newTitle) {
      pb.manifest.title = newTitle;
      pb.manifestDirty = true;
    }

    try {
      const result = await this._savePptBuilderData(pb);
      if (result.cancelled) return;

      this._showToast('已保存');
      if (modal) {
        this._closePptBuilder(modal);
      }
    } catch (e) {
      console.error('save_ppt_extra error:', e);
      this._showToast('保存失败', true);
    }
  },

  /** Return a clean manifest object (no runtime `html` field) for serialization */
  _cleanManifestObject(manifest) {
    const clean = {};
    for (const [key, value] of Object.entries(manifest || {})) {
      if (key.startsWith('_')) continue;
      if (key === 'slides') continue;
      clean[key] = value;
    }
    clean.slides = (manifest.slides || []).map(slide => {
      const result = {};
      for (const [key, value] of Object.entries(slide || {})) {
        if (['html', 'dirty', 'created'].includes(key) || key.startsWith('_')) continue;
        result[key] = value;
      }
      return result;
    });
    return clean;
  },

  /** Return a clean manifest object (no runtime `html` field) for serialization */
  _cleanManifestJson(manifest) {
    return JSON.stringify(this._cleanManifestObject(manifest), null, 2);
  },

  _showToast(message, isError = false) {
    const toast = document.createElement('div');
    toast.textContent = message;
    toast.style.cssText = `position:fixed;top:20px;right:20px;padding:8px 16px;border-radius:4px;background:${isError ? 'rgba(231,76,60,0.9)' : 'rgba(46,204,113,0.9)'};color:#fff;font-size:13px;z-index:10000;box-shadow:0 2px 6px rgba(0,0,0,0.2);`;
    document.body.appendChild(toast);
    setTimeout(() => document.body.removeChild(toast), 1000);
  },

  _generateSlideHtml(title, slideType) {
    const pb = this._pptBuilder;
    const templateFiles = pb && pb.templateFiles;
    const escapedTitle = this._escapeHtml(title);

    // Check if we have a template for this slide type
    if (templateFiles && templateFiles[slideType]) {
      let html = templateFiles[slideType];
      // Get CSS content if available
      const cssKey = slideType + '_css';
      const cssContent = templateFiles[cssKey];

      // Replace placeholder title with actual title
      html = html.replace(/标题|PLACEHOLDER_TITLE/g, escapedTitle);

      // Inject CSS inline if available
      if (cssContent) {
        // Replace <link rel="stylesheet" href="..."> with inline <style>
        html = html.replace(/<link[^>]*rel=["']stylesheet["'][^>]*>/g, '');
        html = html.replace(/<\/head>/, `<style>${cssContent}</style></head>`);
      }

      return html;
    }

    // Fallback to default templates
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
    this._stopPptEditorWatch();
    this._pptBuilder = null;
    if (modal && modal.parentNode) {
      modal.parentNode.removeChild(modal);
    }
  },

  _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  },

  _addAiMessage(container, role, content) {
    const msg = document.createElement('div');
    msg.style.cssText = `display:flex;gap:8px;${role === 'user' ? 'justify-content:flex-end;' : ''}`;
    msg.innerHTML = `
      <div style="max-width:80%;padding:12px 16px;border-radius:12px;background:${role === 'user' ? 'var(--accent)' : 'var(--bg-secondary)'};color:${role === 'user' ? '#fff' : 'var(--text-primary)'};font-size:14px;line-height:1.6;box-shadow:0 2px 4px rgba(0,0,0,0.1);">
        <div class="ai-msg-content"></div>
      </div>
    `;
    container.appendChild(msg);
    const contentDiv = msg.querySelector('.ai-msg-content');
    if (content) {
      this._renderAiContent(contentDiv, content, role);
    }
    container.scrollTop = container.scrollHeight;
    return msg;
  },

  _renderAiContent(contentDiv, text, role) {
    if (role === 'user') {
      contentDiv.style.whiteSpace = 'pre-wrap';
      contentDiv.textContent = text;
      return;
    }

    const codeMatch = text.match(/```html\n([\s\S]*?)\n```/);
    if (codeMatch) {
      const htmlCode = codeMatch[1];
      const beforeCode = text.substring(0, codeMatch.index);
      const afterCode = text.substring(codeMatch.index + codeMatch[0].length);

      contentDiv.innerHTML = '';

      if (beforeCode.trim()) {
        const beforeDiv = document.createElement('div');
        beforeDiv.innerHTML = window.marked ? window.marked.parse(beforeCode) : beforeCode;
        contentDiv.appendChild(beforeDiv);
      }

      const codeBlock = document.createElement('div');
      codeBlock.style.cssText = 'margin:8px 0;';
      const pre = document.createElement('pre');
      pre.style.cssText = 'background:var(--bg-tertiary);padding:12px;border-radius:6px;overflow-x:auto;margin:0;border:1px solid var(--border);';
      const code = document.createElement('code');
      code.className = 'language-html';
      code.textContent = htmlCode;
      pre.appendChild(code);
      codeBlock.appendChild(pre);

      if (window.hljs) {
        window.hljs.highlightElement(code);
      }

      const btn = document.createElement('button');
      btn.textContent = '应用此代码';
      btn.style.cssText = 'margin-top:8px;padding:6px 12px;border-radius:4px;border:1px solid var(--accent);background:transparent;color:var(--accent);cursor:pointer;font-size:12px;';

      const pb = this._pptBuilder;
      const self = this;
      btn.onclick = function() {
        if (confirm('确定要替换当前页面的HTML代码吗？')) {
          pb.slides[pb.currentSlideIndex].html = htmlCode;
          self._renderPptBuilderInContent();
        }
      };
      codeBlock.appendChild(btn);
      contentDiv.appendChild(codeBlock);

      if (afterCode.trim()) {
        const afterDiv = document.createElement('div');
        afterDiv.innerHTML = window.marked ? window.marked.parse(afterCode) : afterCode;
        contentDiv.appendChild(afterDiv);
      }
    } else {
      contentDiv.innerHTML = window.marked ? window.marked.parse(text) : text.replace(/\n/g, '<br>');
    }
  },

  async _callAi(appConfig, userMsg, currentHtml) {
    const provider = appConfig.aiProvider;
    const apiKey = provider === 'lectureai'
        ? (window.Auth?.getToken() || '')
        : appConfig.aiApiKey;

    const systemPrompt = `你是一个HTML幻灯片编辑助手。用户会告诉你如何修改当前页面,你需要返回修改后的完整HTML代码。
当前页面HTML:
\`\`\`html
${currentHtml}
\`\`\`

请根据用户要求修改HTML,并用\`\`\`html\`\`\`包裹返回完整代码。`;

    try {
      Tracker.track('ai_call', provider);
      const result = await window.__TAURI__.core.invoke('call_ai', {
        provider,
        apiKey,
        apiType: appConfig.aiApiType,
        baseUrl: appConfig.aiBaseUrl,
        model: appConfig.aiModel,
        systemPrompt,
        userMsg
      });
      return result;
    } catch (e) {
      throw new Error(`AI调用失败: ${e}`);
    }
  },

  _showReorderModal() {
    const pb = this._pptBuilder;
    if (!pb) return;

    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:3100;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;';
    modal.innerHTML = `
      <div style="background:var(--bg-primary);border-radius:12px;width:500px;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.4);">
        <div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;">
          <span style="font-weight:600;font-size:16px;">调整页面顺序</span>
          <button id="reorder-close" style="background:none;border:none;color:var(--text-muted);font-size:20px;cursor:pointer;">✕</button>
        </div>
        <div id="reorder-list" style="flex:1;overflow-y:auto;padding:12px;"></div>
        <div style="padding:16px 20px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;">
          <button id="reorder-done" style="padding:8px 16px;border-radius:6px;border:none;background:var(--accent);color:#fff;cursor:pointer;">完成</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    this._renderReorderList();

    const close = () => {
      document.body.removeChild(modal);
      this._renderPptBuilderInContent();
    };
    document.getElementById('reorder-close').onclick = close;
    document.getElementById('reorder-done').onclick = close;
    modal.onclick = (e) => {
      if (e.target === modal) close();
    };
  },

  _showAiChat() {
    const pb = this._pptBuilder;
    if (!pb) return;

    const appConfig = CourseLoader.appConfig || {};
    if (!appConfig.aiProvider || (appConfig.aiProvider !== 'lectureai' && !appConfig.aiApiKey)) {
      alert('请先在开发者设置中配置AI');
      return;
    }

    if (appConfig.aiProvider === 'custom' && (!appConfig.aiBaseUrl || !appConfig.aiApiType)) {
      alert('请先在开发者设置中配置自定义 AI 的 API 类型和 Base URL');
      return;
    }

    if (!pb.chatHistory) pb.chatHistory = {};
    if (!pb.chatHistory[pb.currentSlideIndex]) pb.chatHistory[pb.currentSlideIndex] = [];

    const sidebar = document.createElement('div');
    sidebar.id = 'ai-sidebar';
    sidebar.style.cssText = 'position:fixed;top:0;right:-500px;width:500px;height:100vh;background:var(--bg-primary);border-left:1px solid var(--border);z-index:3100;display:flex;flex-direction:column;transition:right 0.3s ease;box-shadow:-4px 0 20px rgba(0,0,0,0.2);';
    sidebar.innerHTML = `
      <div style="padding:16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;">
        <span style="font-weight:600;">AI助手</span>
        <button id="ai-close" style="background:none;border:none;color:var(--text-muted);font-size:20px;cursor:pointer;">✕</button>
      </div>
      <div id="ai-messages" style="flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px;"></div>
      <div style="padding:16px;border-top:1px solid var(--border);">
        <div style="display:flex;gap:8px;">
          <input type="text" id="ai-input" placeholder="告诉AI如何修改..." style="flex:1;padding:10px;border:1px solid var(--border);border-radius:6px;background:var(--bg-secondary);color:var(--text-primary);">
          <button id="ai-send" style="padding:10px 20px;border-radius:6px;border:none;background:var(--accent);color:#fff;cursor:pointer;">发送</button>
        </div>
      </div>
    `;

    document.body.appendChild(sidebar);
    setTimeout(() => sidebar.style.right = '0', 10);

    const close = () => {
      sidebar.style.right = '-500px';
      setTimeout(() => document.body.removeChild(sidebar), 300);
    };
    document.getElementById('ai-close').onclick = close;

    const input = document.getElementById('ai-input');
    const sendBtn = document.getElementById('ai-send');
    const messagesDiv = document.getElementById('ai-messages');

    const history = pb.chatHistory[pb.currentSlideIndex];
    history.forEach(msg => this._addAiMessage(messagesDiv, msg.role, msg.content));

    const sendMessage = async () => {
      const userMsg = input.value.trim();
      if (!userMsg) return;

      input.value = '';
      sendBtn.disabled = true;
      input.disabled = true;

      this._addAiMessage(messagesDiv, 'user', userMsg);
      history.push({ role: 'user', content: userMsg });

      const assistantMsg = this._addAiMessage(messagesDiv, 'assistant', '');
      const contentDiv = assistantMsg.querySelector('.ai-msg-content');
      let fullText = '';
      let renderTimer = null;

      try {
        const unlisten = await window.__TAURI__.event.listen('ai-stream-chunk', (event) => {
          fullText += event.payload;

          if (renderTimer) clearTimeout(renderTimer);
          renderTimer = setTimeout(() => {
            this._renderAiContent(contentDiv, fullText, 'assistant');
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
          }, 50);
        });

        await window.__TAURI__.event.listen('ai-stream-done', () => {
          unlisten();
          if (renderTimer) clearTimeout(renderTimer);
          history.push({ role: 'assistant', content: fullText });
          this._renderAiContent(contentDiv, fullText, 'assistant');
          sendBtn.disabled = false;
          input.disabled = false;
          input.focus();
        });

        Tracker.track('ai_call', appConfig.aiProvider);
        await window.__TAURI__.core.invoke('call_ai_stream', {
          provider: appConfig.aiProvider,
          apiKey: appConfig.aiProvider === 'lectureai' ? (window.Auth?.getToken() || '') : appConfig.aiApiKey,
          apiType: appConfig.aiApiType,
          baseUrl: appConfig.aiBaseUrl,
          model: appConfig.aiModel,
          systemPrompt: `你是HTML幻灯片编辑助手。当前页面:\n\`\`\`html\n${pb.slides[pb.currentSlideIndex].html}\n\`\`\`\n\n请根据用户要求修改HTML,用\`\`\`html\`\`\`包裹返回完整代码。`,
          userMsg
        });
      } catch (e) {
        const errMsg = String(e);
        contentDiv.textContent = errMsg;
        contentDiv.style.color = 'var(--text-muted)';
        history.push({ role: 'assistant', content: errMsg });
        sendBtn.disabled = false;
        input.disabled = false;
      }
    };

    sendBtn.onclick = sendMessage;
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    };

    input.focus();
  },

  _renderReorderList() {
    const pb = this._pptBuilder;
    const container = document.getElementById('reorder-list');
    container.innerHTML = pb.slides.map((slide, idx) => `
      <div class="reorder-item" data-index="${idx}" style="display:flex;align-items:center;gap:12px;padding:12px;background:var(--bg-secondary);border-radius:8px;margin-bottom:8px;border:1px solid var(--border);">
        <span style="cursor:grab;color:var(--text-muted);font-size:16px;">⠿</span>
        <span style="font-weight:600;min-width:30px;">${idx + 1}</span>
        <span style="flex:1;">${this._escapeHtml(slide.title)}</span>
        <div style="display:flex;gap:4px;">
          <button class="btn-up" data-index="${idx}" style="padding:4px 8px;border:none;background:var(--bg-hover);color:var(--text-primary);cursor:pointer;border-radius:4px;" ${idx === 0 ? 'disabled style="opacity:0.3;"' : ''}>▲</button>
          <button class="btn-down" data-index="${idx}" style="padding:4px 8px;border:none;background:var(--bg-hover);color:var(--text-primary);cursor:pointer;border-radius:4px;" ${idx === pb.slides.length - 1 ? 'disabled style="opacity:0.3;"' : ''}>▼</button>
        </div>
      </div>
    `).join('');

    // Bind events
    container.querySelectorAll('.btn-up').forEach(btn => {
      btn.onclick = () => {
        const idx = parseInt(btn.dataset.index);
        if (pb.slides[idx]?.linkedFrom || pb.slides[idx - 1]?.linkedFrom) {
          this._showToast('共享页面组请在“共享页面”中整组移动', true);
          return;
        }
        if (idx > 0) {
          [pb.slides[idx - 1], pb.slides[idx]] = [pb.slides[idx], pb.slides[idx - 1]];
          this._renderReorderList();
        }
      };
    });

    container.querySelectorAll('.btn-down').forEach(btn => {
      btn.onclick = () => {
        const idx = parseInt(btn.dataset.index);
        if (pb.slides[idx]?.linkedFrom || pb.slides[idx + 1]?.linkedFrom) {
          this._showToast('共享页面组请在“共享页面”中整组移动', true);
          return;
        }
        if (idx < pb.slides.length - 1) {
          [pb.slides[idx], pb.slides[idx + 1]] = [pb.slides[idx + 1], pb.slides[idx]];
          this._renderReorderList();
        }
      };
    });
  },

  _editPptConfig() {
    const pb = this._pptBuilder;
    if (!pb) return;

    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:3100;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;';

    const configText = this._cleanManifestJson(pb.manifest);

    modal.innerHTML = `
      <div style="background:var(--bg-primary);border-radius:12px;width:90%;max-width:900px;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.4);">
        <div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;">
          <div>
            <div style="font-weight:600;font-size:16px;">编辑配置文件</div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">manifest.json - 修改后点击保存生效</div>
          </div>
          <button id="config-close" style="background:none;border:none;color:var(--text-muted);font-size:20px;cursor:pointer;">✕</button>
        </div>
        <div style="flex:1;overflow:auto;padding:20px;background:var(--bg-secondary);">
          <textarea id="config-editor" style="width:100%;min-height:500px;padding:16px;border:1px solid var(--border);border-radius:8px;background:var(--bg-tertiary);color:var(--text-primary);font-family:'Monaco','Menlo','Courier New',monospace;font-size:13px;line-height:1.6;resize:vertical;box-sizing:border-box;tab-size:2;">${this._escapeHtml(configText)}</textarea>
        </div>
        <div style="padding:16px 20px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;">
          <div style="font-size:13px;color:var(--text-muted);">提示：修改title、slides数组等字段</div>
          <div style="display:flex;gap:12px;">
            <button id="config-cancel" style="padding:8px 16px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;">取消</button>
            <button id="config-save" style="padding:8px 16px;border-radius:6px;border:none;background:var(--accent);color:#fff;cursor:pointer;">保存</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    const close = () => document.body.removeChild(modal);
    document.getElementById('config-close').onclick = close;
    document.getElementById('config-cancel').onclick = close;
    document.getElementById('config-save').onclick = () => {
      try {
        const newManifest = JSON.parse(document.getElementById('config-editor').value);
        // Build a map of file -> html from old slides to restore runtime html content
        const htmlMap = {};
        for (const s of (pb.slides || [])) {
          if (s.file && s.html !== undefined) htmlMap[s.file] = s.html;
        }
        pb.manifest = newManifest;
        pb.slides = newManifest.slides || [];
        pb.manifestDirty = true;
        // Restore in-memory html for slides that still reference the same file
        for (const s of pb.slides) {
          if (s.file && s.file in htmlMap) s.html = htmlMap[s.file];
          s.dirty = true;
        }
        if (pb.currentSlideIndex >= pb.slides.length) {
          pb.currentSlideIndex = Math.max(0, pb.slides.length - 1);
        }
        this._renderPptBuilderInContent();
        close();
      } catch (e) {
        alert('JSON格式错误: ' + e.message);
      }
    };

    modal.onclick = (e) => {
      if (e.target === modal) close();
    };
  },

  _bindPageListDrag() {
    const container = document.getElementById('ppte-page-items');
    if (!container || container.dataset.dragBound) return;
    container.dataset.dragBound = 'true';

    let dragState = null; // { srcIndex, ghost, indicator }

    const getItemAtY = (y) => {
      const items = container.querySelectorAll('li');
      for (const li of items) {
        const rect = li.getBoundingClientRect();
        if (y >= rect.top && y <= rect.bottom) {
          const mid = rect.top + rect.height / 2;
          return { li, index: parseInt(li.dataset.index), above: y < mid };
        }
      }
      // Below all items — target last item, insert below
      if (items.length > 0) {
        const last = items[items.length - 1];
        return { li: last, index: parseInt(last.dataset.index), above: false };
      }
      return null;
    };

    const onMouseMove = (e) => {
      if (!dragState) return;
      e.preventDefault();

      // Move ghost
      dragState.ghost.style.top = (e.clientY - dragState.offsetY) + 'px';
      dragState.ghost.style.left = (e.clientX - dragState.offsetX) + 'px';

      // Update indicator
      const target = getItemAtY(e.clientY);
      container.querySelectorAll('li').forEach(li => {
        li.classList.remove('drag-over-above', 'drag-over-below');
      });
      if (target && target.index !== dragState.srcIndex) {
        target.li.classList.add(target.above ? 'drag-over-above' : 'drag-over-below');
      }
    };

    const onMouseUp = (e) => {
      if (!dragState) return;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);

      // Clean up ghost
      if (dragState.ghost.parentNode) dragState.ghost.parentNode.removeChild(dragState.ghost);

      // Clean up indicators and dragging class
      container.querySelectorAll('li').forEach(li => {
        li.classList.remove('dragging', 'drag-over-above', 'drag-over-below');
      });

      // Perform reorder
      const target = getItemAtY(e.clientY);
      if (target && target.index !== dragState.srcIndex) {
        let destIndex = target.index;
        const srcIndex = dragState.srcIndex;
        // Adjust destination for above/below
        if (!target.above && destIndex < srcIndex) destIndex++;
        else if (target.above && destIndex > srcIndex) destIndex--;

        const pb = this._pptBuilder;
        if (pb.slides[srcIndex]?.linkedFrom || pb.slides[target.index]?.linkedFrom) {
          this._showToast('共享页面组请在“共享页面”中整组移动', true);
          dragState = null;
          return;
        }
        const [moved] = pb.slides.splice(srcIndex, 1);
        pb.slides.splice(destIndex, 0, moved);
        pb.manifestDirty = true;
        pb.currentSlideIndex = destIndex;
        this._renderPptBuilderInContent();
      }

      dragState = null;
    };

    container.addEventListener('mousedown', (e) => {
      const handle = e.target.closest('.drag-handle');
      if (!handle) return;
      const li = handle.closest('li');
      if (!li) return;

      e.preventDefault();
      const srcIndex = parseInt(li.dataset.index);
      if (this._pptBuilder?.slides?.[srcIndex]?.linkedFrom) {
        this._showToast('共享页面组请在“共享页面”中整组移动', true);
        return;
      }
      const rect = li.getBoundingClientRect();

      // Create ghost element
      const ghost = li.cloneNode(true);
      ghost.classList.remove('active');
      ghost.style.cssText = `
        position: fixed;
        top: ${rect.top}px;
        left: ${rect.left}px;
        width: ${rect.width}px;
        height: ${rect.height}px;
        background: var(--bg-secondary);
        border: 1px solid var(--accent);
        border-radius: 6px;
        opacity: 0.85;
        z-index: 9999;
        pointer-events: none;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 12px 16px;
        font-size: 13px;
        color: var(--text-primary);
        box-sizing: border-box;
        list-style: none;
      `;
      document.body.appendChild(ghost);

      li.classList.add('dragging');

      dragState = {
        srcIndex,
        ghost,
        offsetY: e.clientY - rect.top,
        offsetX: e.clientX - rect.left,
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  },

  _escapeAttr(str) {
    return (str || '').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  },

  _normalizeManifestSlides(slides) {
    const rawSlides = Array.isArray(slides) ? slides : [];
    return rawSlides.map((slide, index) => {
      if (typeof slide === 'string') {
        return {
          id: this._newPpteId?.('slide') || `slide_${Date.now()}_${index}`,
          file: slide,
          title: `页面 ${index + 1}`,
          slide_type: 'content',
          html: '',
        };
      }
      return {
        ...slide,
        id: slide?.id || this._newPpteId?.('slide') || `slide_${Date.now()}_${index}`,
        file: slide?.file || `slide${String(index + 1).padStart(2, '0')}.html`,
        title: slide?.title || `页面 ${index + 1}`,
        slide_type: slide?.slide_type || 'content',
        html: slide?.html || '',
        dirty: !!slide?.dirty,
        created: !!slide?.created,
      };
    });
  },
};

if (window.Settings) {
  Object.assign(window.Settings, window.PpteEditor);
}
