const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const workbenchPath = path.join(__dirname, '..', 'src', 'js', 'workbench-window.js');
const source = fs.readFileSync(workbenchPath, 'utf8');
const slashSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'ppte-slash-commands.js'), 'utf8');
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
vm.runInContext(`${slashSource}\nglobalThis.PpteSlashCommands = window.PpteSlashCommands;`, context);
vm.runInContext(`${source}\nglobalThis.WorkbenchWindow = window.WorkbenchWindow;`, context);

const wb = context.WorkbenchWindow;
const slash = context.PpteSlashCommands;
assert.ok(wb, 'WorkbenchWindow should be defined');
assert.ok(slash, 'PpteSlashCommands should be defined');
assert.equal('maxToolRounds' in wb, false, 'deck-level Agent must not have a fixed tool-round cap');
assert.match(htmlSource, /id="wb-stop"/, 'workbench needs a user-visible stop control');
assert.match(source, /recoveryRounds > 3/, 'protocol recovery must stop before an infinite paid loop');
assert.match(source, /deckValidated = false/, 'deck mutations must invalidate earlier deck validation');
assert.match(source, /get-command-context/, 'concept animation command must request prepared slide context');
assert.match(source, /正在提交模型请求/, 'the first request phase should describe submission truthfully');
assert.match(source, /请求已送达，等待模型首个响应/);
assert.match(source, /模型正在准备下一步工具计划/);
assert.match(source, /用户取消了当前任务/);
assert.match(source, /_turnGeneration/);
assert.match(source, /上游模型暂时不可用，1\.2s 后自动重试/, 'transient LectureAI failures should expose the automatic retry phase');

