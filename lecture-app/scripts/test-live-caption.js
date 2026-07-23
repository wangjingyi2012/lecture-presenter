const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  CaptionTranscript,
  downsampleToPcm16,
  renderLatestCaptionLine,
  normalizeCaptionPreferences
} = require('../src/js/live-caption.js');

function testCaptionPreferenceNormalization() {
  assert.deepStrictEqual(normalizeCaptionPreferences({}), {
    model: 'fun-asr-realtime',
    displayMode: 'realtime'
  });
  assert.deepStrictEqual(normalizeCaptionPreferences({
    captionModel: 'paraformer-realtime-v2',
    captionDisplayMode: 'stable'
  }), {
    model: 'paraformer-realtime-v2',
    displayMode: 'stable'
  });
  assert.deepStrictEqual(normalizeCaptionPreferences({
    captionModel: 'untrusted-model',
    captionDisplayMode: 'untrusted-mode'
  }), {
    model: 'fun-asr-realtime',
    displayMode: 'realtime'
  });
}

function testIncrementalReplacement() {
  const transcript = new CaptionTranscript(2);
  assert.strictEqual(transcript.consume({ text: '演', isFinal: false, sentenceId: 1 }), '演');
  assert.strictEqual(transcript.consume({ text: '演讲宝', isFinal: false, sentenceId: 1 }), '演讲宝');
  assert.strictEqual(
    transcript.consume({ text: '演讲宝实时字幕。', isFinal: true, sentenceId: 1 }),
    '演讲宝实时字幕。'
  );
  assert.strictEqual(
    transcript.consume({ text: '第二句话', isFinal: false, sentenceId: 2 }),
    '演讲宝实时字幕。\n第二句话'
  );
}

function testFinalLineWindowAndDeduplication() {
  const transcript = new CaptionTranscript(2);
  transcript.consume({ text: '第一句', isFinal: true, sentenceId: 1 });
  transcript.consume({ text: '第二句旧结果', isFinal: true, sentenceId: 2 });
  transcript.consume({ text: '第二句最终结果', isFinal: true, sentenceId: 2 });
  assert.strictEqual(transcript.text(), '第一句\n第二句最终结果');
  transcript.consume({ text: '第三句', isFinal: true, sentenceId: 3 });
  assert.strictEqual(transcript.text(), '第二句最终结果\n第三句');
  transcript.reset();
  assert.strictEqual(transcript.text(), '');
}

function testSingleLineLiveMode() {
  const transcript = new CaptionTranscript(1);
  transcript.consume({ text: '上一句已经结束', isFinal: true, sentenceId: 1 });
  assert.strictEqual(
    transcript.consume({ text: '当前正在说的一句', isFinal: false, sentenceId: 2 }),
    '当前正在说的一句'
  );
  assert.strictEqual(
    transcript.consume({ text: '当前这一句结束。', isFinal: true, sentenceId: 2 }),
    '当前这一句结束。'
  );
  assert(!transcript.text().includes('\n'));
}

function testLatestContentReplacesOldText() {
  const element = {
    value: '',
    clientWidth: 60,
    set textContent(value) { this.value = value; },
    get textContent() { return this.value; },
    get scrollWidth() { return Array.from(this.value).length * 10; }
  };

  const visible = renderLatestCaptionLine(element, '旧旧旧新新新新新新');
  assert.strictEqual(visible, '新新新新新新');
  assert.strictEqual(element.textContent, '新新新新新新');
  assert(!element.textContent.includes('旧'));
}

function testPcmConversion() {
  const source = new Float32Array(4800);
  source.fill(0.5);
  const output = downsampleToPcm16(source, 48000, 16000);
  assert.strictEqual(output.length, 1600);
  assert(output.every(sample => sample >= 16380 && sample <= 16384));

  const clipped = downsampleToPcm16(new Float32Array([2, -2]), 16000, 16000);
  assert.strictEqual(clipped[0], 32767);
  assert.strictEqual(clipped[1], -32768);
}

function testIntegrationMarkup() {
  const root = path.resolve(__dirname, '..', 'src');
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const audience = fs.readFileSync(path.join(root, 'audience.html'), 'utf8');
  const viewer = fs.readFileSync(path.join(root, 'js', 'ppt-extra-viewer.js'), 'utf8');

  for (const id of ['ppt-extra-caption', 'ppt-play-caption', 'speaker-caption', 'live-caption-overlay']) {
    assert(index.includes(`id="${id}"`), `missing main caption element: ${id}`);
  }
  assert(index.includes('id="setting-caption-display-mode"'));
  assert(index.includes('id="setting-caption-model"'));
  assert(audience.includes('id="audience-live-caption"'));
  assert(audience.includes('LiveCaption?.initAudience'));
  assert(viewer.includes('LiveCaption?.stop'));
  assert(viewer.includes("return 'caption'"));
  const captionCss = fs.readFileSync(path.join(root, 'css', 'live-caption.css'), 'utf8');
  assert(captionCss.includes('white-space: nowrap'));
  assert(captionCss.includes('text-overflow: clip'));
}

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...names) { names.forEach(name => this.values.add(name)); }
  remove(...names) { names.forEach(name => this.values.delete(name)); }
  toggle(name, force) {
    if (force === undefined ? !this.values.has(name) : force) this.values.add(name);
    else this.values.delete(name);
  }
  contains(name) { return this.values.has(name); }
}

