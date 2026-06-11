const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const annotatorPath = path.join(__dirname, '..', 'src', 'js', 'ppte-annotator.js');
const source = fs.readFileSync(annotatorPath, 'utf8');

// --- Minimal DOM mock (just enough for PpteAnnotator.create) ---
function makeClassList(el) {
  return {
    add: (...names) => names.forEach(n => el._classes.add(n)),
    remove: (...names) => names.forEach(n => el._classes.delete(n)),
    toggle: (name, force) => {
      const on = force !== undefined ? force : !el._classes.has(name);
      if (on) el._classes.add(name); else el._classes.delete(name);
      return on;
    },
    contains: (name) => el._classes.has(name),
  };
}

function makeContext2d() {
  const calls = [];
  const record = (name) => (...args) => calls.push({ name, args });
  return {
    calls,
    setTransform: record('setTransform'),
    clearRect: record('clearRect'),
    beginPath: record('beginPath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    quadraticCurveTo: record('quadraticCurveTo'),
    arc: record('arc'),
    stroke: record('stroke'),
    fill: record('fill'),
    globalAlpha: 1,
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
    lineJoin: '',
    lineCap: '',
  };
}

function makeElement(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    _classes: new Set(),
    _listeners: {},
    children: [],
    style: {},
    dataset: {},
    textContent: '',
    innerHTML: '',
    width: 0,
    height: 0,
    isContentEditable: false,
    appendChild(child) { el.children.push(child); child.parentNode = el; return child; },
    remove() {
      if (el.parentNode) {
        el.parentNode.children = el.parentNode.children.filter(c => c !== el);
      }
    },
    addEventListener(type, handler) {
      (el._listeners[type] = el._listeners[type] || []).push(handler);
    },
    dispatch(type, event) {
      (el._listeners[type] || []).forEach(h => h(event));
    },
    querySelectorAll: () => [],
    querySelector: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 450 }),
    setPointerCapture() {},
    focus() {},
    blur() {},
    getContext: () => el._ctx || (el._ctx = makeContext2d()),
  };
  el.classList = makeClassList(el);
  Object.defineProperty(el, 'className', {
    get: () => [...el._classes].join(' '),
    set: (value) => { el._classes = new Set(String(value).split(/\s+/).filter(Boolean)); },
  });
  return el;
}

const documentListeners = {};
const context = {
  console,
  requestAnimationFrame: (fn) => { fn(); return 0; },
  getComputedStyle: () => ({ position: 'static' }),
  ResizeObserver: class { observe() {} disconnect() {} },
  document: {
    head: makeElement('head'),
    createElement: makeElement,
    getElementById: () => null,
    addEventListener(type, handler) {
      (documentListeners[type] = documentListeners[type] || []).push(handler);
    },
  },
  window: { devicePixelRatio: 1 },
};
context.window.window = context.window;

vm.createContext(context);
vm.runInContext(source, context);

// --- Tests ---
assert.ok(context.window.PpteAnnotator, 'PpteAnnotator should be registered on window');
assert.equal(typeof context.window.PpteAnnotator.create, 'function');

const container = makeElement('div');
let activeChanges = [];
const annotator = context.window.PpteAnnotator.create({
  container,
  floatingToggle: true,
  onActiveChange: (active) => activeChanges.push(active),
});

// Layer mounted into container with canvas + toolbar
assert.equal(container.children.length, 1, 'one overlay layer appended');
const layer = container.children[0];
assert.ok(layer.classList.contains('ppte-anno-layer'));
const canvas = layer.children.find(c => c.classList.contains('ppte-anno-canvas'));
assert.ok(canvas, 'canvas exists in layer');

// Activation toggles layer class and fires callback
assert.equal(annotator.isActive(), false);
annotator.setActive(true);
assert.equal(annotator.isActive(), true);
assert.ok(layer.classList.contains('active'));
assert.deepEqual(activeChanges, [true]);

// Draw a stroke on page 0 (the viewer always sets the page before drawing)
annotator.setPage(0);
const ctx2d = canvas.getContext('2d');
canvas.dispatch('pointerdown', { button: 0, clientX: 100, clientY: 100, pointerId: 1, preventDefault() {} });
canvas.dispatch('pointermove', { clientX: 200, clientY: 150, pointerId: 1 });
canvas.dispatch('pointerup', {});
const strokeCalls = ctx2d.calls.filter(c => c.name === 'stroke').length;
assert.ok(strokeCalls > 0, 'stroke drawn after pointer gesture');

// Page switch redraws empty page (clearRect with no new stroke)
ctx2d.calls.length = 0;
annotator.setPage(1);
assert.ok(ctx2d.calls.some(c => c.name === 'clearRect'), 'page switch clears canvas');
assert.equal(ctx2d.calls.filter(c => c.name === 'stroke').length, 0, 'page 1 has no strokes');

// Switch back: page 0 strokes are still there
ctx2d.calls.length = 0;
annotator.setPage(0);
assert.ok(ctx2d.calls.filter(c => c.name === 'stroke').length > 0, 'page 0 strokes restored');

// reset(): deactivates and wipes all pages
ctx2d.calls.length = 0;
annotator.reset();
assert.equal(annotator.isActive(), false);
annotator.setPage(0);
assert.equal(ctx2d.calls.filter(c => c.name === 'stroke').length, 0, 'reset discarded all annotations');

// P key activates via document-level capture listener
activeChanges = [];
(documentListeners.keydown || []).forEach(h => h({
  key: 'p', target: makeElement('div'), preventDefault() {}, stopPropagation() {},
}));
assert.equal(annotator.isActive(), true, 'P key toggles annotation on');

// Escape deactivates
(documentListeners.keydown || []).forEach(h => h({
  key: 'Escape', target: makeElement('div'), preventDefault() {}, stopPropagation() {},
}));
assert.equal(annotator.isActive(), false, 'Escape exits annotation mode');

console.log('ppte-annotator tests passed');
