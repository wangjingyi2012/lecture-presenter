// Tests for CourseManager's pure data helpers (grouping, search, group CRUD,
// course reordering). Runs course-manager.js in a vm sandbox — the helpers
// under test never touch the DOM.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const cmPath = path.join(__dirname, '..', 'src', 'js', 'course-manager.js');
const source = fs.readFileSync(cmPath, 'utf8');

const context = { console, window: {} };
vm.createContext(context);
vm.runInContext(`${source}\nglobalThis.CourseManager = CourseManager;`, context);

const cm = context.CourseManager;
assert.ok(cm, 'CourseManager should be defined');

function makeConfig() {
  return {
    courses: [
      { id: 'c1', path: '/p/c1', label: '数学分析', group: 'g1' },
      { id: 'c2', path: '/p/c2', label: '线性代数', group: 'g1' },
      { id: 'c3', path: '/p/c3', label: '操作系统', group: 'g2' },
      { id: 'c4', path: '/p/c4', label: '英语口语' },
    ],
    groups: [
      { id: 'g1', name: '数学', collapsed: false },
      { id: 'g2', name: '计算机', collapsed: true },
    ],
    lastOpenedCourse: 'c1',
  };
}

// ── _groupedCourses: group order follows groups[], ungrouped comes last ──
{
  const sections = cm._groupedCourses(makeConfig());
  assert.equal(sections.length, 3);
  assert.equal(sections[0].group.id, 'g1');
  assert.deepEqual(sections[0].courses.map(c => c.id), ['c1', 'c2']);
  assert.equal(sections[1].group.id, 'g2');
  assert.deepEqual(sections[1].courses.map(c => c.id), ['c3']);
  assert.equal(sections[2].group, null);
  assert.deepEqual(sections[2].courses.map(c => c.id), ['c4']);
}

// ── _groupedCourses: course pointing at a missing group falls into ungrouped ──
{
  const config = makeConfig();
  config.courses[0].group = 'g-gone';
  const sections = cm._groupedCourses(config);
  const ungrouped = sections[sections.length - 1];
  assert.equal(ungrouped.group, null);
  assert.deepEqual(ungrouped.courses.map(c => c.id), ['c1', 'c4']);
}

// ── _groupedCourses: config without groups field (legacy) ──
{
  const config = makeConfig();
  delete config.groups;
  config.courses.forEach(c => delete c.group);
  const sections = cm._groupedCourses(config);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].group, null);
  assert.equal(sections[0].courses.length, 4);
}

// ── _matches: case-insensitive substring, empty query matches all ──
{
  assert.ok(cm._matches('', '数学分析'));
  assert.ok(cm._matches('数学', '数学分析'));
  assert.ok(cm._matches('OS', '操作系统') === false);
  assert.ok(cm._matches('oral', 'Oral English'));
  assert.ok(!cm._matches('物理', '数学分析'));
}

// ── _createGroup: appends with generated id, initializes groups array ──
{
  const config = makeConfig();
  const g = cm._createGroup(config, '新分组');
  assert.ok(g.id, 'group should get an id');
  assert.equal(g.name, '新分组');
  assert.equal(config.groups.length, 3);
  assert.equal(config.groups[2].name, '新分组');

  const legacy = { courses: [] };
  cm._createGroup(legacy, '第一组');
  assert.equal(legacy.groups.length, 1);
}

// ── _renameGroup ──
{
  const config = makeConfig();
  assert.ok(cm._renameGroup(config, 'g1', '基础数学'));
  assert.equal(config.groups[0].name, '基础数学');
  assert.ok(!cm._renameGroup(config, 'g-gone', 'x'));
  assert.ok(!cm._renameGroup(config, 'g1', ''));
}

// ── _deleteGroup: group removed, its courses become ungrouped ──
{
  const config = makeConfig();
  cm._deleteGroup(config, 'g1');
  assert.deepEqual(config.groups.map(g => g.id), ['g2']);
  assert.equal(config.courses[0].group, undefined);
  assert.equal(config.courses[1].group, undefined);
  assert.equal(config.courses[2].group, 'g2');
  const sections = cm._groupedCourses(config);
  const ungrouped = sections[sections.length - 1];
  assert.deepEqual(ungrouped.courses.map(c => c.id), ['c1', 'c2', 'c4']);
}

// ── _assignGroup ──
{
  const config = makeConfig();
  assert.ok(cm._assignGroup(config, 'c4', 'g2'));
  assert.equal(config.courses[3].group, 'g2');
  assert.ok(cm._assignGroup(config, 'c1', null));
  assert.equal(config.courses[0].group, undefined);
  assert.ok(!cm._assignGroup(config, 'c-gone', 'g1'));
  assert.ok(!cm._assignGroup(config, 'c2', 'g-gone'));
}

// ── _toggleCollapsed ──
{
  const config = makeConfig();
  cm._toggleCollapsed(config, 'g1');
  assert.equal(config.groups[0].collapsed, true);
  cm._toggleCollapsed(config, 'g1');
  assert.equal(config.groups[0].collapsed, false);
}

// ── _moveCourseBefore: insert before target / append at end ──
{
  const config = makeConfig();
  assert.ok(cm._moveCourseBefore(config, 'c4', 'c1'));
  assert.deepEqual(config.courses.map(c => c.id), ['c4', 'c1', 'c2', 'c3']);

  assert.ok(cm._moveCourseBefore(config, 'c4', null));
  assert.deepEqual(config.courses.map(c => c.id), ['c1', 'c2', 'c3', 'c4']);

  // Missing target appends; missing source is a no-op
  assert.ok(cm._moveCourseBefore(config, 'c1', 'c-gone'));
  assert.deepEqual(config.courses.map(c => c.id), ['c2', 'c3', 'c4', 'c1']);
  assert.ok(!cm._moveCourseBefore(config, 'c-gone', null));
}

console.log('All course-manager tests passed.');
