// course-manager.js — Course switcher panel (search, groups, inline management)
const CourseManager = {
  panel: null,
  listEl: null,
  searchInput: null,
  dragSrcId: null,

  init() {
    this.panel = document.getElementById('course-panel');
    this.listEl = document.getElementById('course-panel-list');
    this.searchInput = document.getElementById('course-panel-search-input');

    document.getElementById('course-switcher').addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle();
    });
    // Close on any click outside the switcher group
    document.addEventListener('click', (e) => {
      if (this.isOpen() && !e.target.closest('#course-switcher-group')) this.close();
    });
    this.searchInput.addEventListener('input', () => this.render());

    document.getElementById('course-panel-create-group').addEventListener('click', () => this.startCreateGroup());
    document.getElementById('course-panel-create').addEventListener('click', () => {
      this.close();
      CourseCreator.open();
    });
    document.getElementById('course-panel-import').addEventListener('click', () => this.importCourse());
    document.getElementById('course-panel-create-ppt').addEventListener('click', () => {
      this.close();
      Settings.createPptExtra();
    });
    document.getElementById('course-panel-open-ppt').addEventListener('click', () => {
      this.close();
      Settings.openPptExtra();
    });
  },

  open() {
    this.panel.classList.remove('hidden');
    this.searchInput.value = '';
    this.render();
    this.searchInput.focus();
  },

  close() {
    this.panel.classList.add('hidden');
    // Clicking outside during drag leaves stale state; reset it
    this.dragSrcId = null;
  },

  isOpen() {
    return !this.panel.classList.contains('hidden');
  },

  toggle() {
    if (this.isOpen()) this.close();
    else this.open();
  },

  // Update switcher label + redraw panel. Called after any config change.
  refresh() {
    const config = CourseLoader.appConfig || { courses: [] };
    const current = config.courses.find(c => c.id === config.lastOpenedCourse);
    document.getElementById('course-switcher-label').textContent =
      current ? current.label : '未选择课程';
    if (this.isOpen()) this.render();
  },

  // ── Pure data helpers (also exercised by scripts/test-course-manager.js) ──

  _groups(config) {
    return config.groups || [];
  },

  // Organize courses into [{group|null, courses:[...]}]; ungrouped always last.
  _groupedCourses(config) {
    const sections = this._groups(config).map(g => ({
      group: g,
      courses: config.courses.filter(c => c.group === g.id),
    }));
    sections.push({ group: null, courses: config.courses.filter(c => !this._groupExists(config, c.group)) });
    return sections;
  },

  _groupExists(config, groupId) {
    return !!groupId && this._groups(config).some(g => g.id === groupId);
  },

  _matches(query, label) {
    return !query || label.toLowerCase().includes(query.toLowerCase());
  },

  _createGroup(config, name) {
    if (!config.groups) config.groups = [];
    const group = { id: 'g' + Date.now(), name, collapsed: false };
    config.groups.push(group);
    return group;
  },

  // Rename a group in place; returns false when the group does not exist.
  _renameGroup(config, groupId, name) {
    const group = this._groups(config).find(g => g.id === groupId);
    if (!group || !name) return false;
    group.name = name;
    return true;
  },

  // Delete a group: its courses fall back to ungrouped (courses are kept).
  _deleteGroup(config, groupId) {
    if (!config.groups) return;
    config.groups = config.groups.filter(g => g.id !== groupId);
    config.courses.forEach(c => {
      if (c.group === groupId) delete c.group;
    });
  },

  // Move a course into a group (null = ungrouped). Returns false if no such course/group.
  _assignGroup(config, courseId, groupId) {
    const course = config.courses.find(c => c.id === courseId);
    if (!course) return false;
    if (groupId !== null && !this._groupExists(config, groupId)) return false;
    if (groupId === null) delete course.group;
    else course.group = groupId;
    return true;
  },

  _toggleCollapsed(config, groupId) {
    const group = this._groups(config).find(g => g.id === groupId);
    if (group) group.collapsed = !group.collapsed;
  },

  // Move course `courseId` so it sits right before `beforeCourseId`
  // (or at the end of its group when beforeCourseId is null).
  _moveCourseBefore(config, courseId, beforeCourseId) {
    const courses = config.courses;
    const srcIdx = courses.findIndex(c => c.id === courseId);
    if (srcIdx === -1) return false;
    const [moved] = courses.splice(srcIdx, 1);
    if (beforeCourseId === null) {
      courses.push(moved);
      return true;
    }
    const dstIdx = courses.findIndex(c => c.id === beforeCourseId);
    if (dstIdx === -1) {
      courses.push(moved);
      return true;
    }
    courses.splice(dstIdx, 0, moved);
    return true;
  },

  // ── Rendering ──

  render() {
    const config = CourseLoader.appConfig;
    const query = this.searchInput.value.trim();
    this.listEl.innerHTML = '';

    const sections = this._groupedCourses(config);
    let anyVisible = false;

    sections.forEach(({ group, courses }) => {
      const visible = courses.filter(c => this._matches(query, c.label));
      // While searching, hide empty groups and ignore collapsed state
      if (query && visible.length === 0) return;
      // Hide the "ungrouped" header entirely when there is nothing ungrouped
      if (!group && visible.length === 0) return;
      anyVisible = true;

      const sectionEl = document.createElement('div');
      sectionEl.className = 'course-group';

      if (group) sectionEl.appendChild(this._renderGroupHeader(config, group, visible.length));

      const collapsed = group && group.collapsed && !query;
      if (!collapsed) {
        const ul = document.createElement('ul');
        ul.className = 'course-group-items';
        ul.dataset.groupId = group ? group.id : '';
        visible.forEach(course => ul.appendChild(this._renderCourseItem(config, course)));
        // Allow dropping onto the (possibly empty) group body
        this._bindGroupDropZone(ul, group ? group.id : null);
        sectionEl.appendChild(ul);
      }
      this.listEl.appendChild(sectionEl);
    });

    if (!anyVisible) {
      const empty = document.createElement('div');
      empty.className = 'course-panel-empty';
      empty.textContent = query ? '没有匹配的课程' : '还没有课程，点击下方按钮创建或导入';
      this.listEl.appendChild(empty);
    }
  },

  _renderGroupHeader(config, group, count) {
    const header = document.createElement('div');
    header.className = 'course-group-header';

    const toggle = document.createElement('span');
    toggle.className = 'course-group-toggle';
    toggle.textContent = group.collapsed ? '▸' : '▾';
    toggle.title = '折叠 / 展开';

    const name = document.createElement('span');
    name.className = 'course-group-name';
    name.textContent = group.name;

    const badge = document.createElement('span');
    badge.className = 'course-group-count';
    badge.textContent = count;

    const actions = document.createElement('span');
    actions.className = 'course-group-actions';

    const renameBtn = document.createElement('button');
    renameBtn.textContent = '✎';
    renameBtn.title = '重命名分组';
    renameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._startInlineEdit(name, group.name, async (newName) => {
        if (this._renameGroup(config, group.id, newName)) {
          await this.persist();
          this.render();
        }
      });
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = '✕';
    deleteBtn.title = '删除分组（课程保留，归入未分组）';
    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`确定删除分组「${group.name}」？组内课程会移到未分组。`)) return;
      this._deleteGroup(config, group.id);
      await this.persist();
      this.render();
    });

    actions.appendChild(renameBtn);
    actions.appendChild(deleteBtn);

    header.appendChild(toggle);
    header.appendChild(name);
    header.appendChild(badge);
    header.appendChild(actions);

    header.addEventListener('click', async () => {
      this._toggleCollapsed(config, group.id);
      await this.persist();
      this.render();
    });
    // Drop onto a (collapsed) group header moves the course into that group
    this._bindGroupDropZone(header, group.id);
    return header;
  },

  _renderCourseItem(config, course) {
    const li = document.createElement('li');
    li.draggable = true;
    li.dataset.courseId = course.id;
    if (course.id === config.lastOpenedCourse) li.classList.add('current');

    const handle = document.createElement('span');
    handle.className = 'drag-handle';
    handle.title = '拖拽排序 / 移动分组';
    handle.textContent = '⠿';

    const label = document.createElement('span');
    label.className = 'course-label';
    label.textContent = course.label;

    const actions = document.createElement('span');
    actions.className = 'course-actions';

    if (course.createdByApp) {
      const editContentBtn = document.createElement('button');
      editContentBtn.textContent = '⚙';
      editContentBtn.title = '编辑课程内容';
      editContentBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await App.loadCourse(course.id);
        this.close();
        CourseCreator.open(course.id);
      });
      actions.appendChild(editContentBtn);
    }

    const renameBtn = document.createElement('button');
    renameBtn.textContent = '✎';
    renameBtn.title = '编辑名称';
    renameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._startInlineEdit(label, course.label, async (newLabel) => {
        if (newLabel !== course.label) {
          course.label = newLabel;
          await this.persist();
          this.refresh();
          this.render();
        }
      });
    });

    const moveBtn = document.createElement('button');
    moveBtn.textContent = '⇄';
    moveBtn.title = '移动到分组';
    moveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._showMoveMenu(config, course, moveBtn);
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn-delete';
    deleteBtn.textContent = '✕';
    deleteBtn.title = '删除课程';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.deleteCourse(course.id);
    });

    actions.appendChild(renameBtn);
    actions.appendChild(moveBtn);
    actions.appendChild(deleteBtn);

    li.appendChild(handle);
    li.appendChild(label);
    li.appendChild(actions);

    li.addEventListener('click', () => this.switchCourse(course.id));
    this._bindCourseDragEvents(li, config);
    return li;
  },

  // Small popup listing all groups (+ ungrouped) for the ⇄ action
  _showMoveMenu(config, course, anchorBtn) {
    this._dismissMoveMenu();
    const menu = document.createElement('div');
    menu.className = 'course-move-menu';
    menu.id = 'course-move-menu';

    const targets = [
      ...this._groups(config).map(g => ({ id: g.id, name: g.name })),
      { id: null, name: '未分组' },
    ];
    targets.forEach(t => {
      const item = document.createElement('button');
      item.textContent = t.name;
      if ((course.group || null) === t.id) {
        item.className = 'active';
        item.textContent += ' ✓';
      }
      item.addEventListener('click', async (e) => {
        e.stopPropagation();
        this._dismissMoveMenu();
        if (this._assignGroup(config, course.id, t.id)) {
          await this.persist();
          this.render();
        }
      });
      menu.appendChild(item);
    });

    anchorBtn.closest('li').appendChild(menu);
    // Dismiss on the next click anywhere else
    setTimeout(() => {
      document.addEventListener('click', this._moveMenuDismisser = () => this._dismissMoveMenu(), { once: true });
    }, 0);
  },

  _dismissMoveMenu() {
    const menu = document.getElementById('course-move-menu');
    if (menu) menu.remove();
    if (this._moveMenuDismisser) {
      document.removeEventListener('click', this._moveMenuDismisser);
      this._moveMenuDismisser = null;
    }
  },

  // Replace a label span with an inline input; commit on blur/Enter, cancel on Escape.
  _startInlineEdit(labelEl, oldText, onCommit) {
    const input = document.createElement('input');
    input.className = 'course-edit-input';
    input.value = oldText;
    labelEl.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const commit = async () => {
      if (done) return;
      done = true;
      const newText = input.value.trim();
      if (newText && newText !== oldText) await onCommit(newText);
      else this.render();
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        done = true;
        this.render();
      }
    });
    input.addEventListener('click', (e) => e.stopPropagation());
  },

  // Inline "new group" row at the top of the list
  startCreateGroup() {
    const existing = this.listEl.querySelector('.course-group-new-input');
    if (existing) { existing.focus(); return; }

    const row = document.createElement('div');
    row.className = 'course-group-header course-group-new';
    const input = document.createElement('input');
    input.className = 'course-edit-input course-group-new-input';
    input.placeholder = '分组名称…';
    row.appendChild(input);
    this.listEl.prepend(row);
    input.focus();

    let done = false;
    const commit = async () => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (name) {
        this._createGroup(CourseLoader.appConfig, name);
        await this.persist();
      }
      this.render();
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        done = true;
        this.render();
      }
    });
  },

  // ── Course-level actions ──

  async switchCourse(courseId) {
    const config = CourseLoader.appConfig;
    if (courseId === config.lastOpenedCourse) {
      this.close();
      return;
    }
    this.close();
    Tracker.track('course_switch', courseId);
    config.lastOpenedCourse = courseId;
    await CourseLoader.saveAppConfig(config);
    this.refresh();
    await App.loadCourse(courseId);
  },

  async importCourse() {
    if (!window.__TAURI__) return;
    try {
      const entry = await window.__TAURI__.core.invoke('import_course');
      CourseLoader.appConfig.courses.push(entry);
      CourseLoader.appConfig.lastOpenedCourse = entry.id;
      await this.persist();
      this.refresh();
      await App.loadCourse(entry.id);
      Tracker.track('course_import', entry.label);
      this.close();
    } catch (e) {
      if (e !== 'cancelled') alert('导入失败: ' + e);
    }
  },

  async deleteCourse(courseId) {
    const config = CourseLoader.appConfig;
    const index = config.courses.findIndex(c => c.id === courseId);
    if (index === -1) return;
    const course = config.courses[index];
    if (!confirm(`确定删除课程「${course.label}」？`)) return;
    Tracker.track('course_delete', course.label);

    const wasActive = course.id === config.lastOpenedCourse;
    config.courses.splice(index, 1);

    if (wasActive && config.courses.length > 0) {
      config.lastOpenedCourse = config.courses[0].id;
      await this.persist();
      this.refresh();
      await App.loadCourse(config.courses[0].id);
    } else if (config.courses.length === 0) {
      config.lastOpenedCourse = '';
      await this.persist();
      this.refresh();
      App.showEmptyState();
    } else {
      await this.persist();
      this.refresh();
    }
    if (this.isOpen()) this.render();
  },

  // ── Drag & drop ──

  _bindCourseDragEvents(li, config) {
    li.addEventListener('dragstart', (e) => {
      e.stopPropagation();
      this.dragSrcId = li.dataset.courseId;
      li.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    li.addEventListener('dragend', () => {
      li.classList.remove('dragging');
      this.listEl.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    });

    li.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      li.classList.add('drag-over');
    });

    li.addEventListener('dragleave', () => {
      li.classList.remove('drag-over');
    });

    li.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      li.classList.remove('drag-over');
      const srcId = this.dragSrcId;
      this.dragSrcId = null;
      if (!srcId || srcId === li.dataset.courseId) return;
      // Dropping on a course: adopt that course's group, insert right before it
      const target = config.courses.find(c => c.id === li.dataset.courseId);
      if (!target) return;
      this._assignGroup(config, srcId, target.group || null);
      this._moveCourseBefore(config, srcId, li.dataset.courseId);
      await this.persist();
      this.render();
    });
  },

  // Drop onto a group body/header: move to end of that group
  _bindGroupDropZone(el, groupId) {
    el.addEventListener('dragover', (e) => {
      if (e.target.closest('li')) return; // course rows handle their own drops
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('drag-over');
    });
    el.addEventListener('dragleave', () => {
      el.classList.remove('drag-over');
    });
    el.addEventListener('drop', async (e) => {
      if (e.target.closest('li')) return;
      e.preventDefault();
      el.classList.remove('drag-over');
      const srcId = this.dragSrcId;
      this.dragSrcId = null;
      if (!srcId) return;
      const config = CourseLoader.appConfig;
      if (!this._assignGroup(config, srcId, groupId)) return;
      // Append at the end of the target group: insert right after its last member
      const courses = config.courses;
      let lastMemberId = null;
      courses.forEach(c => {
        if (c.id !== srcId && (c.group || null) === groupId) lastMemberId = c.id;
      });
      if (lastMemberId) {
        // Reinsert after the last member: move before whatever follows it
        const lastIdx = courses.findIndex(c => c.id === lastMemberId);
        const next = courses.slice(lastIdx + 1).find(c => c.id !== srcId);
        this._moveCourseBefore(config, srcId, next ? next.id : null);
      } else {
        this._moveCourseBefore(config, srcId, null);
      }
      await this.persist();
      this.render();
    });
  },

  async persist() {
    await CourseLoader.saveAppConfig(CourseLoader.appConfig);
  },
};
