// Tests for the PPTE outline (outline.md) feature: editor state handling and
// LectureAI prompt injection. Runs ppte-editor.js / workbench-window.js in vm
// sandboxes with a stubbed DOM, matching the other framework-free test scripts.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const editorSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'ppte-editor.js'), 'utf8');
const workbenchSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'workbench-window.js'), 'utf8');

// ---------- shared DOM stub ----------
function makeEl(id) {
  const classes = new Set();
  return {
    id,
    value: '',
    textContent: '',
    innerHTML: '',
    disabled: false,
    style: {},
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : !!force;
        if (on) classes.add(c); else classes.delete(c);
      },
      contains: (c) => classes.has(c),
    },
  };
}

function makeDocument() {
  const elements = {};
  return {
    elements,
    getElementById(id) { return elements[id] || null; },
    createElement() { return makeEl('toast'); },
    body: { appendChild() {}, removeChild() {} },
    addEventListener() {},
  };
}
async function main() {
  // ---------- ppte-editor.js sandbox ----------
  const document = makeDocument();
  for (const id of [
    'ppt-current-title', 'ppt-current-html',
    'ppte-tab-slide', 'ppte-tab-outline',
    'ppte-editor-toolbar', 'ppte-outline-pane',
    'ppte-outline-edit', 'ppte-outline-preview',
    'ppte-outline-toggle', 'ppte-outline-status',
  ]) {
    document.elements[id] = makeEl(id);
  }

  let diskOutline = '';
  const tauriCalls = [];
  const editorContext = {
    console,
    window: {
      __TAURI__: {
        core: {
          invoke: async (cmd, args) => {
            tauriCalls.push({ cmd, args });
            if (cmd === 'stat_files') return (args.paths || []).map(() => ({ exists: false, mtimeMs: null, size: null, contentHash: null }));
            if (cmd === 'read_text_file') {
              if (String(args.filePath).endsWith('outline.md')) {
                if (diskOutline === null) throw new Error('not found');
                return diskOutline;
              }
              return '<h1>slide</h1>';
            }
            return null;
          },
        },
        event: { listen: async () => () => {} },
      },
    },
    document,
    setTimeout: (fn) => 0,
    clearTimeout() {},
  };
  editorContext.window.PpteEditor = undefined;
  vm.createContext(editorContext);
  vm.runInContext(`${editorSource}\nglobalThis.PpteEditor = window.PpteEditor;`, editorContext);
  const editor = editorContext.PpteEditor;
  assert.ok(editor, 'PpteEditor should be defined');

  // ── _loadPptFileStats covers outline.md so saves get conflict protection ──
  {
    tauriCalls.length = 0;
    const stats = await editor._loadPptFileStats('/deck', { slides: [{ file: 'slide01.html', title: 'A' }] });
    const statCall = tauriCalls.find(c => c.cmd === 'stat_files');
    assert.ok(statCall.args.paths.some(p => p.endsWith('/outline.md')), 'stat_files must include outline.md');
    assert.ok('outline.md' in stats, 'fileStats must key outline.md');
  }

  // ── _collectPptSlideFiles: outline rides along only when dirty ──
  {
    const pb = {
      folderPath: '/deck',
      slides: [{ file: 'slide01.html', title: 'A', html: '<h1>A</h1>', dirty: false, created: false }],
      outline: '# 章纲\n1. 安装',
      outlineDirty: false,
    };
    assert.deepEqual(editor._collectPptSlideFiles(pb), [], 'clean outline must not be written');

    pb.outlineDirty = true;
    assert.deepEqual(
      editor._collectPptSlideFiles(pb),
      [['outline.md', '# 章纲\n1. 安装']],
      'dirty outline must join the transactional save'
    );

    pb.outlineDirty = false;
    const forced = editor._collectPptSlideFiles(pb, true);
    assert.ok(forced.some(([name]) => name === 'outline.md'), 'forceAll keeps a non-empty outline');
    pb.outline = '';
    assert.ok(!editor._collectPptSlideFiles(pb, true).some(([name]) => name === 'outline.md'), 'forceAll must not create an empty outline.md');
  }

  // ── tab switching preserves unsaved edits on both sides ──
  {
    const pb = {
      folderPath: '/deck',
      slides: [{ file: 'slide01.html', title: 'A', html: '<h1>A</h1>', dirty: false }],
      currentSlideIndex: 0,
      outline: '原始大纲',
      outlineDirty: false,
      activeTab: 'slide',
    };
    editor._pptBuilder = pb;
    document.elements['ppt-current-title'].value = 'A';
    document.elements['ppt-current-html'].value = '<h1>A edited</h1>';
    document.elements['ppte-outline-edit'].value = '';

    editor._setPptEditorTab('outline');
    assert.equal(pb.slides[0].html, '<h1>A edited</h1>', 'slide edits must be captured before leaving the slide tab');
    assert.equal(pb.slides[0].dirty, true);
    assert.equal(pb.activeTab, 'outline');
    assert.equal(document.elements['ppte-outline-edit'].value, '原始大纲');
    assert.ok(document.elements['ppte-outline-pane'].classList.contains('hidden') === false);
    assert.ok(document.elements['ppt-current-html'].classList.contains('hidden'));

    document.elements['ppte-outline-edit'].value = '改过的大纲';
    editor._setPptEditorTab('slide');
    assert.equal(pb.outline, '改过的大纲', 'outline edits must be captured before leaving the outline tab');
    assert.equal(pb.outlineDirty, true);
    assert.ok(document.elements['ppte-outline-pane'].classList.contains('hidden'));
    editor._pptBuilder = null;
  }

  // ── _markOutlineFromEditor only reads the DOM while the outline tab is active ──
  {
    const pb = { outline: 'x', outlineDirty: false, activeTab: 'slide' };
    document.elements['ppte-outline-edit'].value = 'should-not-count';
    editor._markOutlineFromEditor(pb);
    assert.equal(pb.outlineDirty, false, 'hidden outline textarea must not dirty the outline');
    pb.activeTab = 'outline';
    editor._markOutlineFromEditor(pb);
    assert.equal(pb.outline, 'should-not-count');
    assert.equal(pb.outlineDirty, true);
  }

  // ── live refresh: outline.md change handling ──
  {
    const pb = {
      folderPath: '/deck',
      slides: [{ file: 'slide01.html', title: 'A', html: '<h1>A</h1>', dirty: false }],
      currentSlideIndex: 0,
      outline: '本地大纲',
      outlineDirty: false,
      activeTab: 'slide',
      fileStats: {},
    };
    editor._pptBuilder = pb;

    // own-save echo: disk content identical -> silent stat refresh, no overwrite
    diskOutline = '本地大纲';
    await editor._handlePptEditorFileChanged({ folderPath: '/deck', files: ['outline.md'] });
    assert.equal(pb.outline, '本地大纲');
    assert.ok(pb.fileStats['outline.md'], 'echo refresh must update the stat baseline');

    // external change, local clean -> adopt disk version
    diskOutline = '外部大纲';
    await editor._handlePptEditorFileChanged({ folderPath: '/deck', files: ['outline.md'] });
    assert.equal(pb.outline, '外部大纲', 'clean outline must follow external edits');

    // external change, local dirty -> keep local
    pb.outlineDirty = true;
    pb.outline = '未保存大纲';
    diskOutline = '又来一个外部版本';
    await editor._handlePptEditorFileChanged({ folderPath: '/deck', files: ['outline.md'] });
    assert.equal(pb.outline, '未保存大纲', 'dirty outline must never be clobbered');

    editor._pptBuilder = null;
  }

  // ---------- workbench-window.js sandbox ----------
  {
    const wbContext = {
      console,
      window: {},
      document: { getElementById() { return null; }, addEventListener() {} },
      setTimeout, clearTimeout, setInterval, clearInterval,
    };
    vm.createContext(wbContext);
    vm.runInContext(`${workbenchSource}\nglobalThis.WorkbenchWindow = window.WorkbenchWindow;`, wbContext);
    const wb = wbContext.WorkbenchWindow;
    assert.ok(wb, 'WorkbenchWindow should be defined');

    wb.manifest = { title: '安装课', slides: [{ title: '封面', file: 'slide01.html' }], outline: '' };
    assert.equal(wb._outlinePromptBlock(), '', 'no outline -> no prompt block');
    assert.ok(!wb._systemPrompt().includes('[用户章纲]'), 'system prompt stays clean without outline');

    wb.manifest.outline = '# AndroidStudio 安装\n## 第一章 下载\n第1页：封面';
    const block = wb._outlinePromptBlock();
    assert.ok(block.includes('# AndroidStudio 安装'), 'outline text must reach the prompt');
    assert.ok(block.includes('章纲'), 'block must explain the outline role');
    assert.ok(wb._systemPrompt().includes('[用户章纲]'), 'planning system prompt must carry the outline');

    wb._activeTask = { userInstruction: '生成整套课件' };
    const plan = {
      visualSystem: {},
      slides: [
        { page: 1, role: 'cover', title: '封面', layoutFamily: 'cover', motion: 'none' },
        { page: 2, role: 'content', title: '下载', layoutFamily: 'content', motion: 'none' },
      ],
    };
    const pageContext = wb._harnessPageContext(plan, plan.slides[1]);
    assert.ok(pageContext.includes('# AndroidStudio 安装'), 'legacy per-page context must carry the outline');
    assert.ok(pageContext.indexOf('[用户章纲]') > pageContext.indexOf('[整套任务原始目标]'), 'outline follows the original goal');

    // Pi start_page payload folds the outline into user_instruction (client-only)
    const piInstruction = [wb._activeTask.userInstruction, wb._outlinePromptBlock()].filter(Boolean).join('\n\n');
    assert.ok(piInstruction.includes('生成整套课件') && piInstruction.includes('# AndroidStudio 安装'));
  }

  // ---------- write_outline tool (ppte-workbench-agent.js) ----------
  {
    const agentSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'ppte-workbench-agent.js'), 'utf8');
    const saveCalls = [];
    const fakeEditor = {
      _pptBuilder: null,
      _updatePptOutlineStatus() {},
      async _savePptBuilderData(pb) {
        saveCalls.push(pb.outline);
        pb.outlineDirty = false;
        return { saved: ['outline.md'], conflicts: [] };
      },
    };
    const agentContext = {
      console,
      window: { PpteEditor: fakeEditor },
      document: { getElementById() { return null; } },
      setTimeout, clearTimeout,
    };
    vm.createContext(agentContext);
    vm.runInContext(`${agentSource}\nglobalThis.Agent = window.PpteWorkbenchAgent;`, agentContext);
    const agent = agentContext.Agent;
    assert.ok(agent, 'PpteWorkbenchAgent should be defined');

    // success path: clean editor state -> content written through the save pipeline
    const pb = { folderPath: '/deck', outline: '', outlineDirty: false, activeTab: 'slide' };
    fakeEditor._pptBuilder = pb;
    const ok = await agent._toolWriteOutline(pb, { content: '# 新大纲' });
    assert.ok(ok.includes('已保存'), `expected success, got: ${ok}`);
    assert.equal(pb.outline, '# 新大纲');
    assert.deepEqual(saveCalls, ['# 新大纲'], 'write must go through _savePptBuilderData');

    // empty content is refused before touching state
    const refused = await agent._toolWriteOutline(pb, { content: '   ' });
    assert.ok(refused.includes('失败'));

    // unsaved user edits are never clobbered
    pb.outlineDirty = true;
    pb.outline = '用户未保存的内容';
    const blocked = await agent._toolWriteOutline(pb, { content: '# AI 大纲' });
    assert.ok(blocked.includes('未保存'), `expected dirty-guard message, got: ${blocked}`);
    assert.equal(pb.outline, '用户未保存的内容', 'dirty outline must survive a refused write');
    pb.outlineDirty = false;

    // disk conflict rolls back the in-memory state
    fakeEditor._savePptBuilderData = async () => ({ cancelled: true, reason: 'conflict' });
    pb.outline = '磁盘上的版本';
    const conflict = await agent._toolWriteOutline(pb, { content: '# 又一版' });
    assert.ok(conflict.includes('失败'));
    assert.equal(pb.outline, '磁盘上的版本', 'conflict must roll back to the previous outline');
    assert.equal(pb.outlineDirty, false);

    // display name keeps the raw tool id out of the UI
    const wbSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'workbench-window.js'), 'utf8');
    assert.match(wbSource, /write_outline:\s*'写入课件大纲'/);
  }
}

main()
  .then(() => console.log('test-ppte-outline: all assertions passed'))
  .catch((err) => { console.error(err); process.exit(1); });
