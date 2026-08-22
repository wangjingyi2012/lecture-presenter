// test-patch-applicator.js — patch applicator vocabulary tests (apply_patch).
// DOM ops replay on a clean parse of the slide HTML via an injectable parser;
// the vm sandbox has no DOMParser, so tests inject a minimal stub DOM (the
// same approach test-ppte-visual-editor.js uses for path resolution).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const agentSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'ppte-workbench-agent.js'), 'utf8');

const invokeCalls = [];
const context = {
  console,
  window: {
    Settings: {},
    CourseLoader: { appConfig: {} },
    Auth: { getToken() { return 'token'; } },
    __TAURI__: {
      core: {
        async invoke(command, args) {
          invokeCalls.push({ command, args });
          if (command === 'ppte_agent_revision_get') return { deckHash: `sha256:${'a'.repeat(64)}` };
          if (command === 'ppte_task_journal_start') return { runId: args.runId };
          if (command === 'ppte_task_journal_receipt_get') return null;
          if (command === 'ppte_task_journal_append_receipt') return args.receipt;
          if (command === 'ppte_task_journal_before_write') return { ok: true };
          return null;
        },
      },
    },
  },
  document: { getElementById() { return null; } },
  setTimeout,
  clearTimeout,
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(`${agentSource}\nglobalThis.PpteWorkbenchAgent = window.PpteWorkbenchAgent;`, context);
const agent = context.PpteWorkbenchAgent;

// ---- minimal stub DOM (element-child index addressing, no real parsing) ----
function fakeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    innerHTML: '',
    attributes: {},
    styleProps: {},
    appendChild(node) { node.parentNode = el; el.children.push(node); return node; },
    insertBefore(node, ref) {
      node.parentNode = el;
      const i = ref ? el.children.indexOf(ref) : -1;
      if (i >= 0) el.children.splice(i, 0, node);
      else el.children.push(node);
      return node;
    },
    removeChild(node) {
      const i = el.children.indexOf(node);
      if (i >= 0) el.children.splice(i, 1);
      node.parentNode = null;
      return node;
    },
    setAttribute(name, value) { el.attributes[name] = String(value); },
    removeAttribute(name) { delete el.attributes[name]; },
  };
  el.style = {
    setProperty(name, value) { el.styleProps[name] = String(value); },
    removeProperty(name) { delete el.styleProps[name]; },
  };
  Object.defineProperty(el, 'outerHTML', {
    get() {
      const attrs = Object.entries(el.attributes).map(([k, v]) => ` ${k}="${v}"`).join('');
      const style = Object.entries(el.styleProps).map(([k, v]) => `${k}: ${v};`).join(' ');
      const styleAttr = style ? ` style="${style}"` : '';
      return `<${tag}${attrs}${styleAttr}>${el.innerHTML}${el.children.map(child => child.outerHTML).join('')}</${tag}>`;
    },
  });
  return el;
}

function fakeDoc() {
  const body = fakeEl('body');
  const html = fakeEl('html');
  body.parentNode = html;
  html.children = [body];
  return {
    body,
    documentElement: html,
    doctype: { name: 'html' },
    createElement(tag) {
      if (tag === 'template') {
        const tpl = { content: { firstElementChild: null } };
        Object.defineProperty(tpl, 'innerHTML', {
          set(fragment) {
            // Naive fragment parse: enough to assert what got inserted.
            const match = String(fragment).match(/^\s*<([a-z0-9-]+)([^>]*)>([\s\S]*?)<\/\1>\s*$/i);
            const node = fakeEl(match ? match[1] : 'div');
            node.innerHTML = match ? match[3] : String(fragment);
            tpl.content.firstElementChild = node;
          },
        });
        return tpl;
      }
      return fakeEl(tag);
    },
  };
}

function makePb() {
  const pb = {
    manifest: { title: '体检课件', slides: null },
    slides: [
      { id: 's1', file: 'slide01.html', title: '封面', slide_type: 'cover', html: '<h1>封面</h1>' },
      { id: 's2', file: 'slide02.html', title: '要点', slide_type: 'content', html: '<main><p>旧文案</p></main>' },
      { id: 's3', file: 'slide03.html', title: '总结', slide_type: 'finish', html: '<h1>谢谢</h1>' },
    ],
    currentSlideIndex: 0,
    manifestDirty: false,
    folderPath: '/tmp/patch-deck',
  };
  pb.manifest.slides = pb.slides;
  return pb;
}

