// settings.js — Theme, font size, course switching, presentation mode
window.Settings = {
  init(appConfig) {
    this.applyTheme(appConfig.theme || 'dark');
    this.applyFontSize(appConfig.fontSize || 18);
    CourseManager.refresh();
    this.initControls(appConfig);
    this.initDevSettings(appConfig);
    window.LocalPpteAgent?.init(appConfig);
    this.initKeyboardShortcuts();
  },

  // Switch between views
  showCourseView() {
    document.getElementById('content-scroll').style.display = 'block';
    document.getElementById('ppte-management').classList.add('hidden');
    document.getElementById('ppte-editor').classList.add('hidden');
    document.getElementById('sidebar').classList.remove('hidden');
  },

  showPpteManagement() {
    document.getElementById('content-scroll').style.display = 'none';
    document.getElementById('ppte-management').classList.remove('hidden');
    document.getElementById('ppte-editor').classList.add('hidden');
    document.getElementById('sidebar').classList.add('hidden');
    this._loadRecentPpte();
  },

  showPpteEditor() {
    if (document.getElementById('content-scroll')) {
      document.getElementById('content-scroll').style.display = 'none';
    }
    if (document.getElementById('ppte-management')) {
      document.getElementById('ppte-management').classList.add('hidden');
    }
    if (document.getElementById('ppte-editor')) {
      document.getElementById('ppte-editor').classList.remove('hidden');
    }
    document.getElementById('sidebar').classList.add('hidden');
  },

  applyTheme(theme) {
    document.body.dataset.theme = theme;
    // Sync highlight.js theme
    const hljsLink = document.getElementById('hljs-theme');
    if (hljsLink) {
      hljsLink.href = theme === 'dark'
        ? 'vendor/highlight-github-dark.min.css'
        : 'vendor/highlight-github.min.css';
    }
  },

  applyFontSize(size) {
    document.documentElement.style.setProperty('--font-size', size + 'px');
  },

  initControls(appConfig) {
    document.getElementById('btn-theme').addEventListener('click', () => {
      const current = document.body.dataset.theme;
      const next = current === 'dark' ? 'light' : 'dark';
      this.applyTheme(next);
      Tracker.track('theme_change', next);
      appConfig.theme = next;
      CourseLoader.saveAppConfig(appConfig);
    });

    document.getElementById('btn-font-up').addEventListener('click', () => {
      const current = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--font-size'));
      const next = Math.min(current + 2, 28);
      this.applyFontSize(next);
      appConfig.fontSize = next;
      CourseLoader.saveAppConfig(appConfig);
    });

    document.getElementById('btn-font-down').addEventListener('click', () => {
      const current = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--font-size'));
      const next = Math.max(current - 2, 12);
      this.applyFontSize(next);
      appConfig.fontSize = next;
      CourseLoader.saveAppConfig(appConfig);
    });

    // PPTE button in titlebar
    const ppteBtn = document.getElementById('btn-ppte');
    if (ppteBtn) {
      ppteBtn.onclick = () => {
        this.showPpteManagement();
      };
    }

    const ppteWorkbenchEntry = document.getElementById('ppte-workbench-entry');
    if (ppteWorkbenchEntry) {
      ppteWorkbenchEntry.onclick = () => {
        this.showPpteManagement();
      };
    }

    const aiAssistantEntry = document.getElementById('ai-assistant-entry');
    if (aiAssistantEntry) {
      aiAssistantEntry.onclick = () => {
        window.PpteWorkbenchAgent?.open();
      };
    }

    // PPTE management view buttons
    const ppteBackBtn = document.getElementById('ppte-back-to-course');
    if (ppteBackBtn) {
      ppteBackBtn.onclick = () => this.showCourseView();
    }

    const ppteCreateBtn = document.getElementById('ppte-create-btn');
    if (ppteCreateBtn) {
      ppteCreateBtn.onclick = () => {
        this.createPptExtra();
      };
    }

    const ppteOpenBtn = document.getElementById('ppte-open-btn');
    if (ppteOpenBtn) {
      ppteOpenBtn.onclick = () => {
        this.openPptExtra();
      };
    }

    const ppteCloudBtn = document.getElementById('ppte-cloud-btn');
    if (ppteCloudBtn) {
      ppteCloudBtn.onclick = () => {
        if (!window.Auth?.isLoggedIn?.()) {
          window.Auth?.showLoginModal?.();
          return;
        }
        if (!window.Auth?.isAdmin?.() && (window.Auth?.getMembership?.() || 1) < 2) {
          const membershipUrl = window.Auth?.membershipUrl || 'https://design.hz-study-system.com/membership';
          if (window.__TAURI__?.shell?.open) window.__TAURI__.shell.open(membershipUrl);
          else window.open(membershipUrl, '_blank', 'noopener');
          return;
        }
        const server = (appConfig.updateServer || 'https://design.hz-study-system.com').replace(/\/$/, '');
        const url = `${server}/app/`;
        if (window.__TAURI__?.shell?.open) window.__TAURI__.shell.open(url);
        else window.open(url, '_blank', 'noopener');
      };
    }

    document.getElementById('ppte-editor-back')?.addEventListener('click', () => {
      this.showPpteManagement();
    });

    // About modal
    this.initAboutModal();
  },

  initAboutModal() {
    const aboutModal = document.getElementById('about-modal');
    if (!aboutModal) return;

    const openAbout = () => aboutModal.classList.remove('hidden');
    const closeAbout = () => aboutModal.classList.add('hidden');

    document.getElementById('btn-about')?.addEventListener('click', openAbout);
    document.getElementById('about-modal-close')?.addEventListener('click', closeAbout);
    document.getElementById('about-modal-overlay')?.addEventListener('click', closeAbout);

    // Close on Escape key
    aboutModal.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeAbout();
    });

    // Website link handler
    const websiteLink = document.getElementById('about-website-link');
    if (websiteLink) {
      websiteLink.addEventListener('click', (e) => {
        e.preventDefault();
        const url = websiteLink.dataset.url;
        if (window.__TAURI__?.shell?.open) {
          window.__TAURI__.shell.open(url);
        } else {
          window.open(url, '_blank');
        }
      });
    }
  },



  initKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Cmd+1-9: jump to section (0-indexed)
      if (e.metaKey && !e.shiftKey && e.key >= '1' && e.key <= '9') {
        e.preventDefault();
        Sidebar.selectSection(parseInt(e.key) - 1);
      }

      // Cmd+0: section 10 (index 9)
      if (e.metaKey && !e.shiftKey && e.key === '0') {
        e.preventDefault();
        Sidebar.selectSection(9);
      }

      // Cmd+Shift+P: presentation mode
      if (e.metaKey && e.shiftKey && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault();
        document.body.classList.toggle('presentation-mode');
      }

      // Escape: close modals (priority order)
      if (e.key === 'Escape') {
        if (window.ResourceCenter?.isOpen?.()) {
          window.ResourceCenter.close();
        } else if (CourseCreator.isOpen()) {
          CourseCreator.close();
        } else if (CourseManager.isOpen()) {
          CourseManager.close();
        } else if (CodeViewer.isOpen()) {
          CodeViewer.close();
        } else if (HtmlViewer.isOpen()) {
          HtmlViewer.close();
        } else if (PptExtraViewer.isOpen()) {
          PptExtraViewer.close();
        } else if (!document.getElementById('pdf-modal').classList.contains('hidden')) {
          PdfViewer.close();
        } else if (!document.getElementById('video-modal').classList.contains('hidden')) {
          VideoPlayer.close();
        }
      }
    });
  }
};
