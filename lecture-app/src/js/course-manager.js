// course-manager.js — Course management modal (import, delete, edit, reorder)
const CourseManager = {
  modal: null,
  list: null,
  dragSrcIndex: null,

  init() {
    this.modal = document.getElementById('course-modal');
    this.list = document.getElementById('course-list');

    document.getElementById('course-modal-overlay').addEventListener('click', () => this.close());
    document.getElementById('course-modal-close').addEventListener('click', () => this.close());
    document.getElementById('course-modal-import').addEventListener('click', () => this.importCourse());
    document.getElementById('course-modal-create').addEventListener('click', () => {
      this.close();
      CourseCreator.open();
    });
    document.getElementById('course-modal-create-ppt').addEventListener('click', () => {
      this.close();
      Settings.createPptExtra();
    });
    document.getElementById('course-modal-open-ppt').addEventListener('click', () => {
      this.close();
      Settings.openPptExtra();
    });
  },

  open() {
    this.renderList();
    this.modal.classList.remove('hidden');
  },

  close() {
    this.modal.classList.add('hidden');
  },

  isOpen() {
    return !this.modal.classList.contains('hidden');
  },

  renderList() {
    const courses = CourseLoader.appConfig.courses;
    this.list.innerHTML = '';
    courses.forEach((course, index) => {
      const li = document.createElement('li');
      li.draggable = true;
      li.dataset.index = index;

      const editContentBtn = course.createdByApp
        ? `<button class="btn-edit-content" title="编辑课程内容">⚙</button>` : '';

      li.innerHTML = `
        <span class="drag-handle" title="拖拽排序">⠿</span>
        <span class="course-label">${this._escapeHtml(course.label)}</span>
        <div class="course-actions">
          ${editContentBtn}
          <button class="btn-edit" title="编辑名称">✎</button>
          <button class="btn-delete" title="删除课程">✕</button>
        </div>
      `;

      const editContentEl = li.querySelector('.btn-edit-content');
      if (editContentEl) {
        editContentEl.addEventListener('click', async () => {
          await App.loadCourse(course.id);
          this.close();
          CourseCreator.open(course.id);
        });
      }
      li.querySelector('.btn-edit').addEventListener('click', () => this.startEdit(li, index));
      li.querySelector('.btn-delete').addEventListener('click', () => this.deleteCourse(index));
      this._bindDragEvents(li);
      this.list.appendChild(li);
    });
  },

  async importCourse() {
    if (!window.__TAURI__) return;
    try {
      const entry = await window.__TAURI__.core.invoke('import_course');
      CourseLoader.appConfig.courses.push(entry);
      CourseLoader.appConfig.lastOpenedCourse = entry.id;
      await this.persist();
      Settings.refreshCourseOptions(CourseLoader.appConfig);
      await App.loadCourse(entry.id);
      Tracker.track('course_import', entry.label);
      this.renderList();
    } catch (e) {
      if (e !== 'cancelled') alert('导入失败: ' + e);
    }
  },

  async deleteCourse(index) {
    const courses = CourseLoader.appConfig.courses;
    const course = courses[index];
    if (!confirm(`确定删除课程「${course.label}」？`)) return;
    Tracker.track('course_delete', course.label);

    const wasActive = course.id === CourseLoader.appConfig.lastOpenedCourse;
    courses.splice(index, 1);

    if (wasActive && courses.length > 0) {
      CourseLoader.appConfig.lastOpenedCourse = courses[0].id;
      await this.persist();
      Settings.refreshCourseOptions(CourseLoader.appConfig);
      await App.loadCourse(courses[0].id);
    } else if (courses.length === 0) {
      CourseLoader.appConfig.lastOpenedCourse = '';
      await this.persist();
      Settings.refreshCourseOptions(CourseLoader.appConfig);
      App.showEmptyState();
    } else {
      await this.persist();
      Settings.refreshCourseOptions(CourseLoader.appConfig);
    }
    this.renderList();
  },

  startEdit(li, index) {
    const label = li.querySelector('.course-label');
    const oldText = CourseLoader.appConfig.courses[index].label;
    const input = document.createElement('input');
    input.className = 'course-edit-input';
    input.value = oldText;
    label.replaceWith(input);
    input.focus();
    input.select();

    const save = () => this.saveEdit(input, index);
    input.addEventListener('blur', save, { once: true });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        input.removeEventListener('blur', save);
        this.renderList();
      }
    });
  },

  async saveEdit(input, index) {
    const newLabel = input.value.trim();
    if (newLabel && newLabel !== CourseLoader.appConfig.courses[index].label) {
      CourseLoader.appConfig.courses[index].label = newLabel;
      await this.persist();
      Settings.refreshCourseOptions(CourseLoader.appConfig);
    }
    this.renderList();
  },

  _bindDragEvents(li) {
    li.addEventListener('dragstart', (e) => {
      this.dragSrcIndex = parseInt(li.dataset.index);
      li.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    li.addEventListener('dragend', () => {
      li.classList.remove('dragging');
      this.list.querySelectorAll('li').forEach(el => el.classList.remove('drag-over'));
    });

    li.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      li.classList.add('drag-over');
    });

    li.addEventListener('dragleave', () => {
      li.classList.remove('drag-over');
    });

    li.addEventListener('drop', (e) => {
      e.preventDefault();
      const targetIndex = parseInt(li.dataset.index);
      if (this.dragSrcIndex !== null && this.dragSrcIndex !== targetIndex) {
        this._reorder(this.dragSrcIndex, targetIndex);
      }
      this.dragSrcIndex = null;
    });
  },

  async _reorder(fromIndex, toIndex) {
    const courses = CourseLoader.appConfig.courses;
    const [moved] = courses.splice(fromIndex, 1);
    courses.splice(toIndex, 0, moved);
    await this.persist();
    Settings.refreshCourseOptions(CourseLoader.appConfig);
    this.renderList();
  },

  async persist() {
    await CourseLoader.saveAppConfig(CourseLoader.appConfig);
  },

  _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
};
