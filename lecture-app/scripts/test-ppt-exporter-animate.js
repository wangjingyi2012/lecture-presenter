// test-ppt-exporter-animate.js — _buildAnimationPlan logic of PptePptExporter (vm sandbox).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'ppte-ppt-exporter.js'), 'utf8');
const context = { console, URL, Blob, btoa, unescape, encodeURIComponent };
context.globalThis = context;
vm.createContext(context);
const exporter = vm.runInContext(`${source}\n;PptePptExporter;`, context);

function textItem(exportId, text, extra = {}) {
  return {
    exportId: String(exportId),
    text,
    box: { x: 1, y: 1, w: 2, h: 1 },
    color: '222222',
    fontFace: 'Microsoft YaHei',
    fontSize: 18,
    bold: false,
    italic: false,
    underline: false,
    align: 'left',
    lineHeightMultiple: 1.2,
    ...extra
  };
}

function shapeItem(exportId, fill) {
  return {
    exportId: String(exportId),
    box: { x: 0, y: 0, w: 3, h: 2 },
    rounded: false,
    fill: { color: fill, transparency: 0 },
    line: { color: 'FFFFFF', transparency: 100 }
  };
}

function snap({ texts = [], shapes = [], images = [] }) {
  return { basePath: '', backgroundColor: 'rgb(255,255,255)', backgroundImage: '', shapes, images, texts };
}

function clickSummary(plan) {
  // JSON round-trip converts vm-realm objects so deepStrictEqual can compare them.
  return JSON.parse(JSON.stringify(plan.clicks));
}

// Progressive reveal: B appears at step 1 -> enter on click 1; A stays static.
{
  const plan = exporter._buildAnimationPlan([
    snap({ texts: [textItem(1, 'A')] }),
    snap({ texts: [textItem(1, 'A'), textItem(2, 'B')] })
  ]);
  assert.equal(plan.objects.length, 2);
  assert.deepEqual(clickSummary(plan), [{ enter: ['pptr1'], exit: [] }]);
  const a = plan.objects.find(o => o.item.text === 'A');
  const b = plan.objects.find(o => o.item.text === 'B');
  assert.equal(a.name, undefined);
  assert.equal(b.name, 'pptr1');
}

// Scene swap: A visible at step 0, B at step 1 -> click 1 exits A and enters B.
{
  const plan = exporter._buildAnimationPlan([
    snap({ texts: [textItem(1, 'A')] }),
    snap({ texts: [textItem(2, 'B')] })
  ]);
  assert.deepEqual(clickSummary(plan), [{ enter: ['pptr2'], exit: ['pptr1'] }]);
}

// Fully static deck: no clicks, no names.
{
  const plan = exporter._buildAnimationPlan([
    snap({ texts: [textItem(1, 'A')], shapes: [shapeItem(2, 'FF0000')] })
  ]);
  assert.equal(plan.clicks.length, 0);
  assert.equal(plan.objects.length, 2);
  assert.ok(plan.objects.every(o => o.name === undefined));
}

// Disappear without re-enter: exit only.
{
  const plan = exporter._buildAnimationPlan([
    snap({ texts: [textItem(1, 'A'), textItem(2, 'B')] }),
    snap({ texts: [textItem(1, 'A')] })
  ]);
  assert.deepEqual(clickSummary(plan), [{ enter: [], exit: ['pptr1'] }]);
  const b = plan.objects.find(o => o.item.text === 'B');
  assert.equal(b.name, 'pptr1');
}

// Content change (same exportId, different text) -> exit old variant + enter new variant.
{
  const plan = exporter._buildAnimationPlan([
    snap({ texts: [textItem(1, '阶段一')] }),
    snap({ texts: [textItem(1, '阶段二')] })
  ]);
  assert.equal(plan.objects.length, 2);
  assert.deepEqual(clickSummary(plan), [{ enter: ['pptr2'], exit: ['pptr1'] }]);
  assert.equal(plan.objects[0].item.text, '阶段一');
  assert.equal(plan.objects[1].item.text, '阶段二');
}

// Broken visibility interval: visible at steps 0 and 2 -> two objects.
{
  const plan = exporter._buildAnimationPlan([
    snap({ texts: [textItem(1, 'A')] }),
    snap({ texts: [] }),
    snap({ texts: [textItem(1, 'A')] })
  ]);
  assert.equal(plan.objects.length, 2);
  assert.deepEqual(clickSummary(plan), [
    { enter: [], exit: ['pptr1'] },
    { enter: ['pptr2'], exit: [] }
  ]);
}

// Box-only change (position shift) keeps one object, box from the last visible step.
{
  const moved = textItem(1, 'A');
  moved.box = { x: 5, y: 1, w: 2, h: 1 };
  const plan = exporter._buildAnimationPlan([
    snap({ texts: [textItem(1, 'A')] }),
    snap({ texts: [moved] })
  ]);
  assert.equal(plan.objects.length, 1);
  assert.deepEqual(clickSummary(plan), [{ enter: [], exit: [] }]);
  assert.equal(plan.objects[0].item.box.x, 5);
}

// Ordering: shapes before images before texts; names are unique and sequential.
{
  const img = { exportId: '5', box: { x: 0, y: 0, w: 1, h: 1 }, src: 'data:image/png;base64,x', alt: '', rotate: 0 };
  const plan = exporter._buildAnimationPlan([
    snap({}),
    snap({ texts: [textItem(9, 'T')], shapes: [shapeItem(3, '00FF00')], images: [img] })
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(plan.objects.map(o => o.kind))), ['shapes', 'images', 'texts']);
  const names = JSON.parse(JSON.stringify(plan.objects.map(o => o.name)));
  assert.deepEqual([...names].sort(), [...names]);
  assert.equal(new Set(names).size, 3);
  assert.deepEqual(clickSummary(plan), [{ enter: ['pptr1', 'pptr2', 'pptr3'], exit: [] }]);
}

// Merge assembles one snapshot holding every variant object.
{
  const snapshots = [
    snap({ texts: [textItem(1, 'A')] }),
    snap({ texts: [textItem(1, 'A'), textItem(2, 'B')] })
  ];
  const plan = exporter._buildAnimationPlan(snapshots);
  const merged = exporter._mergeAnimatedSnapshot(snapshots, plan);
  assert.equal(merged.texts.length, 2);
  assert.equal(merged.shapes.length, 0);
  assert.equal(merged.backgroundColor, 'rgb(255,255,255)');
}

console.log('test-ppt-exporter-animate: all assertions passed');
