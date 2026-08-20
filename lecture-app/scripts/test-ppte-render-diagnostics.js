const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'ppte-render-diagnostics.js'), 'utf8');
const messageListeners = new Set();
let lastFrame = null;

const context = {
  console,
  Uint8Array,
  setTimeout,
  clearTimeout,
  crypto: require('node:crypto').webcrypto,
  window: {
    addEventListener(type, listener) { if (type === 'message') messageListeners.add(listener); },
    removeEventListener(type, listener) { if (type === 'message') messageListeners.delete(listener); },
  },
  document: {
    body: { appendChild(frame) { lastFrame = frame; } },
    createElement(tag) {
      assert.equal(tag, 'iframe');
      const frame = {
        attrs: {},
        style: {},
        contentWindow: {},
        removed: false,
        setAttribute(name, value) { this.attrs[name] = value; },
        remove() { this.removed = true; },
      };
      Object.defineProperty(frame, 'srcdoc', {
        set(value) {
          this._srcdoc = value;
          const nonce = value.match(/"nonce":"([^"]+)"/)?.[1];
          setTimeout(() => {
            const event = {
              source: frame.contentWindow,
              data: {
                type: 'lectureai-render-diagnostics',
                nonce,
                result: {
                  schemaVersion: 1,
                  available: true,
                  passed: false,
                  load: { ok: true, durationMs: 12 },
                  canvas: { width: 1920, height: 1080, scrollWidth: 2100, scrollHeight: 1080 },
                  overflow: { horizontalCount: 1, verticalCount: 0, selectors: ['main.deck'] },
                  font: { minBodyPx: 12, violationCount: 1 },
                  resources: { failedCount: 1, items: ['/Users/private/course/missing.png'] },
                  scripts: { errorCount: 1, messages: ['secret at /Users/private/course/slide.html'] },
                  steps: { present: true, maxStep: 2, finalStep: 1, completed: false },
                  template: { actual: 'wrong-template', matched: false },
                  issues: [
                    { code: 'RENDER_HORIZONTAL_OVERFLOW', message: 'forged', selectors: ['main.deck'] },
                    { code: 'RENDER_RESOURCE_MISSING', resources: ['/Users/private/course/missing.png'] },
                    { code: 'RENDER_SCRIPT_ERROR', count: 1, message: '<html>secret</html>' },
                  ],
                },
              },
            };
            for (const listener of [...messageListeners]) listener(event);
          }, 0);
        },
      });
      return frame;
    },
  },
};
context.window.crypto = context.crypto;
vm.createContext(context);
vm.runInContext(`${source}\nglobalThis.PpteRenderDiagnostics = window.PpteRenderDiagnostics;`, context);

(async () => {
  const diagnostics = context.PpteRenderDiagnostics;
  const srcdoc = diagnostics._buildSrcdoc(
    '<html><head><base href="wrong"><title>T</title></head><body></body></html>',
    'slide://localhost/Users/private/course/',
    { nonce: 'n-1', expectedTemplate: 'expected-template' },
  );
  assert.equal((srcdoc.match(/<base\b/gi) || []).length, 1, 'diagnostic srcdoc replaces an existing base');
  assert.match(srcdoc, /diagnosticFrameRunner/);
  assert.match(srcdoc, /expected-template/);

  const result = await diagnostics.diagnose({
    html: '<!doctype html><html><body><main data-template="wrong-template"></main></body></html>',
    baseHref: 'slide://localhost/Users/private/course/',
    page: 4,
    pageId: 'slide-4',
    expectedTemplate: 'expected-template',
    timeoutMs: 1000,
  });
  assert.equal(lastFrame.attrs.sandbox, 'allow-scripts');
  assert.ok(!lastFrame.attrs.sandbox.includes('allow-same-origin'));
  assert.equal(lastFrame.removed, true);
  assert.equal(result.page, 4);
  assert.equal(result.pageId, 'slide-4');
  assert.equal(result.passed, false);
  assert.deepEqual(Array.from(result.resources.items), ['course/missing.png']);
  assert.equal(result.scripts.errorCount, 1);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('/Users/private'));
  assert.ok(!serialized.includes('<html>'));
  assert.ok(!serialized.includes('secret'));
  assert.ok(!serialized.includes('messages'));
  console.log('PPTE render diagnostics tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
