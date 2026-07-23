// live-caption.js — microphone capture, Fun-ASR streaming, and synchronized caption display
(function (global) {
  'use strict';

  class CaptionTranscript {
    constructor(maxFinalLines = 2) {
      this.maxFinalLines = maxFinalLines;
      this.finalItems = [];
      this.partialText = '';
    }

    consume(result) {
      if (!result || typeof result.text !== 'string') return this.text();
      const text = result.text.trim();
      if (!text) return this.text();
      const isFinal = result.isFinal === true || result.is_final === true;
      const sentenceId = Number(result.sentenceId ?? result.sentence_id ?? 0);

      if (isFinal) {
        const existing = this.finalItems.findIndex(item => sentenceId > 0 && item.id === sentenceId);
        const item = { id: sentenceId, text };
        if (existing >= 0) this.finalItems[existing] = item;
        else this.finalItems.push(item);
        this.finalItems = this.finalItems.slice(-this.maxFinalLines);
        this.partialText = '';
      } else {
        this.partialText = text;
      }
      return this.text();
    }

    text() {
      if (this.partialText) {
        if (this.maxFinalLines === 1) return this.partialText;
        const previous = this.finalItems.length
          ? this.finalItems[this.finalItems.length - 1].text
          : '';
        return [previous, this.partialText].filter(Boolean).join('\n');
      }
      return this.finalItems.map(item => item.text).join('\n');
    }

    reset() {
      this.finalItems = [];
      this.partialText = '';
    }
  }

  function downsampleToPcm16(input, inputRate, outputRate = 16000) {
    if (!input || !input.length) return new Int16Array(0);
    const ratio = Math.max(1, Number(inputRate) / outputRate);
    const outputLength = Math.max(1, Math.floor(input.length / ratio));
    const output = new Int16Array(outputLength);

    for (let index = 0; index < outputLength; index += 1) {
      const start = Math.floor(index * ratio);
      const end = Math.max(start + 1, Math.min(input.length, Math.floor((index + 1) * ratio)));
      let sum = 0;
      for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
        sum += input[sampleIndex];
      }
      const sample = Math.max(-1, Math.min(1, sum / (end - start)));
      output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    return output;
  }

  function pcm16ToBase64(samples) {
    const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
    let binary = '';
    for (let index = 0; index < bytes.length; index += 1) {
      binary += String.fromCharCode(bytes[index]);
    }
    return global.btoa(binary);
  }

  function renderLatestCaptionLine(textElement, text) {
    if (!textElement) return '';
    const line = String(text || '').replace(/\s*\n+\s*/g, ' ').trim();
    textElement.textContent = line;
    if (!line) return '';

    const availableWidth = textElement.clientWidth;
    if (!availableWidth || textElement.scrollWidth <= availableWidth) return line;

    const characters = Array.from(line);
    let low = 0;
    let high = characters.length - 1;
    let firstVisible = high;

    // Find the longest suffix that fits. The newest recognition result stays
    // visible while older text is discarded from the left edge.
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      textElement.textContent = characters.slice(middle).join('');
      if (textElement.scrollWidth <= availableWidth) {
        firstVisible = middle;
        high = middle - 1;
      } else {
        low = middle + 1;
      }
    }

    const visible = characters.slice(firstVisible).join('');
    textElement.textContent = visible;
    return visible;
  }

  function createDisplay(overlay, textElement) {
    return {
      show(text, statusOnly = false) {
        if (!overlay || !textElement) return;
        renderLatestCaptionLine(textElement, text);
        overlay.classList.toggle('status-only', !!statusOnly);
        overlay.classList.toggle('visible', !!text);
      },
      clear() {
        if (!overlay || !textElement) return;
        textElement.textContent = '';
        overlay.classList.remove('visible', 'status-only');
      }
    };
  }

  function normalizeCaptionPreferences(value = {}) {
    const model = value.captionModel === 'paraformer-realtime-v2'
      ? 'paraformer-realtime-v2'
      : 'fun-asr-realtime';
    const displayMode = value.captionDisplayMode === 'stable' ? 'stable' : 'realtime';
    return { model, displayMode };
  }

  const LiveCaption = {
    state: 'stopped',
    transcript: new CaptionTranscript(1),
    initialized: false,
    stream: null,
    audioContext: null,
    sourceNode: null,
    processorNode: null,
    muteNode: null,
    display: null,
    clearTimer: null,
    audioErrorShown: false,
    desiredActive: false,
    startAttempt: 0,
    currentPreferences: normalizeCaptionPreferences(),

    normalizePreferences(value) {
      return normalizeCaptionPreferences(value);
    },

    getPreferences() {
      return normalizeCaptionPreferences(global.CourseLoader?.appConfig || {});
    },

    initMain() {
      if (this.initialized || !global.document) return;
      this.initialized = true;
      const overlay = document.getElementById('live-caption-overlay');
      this.display = createDisplay(overlay, overlay?.querySelector('.live-caption-text'));

      document.querySelectorAll('.caption-toggle').forEach(button => {
        button.addEventListener('click', event => {
          event.stopPropagation();
          this.toggle();
        });
      });

      if (global.__TAURI__?.event) {
        global.__TAURI__.event.listen('caption-result', event => {
          this.handleResult(event.payload || {});
        }).catch(error => console.warn('Failed to listen for caption results:', error));
        global.__TAURI__.event.listen('caption-status', event => {
          const payload = event.payload || {};
          this.handleStatus(payload.state || 'error', payload.message || '字幕状态异常');
        }).catch(error => console.warn('Failed to listen for caption status:', error));
      }

      global.addEventListener('beforeunload', () => {
        this.cleanupAudio();
        global.__TAURI__?.core?.invoke('caption_stop').catch(() => {});
      });
      this.renderControls();
    },

    async toggle() {
      if (this.state === 'starting' || this.state === 'listening') {
        await this.stop();
      } else {
        await this.start();
      }
    },

    async start() {
      if (!global.__TAURI__?.core) {
        this.handleStatus('error', '实时字幕需要在演讲宝桌面应用中使用');
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        this.handleStatus('error', '当前系统无法访问麦克风');
        return;
      }

      this.desiredActive = true;
      const attempt = ++this.startAttempt;
      this.state = 'starting';
      this.currentPreferences = this.getPreferences();
      this.transcript.reset();
      this.renderControls();
      this.showStatus('正在准备实时字幕…');

      try {
        const tokenStatus = await global.__TAURI__.core.invoke('caption_token_status');
        if (!this.desiredActive || attempt !== this.startAttempt) return;
        if (!tokenStatus?.configured) {
          throw new Error('请先在设置中配置阿里云百炼字幕 API Key');
        }

        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          },
          video: false
        });
        if (!this.desiredActive || attempt !== this.startAttempt) {
          this.cleanupAudio();
          return;
        }
        await global.__TAURI__.core.invoke('caption_start', {
          model: this.currentPreferences.model,
          displayMode: this.currentPreferences.displayMode
        });
        if (!this.desiredActive || attempt !== this.startAttempt) {
          await global.__TAURI__.core.invoke('caption_stop').catch(() => {});
          this.cleanupAudio();
          return;
        }
        await this.startAudioPipeline(this.stream);
      } catch (error) {
        this.cleanupAudio();
        if (!this.desiredActive || attempt !== this.startAttempt) return;
        this.handleStatus('error', this.friendlyError(error));
      }
    },

    async stop() {
      this.desiredActive = false;
      this.startAttempt += 1;
      this.cleanupAudio();
      this.transcript.reset();
      this.clearScheduled();
      this.display?.clear();
      this.state = 'stopped';
      this.renderControls();
      this.renderSpeakerPreview('', '字幕未开启');
      if (global.__TAURI__?.core) {
        try {
          await global.__TAURI__.core.invoke('caption_stop');
        } catch (error) {
          console.warn('Failed to stop live captions:', error);
        }
      }
    },

    async startAudioPipeline(stream) {
      const AudioContextClass = global.AudioContext || global.webkitAudioContext;
      if (!AudioContextClass) throw new Error('当前系统不支持麦克风音频处理');

      try {
        this.audioContext = new AudioContextClass({ sampleRate: 16000, latencyHint: 'interactive' });
      } catch (_) {
        this.audioContext = new AudioContextClass({ latencyHint: 'interactive' });
      }
      await this.audioContext.resume();
      this.sourceNode = this.audioContext.createMediaStreamSource(stream);
      this.processorNode = this.audioContext.createScriptProcessor(4096, 1, 1);
      this.muteNode = this.audioContext.createGain();
      this.muteNode.gain.value = 0;

      this.processorNode.onaudioprocess = event => {
        if (this.state !== 'starting' && this.state !== 'listening') return;
        const input = event.inputBuffer.getChannelData(0);
        const pcm = downsampleToPcm16(input, this.audioContext.sampleRate, 16000);
        if (!pcm.length) return;
        const audioBase64 = pcm16ToBase64(pcm);
        global.__TAURI__.core.invoke('caption_audio_chunk', { audioBase64 }).catch(error => {
          if (this.audioErrorShown || this.state === 'stopped') return;
          this.audioErrorShown = true;
          this.handleStatus('error', `发送麦克风音频失败：${error}`);
        });
      };

      this.sourceNode.connect(this.processorNode);
      this.processorNode.connect(this.muteNode);
      this.muteNode.connect(this.audioContext.destination);
    },

    cleanupAudio() {
      if (this.processorNode) {
        this.processorNode.onaudioprocess = null;
        try { this.processorNode.disconnect(); } catch (_) {}
      }
      if (this.sourceNode) {
        try { this.sourceNode.disconnect(); } catch (_) {}
      }
      if (this.muteNode) {
        try { this.muteNode.disconnect(); } catch (_) {}
      }
      if (this.stream) {
        this.stream.getTracks().forEach(track => track.stop());
      }
      if (this.audioContext && this.audioContext.state !== 'closed') {
        this.audioContext.close().catch(() => {});
      }
      this.stream = null;
      this.audioContext = null;
      this.sourceNode = null;
      this.processorNode = null;
      this.muteNode = null;
      this.audioErrorShown = false;
    },

    handleResult(result) {
      if (this.state === 'stopped') return;
      const text = this.transcript.consume(result);
      if (!text) return;
      this.clearScheduled();
      this.display?.show(text, false);
      this.renderSpeakerPreview(
        text,
        this.currentPreferences.displayMode === 'stable' ? '稳定字幕' : '实时字幕'
      );

      if (result.isFinal === true || result.is_final === true) {
        this.clearTimer = global.setTimeout(() => {
          this.transcript.reset();
          this.display?.clear();
          this.renderSpeakerPreview('', this.state === 'listening' ? '正在聆听' : '字幕未开启');
        }, 8000);
      }
    },

    handleStatus(state, message) {
      if ((state === 'starting' || state === 'listening') && !this.desiredActive) {
        global.__TAURI__?.core?.invoke('caption_stop').catch(() => {});
        return;
      }
      this.state = state;
      if (state === 'error') {
        this.desiredActive = false;
        this.cleanupAudio();
        this.showStatus(message || '字幕连接失败', 5000);
        this.renderSpeakerPreview('', message || '字幕连接失败');
      } else if (state === 'listening') {
        this.showStatus('字幕已开启 · 正在聆听', 1800);
        this.renderSpeakerPreview('', '正在聆听');
      } else if (state === 'stopped') {
        this.desiredActive = false;
        this.cleanupAudio();
        this.transcript.reset();
        this.clearScheduled();
        this.display?.clear();
        this.renderSpeakerPreview('', '字幕未开启');
      } else {
        this.showStatus(message || '正在连接实时字幕…');
        this.renderSpeakerPreview('', message || '正在连接');
      }
      this.renderControls();
    },

    showStatus(message, duration = 0) {
      this.clearScheduled();
      this.display?.show(message, true);
      if (duration > 0) {
        this.clearTimer = global.setTimeout(() => {
          this.display?.clear();
        }, duration);
      }
    },

    clearScheduled() {
      if (this.clearTimer) global.clearTimeout(this.clearTimer);
      this.clearTimer = null;
    },

    renderControls() {
      const active = this.state === 'listening';
      const starting = this.state === 'starting';
      document.querySelectorAll('.caption-toggle').forEach(button => {
        button.classList.toggle('caption-active', active);
        button.classList.toggle('caption-starting', starting);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
        button.title = active ? '关闭实时字幕 (C)' : (starting ? '正在连接实时字幕 (C)' : '开启实时字幕 (C)');
      });
      const playLabel = document.querySelector('#ppt-play-caption span');
      if (playLabel) playLabel.textContent = active ? '关闭实时字幕 (C)' : (starting ? '正在连接… (C)' : '开启实时字幕 (C)');
      const speakerLabel = document.querySelector('#speaker-caption span');
      if (speakerLabel) speakerLabel.textContent = active ? '关闭字幕' : (starting ? '连接中' : '字幕');
    },

    renderSpeakerPreview(text, stateText) {
      const preview = document.getElementById('speaker-caption-preview');
      if (!preview) return;
      preview.classList.toggle('listening', this.state === 'listening');
      const state = preview.querySelector('.speaker-caption-state');
      const content = preview.querySelector('.speaker-caption-text');
      if (state) state.textContent = stateText || '';
      if (content) content.textContent = (text || '').replace(/\n/g, ' ');
    },

    friendlyError(error) {
      const raw = String(error?.message || error || '字幕启动失败');
      if (/NotAllowedError|Permission denied|not allowed/i.test(raw)) {
        return '麦克风权限被拒绝，请在“系统设置 → 隐私与安全性 → 麦克风”中允许演讲宝';
      }
      if (/NotFoundError|Requested device not found/i.test(raw)) {
        return '没有检测到可用麦克风';
      }
      return raw;
    },

    initAudience() {
      if (!global.document || !global.__TAURI__?.event) return;
      const overlay = document.getElementById('audience-live-caption');
      const display = createDisplay(overlay, overlay?.querySelector('.live-caption-text'));
      const transcript = new CaptionTranscript(1);
      let clearTimer = null;
      const clearScheduled = () => {
        if (clearTimer) global.clearTimeout(clearTimer);
        clearTimer = null;
      };

      global.__TAURI__.event.listen('caption-result', event => {
        const result = event.payload || {};
        const text = transcript.consume(result);
        if (!text) return;
        clearScheduled();
        display.show(text, false);
        if (result.isFinal === true || result.is_final === true) {
          clearTimer = global.setTimeout(() => {
            transcript.reset();
            display.clear();
          }, 8000);
        }
      });
      global.__TAURI__.event.listen('caption-status', event => {
        const payload = event.payload || {};
        clearScheduled();
        if (payload.state === 'stopped') {
          transcript.reset();
          display.clear();
        } else if (payload.state === 'error') {
          display.show(payload.message || '实时字幕已中断', true);
          clearTimer = global.setTimeout(() => display.clear(), 5000);
        } else if (payload.state === 'listening') {
          display.show('字幕已开启 · 正在聆听', true);
          clearTimer = global.setTimeout(() => display.clear(), 1800);
        }
      });
    }
  };

  global.LiveCaption = LiveCaption;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      CaptionTranscript,
      downsampleToPcm16,
      renderLatestCaptionLine,
      normalizeCaptionPreferences
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
