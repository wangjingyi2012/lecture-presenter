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
    Tracker.configure(appConfig);

    // Initialize updater and notifications
    window.errorLogs.push('[APP] Updater type: ' + typeof Updater);
    window.errorLogs.push('[APP] NotificationCenter type: ' + typeof window.NotificationCenter);

    if (typeof Updater !== 'undefined') {
      await Updater.init(appConfig);
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
        <div class="icon">📚</div>
        <p>还没有课程</p>
        <p style="font-size: 0.8em; margin-top: 8px;">点击右上角 ⚙ 导入或创建你的第一个课程</p>
      </div>
    `;
    Sidebar.setCourseInfo('', '');
    document.getElementById('week-list').innerHTML = '';
  }
};

// Start the app
document.addEventListener('DOMContentLoaded', () => App.init());
