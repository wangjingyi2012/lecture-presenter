const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const workbenchPath = path.join(__dirname, '..', 'src', 'js', 'workbench-window.js');
const source = fs.readFileSync(workbenchPath, 'utf8');
const agentPath = path.join(__dirname, '..', 'src', 'js', 'ppte-workbench-agent.js');
const agentSource = fs.readFileSync(agentPath, 'utf8');
const createPath = path.join(__dirname, '..', 'src', 'js', 'ppte-create.js');
const createSource = fs.readFileSync(createPath, 'utf8');
const editorSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'ppte-editor.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'workbench.html'), 'utf8');

const context = {
  console,
  window: {},
  document: { addEventListener() {} },
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
};

vm.createContext(context);
vm.runInContext(`${source}\nglobalThis.WorkbenchWindow = window.WorkbenchWindow;`, context);

const wb = context.WorkbenchWindow;
assert.ok(wb, 'WorkbenchWindow should be defined');
assert.equal('maxToolRounds' in wb, false, 'deck-level Agent must not have a fixed tool-round cap');
assert.match(htmlSource, /id="wb-stop"/, 'workbench needs a user-visible stop control');
assert.match(source, /recoveryRounds > 3/, 'protocol recovery must stop before an infinite paid loop');
assert.match(source, /deckValidated = false/, 'deck mutations must invalidate earlier deck validation');
assert.doesNotMatch(source, /const phrases = \['思考中'/, 'workbench must not simulate model thinking with rotating phrases');
assert.match(htmlSource, /vendor\/marked\.min\.js/, 'workbench should load the Markdown renderer');
assert.match(htmlSource, /\.markdown-body table/, 'workbench should style rendered Markdown tables');
assert.doesNotMatch(editorSource, /templateFilesDirty:\s*!!templateFiles/, 'persisted template assets must not be marked dirty when a new PPTE opens');
assert.match(editorSource, /templateFilesDirty:\s*false/, 'new PPTE template assets should start clean');

const editorContext = {
  console,
  window: { Settings: {} },
  document: { getElementById() { return null; }, addEventListener() {} },
  setTimeout() { return 0; },
  clearTimeout() {},
};
vm.createContext(editorContext);
vm.runInContext(`${editorSource}\nglobalThis.PpteEditor = window.PpteEditor;`, editorContext);
const editor = editorContext.PpteEditor;
editor.showPpteEditor = () => {};
editor._renderPptBuilderInContent = () => {};
editor._startPptEditorWatch = () => {};
editor._openPptBuilder('/tmp/template-deck', {
  title: '模板课件',
  slides: [{ file: 'slide01.html', title: '封面', slide_type: 'cover', html: '<h1>封面</h1>' }],
}, {
  cover_css: 'body{color:red}',
  img_background: 'base64',
});
assert.equal(editor._pptBuilder.templateFilesDirty, false);
assert.deepEqual(Array.from(editor._collectPptSlideFiles(editor._pptBuilder)), [], 'already-persisted template assets must not join the first Agent save');

wb.manifest = { title: '测试课件', slides: [{ title: '封面' }] };
assert.match(wb._systemPrompt(), /不超过 32 个汉字/);
assert.match(wb._systemPrompt(), /最终不再调用工具时/);
assert.equal(wb._compactStatus('好的。\n\n现在读取第 3 页。'), '现在读取第 3 页。');
assert.equal(wb._compactStatus('## 检查结果\n- 已完成全部检查'), '- 已完成全部检查');
assert.equal(wb._hasUnexecutedToolIntent('先读取第 1 页，确认封面风格。'), true);
assert.equal(wb._hasUnexecutedToolIntent('现在校验第 3 页。'), true);
assert.equal(wb._hasUnexecutedToolIntent('检查结果：课件结构完整，无需修改。'), false);

const starterSlides = [
  { file: 'slide01.html', title: '封面', slide_type: 'cover', html: '<link rel="stylesheet" href="style.css"><h1>PPT主标题</h1>' },
  { file: 'slide02.html', title: '目录', slide_type: 'catalog', html: '<link rel="stylesheet" href="catalog.css"><h1>课程导览</h1>' },
  { file: 'slide03.html', title: '章节 1', slide_type: 'chapter', html: '<link rel="stylesheet" href="chapter.css"><h1>章节名称</h1>' },
  { file: 'slide04.html', title: '内容', slide_type: 'content', html: '<link rel="stylesheet" href="content.css"><h1>本页PPT标题</h1>' },
  { file: 'slide05.html', title: '总结', slide_type: 'finish', html: '<link rel="stylesheet" href="finish.css">' },
];
wb.manifest = {
  title: 'AI发展史',
  slides: starterSlides.map(s => ({ title: s.title, slideType: s.slide_type, file: s.file })),
  templateBlueprint: {
    name: '安恒',
    state: 'starter',
    isStarter: true,
    roles: starterSlides.map((s, i) => ({
      page: i + 1,
      title: s.title,
      slideType: s.slide_type,
      file: s.file,
      stylesheets: [`${s.slide_type === 'cover' ? 'style' : s.slide_type}.css`],
    })),
  },
};
assert.match(wb._systemPrompt(), /五页母版/);
assert.match(wb._systemPrompt(), /template_role/);
assert.match(wb._systemPrompt(), /chapter\.css/);
assert.match(wb._systemPrompt(), /结束页必须是最后一页/);
assert.match(wb._systemPrompt(), /set_deck_plan/);
assert.match(wb._systemPrompt(), /search_design_examples/);
assert.match(wb._systemPrompt(), /validate_deck/);
assert.equal(wb._requestedSlideCount('创建一个15页的关于 AI 发展史的课件'), 15);
assert.match(wb._taskInitialization('创建一个15页的关于 AI 发展史的课件'), /只需净新增 10 页/);
assert.match(wb._taskInitialization('创建一个15页的关于 AI 发展史的课件'), /总页数恰好为 15/);
assert.equal(wb._isDeckLevelTask('检查一下课件'), true);
assert.equal(wb._requiresDeckPlan('检查一下课件'), false);
assert.equal(wb._requiresDeckPlan('创建一个15页的课件'), true);

const agentContext = {
  console,
  window: {
    Settings: {},
    CourseLoader: { appConfig: {} },
    Auth: { getToken() { return ''; } },
    __TAURI__: { core: { async invoke() { return false; } } },
  },
  document: { getElementById() { return null; }, querySelector() { return null; }, createElement() { return {}; } },
};
vm.createContext(agentContext);
vm.runInContext(`${agentSource}\nglobalThis.PpteWorkbenchAgent = window.PpteWorkbenchAgent;`, agentContext);
const agent = agentContext.PpteWorkbenchAgent;
const pb = {
  manifest: { title: 'AI发展史' },
  slides: starterSlides.map((s, i) => ({ ...s, id: `s${i + 1}` })),
  currentSlideIndex: 0,
  manifestDirty: false,
};
agentContext.window.Settings._pptBuilder = pb;
agentContext.window.Settings._newPpteId = () => 'new-slide';
agentContext.window.Settings._nextPpteSlideFile = () => 'slide06.html';
const successfulSave = async (currentPb) => ({
  saved: ['manifest.json', ...currentPb.slides.filter(s => s.dirty || s.created).map(s => s.file)],
  conflicts: [],
});
agentContext.window.Settings._savePptBuilderData = successfulSave;
agentContext.window.Settings._renderPptBuilderInContent = () => {};
agentContext.window.Settings._markCurrentSlideFromEditor = () => {};

const legacyBlueprint = agent._templateBlueprint(pb);
assert.equal(legacyBlueprint.isStarter, true, 'legacy five-page decks should be recognized as starter templates');
assert.deepEqual(Array.from(legacyBlueprint.roles, r => r.slideType), ['cover', 'catalog', 'chapter', 'content', 'finish']);

const createContext = { window: { Settings: {} }, console, document: {} };
vm.createContext(createContext);
vm.runInContext(`${createSource}\nglobalThis.PpteCreate = window.PpteCreate;`, createContext);
const templateMeta = createContext.PpteCreate._buildAgentTemplateMetadata('安恒', starterSlides);
assert.equal(templateMeta.state, 'starter');
assert.equal(templateMeta.name, '安恒');
assert.deepEqual(Array.from(templateMeta.roles, r => r.slideType), ['cover', 'catalog', 'chapter', 'content', 'finish']);

async function testTemplateAwareInsertKeepsFinishLast() {
  const result = await agent._toolInsertSlide(pb, {
    tool: 'insert_slide',
    after: 5,
    template_role: 'chapter',
    slide_type: 'chapter',
    title: '第二章 大模型时代',
  });
  assert.equal(pb.slides.length, 6);
  assert.equal(pb.slides[4].title, '第二章 大模型时代', 'new content should be inserted before finish');
  assert.equal(pb.slides[4].slide_type, 'chapter', 'inserted page should preserve the requested template role');
  assert.equal(pb.slides[4].html, starterSlides[2].html, 'inserted page should clone the selected template HTML');
  assert.equal(pb.slides[5].slide_type, 'finish', 'finish page must remain last');
  assert.equal(pb.manifest.agentTemplate.state, 'initialized');
  assert.match(result, /结束页为第6页/);

  const rejected = await agent._toolReorderSlides(pb, { order: [1, 2, 3, 4, 6, 5] });
  assert.match(rejected, /结束页必须保持在最后一页/);
}

async function testStarterDeckExpandsToExactlyFifteenPages() {
  const deck = {
    manifest: {
      title: 'AI发展史',
      agentTemplate: {
        schemaVersion: 1,
        name: '安恒',
        state: 'starter',
        roles: starterSlides.map(s => ({ file: s.file, title: s.title, slideType: s.slide_type })),
      },
    },
    slides: starterSlides.map((s, i) => ({ ...s, id: `deck-s${i + 1}` })),
    currentSlideIndex: 0,
    manifestDirty: false,
  };
  let nextFile = 6;
  agentContext.window.Settings._pptBuilder = deck;
  agentContext.window.Settings._nextPpteSlideFile = () => `slide${String(nextFile++).padStart(2, '0')}.html`;
  const roles = ['content', 'content', 'chapter', 'content', 'content', 'content', 'chapter', 'content', 'content', 'content'];
  for (let i = 0; i < roles.length; i++) {
    await agent._toolInsertSlide(deck, {
      tool: 'insert_slide',
      after: 5 + i,
      template_role: roles[i],
      slide_type: roles[i],
      title: `新增页面 ${i + 1}`,
    });
  }
  assert.equal(deck.slides.length, 15, 'five template pages plus ten net additions must equal the requested 15 pages');
  assert.equal(deck.slides.at(-1).slide_type, 'finish', 'the original finish template must end the 15-page deck');
  assert.equal(deck.slides.filter(s => s.slide_type === 'chapter').length, 3);
  assert.ok(deck.slides.filter(s => s.slide_type === 'chapter').every(s => s.html.includes('chapter.css')));
  assert.ok(deck.slides.filter(s => s.slide_type === 'content').every(s => s.html.includes('content.css')));
}

async function testCancelledSaveRollsBackAgentMutation() {
  const deck = {
    manifest: { title: '保存冲突测试', slides: [] },
    slides: [{
      id: 'original',
      file: 'slide01.html',
      title: '原始标题',
      slide_type: 'cover',
      html: '<h1>原始内容</h1>',
      dirty: false,
      created: false,
    }],
    currentSlideIndex: 0,
    manifestDirty: false,
    templateFilesDirty: false,
    fileStats: { 'manifest.json': { exists: true } },
  };
  deck.manifest.slides = deck.slides;
  agentContext.window.Settings._pptBuilder = deck;
  agentContext.window.Settings._savePptBuilderData = async () => ({
    saved: [],
    conflicts: ['catalog.css'],
    cancelled: true,
  });
  const result = await agent._toolWriteSlide(deck, {
    tool: 'write_slide',
    page: 1,
    title: '错误的新标题',
    html: '<h1>不应留在内存</h1>',
  });
  assert.match(result, /保存失败/);
  assert.match(result, /catalog\.css/);
  assert.equal(deck.slides[0].title, '原始标题');
  assert.equal(deck.slides[0].html, '<h1>原始内容</h1>');
  agentContext.window.Settings._savePptBuilderData = successfulSave;
}

async function testWorkbenchStopsAfterDiskSaveFailure() {
  const replies = [`保存页面\n\`\`\`action\n${JSON.stringify({ tool: 'insert_slide', after: 1, title: '不会继续' })}\n\`\`\``];
  let aiCalls = 0;
  let finalMarkdown = '';
  wb.history = [{ role: 'system', content: 'test' }];
  wb._callAI = async () => replies[aiCalls++];
  wb._rpc = async () => 'insert_slide 保存失败：检测到文件冲突：catalog.css。已恢复执行前状态，本轮必须停止。';
  wb._appendAssistantMarkdown = text => { finalMarkdown = text; };
  wb._log = () => {};
  wb._logAction = () => {};
  wb._finishAction = () => {};
  wb._logResult = () => {};
  wb._setBusy = () => {};
  await wb._runTurn();
  assert.equal(aiCalls, 1, 'workbench must not continue the model loop after a disk-save failure');
  assert.match(finalMarkdown, /任务已停止/);
  assert.match(finalMarkdown, /catalog\.css/);
}

async function testLongDeckJobRunsToCompletion() {
  const actionRounds = 20;
  const replies = ['先读取第 1 页，确认封面风格。'];
  replies.push(...Array.from({ length: actionRounds }, (_, i) =>
    `处理中\n\`\`\`action\n${JSON.stringify({ tool: 'read_slide', page: i + 1 })}\n\`\`\``
  ));
  replies.push('整套课件处理完成。');

  const logs = [];
  const executed = [];
  let aiCalls = 0;

  wb.history = [{ role: 'system', content: 'test' }];
  wb._callAI = async () => {
    const reply = replies[aiCalls];
    aiCalls += 1;
    return reply;
  };
  wb._appendAssistantMarkdown = () => {};
  wb._rpc = async (type, payload) => {
    assert.equal(type, 'execute-action');
    executed.push(payload.action);
    return `第${payload.action.page}页已读取`;
  };
  wb._log = (type, text) => logs.push({ type, text });
  wb._logAction = () => {};
  wb._logResult = () => {};
  wb._setBusy = () => {};

  await wb._runTurn();

  assert.equal(aiCalls, actionRounds + 2, 'Agent should recover when the model describes a tool without calling it');
  assert.equal(executed.length, actionRounds, 'all tool actions should execute');
  assert.equal(wb.history.some(x => String(x.content).includes('[工具协议纠正]')), true);
  assert.equal(wb.busy, false, 'busy state should be cleared after completion');
  assert.equal(logs.some(x => String(x.text).includes('工具调用上限')), false);
}

async function testDeckTaskRequiresPlanBeforeMutationAndValidationBeforeFinish() {
  const plan = {
    targetSlideCount: 1,
    visualSystem: { style: 'test' },
    slides: [{ page: 1, role: 'cover', title: '测试', contentKind: 'cover', layoutFamily: 'cover', componentIds: [], motion: 'none', visualIntent: '测试' }],
  };
  const replies = [
    `直接写页\n\`\`\`action\n${JSON.stringify({ tool: 'write_slide', page: 1, html: '<h1>blocked</h1>' })}\n\`\`\``,
    `保存蓝图\n\`\`\`action\n${JSON.stringify({ tool: 'set_deck_plan', plan })}\n\`\`\``,
    `写入页面\n\`\`\`action\n${JSON.stringify({ tool: 'write_slide', page: 1, html: '<h1>ok</h1>' })}\n\`\`\``,
    '任务完成。',
    `整套校验\n\`\`\`action\n${JSON.stringify({ tool: 'validate_deck' })}\n\`\`\``,
    '任务完成。',
  ];
  const executed = [];
  let aiCalls = 0;
  wb._activeTask = { deckLevel: true, requiresPlan: true, planSaved: false, deckValidated: false };
  wb.history = [{ role: 'system', content: 'test' }];
  wb._callAI = async () => replies[aiCalls++];
  wb._rpc = async (_type, payload) => {
    executed.push(payload.action.tool);
    if (payload.action.tool === 'validate_deck') return JSON.stringify({ passed: true });
    return `${payload.action.tool} 已完成`;
  };
  wb._appendAssistantMarkdown = () => {};
  wb._log = () => {};
  wb._logAction = () => {};
  wb._finishAction = () => {};
  wb._logResult = () => {};
  wb._setBusy = () => {};

  await wb._runTurn();

  assert.deepEqual(executed, ['set_deck_plan', 'write_slide', 'validate_deck']);
  assert.equal(wb.history.some(x => String(x.content).includes('[规划门禁]')), true);
  assert.equal(wb.history.some(x => String(x.content).includes('[完成门禁]')), true);
}

async function testDeckInspectionRequiresValidationButNotPlan() {
  const replies = [
    `整套校验\n\`\`\`action\n${JSON.stringify({ tool: 'validate_deck' })}\n\`\`\``,
    '检查完成。',
  ];
  const executed = [];
  let aiCalls = 0;
  wb._activeTask = { deckLevel: true, requiresPlan: false, planSaved: true, deckValidated: false };
  wb.history = [{ role: 'system', content: 'test' }];
  wb._callAI = async () => replies[aiCalls++];
  wb._rpc = async (_type, payload) => {
    executed.push(payload.action.tool);
    return JSON.stringify({ passed: true });
  };
  wb._appendAssistantMarkdown = () => {};
  wb._log = () => {};
  wb._logAction = () => {};
  wb._finishAction = () => {};
  wb._logResult = () => {};
  wb._setBusy = () => {};

  await wb._runTurn();

  assert.deepEqual(executed, ['validate_deck']);
  assert.equal(wb.history.some(x => String(x.content).includes('[规划门禁]')), false);
}

async function testOptionalPlanToolsUseSeparateTauriStorage() {
  const calls = [];
  agentContext.window.Auth.getToken = () => 'token';
  agentContext.window.__TAURI__.core.invoke = async (command, payload) => {
    calls.push({ command, payload });
    if (command === 'ppte_agent_plan_write') return payload.plan;
    if (command === 'lectureai_design_examples') return { count: 1, items: [{ id: 'history-event-01' }] };
    return false;
  };
  const planResult = await agent._toolSetDeckPlan({ folderPath: '/tmp/old-ppte' }, {
    plan: {
      targetSlideCount: 1,
      visualSystem: { style: 'test' },
      slides: [{ page: 1, role: 'cover', title: '封面', contentKind: 'cover', layoutFamily: 'cover', componentIds: [], motion: 'none', visualIntent: '建立主题' }],
    },
  });
  const examples = await agent._toolSearchDesignExamples({ content_kind: 'historical_event' });
  assert.match(planResult, /课件蓝图/);
  assert.match(examples, /history-event-01/);
  assert.deepEqual(calls.map(call => call.command), ['ppte_agent_plan_write', 'lectureai_design_examples']);
}

(async () => {
  agentContext.window.Settings._pptBuilder = pb;
  await testTemplateAwareInsertKeepsFinishLast();
  await testStarterDeckExpandsToExactlyFifteenPages();
  await testCancelledSaveRollsBackAgentMutation();
  await testWorkbenchStopsAfterDiskSaveFailure();
  await testLongDeckJobRunsToCompletion();
  await testDeckTaskRequiresPlanBeforeMutationAndValidationBeforeFinish();
  await testDeckInspectionRequiresValidationButNotPlan();
  await testOptionalPlanToolsUseSeparateTauriStorage();
})()
  .then(() => console.log('test-workbench-window: all assertions passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
