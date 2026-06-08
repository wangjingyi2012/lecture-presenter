// drag.js — Window dragging via Tauri startDragging API (replaces CSS -webkit-app-region)
const Drag = {
  init() {
    if (!window.__TAURI__) return;

    // Main titlebar drag
    this.makeDraggable(document.getElementById('titlebar-drag'));

    // Modal header drag — delegate via class
    document.addEventListener('mousedown', (e) => {
      const header = e.target.closest('.modal-header, .ppt-extra-header, .speaker-header');
      if (!header) return;
      // Don't drag if clicking a button or control
      if (e.target.closest('button, .modal-controls, select, input')) return;
      window.__TAURI__.window.getCurrentWindow().startDragging();
    });
  },

  makeDraggable(el) {
    if (!el) return;
    el.addEventListener('mousedown', () => {
      window.__TAURI__.window.getCurrentWindow().startDragging();
    });
  }
};
