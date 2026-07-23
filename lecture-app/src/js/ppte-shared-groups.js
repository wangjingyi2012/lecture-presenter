// ppte-shared-groups.js — Reusable slide groups with local snapshots and explicit updates.
window.PpteSharedGroups = {
  _newPpteId(prefix) {
    const random = globalThis.crypto?.randomUUID?.()
      || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
    return `${prefix}_${random.replace(/-/g, '')}`;
  },

  _ensurePpteStableIds(manifest) {
    if (!manifest || typeof manifest !== 'object') return false;
    let changed = false;
    if (!Number.isInteger(manifest.schemaVersion) || manifest.schemaVersion < 2) {
      manifest.schemaVersion = 2;
      changed = true;
    }
    if (!manifest.deckId) {
      manifest.deckId = this._newPpteId('deck');
      changed = true;
    }
    if (!Array.isArray(manifest.sharedGroups)) {
      manifest.sharedGroups = [];
      changed = true;
    }
    if (!Array.isArray(manifest.linkedGroups)) {
      manifest.linkedGroups = [];
      changed = true;
    }

    const seenSlideIds = new Set();
    for (const slide of (manifest.slides || [])) {
      if (!slide.id || seenSlideIds.has(slide.id)) {
        slide.id = this._newPpteId('slide');
        changed = true;
      }
      seenSlideIds.add(slide.id);
    }

    const seenGroupIds = new Set();
    for (const group of manifest.sharedGroups) {
      if (!group.id || seenGroupIds.has(group.id)) {
        group.id = this._newPpteId('group');
        changed = true;
      }
      seenGroupIds.add(group.id);
      if (!Array.isArray(group.slideIds)) {
        group.slideIds = [];
        changed = true;
      }
    }
    return changed;
  },

  _nextPpteSlideFile(pb) {
    const used = new Set((pb?.slides || []).map(slide => String(slide.file || '').replace(/\\/g, '/')));
    let max = 0;
    for (const file of used) {
      const match = file.match(/^slide(\d+)\.html?$/i);
      if (match) max = Math.max(max, Number(match[1]));
    }
    let candidate;
    do {
      max += 1;
      candidate = `slide${String(max).padStart(2, '0')}.html`;
    } while (used.has(candidate));
    return candidate;
  },

  _sharedGroupStatusLabel(state) {
    return {
      checking: '检查中',
      current: '最新',
      update_available: '有更新',
      local_modified: '本地已改',
      source_missing: '源失效',
      source_mismatch: '源不匹配',
      group_deleted: '源组已删',
      snapshot_broken: '副本损坏',
    }[state] || '共享';
  },

  _selectedSharedSlideIndexes(pb) {
    const selected = pb?.sharedSelection || new Set();
    if (selected.size === 0 && pb?.slides?.[pb.currentSlideIndex]) {
      return [pb.currentSlideIndex];
    }
    return (pb?.slides || [])
      .map((slide, index) => selected.has(slide.id) ? index : -1)
      .filter(index => index >= 0);
  },

  _indexesAreContiguous(indexes) {
    if (!indexes.length) return false;
    return indexes.every((index, position) => position === 0 || index === indexes[position - 1] + 1);
  },

  async _createSharedGroupFromSelection() {
    const pb = this._pptBuilder;
    if (!pb) return;
    this._markCurrentSlideFromEditor?.(pb);
    this._ensurePpteStableIds(pb.manifest);

    const indexes = this._selectedSharedSlideIndexes(pb);
    if (!this._indexesAreContiguous(indexes)) {
      alert('共享页面组必须是一张页面，或一组连续页面。');
      return;
    }
    const slides = indexes.map(index => pb.slides[index]);
    if (slides.some(slide => slide.linkedFrom)) {
      alert('引用自其他 PPTE 的页面不能再次设为真源，请先断开引用。');
      return;
    }
    const slideIds = slides.map(slide => slide.id);
    const duplicate = (pb.manifest.sharedGroups || []).find(group =>
      JSON.stringify(group.slideIds || []) === JSON.stringify(slideIds));
    if (duplicate) {
      this._showToast(`这些页面已经属于共享组“${duplicate.name}”`);
      return;
    }

    const defaultName = slides.length === 1
      ? slides[0].title
      : `${slides[0].title} 等 ${slides.length} 页`;
    const name = prompt('给这组共享页面起一个名称：', defaultName);
    if (!name?.trim()) return;

    pb.manifest.sharedGroups.push({
      id: this._newPpteId('group'),
      name: name.trim(),
      slideIds,
      createdAt: new Date().toISOString(),
    });
    pb.manifestDirty = true;
    pb.sharedSelection.clear();
    const result = await this._savePptBuilderData(pb);
    if (result.cancelled) return;
    this._renderPptBuilderInContent();
    this._showToast(`已创建共享页面组：${name.trim()}`);
  },

  async _readPpteManifest(folderPath) {
    const content = await window.__TAURI__.core.invoke('read_text_file', {
      filePath: `${String(folderPath).replace(/[\\/]+$/, '')}/manifest.json`,
    });
    return JSON.parse(content);
  },

  _createSharedModal(title, bodyHtml, options = {}) {
    const modal = document.createElement('div');
    modal.className = 'ppte-shared-modal';
    modal.innerHTML = `
      <div class="ppte-shared-dialog">
        <div class="ppte-shared-dialog-header">
          <strong>${this._escapeHtml(title)}</strong>
          <button type="button" class="ppte-editor-button ppte-editor-button-compact" data-shared-close>关闭</button>
        </div>
        <div class="ppte-shared-dialog-body">${bodyHtml}</div>
        ${options.footerHtml ? `<div class="ppte-shared-dialog-footer">${options.footerHtml}</div>` : ''}
      </div>`;
    const close = () => modal.remove();
    modal.querySelector('[data-shared-close]').onclick = close;
    modal.onclick = event => {
      if (event.target === modal) close();
    };
    document.body.appendChild(modal);
    return { modal, close };
  },

  async _showInsertSharedGroupModal() {
    if (!window.__TAURI__) {
      alert('此功能需要在桌面应用中运行。');
      return;
    }
    const pb = this._pptBuilder;
    if (!pb) return;
    const recent = (CourseLoader.appConfig?.recentPpte || [])
      .filter(item => item.path && item.path !== pb.folderPath);
    const sources = (await Promise.all(recent.map(async item => {
      try {
        const manifest = await this._readPpteManifest(item.path);
        return Array.isArray(manifest.sharedGroups) && manifest.sharedGroups.length
          ? { ...item, manifest }
          : null;
      } catch (_) {
        return null;
      }
    }))).filter(Boolean);

    const listHtml = sources.length
      ? sources.map((source, index) => `
          <button type="button" class="ppte-shared-card" data-source-index="${index}" style="text-align:left;cursor:pointer;color:inherit;">
            <span class="ppte-shared-card-title">${this._escapeHtml(source.title || source.manifest.title || '未命名 PPTE')}</span>
            <span class="ppte-shared-card-meta">${this._escapeHtml(source.path)}</span>
            <span class="ppte-shared-card-meta">${source.manifest.sharedGroups.length} 个共享页面组</span>
          </button>`).join('')
      : '<div class="ppte-shared-empty">最近打开的 PPTE 中还没有共享页面组。</div>';

    const { modal, close } = this._createSharedModal('插入共享页面组', `
      <div class="ppte-shared-list">${listHtml}</div>`, {
      footerHtml: '<button type="button" class="ppte-editor-button" data-browse-source>浏览其他 PPTE</button>',
    });

    modal.querySelectorAll('[data-source-index]').forEach(button => {
      button.onclick = async () => {
        const source = sources[Number(button.dataset.sourceIndex)];
        close();
        await this._chooseSharedGroupFromSource(source.path, source.manifest);
      };
    });
    modal.querySelector('[data-browse-source]').onclick = async () => {
      try {
        const sourcePath = await window.__TAURI__.core.invoke('pick_folder');
        if (!sourcePath) return;
        const manifest = await this._readPpteManifest(sourcePath);
        close();
        await this._chooseSharedGroupFromSource(sourcePath, manifest);
      } catch (error) {
        if (String(error) !== 'cancelled') alert(`无法打开源 PPTE：${error}`);
      }
    };
  },

  async _chooseSharedGroupFromSource(sourcePath, manifest) {
    const pb = this._pptBuilder;
    if (!pb) return;
    this._ensurePpteStableIds(manifest);
    if (sourcePath === pb.folderPath || manifest.deckId === pb.manifest.deckId) {
      alert('不能把当前 PPTE 作为自己的共享页面来源。');
      return;
    }
    const groups = manifest.sharedGroups || [];
    if (!groups.length) {
      alert('这个 PPTE 还没有共享页面组。请先打开源 PPTE，勾选页面并点击“共享所选”。');
      return;
    }
    const existing = new Set((pb.manifest.linkedGroups || [])
      .map(link => `${link.sourceDeckId}:${link.groupId}`));
    const available = groups.filter(group => !existing.has(`${manifest.deckId}:${group.id}`));
    if (!available.length) {
      alert('这个 PPTE 的共享页面组都已经插入当前课件。');
      return;
    }
    if (available.length === 1) {
      await this._insertSharedGroup(sourcePath, available[0].id);
      return;
    }

    const { modal, close } = this._createSharedModal('选择页面组', `
      <div class="ppte-shared-list">
        ${available.map((group, index) => `
          <button type="button" class="ppte-shared-card" data-group-index="${index}" style="text-align:left;cursor:pointer;color:inherit;">
            <span class="ppte-shared-card-title">${this._escapeHtml(group.name || '未命名页面组')}</span>
            <span class="ppte-shared-card-meta">${(group.slideIds || []).length} 页</span>
          </button>`).join('')}
      </div>`);
    modal.querySelectorAll('[data-group-index]').forEach(button => {
      button.onclick = async () => {
        const group = available[Number(button.dataset.groupIndex)];
        close();
        await this._insertSharedGroup(sourcePath, group.id);
      };
    });
  },

  async _insertSharedGroup(sourcePath, groupId) {
    const pb = this._pptBuilder;
    if (!pb) return;
    this._showToast('正在创建共享页面快照...');
    try {
      const snapshot = await window.__TAURI__.core.invoke('ppte_shared_group_snapshot', {
        sourcePath,
        targetPath: pb.folderPath,
        groupId,
      });
      const targetSlides = [];
      for (const sourceSlide of snapshot.slides || []) {
        const html = await window.__TAURI__.core.invoke('read_text_file', {
          filePath: `${pb.folderPath}/${sourceSlide.targetFile}`,
        });
        targetSlides.push({
          id: this._newPpteId('slide'),
          file: sourceSlide.targetFile,
          title: sourceSlide.title,
          slide_type: sourceSlide.slideType || 'content',
          linkedFrom: { groupId: snapshot.groupId, sourceSlideId: sourceSlide.sourceSlideId },
          html,
          dirty: false,
          created: false,
        });
      }
      const insertAt = Math.min((pb.currentSlideIndex ?? pb.slides.length - 1) + 1, pb.slides.length);
      pb.slides.splice(insertAt, 0, ...targetSlides);
      pb.manifest.slides = pb.slides;
      if (!Array.isArray(pb.manifest.linkedGroups)) pb.manifest.linkedGroups = [];
      pb.manifest.linkedGroups.push({
        groupId: snapshot.groupId,
        name: snapshot.name,
        sourceDeckId: snapshot.sourceDeckId,
        sourcePath,
        sourceContentHash: snapshot.contentHash,
        snapshotHash: snapshot.snapshotHash,
        snapshotRoot: snapshot.snapshotRoot,
        targetSlideIds: targetSlides.map(slide => slide.id),
        syncedAt: new Date().toISOString(),
      });
      pb.currentSlideIndex = insertAt;
      pb.manifestDirty = true;
      const result = await this._savePptBuilderData(pb);
      if (result.cancelled) return;
      pb.linkedGroupStatuses[snapshot.groupId] = { state: 'current' };
      this._renderPptBuilderInContent();
      this._showToast(`已插入共享页面组：${snapshot.name}`);
    } catch (error) {
      console.error('Insert shared PPTE group failed:', error);
      alert(`插入共享页面组失败：${error}`);
    }
  },

  async _checkLinkedGroups(options = {}) {
    const pb = this._pptBuilder;
    if (!pb || !window.__TAURI__) return;
    const links = pb.manifest.linkedGroups || [];
    if (!links.length) return;
    if (!pb.linkedGroupStatuses) pb.linkedGroupStatuses = {};

    for (const link of links) {
      pb.linkedGroupStatuses[link.groupId] = { state: 'checking' };
      try {
        const info = await window.__TAURI__.core.invoke('ppte_shared_group_inspect', {
          sourcePath: link.sourcePath,
          groupId: link.groupId,
        });
        if (info.sourceDeckId !== link.sourceDeckId) {
          pb.linkedGroupStatuses[link.groupId] = { state: 'source_mismatch' };
          continue;
        }
        let snapshotHash;
        try {
          snapshotHash = await window.__TAURI__.core.invoke('ppte_shared_snapshot_hash', {
            targetPath: pb.folderPath,
            snapshotRoot: link.snapshotRoot,
          });
        } catch (_) {
          pb.linkedGroupStatuses[link.groupId] = { state: 'snapshot_broken', info };
          continue;
        }
        if (snapshotHash !== link.snapshotHash) {
          pb.linkedGroupStatuses[link.groupId] = {
            state: 'local_modified',
            info,
            sourceUpdated: info.contentHash !== link.sourceContentHash,
          };
        } else if (info.contentHash !== link.sourceContentHash) {
          pb.linkedGroupStatuses[link.groupId] = { state: 'update_available', info };
        } else {
          pb.linkedGroupStatuses[link.groupId] = { state: 'current', info };
        }
      } catch (error) {
        const message = String(error);
        pb.linkedGroupStatuses[link.groupId] = {
          state: message.includes('GROUP_NOT_FOUND') ? 'group_deleted' : 'source_missing',
          error: message,
        };
      }
    }
    this._renderPptBuilderInContent();
    if (!options.silent) {
      const updates = Object.values(pb.linkedGroupStatuses)
        .filter(status => ['update_available', 'local_modified', 'snapshot_broken'].includes(status.state)).length;
      this._showToast(updates ? `检查完成：${updates} 个页面组需要处理` : '所有共享页面均为最新');
    }
  },

  _linkedGroupById(groupId) {
    return (this._pptBuilder?.manifest?.linkedGroups || []).find(link => link.groupId === groupId);
  },

  async _syncLinkedGroup(groupId) {
    const pb = this._pptBuilder;
    const link = this._linkedGroupById(groupId);
    if (!pb || !link) return;
    const status = pb.linkedGroupStatuses?.[groupId];
    if (status?.state === 'local_modified') {
      const overwrite = confirm('目标课件中的共享副本已被修改。继续同步会用源版本覆盖这些修改。\n\n确定覆盖吗？');
      if (!overwrite) return;
    } else if (!confirm(`从源 PPTE 同步“${link.name || '共享页面组'}”？`)) {
      return;
    }

    try {
      const snapshot = await window.__TAURI__.core.invoke('ppte_shared_group_snapshot', {
        sourcePath: link.sourcePath,
        targetPath: pb.folderPath,
        groupId,
      });
      const oldSlides = pb.slides.filter(slide => link.targetSlideIds.includes(slide.id));
      const oldIdBySource = new Map(oldSlides.map(slide => [slide.linkedFrom?.sourceSlideId, slide.id]));
      const oldIndexes = pb.slides
        .map((slide, index) => link.targetSlideIds.includes(slide.id) ? index : -1)
        .filter(index => index >= 0);
      const insertAt = oldIndexes.length ? Math.min(...oldIndexes) : Math.min(pb.currentSlideIndex + 1, pb.slides.length);
      pb.slides = pb.slides.filter(slide => !link.targetSlideIds.includes(slide.id));

      const nextSlides = [];
      for (const sourceSlide of snapshot.slides || []) {
        const html = await window.__TAURI__.core.invoke('read_text_file', {
          filePath: `${pb.folderPath}/${sourceSlide.targetFile}`,
        });
        nextSlides.push({
          id: oldIdBySource.get(sourceSlide.sourceSlideId) || this._newPpteId('slide'),
          file: sourceSlide.targetFile,
          title: sourceSlide.title,
          slide_type: sourceSlide.slideType || 'content',
          linkedFrom: { groupId, sourceSlideId: sourceSlide.sourceSlideId },
          html,
          dirty: false,
          created: false,
        });
      }
      pb.slides.splice(Math.min(insertAt, pb.slides.length), 0, ...nextSlides);
      Object.assign(link, {
        name: snapshot.name,
        sourceContentHash: snapshot.contentHash,
        snapshotHash: snapshot.snapshotHash,
        snapshotRoot: snapshot.snapshotRoot,
        targetSlideIds: nextSlides.map(slide => slide.id),
        syncedAt: new Date().toISOString(),
      });
      pb.manifest.slides = pb.slides;
      pb.currentSlideIndex = Math.min(insertAt, Math.max(0, pb.slides.length - 1));
      pb.manifestDirty = true;
      const result = await this._savePptBuilderData(pb);
      if (result.cancelled) return;
      pb.linkedGroupStatuses[groupId] = { state: 'current' };
      this._renderPptBuilderInContent();
      this._showToast(`已同步：${snapshot.name}`);
      this._showSharedGroupsManager();
    } catch (error) {
      alert(`同步失败：${error}`);
    }
  },

  async _relinkSharedGroup(groupId) {
    const pb = this._pptBuilder;
    const link = this._linkedGroupById(groupId);
    if (!pb || !link) return;
    try {
      const sourcePath = await window.__TAURI__.core.invoke('pick_folder');
      if (!sourcePath) return;
      const info = await window.__TAURI__.core.invoke('ppte_shared_group_inspect', { sourcePath, groupId });
      if (info.sourceDeckId !== link.sourceDeckId) {
        alert('选择的 PPTE 不是原始真源，课件 ID 不匹配。');
        return;
      }
      link.sourcePath = sourcePath;
      pb.manifestDirty = true;
      await this._savePptBuilderData(pb);
      await this._checkLinkedGroups({ silent: true });
      this._showSharedGroupsManager();
    } catch (error) {
      if (String(error) !== 'cancelled') alert(`重新定位失败：${error}`);
    }
  },

  async _detachSharedGroup(groupId) {
    const pb = this._pptBuilder;
    const link = this._linkedGroupById(groupId);
    if (!pb || !link) return;
    if (!confirm(`断开“${link.name || '共享页面组'}”的引用？\n\n当前页面和资源会保留，但以后不再收到源更新。`)) return;
    for (const slide of pb.slides) {
      if (link.targetSlideIds.includes(slide.id)) delete slide.linkedFrom;
    }
    pb.manifest.linkedGroups = pb.manifest.linkedGroups.filter(item => item !== link);
    delete pb.linkedGroupStatuses[groupId];
    pb.manifestDirty = true;
    await this._savePptBuilderData(pb);
    this._renderPptBuilderInContent();
    this._showToast('已断开引用，页面副本已保留');
    this._showSharedGroupsManager();
  },

  async _removeSharedSourceGroup(groupId) {
    const pb = this._pptBuilder;
    const group = (pb?.manifest?.sharedGroups || []).find(item => item.id === groupId);
    if (!pb || !group) return;
    if (!confirm(`取消共享“${group.name || '未命名页面组'}”？\n\n已经插入其他 PPTE 的副本仍能播放，但以后会显示“源页面组已删除”。`)) return;
    pb.manifest.sharedGroups = pb.manifest.sharedGroups.filter(item => item !== group);
    pb.manifestDirty = true;
    await this._savePptBuilderData(pb);
    this._renderPptBuilderInContent();
    this._showSharedGroupsManager();
  },

  async _updateSharedSourceGroupFromSelection(groupId) {
    const pb = this._pptBuilder;
    const group = (pb?.manifest?.sharedGroups || []).find(item => item.id === groupId);
    if (!pb || !group) return;
    const indexes = (pb.slides || [])
      .map((slide, index) => pb.sharedSelection?.has(slide.id) ? index : -1)
      .filter(index => index >= 0);
    if (!indexes.length) {
      alert('请先在左侧勾选新的连续页面，再更新页面组。');
      return;
    }
    if (!this._indexesAreContiguous(indexes)) {
      alert('共享页面组必须是一组连续页面。');
      return;
    }
    const slides = indexes.map(index => pb.slides[index]);
    if (slides.some(slide => slide.linkedFrom)) {
      alert('引用自其他 PPTE 的页面不能成为真源。');
      return;
    }
    group.slideIds = slides.map(slide => slide.id);
    group.updatedAt = new Date().toISOString();
    pb.sharedSelection.clear();
    pb.manifestDirty = true;
    await this._savePptBuilderData(pb);
    this._renderPptBuilderInContent();
    this._showSharedGroupsManager();
    this._showToast(`已更新共享页面组：${group.name}`);
  },

  async _moveLinkedGroup(groupId, direction) {
    const pb = this._pptBuilder;
    if (!pb) return;
    const units = [];
    for (const slide of pb.slides) {
      const linkedGroupId = slide.linkedFrom?.groupId;
      const previous = units[units.length - 1];
      if (linkedGroupId && previous?.groupId === linkedGroupId) previous.slides.push(slide);
      else units.push({ groupId: linkedGroupId || null, slides: [slide] });
    }
    const index = units.findIndex(unit => unit.groupId === groupId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= units.length) return;
    [units[index], units[target]] = [units[target], units[index]];
    pb.slides = units.flatMap(unit => unit.slides);
    pb.manifest.slides = pb.slides;
    const link = this._linkedGroupById(groupId);
    pb.currentSlideIndex = Math.max(0, pb.slides.findIndex(slide => link?.targetSlideIds.includes(slide.id)));
    pb.manifestDirty = true;
    await this._savePptBuilderData(pb);
    this._renderPptBuilderInContent();
    this._showSharedGroupsManager();
  },

  async _showSharedGroupsManager() {
    document.querySelector('.ppte-shared-modal')?.remove();
    const pb = this._pptBuilder;
    if (!pb) return;
    const links = pb.manifest.linkedGroups || [];
    const sources = pb.manifest.sharedGroups || [];
    const sourceHtml = sources.length ? `
      <div style="margin-bottom:16px;">
        <div style="font-weight:600;margin-bottom:8px;">本课件是真源</div>
        <div class="ppte-shared-list">
          ${sources.map((group, index) => `<div class="ppte-shared-card" data-source-group-index="${index}">
            <div class="ppte-shared-card-title">${this._escapeHtml(group.name || '未命名页面组')}</div>
            <div class="ppte-shared-card-meta">${(group.slideIds || []).length} 页 · ${this._escapeHtml(group.id)}</div>
            <div class="ppte-shared-card-actions">
              <button class="ppte-editor-button" data-update-source-group>使用左侧勾选页面更新</button>
              <button class="ppte-editor-button ppte-editor-button-danger" data-remove-source-group>取消共享</button>
            </div>
          </div>`).join('')}
        </div>
      </div>` : '';
    const linkedHtml = links.length ? links.map((link, index) => {
      const status = pb.linkedGroupStatuses?.[link.groupId] || { state: 'checking' };
      return `<div class="ppte-shared-card" data-link-index="${index}">
        <div class="ppte-shared-card-title">${this._escapeHtml(link.name || '共享页面组')}</div>
        <div class="ppte-shared-card-meta">${this._escapeHtml(this._sharedGroupStatusLabel(status.state))} · ${link.targetSlideIds?.length || 0} 页</div>
        <div class="ppte-shared-card-meta" title="${this._escapeAttr(link.sourcePath || '')}">${this._escapeHtml(link.sourcePath || '')}</div>
        <div class="ppte-shared-card-actions">
          ${['update_available', 'local_modified', 'snapshot_broken'].includes(status.state) ? '<button class="ppte-editor-button ppte-editor-button-primary" data-sync>同步更新</button>' : ''}
          <button class="ppte-editor-button" data-relink>重新定位</button>
          <button class="ppte-editor-button" data-move-up>上移整组</button>
          <button class="ppte-editor-button" data-move-down>下移整组</button>
          <button class="ppte-editor-button ppte-editor-button-danger" data-detach>断开引用</button>
        </div>
      </div>`;
    }).join('') : '<div class="ppte-shared-empty">当前 PPTE 还没有引用其他共享页面组。</div>';

    const { modal } = this._createSharedModal('共享页面', `
      ${sourceHtml}
      <div style="font-weight:600;margin-bottom:8px;">引用的页面组</div>
      <div class="ppte-shared-list">${linkedHtml}</div>`, {
      footerHtml: '<button type="button" class="ppte-editor-button" data-check-updates>检查更新</button>',
    });
    modal.querySelector('[data-check-updates]').onclick = async () => {
      await this._checkLinkedGroups();
      this._showSharedGroupsManager();
    };
    modal.querySelectorAll('[data-source-group-index]').forEach(card => {
      const group = sources[Number(card.dataset.sourceGroupIndex)];
      card.querySelector('[data-update-source-group]').onclick = () => {
        modal.remove();
        this._updateSharedSourceGroupFromSelection(group.id);
      };
      card.querySelector('[data-remove-source-group]').onclick = () => {
        modal.remove();
        this._removeSharedSourceGroup(group.id);
      };
    });
    modal.querySelectorAll('[data-link-index]').forEach(card => {
      const link = links[Number(card.dataset.linkIndex)];
      card.querySelector('[data-sync]')?.addEventListener('click', () => {
        modal.remove();
        this._syncLinkedGroup(link.groupId);
      });
      card.querySelector('[data-relink]').onclick = () => {
        modal.remove();
        this._relinkSharedGroup(link.groupId);
      };
      card.querySelector('[data-detach]').onclick = () => {
        modal.remove();
        this._detachSharedGroup(link.groupId);
      };
      card.querySelector('[data-move-up]').onclick = () => {
        modal.remove();
        this._moveLinkedGroup(link.groupId, -1);
      };
      card.querySelector('[data-move-down]').onclick = () => {
        modal.remove();
        this._moveLinkedGroup(link.groupId, 1);
      };
    });
  },
};

if (window.Settings) {
  Object.assign(window.Settings, window.PpteSharedGroups);
}
