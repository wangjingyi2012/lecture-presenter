// Notification Center - 立即记录加载状态
if (window.errorLogs) {
  window.errorLogs.push('[NOTIFY] notification-center.js loading...');
}

window.NotificationCenter = {
  notifications: [],
  serverUrl: 'https://www.hz-study-system.com',
  currentVersion: '0.1.0',

  log(msg) {
    console.log(msg);
    if (window.errorLogs) {
      window.errorLogs.push(`[NOTIFY] ${msg}`);
    }
  },

  async init(config) {
    try {
      this.serverUrl = (config && (config.notificationServer || config.updateServer)) || this.serverUrl;
      this.log('NotificationCenter init');
      if (!this.serverUrl) {
        this.notifications = [];
        this.render();
        return;
      }
      await this.fetchNotifications();
      this.render();
    } catch (err) {
      this.log('Init error: ' + err);
    }
  },

  async fetchNotifications() {
    try {
      this.notifications = await window.__TAURI__.core.invoke('fetch_notifications', {
        currentVersion: this.currentVersion,
        serverUrl: this.serverUrl
      });
      this.log('Fetched ' + this.notifications.length + ' notifications');
    } catch (err) {
      this.log('Fetch error: ' + err);
    }
  },

  render() {
    try {
      const container = document.getElementById('notification-center');
      if (!container) {
        this.log('Container not found');
        return;
      }
      if (!this.serverUrl) {
        container.innerHTML = '';
        return;
      }

      const count = this.notifications.length;
      const badge = count > 0 ? `<span class="notification-badge">${count}</span>` : '';

      container.innerHTML = `
        <button class="notification-btn" id="notif-btn">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
            <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
          </svg>
          ${badge}
        </button>
        <div class="notification-dropdown" id="notif-dropdown" style="display:none;">
          ${count === 0 ? '<div class="notification-empty">暂无通知</div>' :
            this.notifications.map((n, i) => `
              <div class="notification-item" data-id="${i}">
                <div class="notification-title">${n.title}</div>
                <div class="notification-preview">${n.content.replace(/<[^>]+>/g, '').replace(/[#*`\[\]!]/g, '').replace(/\(http[^)]*\)/g, '').substring(0, 60)}</div>
              </div>
            `).join('')}
        </div>
      `;

      document.getElementById('notif-btn').onclick = () => this.toggle();

      // Close dropdown on outside click
      document.addEventListener('click', (e) => {
        const container = document.getElementById('notification-center');
        if (container && !container.contains(e.target)) {
          const dd = document.getElementById('notif-dropdown');
          if (dd) dd.style.display = 'none';
        }
      });

      this.notifications.forEach((n, i) => {
        const item = document.querySelector(`[data-id="${i}"]`);
        if (item) item.onclick = () => this.showDetail(n);
      });

      this.log('Rendered ' + count + ' notifications');
    } catch (err) {
      this.log('Render error: ' + err);
    }
  },

  toggle() {
    const dropdown = document.getElementById('notif-dropdown');
    if (dropdown) {
      const isHidden = dropdown.style.display === 'none';
      dropdown.style.display = isHidden ? 'block' : 'none';
      // Clear badge when opening
      if (isHidden) {
        const badge = document.querySelector('.notification-badge');
        if (badge) badge.style.display = 'none';
      }
    }
  },

  showDetail(notification) {
    // Render content as Markdown if marked.js is available, fallback to plain text
    let renderedContent = notification.content;
    if (window.marked) {
      try {
        renderedContent = window.marked.parse(notification.content);
      } catch (e) {
        // Fallback: preserve newlines as <br>
        renderedContent = notification.content.replace(/\n/g, '<br>');
      }
    } else {
      renderedContent = notification.content.replace(/\n/g, '<br>');
    }

    const dialog = document.createElement('div');
    dialog.className = 'notification-dialog-overlay';
    dialog.innerHTML = `
      <div class="notification-dialog" style="max-width:600px;width:90vw;">
        <h3>${notification.title}</h3>
        <div class="notification-content notification-md">${renderedContent}</div>
        <button class="btn-primary" id="close-notif">关闭</button>
      </div>
    `;
    document.body.appendChild(dialog);
    document.getElementById('close-notif').onclick = () => dialog.remove();
  }
};

// 确认加载完成
if (window.errorLogs) {
  window.errorLogs.push('[NOTIFY] notification-center.js loaded successfully');
}
