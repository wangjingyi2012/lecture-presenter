// ai-settings.js — AI provider settings and connection test
window.AiSettings = {
  initAiSettings(appConfig) {
    // AI Configuration
    const aiProviderSelect = document.getElementById('setting-ai-provider');
    const aiApiKeyInput = document.getElementById('setting-ai-apikey');
    const aiApiTypeSelect = document.getElementById('setting-ai-api-type');
    const aiBaseUrlInput = document.getElementById('setting-ai-baseurl');
    const aiModelInput = document.getElementById('setting-ai-model');
    const aiTestBtn = document.getElementById('setting-ai-test');
    const aiHint = document.getElementById('setting-ai-hint');

    if (appConfig.aiProvider) aiProviderSelect.value = appConfig.aiProvider;
    if (appConfig.aiApiKey) aiApiKeyInput.value = appConfig.aiApiKey;
    if (appConfig.aiApiType) aiApiTypeSelect.value = appConfig.aiApiType;
    if (appConfig.aiBaseUrl) aiBaseUrlInput.value = appConfig.aiBaseUrl;
    if (appConfig.aiModel) aiModelInput.value = appConfig.aiModel;

    aiProviderSelect.addEventListener('change', async () => {
      appConfig.aiProvider = aiProviderSelect.value || undefined;
      if (aiProviderSelect.value === 'deepseek') {
        appConfig.aiApiType = 'openai-chat';
        appConfig.aiBaseUrl = 'https://api.deepseek.com';
        appConfig.aiModel = 'deepseek-chat';
      } else if (aiProviderSelect.value === 'minimax') {
        appConfig.aiApiType = 'anthropic-messages';
        appConfig.aiBaseUrl = 'https://api.minimaxi.com/anthropic/v1';
        appConfig.aiModel = 'MiniMax-M2.5';
      } else if (aiProviderSelect.value === 'custom') {
        appConfig.aiApiType = appConfig.aiApiType || 'openai-chat';
        appConfig.aiModel = appConfig.aiModel || 'gpt-5.5';
      }
      aiApiTypeSelect.value = appConfig.aiApiType || 'openai-chat';
      aiBaseUrlInput.value = appConfig.aiBaseUrl || '';
      aiModelInput.value = appConfig.aiModel || '';
      await CourseLoader.saveAppConfig(appConfig);
      updateApiSettingsVisibility();
    });

    aiApiKeyInput.addEventListener('input', async () => {
      appConfig.aiApiKey = aiApiKeyInput.value || undefined;
      await CourseLoader.saveAppConfig(appConfig);
    });

    aiApiTypeSelect.addEventListener('change', async () => {
      appConfig.aiApiType = aiApiTypeSelect.value || undefined;
      await CourseLoader.saveAppConfig(appConfig);
    });

    aiBaseUrlInput.addEventListener('change', async () => {
      appConfig.aiBaseUrl = aiBaseUrlInput.value.trim() || undefined;
      await CourseLoader.saveAppConfig(appConfig);
    });

    aiModelInput.addEventListener('change', async () => {
      appConfig.aiModel = aiModelInput.value.trim() || undefined;
      await CourseLoader.saveAppConfig(appConfig);
    });

    aiTestBtn.addEventListener('click', async () => {
      if (!window.__TAURI__) return;
      const provider = aiProviderSelect.value;
      const apiKey = provider === 'lectureai' ? (window.Auth?.getToken() || '') : aiApiKeyInput.value.trim();
      if (!provider || (provider !== 'lectureai' && !apiKey)) {
        aiHint.textContent = '请先选择提供商并填写 API Key';
        return;
      }
      aiTestBtn.disabled = true;
      aiTestBtn.textContent = '测试中...';
      aiHint.textContent = '正在测试 AI 配置...';
      try {
        const result = await window.__TAURI__.core.invoke('test_ai_config', {
          provider,
          apiKey,
          apiType: aiApiTypeSelect.value,
          baseUrl: aiBaseUrlInput.value.trim() || undefined,
          model: aiModelInput.value.trim() || undefined
        });
        aiHint.textContent = `测试成功：${String(result).slice(0, 80)}`;
      } catch (e) {
        aiHint.textContent = `测试失败：${e}`;
      } finally {
        aiTestBtn.disabled = false;
        aiTestBtn.textContent = '测试';
      }
    });

    // Show/hide API settings based on provider.
    const updateApiSettingsVisibility = () => {
      const apiKeyRow = aiApiKeyInput.parentElement;
      if (apiKeyRow) {
        apiKeyRow.style.display = aiProviderSelect.value === 'lectureai' ? 'none' : '';
      }
      document.querySelectorAll('.ai-custom-row').forEach(row => {
        row.style.display = aiProviderSelect.value === 'custom' ? '' : 'none';
      });
      if (aiHint) {
        if (aiProviderSelect.value === 'custom') {
          aiHint.textContent = '自定义 API 支持 OpenAI Chat Completions、Responses 和 Anthropic Messages';
        } else if (aiProviderSelect.value === 'lectureai') {
          aiHint.textContent = 'LectureAI 使用当前登录账号，无需 API Key';
        } else {
          aiHint.textContent = '选择AI提供商并配置API Key';
        }
      }
    };
    updateApiSettingsVisibility();
    aiProviderSelect.addEventListener('change', () => {
      updateApiSettingsVisibility();
    });
  }
};

if (window.Settings) {
  Object.assign(window.Settings, window.AiSettings);
}
