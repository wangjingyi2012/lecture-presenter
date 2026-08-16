// test-ppt-exporter-steps.js — step-driving logic of PptePptExporter (vm sandbox, stub DOM).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'ppte-ppt-exporter.js'), 'utf8');
const context = { console, URL, Blob, btoa, unescape, encodeURIComponent };
context.globalThis = context;
vm.createContext(context);
const exporter = vm.runInContext(`${source}\n;PptePptExporter;`, context);

class FakeKeyboardEvent {
  constructor(type, opts) {
    this.type = type;
    this.key = opts.key;
    this.bubbles = !!opts.bubbles;
    this.cancelable = !!opts.cancelable;
    this.defaultPrevented = false;
  }
  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true;
  }
}

const fakeWin = {
  KeyboardEvent: FakeKeyboardEvent,
  requestAnimationFrame(cb) { cb(0); }
};

// Mimics the template contract: [data-template] root with data-step/data-max-step,
// consuming ArrowRight keydowns (preventDefault) until the final step.
function makeSteppedDoc(maxStep) {
  let step = 0;
  const root = { dataset: { step: '0', maxStep: String(maxStep) } };
  const listeners = [];
  const doc = {
    images: [],
    querySelector(sel) { return sel.includes('[data-template]') ? root : null; },
    addEventListener(type, fn) { if (type === 'keydown') listeners.push(fn); },
    dispatchEvent(event) { listeners.forEach(fn => fn(event)); }
  };
  doc.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight' && step < maxStep) {
      event.preventDefault();
      step += 1;
      root.dataset.step = String(step);
    }
  });
  return { doc, root, getStep: () => step };
}

async function main() {
  // _getStepState
  {
    const stepOf = value => ({ step: value.step, maxStep: value.maxStep });

    const staticDoc = { querySelector: () => null };
    assert.deepEqual(stepOf(exporter._getStepState(staticDoc)), { step: 0, maxStep: 0 });

    const { doc } = makeSteppedDoc(3);
    assert.deepEqual(stepOf(exporter._getStepState(doc)), { step: 0, maxStep: 3 });

    const junkDoc = { querySelector: () => ({ dataset: { step: 'abc', maxStep: '-2' } }) };
    assert.deepEqual(stepOf(exporter._getStepState(junkDoc)), { step: 0, maxStep: 0 });

    const conceptRoot = { dataset: { step: '2', maxStep: '4' } };
    const conceptDoc = {
      querySelector(sel) {
        return sel.includes('[data-ppte-concept-animation]') ? conceptRoot : null;
      }
    };
    assert.deepEqual(stepOf(exporter._getStepState(conceptDoc)), { step: 2, maxStep: 4 });
  }

  // _advanceStep returns true only while the slide consumes the key
  {
    const { doc, getStep } = makeSteppedDoc(2);
    assert.equal(exporter._advanceStep(doc, fakeWin), true);
    assert.equal(getStep(), 1);
    assert.equal(exporter._advanceStep(doc, fakeWin), true);
    assert.equal(getStep(), 2);
    assert.equal(exporter._advanceStep(doc, fakeWin), false);
    assert.equal(getStep(), 2);
  }

  // _advanceStep dispatches a bubbling, cancelable ArrowRight keydown
  {
    const seen = [];
    const doc = { dispatchEvent: (event) => seen.push(event) };
    exporter._advanceStep(doc, fakeWin);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].type, 'keydown');
    assert.equal(seen[0].key, 'ArrowRight');
    assert.equal(seen[0].bubbles, true);
    assert.equal(seen[0].cancelable, true);
  }

  // steps mode: one snapshot per step, stops after the final step
  {
    const { doc } = makeSteppedDoc(3);
    const captured = [];
    const snapshots = await exporter._collectStepSnapshots(doc, fakeWin, async () => {
      captured.push(exporter._getStepState(doc).step);
      return captured[captured.length - 1];
    });
    assert.deepEqual([...snapshots], [0, 1, 2, 3]);
    assert.deepEqual(captured, [0, 1, 2, 3]);
  }

  // steps mode: a handler that consumes without moving the step stalls out
  {
    const root = { dataset: { step: '0', maxStep: '9' } };
    const doc = {
      images: [],
      querySelector: () => root,
      dispatchEvent(event) { event.preventDefault(); }
    };
    const snapshots = await exporter._collectStepSnapshots(doc, fakeWin, async () => 'snap');
    assert.equal(snapshots.length, 2);
  }

  // steps mode: hard guard caps runaway decks
  {
    const { doc } = makeSteppedDoc(1000);
    const snapshots = await exporter._collectStepSnapshots(doc, fakeWin, async () => 'snap');
    assert.equal(snapshots.length, exporter.maxStepGuard);
  }

  // static mode: drives to the final step exactly once
  {
    const { doc, root } = makeSteppedDoc(5);
    await exporter._driveToFinalStep(doc, fakeWin);
    assert.equal(root.dataset.step, '5');
    assert.equal(exporter._advanceStep(doc, fakeWin), false);
  }

  // _withBaseTag injects base + export stylesheet with and without <head>
  {
    const withHead = exporter._withBaseTag('<html><head><title>t</title></head><body></body></html>', 'slide://localhost/x/');
    assert.ok(withHead.includes('<head><base href="slide://localhost/x/"><style data-ppt-export-style>'));

    const noHead = exporter._withBaseTag('<div>slide</div>', 'slide://localhost/x/');
    assert.ok(noHead.startsWith('<base href="slide://localhost/x/"><style data-ppt-export-style>'));
  }

  // The hidden export frame must permit scripts and use srcdoc. Without
  // allow-scripts, WKWebView renders the initial DOM but never installs PPTE
  // step handlers, so every export mode silently captures only step zero.
  {
    assert.ok(source.includes("iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts allow-popups')"));
    assert.ok(source.includes('iframe.srcdoc = frameHtml'));
    assert.ok(!source.includes('doc.write(html)'));
  }

  // Tauri's production CSP blocks arbitrary inline scripts inherited by srcdoc.
  // Executable inline scripts are therefore served through the existing slide
  // protocol, while JSON data and already-external scripts remain untouched.
  {
    const transformed = exporter._externalizeInlineScripts([
      '<script>window.a=1</script>',
      '<script type="application/json">{"x":1}</script>',
      '<script src="existing.js"></script>',
      '<script type="module">window.m=1</script>'
    ].join(''), 'slide://localhost/tmp/slide.html');
    assert.ok(transformed.includes('src="slide://localhost/tmp/slide.html?ppte-export-script=0"'));
    assert.ok(transformed.includes('<script type="application/json">{"x":1}</script>'));
    assert.ok(transformed.includes('<script src="existing.js"></script>'));
    assert.ok(transformed.includes('type="module" src="slide://localhost/tmp/slide.html?ppte-export-script=3"'));
  }

  // _exportCss kills motion and hides presentation chrome only under [data-template]
  {
    const css = exporter._exportCss();
    assert.ok(css.includes('transition:none!important'));
    assert.ok(css.includes('animation:none!important'));
    assert.ok(css.includes('[data-template] .step-rail'));
    assert.ok(css.includes('[data-template] .term-rail'));
    assert.ok(css.includes('[data-ppte-concept-animation] .ppte-step-rail'));
    assert.ok(css.includes('[data-ppte-concept-animation] .ppte-step-dots'));
    assert.ok(css.includes('visibility:hidden!important'));
    // chrome hiding must stay scoped to template pages
    assert.ok(!/(^|[},])\s*\.step-rail/.test(css));
  }

  console.log('test-ppt-exporter-steps: all assertions passed');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
