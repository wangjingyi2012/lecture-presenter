// app.js — Application entry point

// Global error logging
window.errorLogs = [];
window.addEventListener('error', (e) => {
  const log = `[${new Date().toISOString()}] ${e.message}\n  at ${e.filename}:${e.lineno}:${e.colno}\n  ${e.error?.stack || ''}`;
  window.errorLogs.push(log);
  console.error(log);
});

window.addEventListener('unhandledrejection', (e) => {
  const log = `[${new Date().toISOString()}] Unhandled Promise: ${e.reason}`;
  window.errorLogs.push(log);
  console.error(log);
});

window.showErrorLogs = () => {
  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.8);z-index:9999;display:flex;align-items:center;justify-content:center;';
  const closeModal = () => document.body.removeChild(modal);
  modal.innerHTML = `
    <div style="background:#1e1e1e;color:#fff;width:80%;height:80%;border-radius:8px;display:flex;flex-direction:column;">
      <div style="padding:16px;border-bottom:1px solid #333;display:flex;justify-content:space-between;">
        <span style="font-weight:600;">错误日志</span>
        <button id="close-log-btn" style="background:none;border:none;color:#fff;font-size:20px;cursor:pointer;">✕</button>
      </div>
      <pre style="flex:1;overflow:auto;padding:16px;margin:0;font-family:monospace;font-size:12px;">${window.errorLogs.length ? window.errorLogs.join('\n\n') : '暂无错误'}</pre>
    </div>
  `;
  document.body.appendChild(modal);
  document.getElementById('close-log-btn').onclick = closeModal;
  modal.onclick = (e) => { if (e.target === modal) closeModal(); };
};

// Keyboard shortcut and button
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'l') {
    e.preventDefault();
    window.showErrorLogs();
  }
});

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('btn-error-log');
  if (btn) btn.onclick = () => window.showErrorLogs();
});

const App = {
  courseData: null,

  async init() {
    // Set pdf.js worker
    if (typeof pdfjsLib !== 'undefined') {
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
    }

    // Initialize components
    PdfViewer.init();
    VideoPlayer.init();
    MdViewer.init();
    HtmlViewer.init();
    PptExtraViewer.init();
    CodeViewer.init();
    CourseManager.init();
    CourseCreator.init();
    Drag.init();

    // Load app config
    const appConfig = await CourseLoader.loadAppConfig();
    Settings.init(appConfig);
    window.PpteWorkbenchAgent?.init(appConfig);
    window.ResourceCenter?.init();
    Tracker.configure(appConfig);

    // Initialize updater and notifications
    window.errorLogs.push('[APP] Updater type: ' + typeof Updater);
    window.errorLogs.push('[APP] NotificationCenter type: ' + typeof window.NotificationCenter);

    if (typeof Updater !== 'undefined') {
      // 版本检查走网络，fire-and-forget，断网/慢网不能卡住启动
      Updater.init(appConfig).catch(err => {
        window.errorLogs.push('[APP] Updater init error: ' + err);
      });
    }
    if (typeof window.NotificationCenter !== 'undefined') {
      await window.NotificationCenter.init(appConfig);
    } else {
      window.errorLogs.push('[APP] NotificationCenter is undefined!');
    }

    // Initialize auth (non-blocking)
    if (typeof window.Auth !== 'undefined') {
      window.Auth.init(appConfig).catch(err => {
        window.errorLogs.push('[APP] Auth init error: ' + err);
      });
    }

    Tracker.track('app_launch');

    // Load last opened course
    if (appConfig.courses.length > 0) {
      const courseId = appConfig.lastOpenedCourse || appConfig.courses[0].id;
      await this.loadCourse(courseId);
    } else {
      this.showEmptyState();
    }
  },

  async loadCourse(courseId) {
    try {
      this.courseData = await CourseLoader.loadCourse(courseId);
      const coursePath = CourseLoader.getCoursePath(courseId);
      Content.coursePath = coursePath;

      // Detect if this is a user-created course (absolute paths)
      const entry = CourseLoader.appConfig.courses.find(c => c.id === courseId);
      Content.isAbsolutePath = !!(entry && entry.createdByApp);

      // Update sidebar
      Sidebar.setCourseInfo(
        this.courseData.title,
        `${this.courseData.subtitle || ''} — ${this.courseData.instructor || ''}`
      );
      Sidebar.init(this.courseData.sections, (index) => {
        const section = this.courseData.sections[index];
        if (section) Content.render(section);
      });

      // Select first section
      if (this.courseData.sections.length > 0) {
        Sidebar.selectSection(0);
      }
      Tracker.track('course_load', courseId);
    } catch (e) {
      console.error('Failed to load course:', e);
      this.showEmptyState();
    }
  },

  showEmptyState() {
    document.getElementById('week-title').textContent = '';
    document.getElementById('week-description').textContent = '';
    document.getElementById('resources').innerHTML = `
      <div class="empty-state">
        <div class="empty-cards">
          <button class="empty-card empty-card-primary" id="empty-create-ppte">
            <span class="empty-card-icon"><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
              <rect x="2" y="3" width="20" height="14" rx="2"/>
              <path d="M8 21h8M12 17v4"/>
              <path d="M7 8h2v5H7zM11 6h2v7h-2zM15 10h2v3h-2z" fill="currentColor" stroke="none"/>
            </svg></span>
            <span class="empty-card-title">创建 PPTE 课件</span>
            <span class="empty-card-desc">像 PPT 一样直接做课件，无需先建课程</span>
          </button>
          <button class="empty-card" id="empty-create-course">
            <span class="empty-card-icon"><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
            </svg></span>
            <span class="empty-card-title">创建课程</span>
            <span class="empty-card-desc">把课件、PDF、视频按周组织成教学结构</span>
          </button>
        </div>
        <div class="empty-links">
          <button id="empty-open-ppte">打开已有 PPTE</button>
          <span class="empty-links-divider">·</span>
          <button id="empty-import-course">导入课程文件夹</button>
        </div>
      </div>
    `;
    document.getElementById('empty-create-ppte').addEventListener('click', () => Settings.createPptExtra());
    document.getElementById('empty-create-course').addEventListener('click', () => CourseCreator.open());
    document.getElementById('empty-open-ppte').addEventListener('click', () => Settings.openPptExtra());
    document.getElementById('empty-import-course').addEventListener('click', () => CourseManager.importCourse());
    Sidebar.setCourseInfo('', '');
    document.getElementById('week-list').innerHTML = '';
  }
};

// Start the app
document.addEventListener('DOMContentLoaded', () => App.init());
