// Note: plain (non-strict) assert — objects built inside the vm realm have a
// different Object prototype, so deepStrictEqual would reject them.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const rcPath = path.join(__dirname, '..', 'src', 'js', 'resource-center.js');
const source = fs.readFileSync(rcPath, 'utf8');

const context = {
  console,
  window: {},
  navigator: { platform: 'MacIntel', userAgent: 'Macintosh' },
};

vm.createContext(context);
vm.runInContext(`${source}\nglobalThis.ResourceCenter = window.ResourceCenter;`, context);

const rc = context.ResourceCenter;
assert.ok(rc, 'ResourceCenter should be defined');

// ── course.json shape 1: "ppt-extra" field inside weeks[].resources arrays ──
{
  const raw = {
    weeks: [
      {
        title: '第 1 周',
        resources: {
          slides: [
            { title: '交互演示', 'ppt-extra': 'ppt-extra/week01' },
            { title: '普通PDF', file: 'slides/week01.pdf' },
          ],
          readings: [
            { title: '阅读 PPTE', 'ppt-extra': 'ppt-extra/read01' },
          ],
          // normalizeToV2 only scans slides/readings; resource center must scan every array
          assignments: [
            { title: '作业 PPTE', 'ppt-extra': 'ppt-extra/hw01' },
          ],
        },
      },
    ],
  };
  const out = rc._collectCoursePptePaths(raw, '/courses/demo');
  assert.deepEqual(out, [
    { title: '交互演示', path: '/courses/demo/ppt-extra/week01' },
    { title: '阅读 PPTE', path: '/courses/demo/ppt-extra/read01' },
    { title: '作业 PPTE', path: '/courses/demo/ppt-extra/hw01' },
  ]);
}

// ── course.json shape 2: standalone "ppt-extra": [{title, dir}] resource key ──
{
  const raw = {
    weeks: [
      {
        title: '第 1 周',
        resources: {
          'ppt-extra': [
            { title: '交互演示', dir: 'ppt-extra/week01' },
          ],
        },
      },
    ],
  };
  const out = rc._collectCoursePptePaths(raw, '/courses/demo');
  assert.deepEqual(out, [
    { title: '交互演示', path: '/courses/demo/ppt-extra/week01' },
  ]);

  // top-level standalone key is also accepted
  const out2 = rc._collectCoursePptePaths({ 'ppt-extra': [{ title: 'T', dir: 'deck' }] }, '/courses/x');
  assert.deepEqual(out2, [{ title: 'T', path: '/courses/x/deck' }]);
}

// ── v2 course.json: sections[].resources flat items ──
{
  const raw = {
    version: 2,
    sections: [
      { title: 'S1', resources: [
        { title: 'P', path: 'ppt-extra/a', type: 'ppt-extra' },
        { title: 'V', path: 'v.mp4', type: 'video' },
      ] },
    ],
  };
  const out = rc._collectCoursePptePaths(raw, '/courses/demo');
  assert.deepEqual(out, [{ title: 'P', path: '/courses/demo/ppt-extra/a' }]);
}

// ── path joining: absolute paths pass through, backslashes normalize ──
{
  assert.equal(rc._joinPath('/base/', '/abs/deck'), '/abs/deck');
  assert.equal(rc._joinPath('C:\\courses\\demo', 'ppt-extra\\w1'), 'C:/courses/demo/ppt-extra/w1');
  assert.equal(rc._joinPath('/base', 'rel/deck'), '/base/rel/deck');
}

// ── dedupe by normalized absolute path ──
{
  const items = [
    { title: 'A', path: '/courses/demo/deck' },
    { title: 'A dup trailing slash', path: '/courses/demo/deck/' },
    { title: 'A dup backslash', path: '\\courses\\demo\\deck' },
    { title: 'B', path: '/courses/demo/other' },
  ];
  const out = rc._dedupeSources(items);
  assert.equal(out.length, 2);
  assert.equal(out[0].title, 'A');
  assert.equal(out[1].title, 'B');
}

// ── manifest parsing: schemaVersion 1 ──
{
  const manifest = rc._parseManifest(JSON.stringify({
    title: '旧课件',
    slides: [
      { file: 'slide01.html', title: '封面' },
      { file: 'slide02.html' },
    ],
  }));
  assert.equal(manifest.title, '旧课件');
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.hasSharedGroups, false);
  assert.deepEqual(manifest.slides, [
    { file: 'slide01.html', title: '封面', slideType: 'content' },
    { file: 'slide02.html', title: '页面 2', slideType: 'content' },
  ]);
}

// ── manifest parsing: schemaVersion 2 with shared groups ──
{
  const manifest = rc._parseManifest({
    title: '新课件',
    schemaVersion: 2,
    deckId: 'deck_x',
    sharedGroups: [{ id: 'group_1', name: 'G', slideIds: ['slide_1'] }],
    slides: [
      { id: 'slide_1', file: 'slide01.html', title: '章节', slide_type: 'chapter' },
    ],
  });
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.hasSharedGroups, true);
  assert.deepEqual(manifest.slides, [
    { file: 'slide01.html', title: '章节', slideType: 'chapter' },
  ]);
}

// ── main-mode manifest append: v1 keeps the v1 shape ──
{
  const v1 = { title: '旧课件', slides: [{ file: 'slide01.html', title: '封面' }] };
  const entries = rc._buildManifestSlideEntries(v1, [
    { file: '.ppte-copies/copy_1/slide02.html', title: '拷贝页', slideType: 'chapter' },
  ]);
  assert.deepEqual(entries, [
    { file: '.ppte-copies/copy_1/slide02.html', title: '拷贝页' },
  ]);
}

// ── main-mode manifest append: v2 gets stable slide_ ids and slide_type ──
{
  let n = 0;
  const v2 = { title: '新课件', schemaVersion: 2, slides: [] };
  const entries = rc._buildManifestSlideEntries(v2, [
    { file: '.ppte-copies/copy_1/a.html', title: 'A', slideType: 'cover' },
    { file: '.ppte-copies/copy_1/b.html', title: 'B' },
  ], () => `slide_test${++n}`);
  assert.deepEqual(entries, [
    { id: 'slide_test1', file: '.ppte-copies/copy_1/a.html', title: 'A', slide_type: 'cover' },
    { id: 'slide_test2', file: '.ppte-copies/copy_1/b.html', title: 'B', slide_type: 'content' },
  ]);

  // default id generator uses the slide_ prefix
  const fallback = rc._buildManifestSlideEntries(v2, [{ file: 'x.html', title: 'X' }]);
  assert.match(fallback[0].id, /^slide_/);
}

console.log('test-resource-center: all assertions passed');