const originalLogForUserLine = wb._log;
const userLines = [];
wb._log = (_type, text) => userLines.push(text);
wb._appendUser('@4 使用 /concept-animate 重绘', [{ page: 4 }]);
wb._appendUser('重绘这一页', [{ page: 4 }]);
assert.equal(userLines[0], '@4 使用 /concept-animate 重绘', 'an explicit @page must not be duplicated in the user log');
assert.equal(userLines[1], '@4 · 重绘这一页', 'an implicit page context should remain visible');
wb._log = originalLogForUserLine;
assert.doesNotMatch(source, /const phrases = \['思考中'/, 'workbench must not simulate model thinking with rotating phrases');
assert.match(htmlSource, /vendor\/marked\.min\.js/, 'workbench should load the Markdown renderer');
assert.match(htmlSource, /ppte-slash-commands\.js/, 'workbench should load the slash-command registry before chat logic');
assert.match(htmlSource, /id="wb-slash-menu"/, 'workbench should expose a slash-command discovery menu');
assert.doesNotMatch(htmlSource, /\.slash-menu\s*\{[^}]*position:\s*absolute/s, 'picker must stay in normal layout flow so WKWebView scroll layers cannot cover it');
assert.doesNotMatch(htmlSource, /<div class="term-input-area"[^>]*>[\s\S]*?id="wb-slash-menu"/, 'picker must be a sibling above the input area, not an upward-overflowing child');
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
assert.equal(wb._resultIsError('set_deck_plan 已保存课件蓝图（目标 20 页）。'), false);
assert.equal(wb._resultIsError('set_deck_plan 失败：缺少完整 plan 对象'), true);
assert.equal(wb._hasUnexecutedToolIntent('先读取第 1 页，确认封面风格。'), true);
assert.equal(wb._hasUnexecutedToolIntent('现在校验第 3 页。'), true);
assert.equal(wb._hasUnexecutedToolIntent('检查结果：课件结构完整，无需修改。'), false);
assert.equal(wb._isHarnessResumeRequest('继续'), true);
assert.equal(wb._isHarnessResumeRequest('继续生成课件'), true);
assert.equal(wb._isHarnessResumeRequest('继续修改第3页'), false);

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
const harnessPlan = {
  targetSlideCount: 5,
  visualSystem: { colors: { text: '#0f172a' } },
  slides: Array.from({ length: 5 }, (_, index) => ({
    page: index + 1,
    role: index === 0 ? 'cover' : 'content',
    title: `主题${index + 1}`,
    contentKind: 'concept',
    layoutFamily: 'test',
    componentIds: [],
    motion: 'none',
    visualIntent: `意图${index + 1}`,
    templateId: index ? `template-${index + 1}` : undefined,
    narrative: index ? { buildsOn: `衔接${index}`, learningGoal: `目标${index + 1}`, keyTakeaway: `结论${index + 1}`, leadsTo: `衔接${index + 1}` } : undefined,
  })),
};
wb._activeTask = { userInstruction: '创建五页课件' };
const pageContext = wb._harnessPageContext(harnessPlan, harnessPlan.slides[2], { 2: '第二页摘要' }, '保持术语一致');
assert.match(pageContext, /主题1/);
assert.match(pageContext, /主题5/);
assert.match(pageContext, /第二页摘要/);
assert.match(pageContext, /保持术语一致/);
assert.doesNotMatch(pageContext, /<!doctype|```html/i, 'page harness context must never carry slide HTML');
const fixedDirective = { mode: 'replace', page: 3, after: null };
assert.equal(wb._harnessAllowedAction({ tool: 'render_template', mode: 'replace', page: 3, template_id: 'template-3' }, harnessPlan.slides[2], fixedDirective, false), '');
assert.match(wb._harnessAllowedAction({ tool: 'render_template', mode: 'replace', page: 4, template_id: 'template-3' }, harnessPlan.slides[2], fixedDirective, false), /第 3 页/);
assert.match(wb._harnessAllowedAction({ tool: 'render_template', mode: 'replace', page: 3, template_id: 'template-4' }, harnessPlan.slides[2], fixedDirective, false), /规划模板 template-3/);
assert.match(wb._systemPrompt(), /五页母版/);
assert.match(wb._systemPrompt(), /template_role/);
assert.match(wb._systemPrompt(), /chapter\.css/);
assert.match(wb._systemPrompt(), /结束页必须是最后一页/);
assert.match(wb._systemPrompt(), /set_deck_plan/);
assert.match(wb._systemPrompt(), /search_design_examples/);
assert.match(wb._systemPrompt(), /render_template/);
assert.match(wb._systemPrompt(), /validate_deck/);
assert.equal(wb._requestedSlideCount('创建一个15页的关于 AI 发展史的课件'), 15);
assert.equal(wb._explicitSectionRequest('创建一个20页的 AI 发展史课件'), false);
assert.equal(wb._explicitSectionRequest('创建一个20页课件，分成5章'), true);
assert.equal(wb._explicitSectionRequest('创建一个40页课件，不分章节'), false);
assert.equal(wb._explicitSectionRequest('重写课件，修复章节衔接问题'), false);
assert.equal(wb._explicitSectionRequest('重写课件，增加一个目录页'), true);
assert.equal(wb._continuousSectionRequest('创建一个40页课件，不分章节'), true);
assert.match(wb._deckPlanGateError({ targetSlideCount: 21, slides: Array(21).fill({ role: 'content' }) }, 20), /最终 20 页/);
assert.match(wb._deckPlanGateError({ targetSlideCount: 20, slides: Array.from({ length: 20 }, (_, i) => ({ role: i === 1 ? 'catalog' : 'content' })) }, 20), /默认不分章/);
assert.match(wb._deckPlanGateError({ targetSlideCount: 20, slides: Array.from({ length: 20 }, (_, i) => ({ role: i === 2 ? 'chapter' : 'content' })) }, 20), /默认不分章/);
assert.equal(wb._deckPlanGateError({ targetSlideCount: 20, slides: Array.from({ length: 20 }, () => ({ role: 'content' })) }, 20), '');
assert.equal(wb._deckPlanGateError({ targetSlideCount: 20, slides: Array.from({ length: 20 }, (_, i) => ({ role: [2, 5, 9, 13, 16].includes(i) ? 'chapter' : 'content' })) }, 20, true), '');
assert.match(wb._deckPlanGateError({ targetSlideCount: 31, slides: Array.from({ length: 31 }, (_, i) => ({ role: i === 2 ? 'chapter' : 'content' })) }, 31), /恰好包含 2 个/);
assert.equal(wb._deckPlanGateError({ targetSlideCount: 31, slides: Array.from({ length: 31 }, (_, i) => ({ role: [2, 17].includes(i) ? 'chapter' : 'content' })) }, 31), '');
assert.equal(wb._deckPlanGateError({ targetSlideCount: 31, slides: Array.from({ length: 31 }, () => ({ role: 'content' })) }, 31, false, true), '');
const strictNarrativeSlides = [
  { page: 1, role: 'cover' },
  {
    page: 2, role: 'content', templateId: 'concept-definition-boundary',
    narrative: { buildsOn: '主题', learningGoal: '理解定义', keyTakeaway: '定义结论', leadsTo: '进入案例' },
  },
  {
    page: 3, role: 'content', templateId: 'case-facts-conclusion',
    narrative: { buildsOn: '进入案例', learningGoal: '理解案例', keyTakeaway: '案例结论', leadsTo: '进入机制' },
  },
];
assert.equal(wb._deckPlanGateError({ targetSlideCount: 3, qualityPolicy: { schemaVersion: 2 }, slides: strictNarrativeSlides }, 3), '');
assert.match(wb._deckPlanGateError({ targetSlideCount: 3, qualityPolicy: { schemaVersion: 2 }, slides: strictNarrativeSlides.map((slide, index) => index === 2 ? { ...slide, narrative: { ...slide.narrative, buildsOn: '无关主题' } } : slide) }, 3), /leadsTo 必须/);
assert.match(wb._deckPlanGateError({ targetSlideCount: 4, qualityPolicy: { schemaVersion: 2 }, slides: [...strictNarrativeSlides, { page: 4, role: 'content', templateId: 'concept-definition-boundary', narrative: { buildsOn: '进入机制', learningGoal: '理解机制', keyTakeaway: '机制结论', leadsTo: '收束' } }] }, 4), /三页窗口内重复/);
assert.match(wb._taskInitialization('创建一个15页的关于 AI 发展史的课件'), /只需净新增 10 页/);
assert.match(wb._taskInitialization('创建一个15页的关于 AI 发展史的课件'), /总页数恰好为 15/);
assert.match(wb._taskInitialization('创建一个15页的关于 AI 发展史的课件'), /默认不分章/);
assert.equal(wb._isDeckLevelTask('检查一下课件'), true);
assert.equal(wb._requiresDeckPlan('检查一下课件'), false);
assert.equal(wb._requiresDeckPlan('创建一个15页的课件'), true);

const slashFont = slash.parse('@3 /font-check', { currentPage: 8 });
assert.equal(slashFont.command.name, 'font-check');
assert.deepEqual(Array.from(slashFont.pages), [3]);
assert.match(slashFont.instruction, /inspect_slides/);
assert.match(slashFont.instruction, /check:"font"/);
assert.match(slashFont.instruction, /修改后必须再次调用同一检查/);
const slashMotion = slash.parse('/concept-animate 用动画介绍 RAG', { currentPage: 4 });
assert.deepEqual(Array.from(slashMotion.pages), [4]);
assert.match(slashMotion.instruction, /用户补充：用动画介绍 RAG/);
assert.equal(slashMotion.command.check, 'concept-animation');
assert.match(slashMotion.instruction, /check:"concept-animation"/);
const conceptWorkflow = slash.commandWorkflowContext(slashMotion.command);
assert.match(conceptWorkflow, /data-ppte-concept-animation/);
assert.match(conceptWorkflow, /class="content-area ppte-click-stage/);
assert.match(conceptWorkflow, /\.ppte-step-rail/);
assert.match(conceptWorkflow, /prefers-reduced-motion/);
assert.match(conceptWorkflow, /current < maxStep/);
assert.match(conceptWorkflow, /Right\/Space\/PageDown/);
assert.equal(slash.parse('/quality-check').pages.length, 0);
assert.equal(slash.parse('/not-a-command').unknown, 'not-a-command');
assert.match(slash.helpMarkdown(), /\/overflow-check/);
assert.match(slash.helpMarkdown(), /\/layout-check/);
assert.match(slash.helpMarkdown(), /\/student-copy/);
assert.match(slash.helpMarkdown(), /\/concept-animate/);
assert.equal(slash.get('clear').localAction, 'clear');
assert.equal(slash.get('compact').localAction, 'compact');
assert.match(slash.helpMarkdown(), /\/clear/);
assert.match(slash.helpMarkdown(), /\/compact/);
const fontSearch = slash.search('@3 /fon', 7);
assert.equal(fontSearch.items[0].name, 'font-check');
const appliedSlash = slash.applySuggestion('@3 /fon', 7, 'font-check');
assert.equal(appliedSlash.value, '@3 /font-check ');
const allCommands = slash.search('/', 1);
assert.equal(allCommands.items.length, slash.commands.length, 'a bare slash should list every command');
const pageCandidates = slash.searchPages('@', 1, [
  { title: '封面', file: 'slide01.html', slideType: 'cover' },
  { title: 'RAG 工作流', file: 'slides/rag-flow.html', slideType: 'content' },
]);
assert.deepEqual(Array.from(pageCandidates.items, item => item.page), [1, 2], 'a bare @ should list every page');
assert.equal(slash.searchPages('@rag', 4, [
  { title: '封面', file: 'slide01.html' },
  { title: 'RAG 工作流', file: 'slides/rag-flow.html' },
]).items[0].file, 'slides/rag-flow.html', '@ search should match titles and file names');
assert.equal(slash.applyPageSuggestion('/font-check @ra', 15, 2).value, '/font-check @2 ');
assert.equal(slash.search('／', 1).items.length, slash.commands.length, 'full-width slash from a Chinese IME should list commands');
assert.equal(slash.searchPages('＠', 1, [{ title: '封面', file: 'slide01.html' }]).items.length, 1, 'full-width @ should list pages');
const skills = [
  { id: 'deck:ppte-layout', name: 'ppte-layout', description: '优化 PPTE 页面布局', sourceLabel: '外接 · 当前课件' },
  { id: 'user:security-course', name: 'security-course', description: '安全课程案例工作流', sourceLabel: '外接 · 用户导入' },
];
assert.equal(slash.searchSkills('$', 1, skills).items.length, 2, 'a bare $ should list every skill');
assert.equal(slash.searchSkills('$secu', 5, skills).items[0].id, 'user:security-course');
assert.equal(slash.applySkillSuggestion('@2 $ppte', 8, 'ppte-layout').value, '@2 $ppte-layout ');
assert.deepEqual(Array.from(slash.parseSkillNames('$ppte-layout @2 $security-course $ppte-layout')), ['ppte-layout', 'security-course']);

async function testLectureAiRetriesOneTransientUpstreamFailure() {
  const originalSelectedConfig = wb.selectedConfig;
  const originalCallOnce = wb._callAIOnce;
  const originalWait = wb._wait;
  const originalMarkRetry = wb._markModelRetry;
  const originalFinish = wb._finishModelStatus;
  let attempts = 0;
  const retries = [];
  wb.selectedConfig = { aiProvider: 'lectureai' };
  wb._callAIOnce = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('LectureAI 上游模型暂时不可用（HTTP 503）：LLM 服务请求失败');
    return '重试成功';
  };
  wb._wait = async milliseconds => { assert.equal(milliseconds, 1200); };
  wb._markModelRetry = attempt => retries.push(attempt);
  wb._finishModelStatus = () => {};

  assert.equal(await wb._callAI([{ role: 'user', content: 'test' }]), '重试成功');
  assert.equal(attempts, 2);
  assert.deepEqual(retries, [2]);
  assert.equal(wb._isRetryableModelError('已超出本月 AI 配额'), false);
  assert.match(wb._friendlyModelError('LectureAI 上游模型暂时不可用（HTTP 503）', true), /已自动重试 1 次/);

  wb.selectedConfig = originalSelectedConfig;
  wb._callAIOnce = originalCallOnce;
  wb._wait = originalWait;
  wb._markModelRetry = originalMarkRetry;
  wb._finishModelStatus = originalFinish;
}

async function testInputUiBindsWithoutTauriEvents() {
  const elements = {};
  const makeButton = () => ({ onclick: null, hidden: false, dataset: {} });
  const input = {
    value: '',
    selectionStart: 0,
    selectionEnd: 0,
    dataset: {},
    focus() {},
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
  };
  elements['wb-input'] = input;
  elements['wb-send'] = makeButton();
  elements['wb-stop'] = makeButton();
  elements['wb-clear'] = makeButton();
  elements['wb-command-trigger'] = makeButton();
  elements['wb-page-trigger'] = makeButton();
  elements['wb-skill-trigger'] = makeButton();
  elements['wb-skill-import'] = makeButton();
  const originalGetElementById = context.document.getElementById;
  context.document.getElementById = id => elements[id] || null;
  const originalTauri = context.window.__TAURI__;
  context.window.__TAURI__ = undefined;

  await wb.init();

  assert.equal(input.dataset.pickerBound, 'true', 'input handlers must bind even when Tauri events are unavailable');
  assert.equal(typeof input.oninput, 'function');
  assert.equal(typeof elements['wb-command-trigger'].onclick, 'function');
  assert.equal(typeof elements['wb-page-trigger'].onclick, 'function');
  assert.equal(typeof elements['wb-skill-trigger'].onclick, 'function');
  assert.equal(typeof elements['wb-skill-import'].onclick, 'function');
  context.window.__TAURI__ = originalTauri;
  context.document.getElementById = originalGetElementById;
}

function testInputPickerRendering() {
  const input = { value: '/', selectionStart: 1, focus() {}, setSelectionRange() {} };
  const menu = {
    hidden: true,
    innerHTML: '',
    querySelectorAll() { return []; },
    querySelector() { return null; },
  };
  const originalGetElementById = context.document.getElementById;
  context.document.getElementById = id => id === 'wb-input' ? input : (id === 'wb-slash-menu' ? menu : null);
  wb.manifest = { slides: [
    { title: '封面', file: 'slide01.html', slideType: 'cover' },
    { title: '正文', file: 'slide02.html', slideType: 'content' },
  ] };
  wb.skills = skills;
  wb._updateInputPicker();
  assert.equal(menu.hidden, false);
  assert.match(menu.innerHTML, new RegExp(`斜杠命令 · ${slash.commands.length}/${slash.commands.length} 项`));
  assert.match(menu.innerHTML, /\/font-check/);
  assert.match(menu.innerHTML, /字体检查/);
  assert.match(menu.innerHTML, /检查字号、单位和投影可读性/);
  assert.match(menu.innerHTML, /\/help/);

  input.value = '@';
  input.selectionStart = 1;
  wb._updateInputPicker();
  assert.equal(menu.hidden, false, 'a bare @ must open the page picker');
  assert.match(menu.innerHTML, /选择页面 · 2\/2 页/);
  assert.match(menu.innerHTML, /@ slide01\.html/);
  assert.match(menu.innerHTML, /@ slide02\.html/);
  assert.match(menu.innerHTML, /封面/);
  assert.match(menu.innerHTML, /正文/);

  input.value = '$';
  input.selectionStart = 1;
  wb._updateInputPicker();
  assert.equal(menu.hidden, false, 'a bare $ must open the skill picker');
  assert.match(menu.innerHTML, /选择技能 · 2\/2 项/);
  assert.match(menu.innerHTML, /\$ppte-layout/);
  assert.match(menu.innerHTML, /优化 PPTE 页面布局/);
  assert.match(menu.innerHTML, /外接 · 当前课件/);
  context.document.getElementById = originalGetElementById;
}

testInputPickerRendering();

async function testExternalSkillImportRefreshesCatalog() {
  const calls = [];
  const logs = [];
  const originalRpc = wb._rpc;
  const originalLog = wb._log;
  const originalOnContext = wb._onContext;
  const originalGetElementById = context.document.getElementById;
  context.document.getElementById = () => null;
  wb._rpc = async type => {
    calls.push(type);
    if (type === 'import-skill') {
      return {
        imported: [{ name: 'security-course', description: '安全课程工作流', sourceLabel: '外接 · 用户导入' }],
        skipped: [],
      };
    }
    return { title: '测试课件', slides: [], skills: [{ name: 'security-course' }], providers: [] };
  };
  wb._log = (type, message) => logs.push({ type, message });
  wb._onContext = ctx => { wb.skills = ctx.skills || []; };

  await wb._importSkills();

  assert.deepEqual(calls, ['import-skill', 'get-context']);
  assert.equal(wb.skills[0].name, 'security-course');
  assert.match(logs[0].message, /\$security-course/);
  wb._rpc = originalRpc;
  wb._log = originalLog;
  wb._onContext = originalOnContext;
  context.document.getElementById = originalGetElementById;
}

const agentContext = {
  console,
  window: {
    Settings: {},
    CourseLoader: { appConfig: {} },
    Auth: { getToken() { return ''; } },
    __TAURI__: { core: { async invoke() { return false; } } },
  },
  document: { getElementById() { return null; }, querySelector() { return null; }, createElement() { return {}; }, body: { appendChild() {} } },
};
vm.createContext(agentContext);
vm.runInContext(`${agentSource}\nglobalThis.PpteWorkbenchAgent = window.PpteWorkbenchAgent;`, agentContext);
const agent = agentContext.PpteWorkbenchAgent;
assert.match(agent._protectedRoleWriteError('catalog', '<link rel="stylesheet" href="brand-catalog.css"><style>.catalog-item{color:#000}</style>', ['brand-catalog.css']), /不能新增或修改/);
assert.equal(agent._protectedRoleWriteError('catalog', '<style>.catalog-item { color: white; }</style>', [], '<style> .catalog-item { color: white; } </style>'), '');
assert.match(agent._protectedRoleWriteError('finish', '<link rel="stylesheet" href="brand-ending.css"><main class="slide"><h1>谢谢</h1></main>', ['brand-ending.css']), /不能叠加正文/);
assert.equal(agent._protectedRoleWriteError('finish', '<link rel="stylesheet" href="brand-ending.css"><main class="slide"><!-- background has text --></main>', ['brand-ending.css']), '');
assert.match(agent._protectedRoleWriteError('chapter', '<link rel="stylesheet" href="content.css"><h1>章节</h1>', ['chapter.css']), /保留角色母版样式 chapter\.css/);
const pb = {
  manifest: { title: 'AI发展史' },
  slides: starterSlides.map((s, i) => ({ ...s, id: `s${i + 1}` })),
  currentSlideIndex: 0,
  manifestDirty: false,
  folderPath: '/tmp/deck',
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

const validConceptAnimation = `
<style>
.ppte-click-layer { position:absolute; opacity:0; }
.ppte-click-layer.is-visible { opacity:1; }
@media (prefers-reduced-motion: reduce) { * { transition:none !important; } }
</style>
<div data-ppte-concept-animation data-step="0" data-max-step="3">
  <div class="ppte-click-canvas">
    <div class="ppte-click-layer" data-show-from="0"></div>
    <div class="ppte-click-layer" data-show-from="1"></div>
    <div class="ppte-click-layer" data-show-from="2"></div>
    <div class="ppte-click-layer" data-show-from="3"></div>
  </div>
  <div class="ppte-step-rail">
    <button class="ppte-step-node" data-target-step="1"><span class="ppte-step-main">检索</span><span class="ppte-step-sub">找到证据</span></button>
    <button class="ppte-step-node" data-target-step="2"><span class="ppte-step-main">增强</span><span class="ppte-step-sub">拼接上下文</span></button>
    <button class="ppte-step-node" data-target-step="3"><span class="ppte-step-main">生成</span><span class="ppte-step-sub">基于证据回答</span></button>
  </div>
  <div class="ppte-step-dots"><span></span><span></span><span></span><span></span></div>
</div>
<script>
root.addEventListener('click', event => {
  const node = event.target.closest('[data-target-step]');
  if (node) goTo(Number(node.dataset.targetStep));
  else if (current < maxStep) goTo(current + 1);
});
document.addEventListener('keydown', event => {
  if (['ArrowRight', ' ', 'PageDown'].includes(event.key) && current < maxStep) { event.preventDefault(); goTo(current + 1); }
  if (['ArrowLeft', 'PageUp'].includes(event.key) && current > 0) { event.preventDefault(); goTo(current - 1); }
});
</script>`;
assert.deepEqual(Array.from(agent._conceptAnimationSourceIssues(validConceptAnimation)), [], 'standard concept animation skeleton should pass its source contract');
const invalidConceptRules = Array.from(agent._conceptAnimationSourceIssues(validConceptAnimation.replaceAll('current < maxStep', 'true').replace('position:absolute', 'position:relative')), issue => issue.rule);
assert.ok(invalidConceptRules.includes('concept-boundary-navigation'), 'boundary release must be validated structurally');
assert.ok(invalidConceptRules.includes('concept-layer-style'), 'stable overlay layers must be validated structurally');

async function testConceptAnimationContextIncludesCurrentNeighborsAndStylesheet() {
  const originalInvoke = agentContext.window.__TAURI__.core.invoke;
  agentContext.window.Settings._pptBuilder = pb;
  agentContext.window.__TAURI__.core.invoke = async (command, payload) => {
    assert.equal(command, 'read_text_file');
    return payload.filePath.endsWith('/content.css')
      ? '.content-area { color: #123456; }'
      : 'body { color: #111111; }';
  };
  const contextText = await agent._getCommandContext({ command: 'concept-animate', pages: [4] });
  assert.match(contextText, /目标页：第 4 页/);
  assert.match(contextText, /相邻页 第3页/);
  assert.match(contextText, /相邻页 第5页/);
  assert.match(contextText, /现有样式 content\.css/);
  assert.match(contextText, /#123456/);
  agentContext.window.__TAURI__.core.invoke = originalInvoke;
}

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

async function testSlashCommandRequiresInspectionAndReinspection() {
  const replies = [
    `直接修改\n\`\`\`action\n${JSON.stringify({ tool: 'write_slide', page: 1, html: '<h1>blocked</h1>' })}\n\`\`\``,
    `检查字体\n\`\`\`action\n${JSON.stringify({ tool: 'inspect_slides', check: 'font', pages: [1] })}\n\`\`\``,
    `修复字体\n\`\`\`action\n${JSON.stringify({ tool: 'write_slide', page: 1, html: '<h1 style="font-size:3vw">ok</h1>' })}\n\`\`\``,
    '已经修复。',
    `重新检查\n\`\`\`action\n${JSON.stringify({ tool: 'inspect_slides', check: 'font', pages: [1] })}\n\`\`\``,
    '字体检查与修复完成。',
  ];
  const executed = [];
  let aiCalls = 0;
  wb._activeTask = {
    deckLevel: false,
    requiresPlan: false,
    planSaved: true,
    deckValidated: false,
    commandCheck: 'font',
    commandPages: [1],
    commandInspected: false,
    commandPassed: false,
  };
  wb.history = [{ role: 'system', content: 'test' }];
  wb._callAI = async () => replies[aiCalls++];
  wb._rpc = async (_type, payload) => {
    executed.push(payload.action.tool);
    if (payload.action.tool === 'inspect_slides') {
      const passed = executed.filter(tool => tool === 'inspect_slides').length > 1;
      return JSON.stringify({ passed, slides: [] });
    }
    return `${payload.action.tool} 已完成`;
  };
  wb._appendAssistantMarkdown = () => {};
  wb._log = () => {};
  wb._logAction = () => {};
  wb._finishAction = () => {};
  wb._logResult = () => {};
  wb._setBusy = () => {};

  await wb._runTurn();

  assert.deepEqual(executed, ['inspect_slides', 'write_slide', 'inspect_slides']);
  assert.equal(wb.history.some(item => String(item.content).includes('[命令门禁]')), true);
  assert.equal(wb.history.some(item => String(item.content).includes('[命令完成门禁]')), true);
  assert.equal(wb._activeTask.commandPassed, true);
}