const settings = context.window.Settings;
function attachPb(pb, saveResult = null) {
  settings._pptBuilder = pb;
  settings._markCurrentSlideFromEditor = () => {};
  settings._renderPptBuilderInContent = () => {};
  settings._savePptBuilderData = saveResult || (async (current) => ({
    saved: ['manifest.json', ...current.slides.filter(s => s.dirty || s.created).map(s => s.file)],
    conflicts: [],
  }));
}

const RUN = 'run_patch_12345678';
const HASH = `sha256:${'b'.repeat(64)}`;
const SPEC = {
  schemaVersion: 1, runId: RUN, intent: 'deck_lint', scope: 'deck',
  targets: { pages: [], outline: false, allowInsert: false, allowDelete: true, allowReorder: true },
  executionStrategy: 'rules_engine', requiresDeckPlan: false, userFacingGoal: '体检整套课件',
  acceptanceCriteria: [{ type: 'no_unplanned_mutation' }], requiredCapabilities: ['slide.read'],
  confidence: 1, requiresClarification: false,
};

async function main() {
  // ---- path guard ----
  assert.equal(agent._patchSafeRelativePath('slide01.html'), 'slide01.html');
  assert.equal(agent._patchSafeRelativePath('resources/a.png'), 'resources/a.png');
  assert.equal(agent._patchSafeRelativePath('../evil.html'), '');
  assert.equal(agent._patchSafeRelativePath('/etc/hosts'), '');
  assert.equal(agent._patchSafeRelativePath('C:/windows/x'), '');
  assert.equal(agent._patchSafeRelativePath('a//b'), '');
  assert.equal(agent._patchSafeRelativePath(''), '');

  // ---- vocabulary support gate ----
  assert.equal(agent._patchSupportError({ op: 'css_set' }, SPEC), null);
  assert.equal(agent._patchSupportError({ op: 'future_op' }, SPEC).code, 'PATCH_VOCABULARY_UNSUPPORTED');
  assert.match(agent._patchSupportError({ op: 'css_set', vocabularyVersion: 99 }, SPEC).userMessage, /请升级应用后重试/);
  assert.equal(agent._patchSupportError({ op: 'css_set' }, { ...SPEC, vocabularyVersion: 99 }).code, 'PATCH_VOCABULARY_UNSUPPORTED');

  // ---- manifest_splice: retitle + reorder + delete in one working order ----
  {
    const pb = makePb();
    attachPb(pb);
    const result = await agent._toolApplyPatch(pb, {
      op: 'manifest_splice',
      ops: [
        { type: 'retitle', page: 2, title: '核心要点' },
        { type: 'delete', page: 2, pageId: 's2' },
      ],
      label: '整理页序',
      _taskRunId: RUN,
      _taskSpec: SPEC,
    });
    assert.match(result, /^apply_patch 已应用/);
    assert.equal(pb.slides.length, 2);
    assert.equal(pb.slides[1].id, 's3', 'finish page stays last after the delete');
    assert.equal(pb.manifestDirty, true);
  }

  // ---- manifest_splice: unauthorized delete is refused ----
  {
    const pb = makePb();
    attachPb(pb);
    const denied = await agent._toolApplyPatch(pb, {
      op: 'manifest_splice', ops: [{ type: 'delete', page: 2 }],
      _taskRunId: RUN, _taskSpec: { ...SPEC, targets: { ...SPEC.targets, allowDelete: false } },
    });
    assert.match(denied, /^apply_patch 失败：当前 LectureAI 任务未授权删除页面/);
    assert.equal(pb.slides.length, 3, 'nothing is written when the batch is refused');

    const reorderBad = await agent._toolApplyPatch(pb, {
      op: 'manifest_splice', ops: [{ type: 'reorder', order: [3, 2, 1] }],
      _taskRunId: RUN, _taskSpec: SPEC,
    });
    assert.match(reorderBad, /结束页必须保持在最后一页/);
    assert.deepEqual(pb.slides.map(s => s.id), ['s1', 's2', 's3']);
  }

  // ---- file_write: slide content, safe asset, rejected targets ----
  {
    const pb = makePb();
    attachPb(pb);
    invokeCalls.length = 0;
    const okSlide = await agent._toolApplyPatch(pb, { op: 'file_write', file: 'slide02.html', content: '<main>新内容</main>' });
    assert.match(okSlide, /^apply_patch 已应用/);
    assert.equal(pb.slides[1].html, '<main>新内容</main>');
    assert.equal(pb.slides[1].dirty, true);

    const okAsset = await agent._toolApplyPatch(pb, { op: 'file_write', file: 'theme.css', content: 'body{}' });
    assert.match(okAsset, /^apply_patch 已应用/);
    const write = invokeCalls.find(call => call.command === 'write_text_file');
    assert.equal(write.args.filePath, '/tmp/patch-deck/theme.css');
    assert.equal(write.args.content, 'body{}');

    for (const file of ['manifest.json', 'outline.md', '.lectureai/run.json', '.ppte-template/roles/cover.html', '../evil.html']) {
      const rejected = await agent._toolApplyPatch(pb, { op: 'file_write', file, content: 'x' });
      assert.match(rejected, /^apply_patch 失败：/, `${file} must be rejected`);
    }
  }

  // ---- baseDeckRevision drift rejects the patch without writing ----
  {
    const pb = makePb();
    attachPb(pb);
    const stale = await agent._toolApplyPatch(pb, {
      op: 'manifest_splice', ops: [{ type: 'retitle', page: 1, title: 'x' }],
      baseDeckRevision: `sha256:${'f'.repeat(64)}`,
      _taskRunId: RUN, _taskSpec: SPEC,
    });
    assert.match(stale, /课件已在任务执行期间发生变化/);
    assert.equal(pb.slides[0].title, '封面', 'a stale batch never writes');
  }

  // ---- DOM ops on the injected stub parser ----
  {
    const pb = makePb();
    attachPb(pb);
    const doc = fakeDoc();
    const card = fakeEl('div');
    card.innerHTML = '<p>旧文案</p>';
    doc.body.appendChild(card);
    const stub = { parseFromString: () => doc };
    agent._newPatchDomParser = () => stub;
    try {
      const css = await agent._toolApplyPatch(pb, { op: 'css_set', file: 'slide02.html', path: '0', property: 'border-left', value: 'none' });
      assert.match(css, /^apply_patch 已应用/);
      assert.equal(card.styleProps['border-left'], 'none');
      assert.ok(pb.slides[1].html.includes('border-left: none;'), 'serialized HTML carries the new style');
      assert.ok(pb.slides[1].html.startsWith('<!DOCTYPE html>'));

      const text = await agent._toolApplyPatch(pb, { op: 'text_replace', file: 'slide02.html', path: '0', old: '旧文案', new: '新文案' });
      assert.match(text, /^apply_patch 已应用/);
      assert.equal(card.innerHTML, '<p>新文案</p>');

      const missing = await agent._toolApplyPatch(pb, { op: 'text_replace', file: 'slide02.html', path: '0', old: '不存在', new: 'x' });
      assert.match(missing, /目标文本与当前页面不一致/);

      const attr = await agent._toolApplyPatch(pb, { op: 'attr_set', file: 'slide02.html', path: '0', attr: 'data-tone', value: 'calm' });
      assert.match(attr, /^apply_patch 已应用/);
      assert.equal(card.attributes['data-tone'], 'calm');

      const insert = await agent._toolApplyPatch(pb, { op: 'dom_insert', file: 'slide02.html', path: '0', position: 'append', html: '<span class="term">术语</span>' });
      assert.match(insert, /^apply_patch 已应用/);
      assert.equal(card.children.length, 1);
      assert.equal(card.children[0].tagName, 'SPAN');

      const remove = await agent._toolApplyPatch(pb, { op: 'dom_remove', file: 'slide02.html', path: '0/0' });
      assert.match(remove, /^apply_patch 已应用/);
      assert.equal(card.children.length, 0);

      const badPath = await agent._toolApplyPatch(pb, { op: 'dom_remove', file: 'slide02.html', path: '9/9' });
      assert.match(badPath, /目标元素不存在/);
      const noSlide = await agent._toolApplyPatch(pb, { op: 'css_set', file: 'slide99.html', path: '0', property: 'color', value: 'red' });
      assert.match(noSlide, /不在当前课件页序中/);
    } finally {
      delete agent._newPatchDomParser;
    }
  }

  // ---- commit failure rolls the builder back (batch-level rollback) ----
  {
    const pb = makePb();
    attachPb(pb, async () => ({ saved: [], conflicts: ['slide02.html'] }));
    const failed = await agent._toolApplyPatch(pb, { op: 'file_write', file: 'slide02.html', content: '<main>新内容</main>' });
    assert.match(failed, /^apply_patch 失败：/);
    assert.equal(pb.slides[1].html, '<main><p>旧文案</p></main>', 'conflicted saves restore the pre-patch state');
    assert.equal(pb.slides[1].dirty, undefined);
  }

  // ---- receipt orchestration through execute-task-action ----
  {
    const pb = makePb();
    attachPb(pb);
    invokeCalls.length = 0;
    const receipt = await agent._executeTaskAction({
      runId: RUN,
      taskSpec: SPEC,
      action: { tool: 'apply_patch', op: 'manifest_splice', ops: [{ type: 'retitle', page: 1, title: '新封面' }], label: '优化封面标题', patchId: 'p-1' },
      envelope: { actionId: `${RUN}:rules:p-1`, argsHash: HASH },
    });
    assert.equal(receipt.ok, true);
    assert.equal(receipt.result.patchId, 'p-1');
    assert.equal(receipt.result.op, 'manifest_splice');
    assert.equal(receipt.result.applied, true);
    assert.equal(pb.slides[0].title, '新封面');
    const receipts = invokeCalls.filter(call => call.command === 'ppte_task_journal_append_receipt').map(call => call.args.receipt);
    assert.equal(receipts[0].status, 'pending', 'a pending receipt is journaled before the write');
    assert.equal(receipts.at(-1).ok, true, 'the final receipt is journaled after the write');
    const beforeWrite = invokeCalls.find(call => call.command === 'ppte_task_journal_before_write');
    assert.ok(beforeWrite, 'the batch revert point is established before writing');
    assert.ok(beforeWrite.args.paths.includes('manifest.json'));

    // Replay protection: the same actionId returns the recorded receipt.
    const replay = await agent._executeTaskAction({
      runId: RUN,
      taskSpec: SPEC,
      action: { tool: 'apply_patch', op: 'manifest_splice', ops: [{ type: 'retitle', page: 1, title: '又一次' }], label: '优化封面标题', patchId: 'p-1' },
      envelope: { actionId: `${RUN}:rules:p-1`, argsHash: HASH },
    });
    assert.equal(replay.ok, true);
    assert.equal(replay.replayed, true);
    assert.equal(pb.slides[0].title, '新封面', 'a replayed patch does not re-apply');
  }

  // ---- unknown op via execute-task-action: terminal receipt, nothing written ----
  {
    const pb = makePb();
    attachPb(pb);
    invokeCalls.length = 0;
    const receipt = await agent._executeTaskAction({
      runId: RUN,
      taskSpec: SPEC,
      action: { tool: 'apply_patch', op: 'future_op', file: 'slide01.html', label: '未来操作', patchId: 'p-9' },
      envelope: { actionId: `${RUN}:rules:p-9`, argsHash: HASH },
    });
    assert.equal(receipt.ok, false);
    assert.equal(receipt.error.code, 'PATCH_VOCABULARY_UNSUPPORTED');
    assert.equal(receipt.error.retryable, false);
    assert.match(receipt.error.userMessage, /请升级应用后重试/);
    assert.ok(!invokeCalls.some(call => call.command === 'ppte_task_journal_before_write'), 'unsupported patches never establish a write point');
    assert.equal(pb.slides[0].html, '<h1>封面</h1>', 'unsupported patches never write');
    // The batch terminates on the same error when the server retries the patch.
    const again = await agent._executeTaskAction({
      runId: RUN,
      taskSpec: SPEC,
      action: { tool: 'apply_patch', op: 'future_op', file: 'slide01.html', patchId: 'p-9' },
      envelope: { actionId: `${RUN}:rules:p-9`, argsHash: HASH },
    });
    assert.equal(again.error.code, 'PATCH_VOCABULARY_UNSUPPORTED');
  }

  // ---- deck digest structure summary (_slideStructureSummary) ----
  {
    // Real DOM tagName casing: HTML tags uppercase, SVG tags stay lowercase.
    const el = (tag, className, namespaceURI) => ({ tagName: tag, className: className || '', namespaceURI: namespaceURI || null });
    const stubDoc = elements => ({ body: { querySelectorAll: () => elements } });
    const originalParser = agent._newPatchDomParser;
    agent._newPatchDomParser = () => ({ parseFromString: () => stubDoc([
      el('DIV', 'slide cover-page'), el('H1', 'title main'), el('P'), el('SCRIPT'), el('BR'),
      el('SECTION', 'card  extra  '),
    ]) });
    const summary = agent._slideStructureSummary('<div class="slide"></div>');
    // First 12 tag+class features (max 2 classes each), script/br skipped.
    assert.equal(summary, 'div.slide.cover-page,h1.title.main,p,section.card.extra');
    // A large inline SVG (either via namespace or lowercase svg tagNames)
    // never consumes the feature budget: HTML elements after it still fill
    // all 12 entries.
    const svgNS = 'http://www.w3.org/2000/svg';
    const withBigSvg = [
      ...Array.from({ length: 20 }, (_, i) => el('path', `p${i}`, svgNS)),
      el('svg', '', svgNS), el('circle', '', svgNS), el('rect', '', svgNS),
      el('path', 'legacy-stub-no-ns'),
      ...Array.from({ length: 20 }, (_, i) => el('SECTION', `sec s${i}`)),
    ];
    agent._newPatchDomParser = () => ({ parseFromString: () => stubDoc(withBigSvg) });
    const afterSvg = agent._slideStructureSummary('<div></div>');
    assert.equal(afterSvg.split(',').length, 12, 'SVG subtree must not eat the budget');
    assert.ok(!/(^|,)svg|(^|,)path|(^|,)circle|(^|,)rect/.test(afterSvg), `no SVG features leak: ${afterSvg}`);
    // Empty / unparseable input yields no structure field.
    assert.equal(agent._slideStructureSummary(''), null);
    assert.equal(agent._slideStructureSummary('   '), null);
    agent._newPatchDomParser = () => ({ parseFromString: () => stubDoc([]) });
    assert.equal(agent._slideStructureSummary('<p>x</p>'), null);
    // Bounded: a body with many elements never exceeds 300 chars and keeps
    // at most 12 features.
    const many = Array.from({ length: 80 }, (_, i) => el('DIV', `${'a'.repeat(30)}${i} ${'b'.repeat(24)}${i}`));
    agent._newPatchDomParser = () => ({ parseFromString: () => stubDoc(many) });
    const bounded = agent._slideStructureSummary('<div></div>');
    assert.ok(bounded.length <= 300);
    assert.ok(bounded.split(',').length <= 12);
    assert.ok(bounded.endsWith('…'), 'truncated summaries carry an ellipsis marker');
    // With short features the entry cap (12) binds before the length cap.
    const shorts = Array.from({ length: 40 }, () => el('SPAN', 'c'));
    agent._newPatchDomParser = () => ({ parseFromString: () => stubDoc(shorts) });
    assert.equal(agent._slideStructureSummary('<span></span>').split(',').length, 12);
    agent._newPatchDomParser = originalParser;
  }

  // ---- validate_deck / validate_slide diagnostics summarizer ----
  {
    const full = {
      page: 3, pageId: 's-3', available: true, passed: false,
      measure: {
        overflowBoxes: [{ selector: `main.deck`, direction: 'vertical', box: { x: 0, y: 0, w: 10, h: 10 } }],
        wraps: [{ selector: 'p.a', lines: 2 }, { selector: 'p.b', lines: 3 }],
        textBoxes: Array.from({ length: 9 }, (_, i) => ({ selector: `p.t${i}`, box: { x: i, y: i, w: 10, h: 10 }, fontPx: 30 })),
        textBoxesTruncated: true,
      },
      issues: [{ code: 'RENDER_VERTICAL_OVERFLOW', severity: 'error' }, { code: 'RENDER_FONT_TOO_SMALL', severity: 'error' }, { code: 'X', severity: 'warning' }],
    };
    const summary = agent._diagnosticsSummary(full);
    // Count-level measure digest only: no full textBoxes/wraps arrays leak.
    assert.deepEqual(JSON.parse(JSON.stringify(summary.measure)), { overflowCount: 1, wrapCount: 2, textBoxCount: 9, textBoxesTruncated: true });
    const serialized = JSON.stringify(summary);
    assert.ok(!serialized.includes('textBoxes":[') && !serialized.includes('wraps":[') && !serialized.includes('overflowBoxes":['));
    assert.equal(summary.issueCount, 3);
    assert.equal(summary.errorCount, 2);
    assert.equal(summary.passed, false);
    assert.equal(summary.available, true);
    // Selector samples capped at 5 (overflow boxes first, then text boxes).
    assert.equal(summary.sampleSelectors.length, 5);
    assert.equal(summary.sampleSelectors[0], 'main.deck');
    // Sample cap does not exceed 5 even with 60 text boxes.
    const wide = { ...full, measure: { ...full.measure, textBoxes: Array.from({ length: 60 }, (_, i) => ({ selector: `p.x${i}`, box: { x: 0, y: 0, w: 1, h: 1 } })) } };
    assert.equal(agent._diagnosticsSummary(wide).sampleSelectors.length, 5);
    // Missing diagnostics collapse to null (field absent downstream).
    assert.equal(agent._diagnosticsSummary(null), null);
    assert.equal(agent._diagnosticsSummary('x'), null);
  }

  console.log('test-patch-applicator: all assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
