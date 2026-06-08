const { invoke } = window.__TAURI__.core;

window.Updater = {
  serverUrl: 'https://www.hz-study-system.com',
  currentVersion: '0.1.0',

  log(msg) {
    console.log(msg);
    if (window.errorLogs) {
      window.errorLogs.push(`[UPDATE] ${msg}`);
    }
  },

  async init(config) {
    this.serverUrl = (config && config.updateServer) || this.serverUrl;
    this.log('Updater init');
    this.log('Update server URL: ' + this.serverUrl);

    const autoCheck = !!this.serverUrl && config.autoCheckUpdate !== false;
    this.log('Auto check update: ' + autoCheck);

    if (autoCheck) {
      await this.checkUpdate();
    }
  },

  async checkUpdate() {
    if (!this.serverUrl) return;

    this.log('Checking for updates...');
    try {
      const result = await invoke('check_update', {
        currentVersion: this.currentVersion,
        serverUrl: this.serverUrl
      });

      this.log('Update check result: ' + JSON.stringify(result));

      if (result.has_update) {
        this.log('Update available: ' + result.version);
        this.showUpdateDialog(result);
      } else {
        this.log('No updates available');
      }
    } catch (err) {
      this.log('检查更新失败: ' + err);
      console.error('检查更新失败:', err);
    }
  },

  showUpdateDialog(updateInfo) {
    let changelogHtml = updateInfo.changelog || '暂无更新说明';
    if (window.marked && updateInfo.changelog) {
      try {
        changelogHtml = window.marked.parse(updateInfo.changelog);
      } catch (e) {
        changelogHtml = updateInfo.changelog.replace(/\n/g, '<br>');
      }
    }

    const dialog = document.createElement('div');
    dialog.className = 'update-dialog-overlay';
    dialog.innerHTML = `
      <div class="update-dialog">
        <h3>发现新版本 ${updateInfo.version}</h3>
        <div class="update-changelog notification-md">${changelogHtml}</div>
        <div class="update-actions">
          ${updateInfo.force_update ? '' : '<button class="btn-secondary" id="btn-update-later">稍后提醒</button>'}
          <button class="btn-primary" id="btn-update-now">立即更新</button>
        </div>
      </div>
    `;
    document.body.appendChild(dialog);

    // 绑定事件
    const btnLater = document.getElementById('btn-update-later');
    if (btnLater) {
      btnLater.onclick = () => this.closeDialog();
    }

    const btnNow = document.getElementById('btn-update-now');
    if (btnNow) {
      btnNow.onclick = () => this.downloadUpdate(updateInfo.download_url);
    }
  },

  downloadUpdate(url) {
    window.open(url, '_blank');
    this.closeDialog();
  },

  closeDialog() {
    const dialog = document.querySelector('.update-dialog-overlay');
    if (dialog) dialog.remove();
  }
};
