// caption-settings.js — secure Alibaba Cloud live-caption credential settings
window.CaptionSettings = {
  initCaptionSettings(appConfig) {
    const tokenInput = document.getElementById('setting-caption-token');
    const saveTestBtn = document.getElementById('setting-caption-save-test');
    const clearBtn = document.getElementById('setting-caption-clear');
    const displayModeSelect = document.getElementById('setting-caption-display-mode');
    const modelSelect = document.getElementById('setting-caption-model');
    const hint = document.getElementById('setting-caption-hint');
    if (!tokenInput || !saveTestBtn || !clearBtn || !displayModeSelect || !modelSelect || !hint) return;

    const preferences = window.LiveCaption.normalizePreferences(appConfig || {});
    displayModeSelect.value = preferences.displayMode;
    modelSelect.value = preferences.model;

    const describePreferences = () => {
      const model = modelSelect.value === 'paraformer-realtime-v2'
        ? 'Paraformer · 过滤语气词'
        : 'Fun-ASR · 保留原始表达';
      const display = displayModeSelect.value === 'stable'
        ? '句末稳定显示'
        : '实时修订显示';
      return `${display}；${model}`;
    };

    const persistPreferences = async () => {
      appConfig.captionDisplayMode = displayModeSelect.value;
      appConfig.captionModel = modelSelect.value;
      await CourseLoader.saveAppConfig(appConfig);
      setHint(`设置已保存：${describePreferences()}；关闭后重新开启字幕生效`, 'success');
    };

    const setHint = (text, type = 'normal') => {
      hint.textContent = text;
      hint.style.color = type === 'error' ? '#f85149' : (type === 'success' ? '#3fb950' : '');
    };

    const refreshStatus = async () => {
      if (!window.__TAURI__) {
        setHint('实时字幕需要在演讲宝桌面应用中配置');
        return false;
      }
      try {
        const status = await window.__TAURI__.core.invoke('caption_token_status');
        setHint(status?.configured
          ? `已配置百炼 API Key；${describePreferences()}`
          : '未配置百炼 API Key；字幕开启前需要先保存并测试');
        return !!status?.configured;
      } catch (error) {
        setHint(`读取字幕配置失败：${error}`, 'error');
        return false;
      }
    };

    saveTestBtn.addEventListener('click', async () => {
      if (!window.__TAURI__) return;
      const token = tokenInput.value.trim();
      const configured = token ? true : await refreshStatus();
      if (!token && !configured) {
        tokenInput.focus();
        setHint('请填写阿里云百炼 API Key', 'error');
        return;
      }

      saveTestBtn.disabled = true;
      saveTestBtn.textContent = '测试中…';
      try {
        if (token) {
          await window.__TAURI__.core.invoke('caption_token_set', { token });
          tokenInput.value = '';
        }
        await persistPreferences();
        const message = await window.__TAURI__.core.invoke('caption_test', {
          model: modelSelect.value
        });
        setHint(`${message || '阿里云实时字幕连接正常'}；${describePreferences()}`, 'success');
      } catch (error) {
        setHint(`字幕连接测试失败：${error}`, 'error');
      } finally {
        saveTestBtn.disabled = false;
        saveTestBtn.textContent = '保存并测试';
      }
    });

    clearBtn.addEventListener('click', async () => {
      if (!window.__TAURI__) return;
      clearBtn.disabled = true;
      clearBtn.textContent = '清除中…';
      try {
        await window.LiveCaption?.stop?.();
        await window.__TAURI__.core.invoke('caption_token_clear');
        tokenInput.value = '';
        setHint('已从系统钥匙串清除字幕 API Key');
      } catch (error) {
        setHint(`清除失败：${error}`, 'error');
      } finally {
        clearBtn.disabled = false;
        clearBtn.textContent = '清除';
      }
    });

    displayModeSelect.addEventListener('change', () => {
      persistPreferences().catch(error => setHint(`保存字幕设置失败：${error}`, 'error'));
    });

    modelSelect.addEventListener('change', () => {
      persistPreferences().catch(error => setHint(`保存字幕设置失败：${error}`, 'error'));
    });

    refreshStatus();
  }
};

if (window.Settings) {
  Object.assign(window.Settings, window.CaptionSettings);
}
