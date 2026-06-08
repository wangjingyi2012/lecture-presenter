// html-viewer.js — Display HTML files in a sandboxed iframe
const HtmlViewer = {
  modal: null,

  init() {
    this.modal = document.getElementById('html-modal');
    if (!this.modal) return;

    document.getElementById('html-close').addEventListener('click', () => this.close());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen()) this.close();
    });
  },

  isOpen() {
    return this.modal && !this.modal.classList.contains('hidden');
  },

  open(title, url) {
    document.getElementById('html-title').textContent = title;
    const iframe = document.getElementById('html-iframe');
    iframe.src = url;
    this.modal.classList.remove('hidden');
  },

  close() {
    this.modal.classList.add('hidden');
    const iframe = document.getElementById('html-iframe');
    iframe.src = 'about:blank';
  },
};
