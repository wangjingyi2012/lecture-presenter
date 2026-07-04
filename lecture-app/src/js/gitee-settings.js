// gitee-settings.js — Gitee backup token settings
window.GiteeSettings = {
  initGiteeSettings() {
    const tokenInput = document.getElementById('setting-gitee-token');
    const saveBtn = document.getElementById('setting-gitee-save');
    const clearBtn = document.getElementById('setting-gitee-clear');
    const hint = document.getElementById('setting-gitee-hint');
    if (!tokenInput || !saveBtn || !clearBtn || !hint) return;

    const setHint = (text, isError = false) => {
      hint.textContent = text;
      hint.style.color = isError ? '#f85149' : '';
    };

    const refreshStatus = async () => {
      if (!window.__TAURI__) {
        setHint('Gitee 备份需要在桌面应用中使用');
        return;
      }
      try {
        const status = await window.__TAURI__.core.invoke('gitee_token_status');
        setHint(status?.configured
          ? '已配置 Gitee Token，保存在系统钥匙串'
          : '未配置 Gitee Token；保存后可用于创建私有备份仓库');
      } catch (e) {
        setHint(`读取 Gitee Token 状态失败：${e}`, true);
      }
    };

    saveBtn.addEventListener('click', async () => {
      if (!window.__TAURI__) return;
      const token = tokenInput.value.trim();
      if (!token) {
        tokenInput.focus();
        setHint('请填写 Gitee Personal Access Token', true);
        return;
      }
      saveBtn.disabled = true;
      saveBtn.textContent = '保存中...';
      try {
        await window.__TAURI__.core.invoke('gitee_token_set', { token });
        tokenInput.value = '';
        const status = await window.__TAURI__.core.invoke('gitee_token_status');
        if (status?.configured) {
          setHint('已配置 Gitee Token，保存在系统钥匙串');
        } else {
          setHint('保存后仍无法读取 Gitee Token，请重新保存', true);
        }
      } catch (e) {
        setHint(`保存失败：${e}`, true);
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = '保存';
      }
    });

    clearBtn.addEventListener('click', async () => {
      if (!window.__TAURI__) return;
      clearBtn.disabled = true;
      clearBtn.textContent = '清除中...';
      try {
        await window.__TAURI__.core.invoke('gitee_token_clear');
        tokenInput.value = '';
        setHint('已清除 Gitee Token');
      } catch (e) {
        setHint(`清除失败：${e}`, true);
      } finally {
        clearBtn.disabled = false;
        clearBtn.textContent = '清除';
      }
    });

    refreshStatus();
  }
};

if (window.Settings) {
  Object.assign(window.Settings, window.GiteeSettings);
}