async function testSlashCommandKeepsPageScope() {
  const replies = [
    `检查错误范围\n\`\`\`action\n${JSON.stringify({ tool: 'inspect_slides', check: 'font' })}\n\`\`\``,
    `检查目标页\n\`\`\`action\n${JSON.stringify({ tool: 'inspect_slides', check: 'font', pages: [2] })}\n\`\`\``,
    `写错页面\n\`\`\`action\n${JSON.stringify({ tool: 'write_slide', page: 3, html: '<h1>wrong</h1>' })}\n\`\`\``,
    `写目标页\n\`\`\`action\n${JSON.stringify({ tool: 'write_slide', page: 2, html: '<h1>right</h1>' })}\n\`\`\``,
    `复检目标页\n\`\`\`action\n${JSON.stringify({ tool: 'inspect_slides', check: 'font', pages: [2] })}\n\`\`\``,
    '完成。',
  ];
  const executed = [];
  let aiCalls = 0;
  wb._activeTask = {
    deckLevel: false,
    requiresPlan: false,
    planSaved: true,
    deckValidated: false,
    commandCheck: 'font',
    commandPages: [2],
    commandInspected: false,
    commandPassed: false,
  };
  wb.history = [{ role: 'system', content: 'test' }];
  wb._callAI = async () => replies[aiCalls++];
  wb._rpc = async (_type, payload) => {
    executed.push(`${payload.action.tool}:${payload.action.page || (payload.action.pages || []).join(',')}`);
    if (payload.action.tool === 'inspect_slides') {
      return JSON.stringify({ passed: executed.filter(item => item.startsWith('inspect_slides')).length > 1 });
    }
    return `${payload.action.tool} 已完成`;
  };
  wb._appendAssistantMarkdown = () => {};
  wb._log = () => {};
  wb._logAction = () => {};
  wb._finishAction = () => {};
  wb._logResult = () => {};
  wb._setBusy = () => {};

  await wb._runTurn();

  assert.deepEqual(executed, ['inspect_slides:2', 'write_slide:2', 'inspect_slides:2']);
  assert.equal(wb.history.some(item => String(item.content).includes('范围固定为第 2 页')), true);
  assert.equal(wb.history.some(item => String(item.content).includes('拒绝写入第 3 页')), true);
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

async function testPlannedPlaceholderRoleConversion() {
  const deck = {
    folderPath: '/tmp/planned-conversion',
    manifest: { title: '短课件', slides: [] },
    slides: starterSlides.map((slide, index) => ({ ...slide, id: `planned-${index + 1}`, dirty: false, created: false })),
    currentSlideIndex: 0,
    manifestDirty: false,
    templateFilesDirty: false,
    fileStats: {},
  };
  deck.manifest.slides = deck.slides;
  agentContext.window.Settings._pptBuilder = deck;
  agentContext.window.Settings._savePptBuilderData = successfulSave;
  agent._activeDeckPlan = {
    folderPath: deck.folderPath,
    plan: { slides: deck.slides.map((_, index) => ({ page: index + 1, role: index === 0 ? 'cover' : index === 4 ? 'finish' : 'content' })) },
  };

  const catalogResult = await agent._toolWriteSlide(deck, {
    tool: 'write_slide', page: 2, title: '正文 A', slide_type: 'content',
    html: '<link rel="stylesheet" href="content.css"><main class="content-area"><h1>正文 A</h1></main>',
  });
  const chapterResult = await agent._toolWriteSlide(deck, {
    tool: 'write_slide', page: 3, title: '正文 B', slide_type: 'content',
    html: '<link rel="stylesheet" href="content.css"><main class="content-area"><h1>正文 B</h1></main>',
  });
  const coverResult = await agent._toolWriteSlide(deck, {
    tool: 'write_slide', page: 1, title: '错误正文', slide_type: 'content',
    html: '<link rel="stylesheet" href="content.css"><main class="content-area"><h1>错误正文</h1></main>',
  });
  const finishResult = await agent._toolWriteSlide(deck, {
    tool: 'write_slide', page: 5, title: '错误正文', slide_type: 'content',
    html: '<link rel="stylesheet" href="content.css"><main class="content-area"><h1>错误正文</h1></main>',
  });

  assert.match(catalogResult, /已保存/);
  assert.match(chapterResult, /已保存/);
  assert.equal(deck.slides[1].slide_type, 'content');
  assert.equal(deck.slides[2].slide_type, 'content');
  assert.match(coverResult, /失败/);
  assert.match(finishResult, /失败/);
}

async function testPrivateTemplateRenderUsesServerHtmlAndSafeSave() {
  const deck = {
    folderPath: '/tmp/template-render',
    manifest: { title: '模板渲染', slides: [] },
    slides: [{
      id: 'slide-1', file: 'slide01.html', title: '原页面', slide_type: 'content',
      html: '<h1>原页面</h1>', dirty: false, created: false,
    }],
    currentSlideIndex: 0,
    manifestDirty: false,
    templateFilesDirty: false,
    fileStats: {},
  };
  deck.manifest.slides = deck.slides;
  agentContext.window.Settings._pptBuilder = deck;
  agentContext.window.Settings._savePptBuilderData = successfulSave;
  const calls = [];
  agentContext.window.Auth.getToken = () => 'template-token';
  agentContext.window.__TAURI__.core.invoke = async (command, payload) => {
    calls.push({ command, payload });
    if (command === 'lectureai_render_template') {
      return {
        template_id: 'key-message-evidence',
        template_version: '0.1.0',
        html: '<!doctype html><html><head></head><body><main class="content-area" data-template="key-message-evidence"></main></body></html>',
        validation: { passed: true, warnings: [], errors: [] },
      };
    }
    if (command === 'list_ppte_resources') return [{ path: 'images/demo.png', kind: 'image', size: 10 }];
    return true;
  };
  const result = await agent._toolRenderTemplate(deck, {
    tool: 'render_template',
    mode: 'replace',
    page: 1,
    template_id: 'key-message-evidence',
    template_version: '0.1.0',
    payload: { title: '灰度发布', message: '降低风险', evidence: [{}, {}] },
  });
  assert.match(result, /render_template\(key-message-evidence\)/);
  assert.match(deck.slides[0].html, /data-template="key-message-evidence"/);
  assert.equal(deck.slides[0].title, '灰度发布');
  assert.equal(calls[0].command, 'list_ppte_resources');
  assert.equal(calls[1].command, 'lectureai_render_template');
  assert.deepEqual(Object.keys(calls[1].payload.request).sort(), ['available_assets', 'host_stylesheets', 'payload', 'role', 'template_id', 'template_version']);
  assert.deepEqual(Array.from(calls[1].payload.request.available_assets), ['images/demo.png']);
  assert.deepEqual(Array.from(calls[1].payload.request.host_stylesheets), []);
  assert.equal('skeleton' in calls[1].payload.request, false);
}

async function testPageHarnessResetsMessagesBetweenSlides() {
  const plan = {
    targetSlideCount: 2,
    visualSystem: { colors: { text: '#0f172a' } },
    slides: [1, 2].map((page) => ({
      page, role: 'content', title: `第${page}页`, contentKind: 'concept', layoutFamily: 'test',
      componentIds: [], motion: 'none', visualIntent: `意图${page}`,
      templateId: `template-${page}`, templateVersion: '0.1.0',
      narrative: { buildsOn: `承接${page}`, learningGoal: `目标${page}`, keyTakeaway: `结论${page}`, leadsTo: `后续${page}` },
    })),
  };
  wb.manifest = { title: 'Harness', slides: [
    { title: '旧页1', slideType: 'content', file: 'slide01.html' },
    { title: '旧页2', slideType: 'content', file: 'slide02.html' },
  ] };
  wb._activeTask = { userInstruction: '生成两页', plan };
  wb._stopRequested = false;
  const calls = [];
  const replies = [
    '```action\n{"tool":"render_template","mode":"replace","page":1,"template_id":"template-1","payload":{"title":"一"}}\n```',
    '```action\n{"tool":"validate_slide","page":1}\n```',
    '第一页完成',
    '```action\n{"tool":"render_template","mode":"replace","page":2,"template_id":"template-2","payload":{"title":"二"}}\n```',
    '```action\n{"tool":"validate_slide","page":2}\n```',
    '第二页完成',
  ];
  wb._callAI = async (messages, mode, templateIds) => {
    calls.push({ messages: JSON.parse(JSON.stringify(messages)), mode, templateIds: [...templateIds] });
    return replies.shift();
  };
  wb._rpc = async (type, payload) => {
    if (type === 'execute-action' && payload.action.tool === 'validate_slide') return JSON.stringify({ passed: true });
    return '操作成功';
  };
  wb._refreshContext = async () => {};
  wb._logAction = () => null;
  wb._finishAction = () => {};
  wb._logResult = () => {};
  const counters = { rounds: 0, tools: 0 };
  const summaries = {};
  summaries[1] = await wb._runHarnessPage(plan, plan.slides[0], summaries, '', counters);
  summaries[2] = await wb._runHarnessPage(plan, plan.slides[1], summaries, '', counters);
  assert.deepEqual(calls.map((call) => call.messages.length), [2, 4, 6, 2, 4, 6]);
  assert.equal(calls[3].messages.some((message) => String(message.content).includes('当前页工具回执')), false, 'second page must not inherit first page tool receipts');
  assert.deepEqual(calls[0].templateIds, ['template-1']);
  assert.deepEqual(calls[3].templateIds, ['template-2']);
}

async function testAgentImportsSelectedExternalSkillFolder() {
  const calls = [];
  agentContext.window.__TAURI__.core.invoke = async (command, payload) => {
    calls.push({ command, payload });
    if (command === 'pick_folder') return '/tmp/codex-skills';
    if (command === 'ppte_skill_import') return { imported: [{ name: 'external-skill' }], skipped: [] };
    return null;
  };

  const result = await agent._importSkill();

  assert.equal(result.imported[0].name, 'external-skill');
  assert.deepEqual(calls.map(call => call.command), ['pick_folder', 'ppte_skill_import']);
  assert.equal(calls[1].payload.sourcePath, '/tmp/codex-skills');
}

(async () => {
  await testLectureAiRetriesOneTransientUpstreamFailure();
  await testInputUiBindsWithoutTauriEvents();
  await testExternalSkillImportRefreshesCatalog();
  agentContext.window.Settings._pptBuilder = pb;
  await testConceptAnimationContextIncludesCurrentNeighborsAndStylesheet();
  await testTemplateAwareInsertKeepsFinishLast();
  await testStarterDeckExpandsToExactlyFifteenPages();
  await testCancelledSaveRollsBackAgentMutation();
  await testWorkbenchStopsAfterDiskSaveFailure();
  await testLongDeckJobRunsToCompletion();
  await testDeckTaskRequiresPlanBeforeMutationAndValidationBeforeFinish();
  await testDeckInspectionRequiresValidationButNotPlan();
  await testSlashCommandRequiresInspectionAndReinspection();
  await testSlashCommandKeepsPageScope();
  await testOptionalPlanToolsUseSeparateTauriStorage();
  await testPlannedPlaceholderRoleConversion();
  await testPrivateTemplateRenderUsesServerHtmlAndSafeSave();
  await testPageHarnessResetsMessagesBetweenSlides();
  await testAgentImportsSelectedExternalSkillFolder();
})()
  .then(() => console.log('test-workbench-window: all assertions passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
