const invoke = window.__TAURI__ ? window.__TAURI__.core.invoke : null;

window.Updater = {
  serverUrl: 'https://design.hz-study-system.com',
  currentVersion: '0.1.0',
  ignoredVersion: '',

  log(msg) {
    console.log(msg);
    if (window.errorLogs) {
      window.errorLogs.push(`[UPDATE] ${msg}`);
    }
  },

  async init(config) {
    this.serverUrl = (config && config.updateServer) || this.serverUrl;
    this.ignoredVersion = (config && config.ignoredUpdateVersion) || '';
    // 用 Tauri 的真实应用版本号，拿不到时保留硬编码兜底
    if (window.__TAURI__ && window.__TAURI__.app && window.__TAURI__.app.getVersion) {
      try {
        this.currentVersion = await window.__TAURI__.app.getVersion();
      } catch (e) {
        this.log('获取应用版本号失败，使用兜底版本: ' + e);
      }
    }
    this.log('Updater init');
    this.log('Update server URL: ' + this.serverUrl);
    this.log('Current version: ' + this.currentVersion);

    const autoCheck = !!this.serverUrl && config.autoCheckUpdate !== false;
    this.log('Auto check update: ' + autoCheck);

    if (autoCheck) {
      await this.checkUpdate();
    }
  },

  async checkUpdate() {
    if (!this.serverUrl || !invoke) return;

    this.log('Checking for updates...');
    try {
      const result = await invoke('check_update', {
        currentVersion: this.currentVersion,
        serverUrl: this.serverUrl
      });

      this.log('Update check result: ' + JSON.stringify(result));

      if (result.has_update) {
        if (this._isIgnoredVersion(result)) {
          this.log('版本 ' + result.version + ' 已被用户忽略，跳过提示');
          return;
        }
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

  // 用户忽略的版本不再提示，但强制更新和更高的新版本仍会提示
  _isIgnoredVersion(result) {
    return !result.force_update && !!this.ignoredVersion && result.version === this.ignoredVersion;
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
          ${updateInfo.force_update ? '' : '<button class="btn-secondary" id="btn-update-ignore">忽略这个版本</button>'}
          ${updateInfo.force_update ? '' : '<button class="btn-secondary" id="btn-update-later">下次再提醒我</button>'}
          <button class="btn-primary" id="btn-update-now">立即更新</button>
        </div>
      </div>
    `;
    document.body.appendChild(dialog);

    // 绑定事件
    const btnIgnore = document.getElementById('btn-update-ignore');
    if (btnIgnore) {
      btnIgnore.onclick = () => this.ignoreVersion(updateInfo.version);
    }

    const btnLater = document.getElementById('btn-update-later');
    if (btnLater) {
      btnLater.onclick = () => this.closeDialog();
    }

    const btnNow = document.getElementById('btn-update-now');
    if (btnNow) {
      btnNow.onclick = () => this.downloadUpdate(updateInfo.download_url);
    }
  },

  // 记住被忽略的版本并持久化到 app-config
  async ignoreVersion(version) {
    this.ignoredVersion = version;
    this.log('忽略版本: ' + version);
    if (invoke) {
      try {
        // 读取最新配置再写回，避免覆盖其他模块刚保存的字段
        const config = await invoke('read_app_config');
        config.ignoredUpdateVersion = version;
        await invoke('save_app_config', { configJson: JSON.stringify(config, null, 2) });
        if (window.CourseLoader && window.CourseLoader.appConfig) {
          window.CourseLoader.appConfig.ignoredUpdateVersion = version;
        }
      } catch (e) {
        this.log('保存忽略版本失败: ' + e);
        console.error('保存忽略版本失败:', e);
      }
    }
    this.closeDialog();
  },

  downloadUpdate(url) {
    if (!url) {
      this.closeDialog();
      return;
    }
    // Tauri 里 window.open 不会打开系统浏览器，必须走 shell
    if (window.__TAURI__ && window.__TAURI__.shell && window.__TAURI__.shell.open) {
      window.__TAURI__.shell.open(url);
    } else if (invoke) {
      invoke('open_external', { path: url }).catch((e) => this.log('打开下载页失败: ' + e));
    } else {
      window.open(url, '_blank');
    }
    this.closeDialog();
  },

  closeDialog() {
    const dialog = document.querySelector('.update-dialog-overlay');
    if (dialog) dialog.remove();
  }
};
