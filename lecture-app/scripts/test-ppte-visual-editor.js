// test-ppte-visual-editor.js — pure-logic tests for PpteVisualEditor
// (ops merge/replay paths, base-href injection, stepped-template driving).
// replayOps itself needs DOMParser and is covered by manual smoke (npm run dev).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'ppte-visual-editor.js'), 'utf8');

function loadModule() {
  const context = { console, window: {}, Number, String, Array, Object, JSON, parseInt, parseFloat };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.window.PpteVisualEditor;
}

// Minimal element stub: tagName, children, parentElement, ownerDocument.
function makeEl(tag, children = []) {
  const el = {
    tagName: tag.toUpperCase(),
    children,
    parentElement: null,
    ownerDocument: null,
  };
  children.forEach(child => {
    child.parentElement = el;
    child.ownerDocument = el.ownerDocument;
  });
  return el;
}

function makeTree() {
  // body > div#a > [span, div#b > em]
  const em = makeEl('em');
  const b = makeEl('div', [em]);
  const span = makeEl('span');
  const a = makeEl('div', [span, b]);
  const body = makeEl('body', [a]);
  const doc = { body };
  [em, b, span, a].forEach(el => { el.ownerDocument = doc; });
  return { doc, body, a, span, b, em };
}

function main() {
  const ve = loadModule();
  // Cross-realm values from the vm fail deepStrictEqual's prototype checks;
  // normalize through JSON before comparing.
  const j = (v) => JSON.parse(JSON.stringify(v));

  // --- encode/decode path ---
  assert.equal(ve.encodePath([0, 2, 1]), '0/2/1');
  assert.deepEqual(j(ve.decodePath('0/2/1')), [0, 2, 1]);
  assert.deepEqual(j(ve.decodePath('')), []);
  assert.deepEqual(j(ve.decodePath(null)), []);

  // --- buildElementPath / resolveElementPath round-trip ---
  {
    const { doc, span, b, em } = makeTree();
    assert.equal(ve.buildElementPath(span), '0/0');
    assert.equal(ve.buildElementPath(b), '0/1');
    assert.equal(ve.buildElementPath(em), '0/1/0');
    assert.equal(ve.buildElementPath(doc.body), '');
    // resolveElementPath needs .children indexing like the DOM — our stub matches.
    assert.equal(ve.resolveElementPath(doc, '0/0'), span);
    assert.equal(ve.resolveElementPath(doc, '0/1/0'), em);
    assert.equal(ve.resolveElementPath(doc, ''), null); // body itself is not addressable
    assert.equal(ve.resolveElementPath(doc, '9/9'), null); // out of range
  }

  // --- mergeOp: latest style op per (path,name) wins, order preserved ---
  {
    let ops = [];
    ops = ve.mergeOp(ops, { type: 'style', path: '0/1', name: 'left', value: '10px' });
    ops = ve.mergeOp(ops, { type: 'style', path: '0/1', name: 'top', value: '20px' });
    ops = ve.mergeOp(ops, { type: 'style', path: '0/1', name: 'left', value: '30px' });
    assert.equal(ops.length, 2);
    assert.deepEqual(j(ops[0]), { type: 'style', path: '0/1', name: 'top', value: '20px' });
    assert.deepEqual(j(ops[1]), { type: 'style', path: '0/1', name: 'left', value: '30px' });
  }

  // --- mergeOp: html ops dedupe per path ---
  {
    let ops = [];
    ops = ve.mergeOp(ops, { type: 'html', path: '0/0', html: '<b>a</b>' });
    ops = ve.mergeOp(ops, { type: 'html', path: '0/0', html: '<b>b</b>' });
    assert.equal(ops.length, 1);
    assert.equal(ops[0].html, '<b>b</b>');
  }

  // --- mergeOp: insert ops are never deduped ---
  {
    let ops = [];
    ops = ve.mergeOp(ops, { type: 'insert', parentPath: '0', index: 1, html: '<div>x</div>' });
    ops = ve.mergeOp(ops, { type: 'insert', parentPath: '0', index: 2, html: '<div>y</div>' });
    assert.equal(ops.length, 2);
  }

  // --- mergeOp: remove drops earlier ops on the element and its descendants ---
  {
    let ops = [];
    ops = ve.mergeOp(ops, { type: 'style', path: '0/1', name: 'left', value: '10px' });
    ops = ve.mergeOp(ops, { type: 'html', path: '0/1/0', html: 'x' });
    ops = ve.mergeOp(ops, { type: 'style', path: '0/2', name: 'top', value: '5px' });
    ops = ve.mergeOp(ops, { type: 'remove', path: '0/1' });
    assert.equal(ops.length, 2);
    assert.deepEqual(j(ops[0]), { type: 'style', path: '0/2', name: 'top', value: '5px' });
    assert.deepEqual(j(ops[1]), { type: 'remove', path: '0/1' });
  }

  // --- injectBaseHref: inject, replace, no-head fallback ---
  {
    const url = 'slide://localhost/deck/';
    const injected = ve.injectBaseHref('<html><head><title>t</title></head><body></body></html>', url);
    assert.ok(injected.includes(`<base href="${url}">`));
    assert.ok(injected.indexOf('<base') > injected.indexOf('<head'));

    const replaced = ve.injectBaseHref('<html><head><base href="http://old/"><title>t</title></head></html>', url);
    assert.ok(!replaced.includes('http://old/'));
    assert.equal((replaced.match(/<base\b/g) || []).length, 1);

    const noHead = ve.injectBaseHref('<div>fragment</div>', url);
    assert.ok(noHead.startsWith(`<base href="${url}">`));

    const quoted = ve.injectBaseHref('<head></head>', 'http://x/?a=1&b="2"');
    assert.ok(quoted.includes('&amp;'));
    assert.ok(quoted.includes('&quot;'));
  }

  // --- getStepState / advanceStep / driveToFinalStep with stubs ---
  {
    const root = { dataset: { step: '0', maxStep: '3' } };
    const listeners = [];
    const doc = {
      querySelector: (sel) => (sel.includes('data-template') ? root : null),
      dispatchEvent: (event) => {
        listeners.forEach(fn => fn(event));
        return true;
      },
    };
    const win = {
      KeyboardEvent: class {
        constructor(type, opts) {
          this.type = type;
          this.key = opts.key;
          this.defaultPrevented = false;
        }
        preventDefault() { this.defaultPrevented = true; }
      },
    };
    assert.deepEqual(j(ve.getStepState(doc)), { step: 0, maxStep: 3 });

    // No listener consuming the key: advanceStep reports false, drive stops.
    assert.equal(ve.advanceStep(doc, win), false);
    ve.driveToFinalStep(doc, win); // must not hang

    // Listener advances the step and consumes the key, stopping at maxStep
    // like real stepped templates do.
    listeners.push((event) => {
      const step = parseInt(root.dataset.step, 10);
      const max = parseInt(root.dataset.maxStep, 10);
      if (step < max) {
        root.dataset.step = String(step + 1);
        event.preventDefault();
      }
    });
    ve.driveToFinalStep(doc, win);
    assert.equal(root.dataset.step, '3');
  }

  // --- _rgbToHex ---
  assert.equal(ve._rgbToHex('rgb(255, 0, 128)'), '#ff0080');
  assert.equal(ve._rgbToHex('rgba(0, 0, 0, 0.5)'), '#000000');
  assert.equal(ve._rgbToHex('transparent'), '#000000');

  console.log('test-ppte-visual-editor: all assertions passed');
}

main();
