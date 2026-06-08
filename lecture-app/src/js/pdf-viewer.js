// pdf-viewer.js — PDF rendering with pdf.js
const PdfViewer = {
  pdfDoc: null,
  currentPage: 1,
  totalPages: 0,
  scale: 1.5,
  isScrollMode: false,
  rendering: false,

  init() {
    document.getElementById('pdf-prev').addEventListener('click', () => this.prevPage());
    document.getElementById('pdf-next').addEventListener('click', () => this.nextPage());
    document.getElementById('pdf-close').addEventListener('click', () => this.close());
    document.getElementById('pdf-scroll-mode').addEventListener('click', () => this.toggleScrollMode());

    // Keyboard navigation — listen on document so arrow keys always work
    document.addEventListener('keydown', (e) => {
      if (!this.isOpen()) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); this.prevPage(); }
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ') { e.preventDefault(); this.nextPage(); }
      if (e.key === 'Escape') this.close();
    });
  },

  isOpen() {
    return !document.getElementById('pdf-modal').classList.contains('hidden');
  },

  async open(title, url) {
    document.getElementById('pdf-title').textContent = title;
    document.getElementById('pdf-modal').classList.remove('hidden');
    document.getElementById('pdf-modal').focus();
    this.currentPage = 1;
    this.isScrollMode = false;
    document.getElementById('pdf-canvas').classList.remove('hidden');
    document.getElementById('pdf-scroll-container').classList.add('hidden');

    try {
      // Try loading via URL first
      let loadingTask;
      if (window.__TAURI__ && url.startsWith('asset://') || url.startsWith('https://asset.localhost')) {
        // For Tauri asset protocol, fetch as arraybuffer
        const response = await fetch(url);
        const data = await response.arrayBuffer();
        loadingTask = pdfjsLib.getDocument({ data });
      } else {
        loadingTask = pdfjsLib.getDocument(url);
      }

      this.pdfDoc = await loadingTask.promise;
      this.totalPages = this.pdfDoc.numPages;
      this.updatePageInfo();
      await this.renderPage(this.currentPage);
    } catch (e) {
      console.error('Failed to load PDF:', e);
      document.getElementById('pdf-container').innerHTML =
        `<div class="empty-state"><div class="icon">⚠</div><p>无法加载 PDF: ${e.message}</p></div>`;
    }
  },

  async renderPage(num) {
    if (this.rendering || !this.pdfDoc) return;
    this.rendering = true;

    try {
      const page = await this.pdfDoc.getPage(num);
      const canvas = document.getElementById('pdf-canvas');
      const ctx = canvas.getContext('2d');

      // Calculate scale to fit container
      const container = document.getElementById('pdf-container');
      const viewport = page.getViewport({ scale: 1 });
      const scaleX = (container.clientWidth - 32) / viewport.width;
      const scaleY = (container.clientHeight - 32) / viewport.height;
      this.scale = Math.min(scaleX, scaleY, 2.5);

      const scaledViewport = page.getViewport({ scale: this.scale });
      canvas.width = scaledViewport.width;
      canvas.height = scaledViewport.height;

      await page.render({ canvasContext: ctx, viewport: scaledViewport }).promise;
    } finally {
      this.rendering = false;
    }
  },

  async renderAllPages() {
    if (!this.pdfDoc) return;
    const container = document.getElementById('pdf-scroll-container');
    container.innerHTML = '';

    for (let i = 1; i <= this.totalPages; i++) {
      const page = await this.pdfDoc.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      const containerWidth = container.clientWidth - 64;
      const scale = Math.min(containerWidth / viewport.width, 2);
      const scaledViewport = page.getViewport({ scale });

      const canvas = document.createElement('canvas');
      canvas.width = scaledViewport.width;
      canvas.height = scaledViewport.height;
      container.appendChild(canvas);

      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport: scaledViewport }).promise;
    }
  },

  toggleScrollMode() {
    this.isScrollMode = !this.isScrollMode;
    const canvas = document.getElementById('pdf-canvas');
    const scrollContainer = document.getElementById('pdf-scroll-container');

    if (this.isScrollMode) {
      canvas.classList.add('hidden');
      scrollContainer.classList.remove('hidden');
      this.renderAllPages();
    } else {
      canvas.classList.remove('hidden');
      scrollContainer.classList.add('hidden');
      this.renderPage(this.currentPage);
    }
  },

  prevPage() {
    if (this.isScrollMode || this.currentPage <= 1) return;
    this.currentPage--;
    this.updatePageInfo();
    this.renderPage(this.currentPage);
  },

  nextPage() {
    if (this.isScrollMode || this.currentPage >= this.totalPages) return;
    this.currentPage++;
    this.updatePageInfo();
    this.renderPage(this.currentPage);
  },

  updatePageInfo() {
    document.getElementById('pdf-page-info').textContent = `${this.currentPage} / ${this.totalPages}`;
  },

  close() {
    document.getElementById('pdf-modal').classList.add('hidden');
    if (this.pdfDoc) {
      this.pdfDoc.destroy();
      this.pdfDoc = null;
    }
    const video = document.getElementById('video-player');
    if (video) video.pause();
  }
};