function fakeElement() {
  return {
    classList: new FakeClassList(),
    attributes: {},
    textContent: '',
    title: '',
    listeners: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, callback) { this.listeners[name] = callback; },
    querySelector() { return this.child || null; }
  };
}

async function testControllerLifecycle() {
  const overlay = fakeElement();
  overlay.child = fakeElement();
  const preview = fakeElement();
  preview.stateChild = fakeElement();
  preview.textChild = fakeElement();
  preview.querySelector = selector => selector.includes('state') ? preview.stateChild : preview.textChild;
  const headerButton = fakeElement();
  const playButton = fakeElement();
  const playLabel = fakeElement();
  const speakerButton = fakeElement();
  const speakerLabel = fakeElement();
  const elements = {
    'live-caption-overlay': overlay,
    'speaker-caption-preview': preview
  };

  global.document = {
    getElementById: id => elements[id] || null,
    querySelectorAll: selector => selector === '.caption-toggle'
      ? [headerButton, playButton, speakerButton]
      : [],
    querySelector: selector => {
      if (selector === '#ppt-play-caption span') return playLabel;
      if (selector === '#speaker-caption span') return speakerLabel;
      return null;
    }
  };
  global.addEventListener = () => {};

  const invocations = [];
  const eventListeners = {};
  let captionStartResolve = null;
  let delayCaptionStart = false;
  global.__TAURI__ = {
    core: {
      invoke: async (command, payload) => {
        invocations.push({ command, payload });
        if (command === 'caption_token_status') return { configured: true };
        if (command === 'caption_start' && delayCaptionStart) {
          return new Promise(resolve => { captionStartResolve = resolve; });
        }
        return null;
      }
    },
    event: {
      listen: async (name, callback) => { eventListeners[name] = callback; }
    }
  };
  global.CourseLoader = { appConfig: {
    captionModel: 'paraformer-realtime-v2',
    captionDisplayMode: 'stable'
  } };

  let trackStopped = false;
  Object.defineProperty(global, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async () => ({
          getTracks: () => [{ stop: () => { trackStopped = true; } }]
        })
      }
    }
  });

  class FakeAudioContext {
    constructor() {
      this.sampleRate = 16000;
      this.state = 'running';
      this.destination = {};
      FakeAudioContext.latest = this;
    }
    async resume() {}
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() {
      this.processor = { connect() {}, disconnect() {}, onaudioprocess: null };
      return this.processor;
    }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    async close() { this.state = 'closed'; }
  }
  global.AudioContext = FakeAudioContext;

  const controller = global.LiveCaption;
  controller.initialized = false;
  controller.state = 'stopped';
  controller.desiredActive = false;
  controller.startAttempt = 0;
  controller.initMain();
  await controller.start();
  const startCall = invocations.find(call => call.command === 'caption_start');
  assert.deepStrictEqual(startCall?.payload, {
    model: 'paraformer-realtime-v2',
    displayMode: 'stable'
  });

  FakeAudioContext.latest.processor.onaudioprocess({
    inputBuffer: { getChannelData: () => new Float32Array([0.25, -0.25, 0.5, -0.5]) }
  });
  await new Promise(resolve => setImmediate(resolve));
  const audioCall = invocations.find(call => call.command === 'caption_audio_chunk');
  assert(audioCall?.payload?.audioBase64, 'microphone PCM must be sent to the backend');

  controller.handleStatus('listening', '字幕已开启');
  assert(headerButton.classList.contains('caption-active'));
  controller.handleResult({ text: '实时字幕', isFinal: false, sentenceId: 1 });
  assert.strictEqual(overlay.child.textContent, '实时字幕');

  await controller.stop();
  assert(trackStopped, 'microphone track must stop with captions');
  assert(invocations.some(call => call.command === 'caption_stop'));
  assert.strictEqual(controller.state, 'stopped');

  delayCaptionStart = true;
  const lateStart = controller.start();
  await new Promise(resolve => setImmediate(resolve));
  assert(captionStartResolve, 'delayed caption start should be in flight');
  await controller.stop();
  controller.handleStatus('listening', '晚到的连接状态');
  assert.strictEqual(controller.state, 'stopped', 'late status must not reactivate captions');
  captionStartResolve();
  await lateStart;
  assert.strictEqual(controller.state, 'stopped', 'cancelled start must remain stopped');
  assert.strictEqual(controller.desiredActive, false);
}

(async () => {
  testCaptionPreferenceNormalization();
  testIncrementalReplacement();
  testFinalLineWindowAndDeduplication();
  testSingleLineLiveMode();
  testLatestContentReplacesOldText();
  testPcmConversion();
  testIntegrationMarkup();
  await testControllerLifecycle();
  console.log('Live caption tests passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
