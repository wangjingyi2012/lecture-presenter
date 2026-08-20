const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const workbenchPath = path.join(__dirname, '..', 'src', 'js', 'workbench-window.js');
const source = fs.readFileSync(workbenchPath, 'utf8');
const taskProtocolSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'lectureai-task-protocol.js'), 'utf8');
const renderDiagnosticsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'ppte-render-diagnostics.js'), 'utf8');
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
  crypto: require('node:crypto').webcrypto,
  TextEncoder,
  URL,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
};
context.window.crypto = context.crypto;
context.window.TextEncoder = TextEncoder;

vm.createContext(context);
vm.runInContext(`${taskProtocolSource}\nglobalThis.LectureAiTaskProtocol = window.LectureAiTaskProtocol;`, context);
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
assert.match(source, /task_resolve/, 'LectureAI turns must resolve a server-owned TaskSpec first');
assert.match(source, /taskSpec\.scope === 'deck'/, 'TaskSpec scope must drive deck routing');
assert.match(source, /taskSpec\.requiresDeckPlan === true/, 'TaskSpec must drive the plan requirement');
assert.doesNotMatch(htmlSource, /课件级 Agent|从其他 Agent/, 'workbench chrome must not expose internal agent terminology');
assert.doesNotMatch(source, /课件级 Agent|从其他 Agent/, 'dynamic empty states must use the LectureAI assistant name');
assert.match(source, /const finalText = this\._userFacingText\(this\._stripActions\(text\)\)/, 'stream finalization must keep user-facing terminology sanitized');

const originalLogForUserLine = wb._log;
const originalAppendMarkdown = wb._appendAssistantMarkdown;
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

// ---- workbench session persistence ----
assert.match(source, /workbench-sessions\.json/, 'workbench chat sessions must persist to a per-deck file');
assert.match(agentSource, /folderPath:\s*pb\?\.folderPath \|\| null/, 'get-context must expose the deck folderPath for session storage');
async function testSessionPersistence() {
  const messages = { innerHTML: '', children: [], appendChild(el) { this.children.push(el); }, querySelectorAll() { return []; } };
  const prevGetEl = context.document.getElementById;
  const prevCreateEl = context.document.createElement;
  context.document.getElementById = (id) => (id === 'wb-messages' ? messages : null);
  context.document.createElement = () => {
    const el = { className: '', textContent: '', type: '', onclick: null, _children: [{ textContent: '' }, { textContent: '' }] };
    Object.defineProperty(el, 'children', { get() { return this._children; } });
    Object.defineProperty(el, 'innerHTML', { get() { return ''; }, set() {} });
    return el;
  };
  const prevTauri = context.window.__TAURI__;
  const writes = [];
  const diskStore = {
    version: 1,
    sessions: [
      { id: 'old1', startedAt: '2026-08-17T10:00:00Z', updatedAt: '2026-08-17T11:00:00Z', preview: '旧对话一', history: [{ role: 'user', content: 'u1' }], transcript: [{ t: 'user', text: '旧问题1' }, { t: 'ai', md: '旧回答1' }] },
      { id: 'old2', startedAt: '2026-08-17T12:00:00Z', updatedAt: '2026-08-17T12:30:00Z', preview: '旧对话二', history: [], transcript: [{ t: 'user', text: '旧问题2' }] },
    ],
  };
  context.window.__TAURI__ = {
    core: {
      invoke: async (cmd, args) => {
        if (cmd === 'write_text_file') { writes.push(args); return null; }
        if (cmd === 'read_text_file') return JSON.stringify(diskStore);
        return null;
      },
    },
  };
  try {
    // Earlier cases stub these without restoring; bring back the real ones.
    wb._log = originalLogForUserLine;
    wb._appendAssistantMarkdown = originalAppendMarkdown;
    wb._deckPath = '/tmp/session-deck';
    // each workbench open begins a new conversation
    await wb._beginSession();
    assert.ok(wb._sessionId && wb._sessionId !== 'old1' && wb._sessionId !== 'old2', 'a fresh session id per window open');
    assert.equal(wb._transcript.length, 0, 'new session starts empty');
    assert.equal(messages.children.length, 1, 'a /resume hint is shown when past sessions exist');
    assert.match(messages.children[0].textContent, /\/resume/);
    // a window that never produced content leaves nothing on disk
    await wb._saveSession();
    assert.equal(writes.length, 0, 'empty fresh sessions are not persisted');
    // _log records conversation lines, skips transient phase lines
    wb._log('user', '你好');
    wb._log('phase', '第 1 轮 · 正在提交模型请求');
    wb._log('sys', '任务结束');
    wb._appendAssistantMarkdown('**回答**');
    assert.deepEqual(wb._transcript, [
      { t: 'user', text: '你好' },
      { t: 'sys', text: '任务结束' },
      { t: 'ai', md: '**回答**' },
    ], 'transcript records user/sys/ai entries and skips phase lines');
    wb._log('err', '忽略我', { skipRecord: true });
    assert.equal(wb._transcript.length, 3, 'skipRecord lines are not persisted');
    // save appends the current session alongside past ones
    wb.history = [{ role: 'user', content: '你好' }];
    await wb._saveSession();
    assert.equal(writes.length, 1, 'save must write once');
    assert.equal(writes[0].filePath, '/tmp/session-deck/.lectureai/workbench-sessions.json');
    const saved = JSON.parse(writes[0].content);
    assert.equal(saved.sessions.length, 3, 'current session joins the two past ones');
    assert.equal(saved.sessions[0].id, wb._sessionId, 'most recently updated session comes first');
    assert.equal(saved.sessions[0].preview, '你好');
    assert.equal(saved.sessions[0].transcript.length, 3);
    // the store is capped at 10 sessions
    wb._sessions = Array.from({ length: 10 }, (_, i) => ({ id: `x${i}`, updatedAt: `2026-08-0${(i % 9) + 1}T00:00:00Z`, transcript: [{ t: 'user', text: `q${i}` }] }));
    await wb._saveSession();
    const capped = JSON.parse(writes[1].content);
    assert.equal(capped.sessions.length, 10, 'only the 10 most recent sessions are kept');
    assert.ok(capped.sessions.some(s => s.id === wb._sessionId), 'the active session is never trimmed');
    // /resume lists past sessions as clickable entries
    messages.children = [];
    await wb._resume();
    assert.equal(messages.children.length, 3, 'one header line plus two session buttons');
    assert.equal(messages.children[1].children[0].textContent, '旧对话一');
    // loading a session replays its transcript and rehydrates history
    messages.children = [];
    wb._loadSession(diskStore.sessions[0]);
    assert.equal(wb._sessionId, 'old1', 'resumed session continues under its own id');
    assert.equal(wb.history.length, 1, 'history is restored for model continuation');
    assert.equal(wb._transcript.length, 2, 'transcript is restored');
    assert.equal(messages.children.length, 3, 'two replayed lines plus the resume notice');
    assert.equal(messages.children[0].textContent, '旧问题1');
    // /clear wipes both the model history and the persisted transcript
    wb._clear();
    assert.equal(wb.history.length, 0);
    assert.equal(wb._transcript.length, 1, 'only the clear notice remains');
  } finally {
    context.document.getElementById = prevGetEl;
    context.document.createElement = prevCreateEl;
    context.window.__TAURI__ = prevTauri;
    wb._deckPath = null;
    wb._sessionId = null;
    wb._sessions = [];
    wb.history = [];
    wb._transcript = [];
  }
}


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
assert.equal(wb._hasUnexecutedToolIntent('查找 DeepSeek 图标资源。'), true);
assert.equal(wb._hasUnexecutedToolIntent('检索图标库。'), true);
assert.equal(wb._hasUnexecutedToolIntent('下载 deepseek-logo.png 到 resources/。'), true);
assert.equal(wb._hasUnexecutedToolIntent('检查结果：课件结构完整，无需修改。'), false);
assert.equal(wb._isHarnessResumeRequest('继续'), true);
assert.equal(wb._isHarnessResumeRequest('继续生成课件'), true);
assert.equal(wb._isHarnessResumeRequest('继续修改第3页'), false);
assert.equal(wb._isRetryableModelError('上游模型只返回了思考过程，未返回可执行内容'), true);
assert.equal(wb._isRetryableModelError('上游模型输出达到长度上限，但未返回可执行内容'), true);

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
assert.match(wb._systemPrompt(), /角色母版起始课件/);
assert.match(wb._systemPrompt(), /template_role/);
assert.match(wb._systemPrompt(), /template_variant/);
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
assert.equal(wb._isDeckLevelTask('重新规划课件内容并重写。'), true, 'rewrite wording from a real failed session is deck-level');
assert.equal(wb._requiresDeckPlan('重新规划课件内容并重写。'), true, 'whole-deck rewrite needs the paged Harness');
assert.equal(wb._isDeckLevelTask('目录和模板文件是不是多余了，完成后不应该出现'), true, 'starter-page cleanup is a deck-level task');
assert.equal(wb._isOutlineOnlyTask('要讲AI对文档处理的帮助，帮我写个大纲'), true, 'outline wording from a real failed session must stay outline-only');
assert.equal(wb._isOutlineOnlyTask('根据大纲重写整套课件'), false, 'an outline used to rewrite slides is not outline-only');

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
  assert.match(menu.innerHTML, /选择页面或文件 · 3\/3 项/, 'picker counts pages plus mentionable files');
  assert.match(menu.innerHTML, /@ slide01\.html/);
  assert.match(menu.innerHTML, /@ slide02\.html/);
  assert.match(menu.innerHTML, /封面/);
  assert.match(menu.innerHTML, /正文/);
  assert.match(menu.innerHTML, /@ outline\.md/, 'the deck outline file must be mentionable');
  assert.match(menu.innerHTML, /课件大纲/);
  assert.match(menu.innerHTML, /data-file="outline\.md"/);

  input.value = '@大纲';
  input.selectionStart = 3;
  wb._updateInputPicker();
  assert.match(menu.innerHTML, /data-file="outline\.md"/, 'typing @大纲 filters to the outline file');
  assert.ok(!menu.innerHTML.includes('slide01.html'), 'non-matching pages are filtered out');

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
vm.runInContext(`${renderDiagnosticsSource}\nglobalThis.PpteRenderDiagnostics = window.PpteRenderDiagnostics;`, agentContext);
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

const v2Deck = {
  manifest: {
    title: '多变体课件',
    agentTemplate: {
      schemaVersion: 2,
      template: { id: 'scholar-blue', name: '学术蓝', version: '1.1.0', digest: 'sha256:test' },
      state: 'starter',
      roles: {
        cover: { blueprintFile: '.ppte-template/roles/cover.html', starterFile: 'slide01.html' },
        catalog: { blueprintFile: '.ppte-template/roles/catalog.html', starterFile: 'slide02.html' },
        chapter: { blueprintFile: '.ppte-template/roles/chapter.html', starterFile: 'slide03.html' },
        content: [
          { id: 'text', title: '要点正文', blueprintFile: '.ppte-template/roles/content-text.html', starterFile: 'slide04.html' },
          { id: 'visual', title: '图文对照', blueprintFile: '.ppte-template/roles/content-visual.html', starterFile: 'slide05.html' },
        ],
        finish: { blueprintFile: '.ppte-template/roles/finish.html', starterFile: 'slide06.html' },
      },
    },
  },
  slides: [
    { file: 'slide01.html', title: '封面', slide_type: 'cover', html: 'edited-cover' },
    { file: 'slide02.html', title: '目录', slide_type: 'catalog', html: 'edited-catalog' },
    { file: 'slide03.html', title: '章节', slide_type: 'chapter', html: 'edited-chapter' },
    { file: 'slide04.html', title: '正文', slide_type: 'content', html: 'edited-text' },
    { file: 'slide05.html', title: '图文', slide_type: 'content', html: 'edited-visual' },
    { file: 'slide06.html', title: '总结', slide_type: 'finish', html: 'edited-finish' },
  ],
  templateBlueprintSnapshot: {
    roles: {
      'cover.html': '<link rel="stylesheet" href="theme.css"><main>original-cover</main>',
      'catalog.html': '<main>original-catalog</main>',
      'chapter.html': '<main>original-chapter</main>',
      'content-text.html': '<main>original-text</main>',
      'content-visual.html': '<main>original-visual</main>',
      'finish.html': '<main>original-finish</main>',
    },
  },
};
const v2Blueprint = agent._templateBlueprint(v2Deck);
assert.equal(v2Blueprint.name, '学术蓝');
assert.deepEqual(Array.from(v2Blueprint.roles.filter(role => role.slideType === 'content'), role => role.variantId), ['text', 'visual']);
assert.equal(agent._roleTemplateHtml(v2Deck, 'content', 'visual'), '<main>original-visual</main>', 'v2 roles must read the immutable snapshot, not an edited starter page');

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

async function testFinalizeDeckRemovesOnlyUnplannedStarterPages() {
  const plannedTitles = ['封面', ...Array.from({ length: 10 }, (_, index) => `正文 ${index + 1}`), '谢谢'];
  const slides = [
    { id: 'cover', file: 'slide01.html', title: '封面', slide_type: 'cover', html: '<h1>封面</h1>' },
    ...Array.from({ length: 10 }, (_, index) => ({
      id: `content-${index + 1}`, file: `generated-${index + 1}.html`, title: `正文 ${index + 1}`,
      slide_type: 'content', html: `<h1>正文 ${index + 1}</h1>`,
    })),
    { id: 'starter-catalog', file: 'slide02.html', title: '目录', slide_type: 'catalog', html: '<h1>目录</h1>' },
    { id: 'starter-chapter', file: 'slide03.html', title: '章节', slide_type: 'chapter', html: '<h1>章节</h1>' },
    { id: 'starter-content-1', file: 'slide04.html', title: '起始正文一', slide_type: 'content', html: '<h1>样例</h1>' },
    { id: 'starter-content-2', file: 'slide05.html', title: '起始正文二', slide_type: 'content', html: '<h1>样例</h1>' },
    { id: 'finish', file: 'slide06.html', title: '谢谢', slide_type: 'finish', html: '<h1>谢谢</h1>' },
  ];
  const deck = {
    folderPath: '/tmp/finalize-deck',
    manifest: { title: '智能文档', slides }, slides,
    currentSlideIndex: 12, manifestDirty: false, templateFilesDirty: false, fileStats: {},
  };
  const plan = {
    targetSlideCount: 12,
    slides: plannedTitles.map((title, index) => ({ page: index + 1, title, role: index === 0 ? 'cover' : index === 11 ? 'finish' : 'content' })),
  };
  agentContext.window.Settings._pptBuilder = deck;
  agentContext.window.Settings._savePptBuilderData = successfulSave;
  const result = await agent._toolFinalizeDeck(deck, { tool: 'finalize_deck', plan });
  assert.equal(deck.slides.length, 12, 'the final manifest must match the plan target');
  assert.equal(deck.slides.at(-1).id, 'finish', 'the finish role must be matched and moved to the final planned slot');
  assert.deepEqual(Array.from(deck.slides, slide => slide.title), plannedTitles);
  assert.equal(slides.length, 16, 'source slide objects/files are not deleted by manifest cleanup');
  assert.match(result, /4 个起始占位页已从成品页序移除/);
  assert.match(result, /源文件和隐藏母版快照仍保留/);
}

async function testNativeDeleteSlideIsManifestOnlyAndPlanBound() {
  const originalPlan = agent._activeDeckPlan;
  const deck = {
    folderPath: '/tmp/delete-deck',
    manifest: { title: '删除测试', slides: [] },
    slides: [
      { id: 'keep-1', file: 'slide01.html', title: '保留一', slide_type: 'cover', html: '<h1>一</h1>' },
      { id: 'remove-2', file: 'slide02.html', title: '占位页', slide_type: 'content', html: '<h1>二</h1>' },
    ],
    currentSlideIndex: 1,
    manifestDirty: false,
    templateFilesDirty: false,
    fileStats: {},
  };
  deck.manifest.slides = deck.slides;
  const taskSpec = {
    runId: 'run_delete_slide_12345678',
    targets: { allowDelete: true, allowInsert: false, allowReorder: true },
  };
  agent._activeDeckPlan = {
    folderPath: deck.folderPath,
    plan: {
      planVersion: 3,
      taskSpecRef: { runId: taskSpec.runId },
      deletedPageIds: ['remove-2'],
      slides: [{ page: 1, sourcePageId: 'keep-1', role: 'cover' }],
      targetSlideCount: 1,
    },
  };
  agentContext.window.Settings._pptBuilder = deck;
  agentContext.window.Settings._savePptBuilderData = successfulSave;
  try {
    const result = await agent._toolDeleteSlide(deck, {
      tool: 'delete_slide', page: 2, page_id: 'remove-2',
      _taskRunId: taskSpec.runId, _taskSpec: taskSpec,
    });
    assert.match(result, /源文件仍保留/);
    assert.deepEqual(Array.from(deck.slides, slide => slide.id), ['keep-1']);
    assert.deepEqual(deck.manifest.slides, deck.slides);
    assert.equal(deck.currentSlideIndex, 0);
    const denied = await agent._toolDeleteSlide(deck, {
      tool: 'delete_slide', page: 1, page_id: 'keep-1',
      _taskRunId: taskSpec.runId, _taskSpec: { ...taskSpec, targets: { ...taskSpec.targets, allowDelete: false } },
    });
    assert.match(denied, /未授权删除/);
  } finally {
    agent._activeDeckPlan = originalPlan;
    agentContext.window.Settings._pptBuilder = pb;
    agentContext.window.Settings._savePptBuilderData = successfulSave;
  }
}

function testStructuredTaskReceiptDetails() {
  const details = agent._taskToolDetails(
    { tool: 'reorder_slides', order: [3, 1, 2] },
    'reorder_slides 已重排',
    { slides: [{ id: 's1' }, { id: 's2' }, { id: 's3' }] },
  );
  assert.deepEqual(details.order, [2, 0, 1], 'server reorder evidence is a complete zero-based permutation');
  const finalize = agent._taskToolDetails(
    { tool: 'finalize_deck', plan: { slides: [{ sourcePageId: 's1' }, { targetPageId: 't2' }], deletedPageIds: ['s3'] } },
    '已整理',
    { slides: [{ id: 's1' }, { id: 't2' }] },
  );
  assert.deepEqual(finalize.order, ['s1', 't2']);
  assert.deepEqual(finalize.deletedPageIds, ['s3']);
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

async function testOutlineOnlyTaskCannotMutateSlides() {
  const replies = [
    `错误规划\n\`\`\`action\n${JSON.stringify({ tool: 'set_deck_plan', plan: { targetSlideCount: 1, slides: [{ page: 1, role: 'cover' }] } })}\n\`\`\``,
    `保存大纲\n\`\`\`action\n${JSON.stringify({ tool: 'write_outline', content: '# AI 文档处理\n\n- 写作辅助\n- 信息提取' })}\n\`\`\``,
    '大纲已经保存。',
  ];
  const executed = [];
  let aiCalls = 0;
  wb._activeTask = {
    deckLevel: false, requiresPlan: false, planSaved: true, deckValidated: false,
    outlineOnly: true, outlineSaved: false,
  };
  wb.history = [{ role: 'system', content: 'test' }];
  wb._callAI = async () => replies[aiCalls++];
  wb._rpc = async (_type, payload) => { executed.push(payload.action.tool); return 'write_outline 已保存课件大纲。'; };
  wb._appendAssistantMarkdown = () => {};
  wb._log = () => {};
  wb._logAction = () => {};
  wb._finishAction = () => {};
  wb._logResult = () => {};
  wb._setBusy = () => {};
  await wb._runTurn();
  assert.deepEqual(executed, ['write_outline'], 'outline-only requests must not plan or mutate slides');
  assert.equal(wb._activeTask.outlineSaved, true);
  assert.equal(wb.history.some(item => String(item.content).includes('[大纲任务边界]')), true);
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
  assert.deepEqual(Object.keys(calls[1].payload.request).sort(), ['available_assets', 'host_stylesheets', 'payload', 'role', 'template_id', 'template_variant', 'template_version']);
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

async function testHarnessFinalizesBeforeDeckValidation() {
  const originalPersist = wb._persistHarnessExecution;
  const originalValidate = wb._validateAndRepairHarness;
  const originalRpc = wb._rpc;
  const originalRefresh = wb._refreshContext;
  const originalAppend = wb._appendAssistantMarkdown;
  const originalLog = wb._log;
  const originalLogAction = wb._logAction;
  const originalFinish = wb._finishAction;
  const originalLogResult = wb._logResult;
  const originalTaskActionRequest = wb._taskActionRequest;
  const originalSelectedConfig = wb.selectedConfig;
  const originalTaskCardRun = wb._taskCardRun;
  const calls = [];
  const plan = {
    targetSlideCount: 1,
    slides: [{ page: 1, role: 'cover', title: '封面' }],
    taskSpecRef: { runId: 'run_finalize_receipt_12345678', revision: 1 },
    execution: { schemaVersion: 1, completedPages: [1], summaries: { 1: '完成' }, stageReviews: [] },
  };
  try {
    wb._activeTask = { userInstruction: '测试收尾', runId: 'run_finalize_receipt_12345678' };
    wb.selectedConfig = { aiProvider: 'lectureai', aiApiKey: 'test-token' };
    wb._taskCardRun = { runId: 'run_finalize_receipt_12345678', status: 'running' };
    wb.manifest = { deckRevision: { deckHash: `sha256:${'a'.repeat(64)}` } };
    wb._stopRequested = false;
    wb._persistHarnessExecution = async () => {};
    wb._validateAndRepairHarness = async () => { calls.push('validate'); return { passed: true, metrics: {} }; };
    wb._rpc = async (type, payload) => {
      calls.push(`${type}:${payload.action.tool}`);
      if (type === 'execute-task-action') {
        assert.equal(payload.envelope.actionId, 'run_finalize_receipt_12345678:client:finalize:1');
        assert.match(payload.envelope.argsHash, /^sha256:[a-f0-9]{64}$/);
        return { ok: true, result: { label: '已确认成品页序与蓝图一致（共 1 页）。' } };
      }
      return '已确认成品页序与蓝图一致（共 1 页）。';
    };
    wb._taskActionRequest = async (action, payload) => {
      if (action === 'task_action_start') {
        assert.equal(payload.actionId, 'run_finalize_receipt_12345678:client:finalize:1');
        return { decision: 'new', receipt: { claimToken: 'claim-finalize-test' } };
      }
      if (action === 'task_action_finish') {
        assert.equal(payload.claimToken, 'claim-finalize-test');
        return { decision: 'stored', receipt: { result: payload.result, newDeckRevision: payload.newDeckRevision } };
      }
      throw new Error(`unexpected task action ${action}`);
    };
    wb._refreshContext = async () => {};
    wb._appendAssistantMarkdown = () => {};
    wb._log = () => {};
    wb._logAction = () => null;
    wb._finishAction = () => {};
    wb._logResult = () => {};
    await wb._runPlannedHarness(plan, '测试收尾');
    assert.deepEqual(calls, ['execute-task-action:finalize_deck', 'validate'], 'deterministic page cleanup must have its own receipt before whole-deck validation');
  } finally {
    wb._persistHarnessExecution = originalPersist;
    wb._validateAndRepairHarness = originalValidate;
    wb._rpc = originalRpc;
    wb._refreshContext = originalRefresh;
    wb._appendAssistantMarkdown = originalAppend;
    wb._log = originalLog;
    wb._logAction = originalLogAction;
    wb._finishAction = originalFinish;
    wb._logResult = originalLogResult;
    wb._taskActionRequest = originalTaskActionRequest;
    wb.selectedConfig = originalSelectedConfig;
    wb._taskCardRun = originalTaskCardRun;
  }
}

async function testHarnessCompletionWaitsForServerAuthority() {
  const originals = {
    persist: wb._persistHarnessExecution,
    validate: wb._validateAndRepairHarness,
    complete: wb._completeLectureAiTaskRun,
    rpc: wb._rpc,
    refresh: wb._refreshContext,
    append: wb._appendAssistantMarkdown,
    log: wb._log,
    logAction: wb._logAction,
    finish: wb._finishAction,
    logResult: wb._logResult,
  };
  const plan = {
    targetSlideCount: 1,
    slides: [{ page: 1, role: 'cover', title: '封面' }],
    execution: { schemaVersion: 1, completedPages: [1], summaries: { 1: '完成' }, stageReviews: [] },
  };
  const events = [];
  try {
    wb._activeTask = { userInstruction: '测试权威收尾', taskSpec: { runId: 'run_complete_order_12345678' } };
    wb._stopRequested = false;
    wb._persistHarnessExecution = async (_plan, execution) => { events.push(execution.status); };
    wb._validateAndRepairHarness = async () => ({ passed: true, metrics: { pages: 1 } });
    wb._completeLectureAiTaskRun = async () => { events.push('server-completed'); return { status: 'completed' }; };
    wb._rpc = async () => '已确认成品页序与蓝图一致（共 1 页）。';
    wb._refreshContext = async () => {};
    wb._appendAssistantMarkdown = () => {};
    wb._log = () => {};
    wb._logAction = () => null;
    wb._finishAction = () => {};
    wb._logResult = () => {};
    await wb._runPlannedHarness(plan, '测试权威收尾');
    assert.deepEqual(events, ['validating', 'server-completed', 'completed']);

    events.length = 0;
    wb._completeLectureAiTaskRun = async () => { throw new Error('服务端确认暂不可用'); };
    await assert.rejects(wb._runPlannedHarness(plan, '测试权威收尾'), /服务端确认暂不可用/);
    assert.deepEqual(events, ['validating', 'paused'], 'server failure must never leave a local completed state');
  } finally {
    wb._persistHarnessExecution = originals.persist;
    wb._validateAndRepairHarness = originals.validate;
    wb._completeLectureAiTaskRun = originals.complete;
    wb._rpc = originals.rpc;
    wb._refreshContext = originals.refresh;
    wb._appendAssistantMarkdown = originals.append;
    wb._log = originals.log;
    wb._logAction = originals.logAction;
    wb._finishAction = originals.finish;
    wb._logResult = originals.logResult;
  }
}

async function testHarnessValidationFailureBecomesRepairable() {
  const originals = {
    persist: wb._persistHarnessExecution,
    validate: wb._validateAndRepairHarness,
    complete: wb._completeLectureAiTaskRun,
    rpc: wb._rpc,
    refresh: wb._refreshContext,
    log: wb._log,
    logAction: wb._logAction,
    finish: wb._finishAction,
    logResult: wb._logResult,
  };
  const plan = {
    targetSlideCount: 1,
    slides: [{ page: 1, role: 'content', title: '正文' }],
    execution: { schemaVersion: 1, completedPages: [1], summaries: { 1: '完成' }, stageReviews: [] },
  };
  const statuses = [];
  try {
    wb._activeTask = { userInstruction: '测试返工', taskSpec: { runId: 'run_repair_order_12345678' } };
    wb._stopRequested = false;
    wb._persistHarnessExecution = async (_plan, execution) => { statuses.push(execution.status); };
    wb._validateAndRepairHarness = async () => ({ passed: false, errors: ['第 1 页内容溢出'] });
    wb._completeLectureAiTaskRun = async () => ({ status: 'needs_repair' });
    wb._rpc = async () => '已确认成品页序与蓝图一致（共 1 页）。';
    wb._refreshContext = async () => {};
    wb._log = () => {};
    wb._logAction = () => null;
    wb._finishAction = () => {};
    wb._logResult = () => {};
    await assert.rejects(wb._runPlannedHarness(plan, '测试返工'), /整套校验未通过/);
    assert.equal(statuses[0], 'validating');
    assert.ok(statuses.includes('needs-repair'));
    assert.equal(statuses.includes('completed'), false);
  } finally {
    wb._persistHarnessExecution = originals.persist;
    wb._validateAndRepairHarness = originals.validate;
    wb._completeLectureAiTaskRun = originals.complete;
    wb._rpc = originals.rpc;
    wb._refreshContext = originals.refresh;
    wb._log = originals.log;
    wb._logAction = originals.logAction;
    wb._finishAction = originals.finish;
    wb._logResult = originals.logResult;
  }
}

async function testPiWebSocketReturnsMatchingToolResult() {
  const OriginalWebSocket = context.WebSocket;
  const originalPrepare = wb._prepareHarnessTarget;
  const originalExecute = wb._executePiTool;
  const originalLog = wb._log;
  const originalStartStatus = wb._startModelStatus;
  const originalFinishStatus = wb._finishModelStatus;
  const sent = [];
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      FakeWebSocket.last = this;
      this.readyState = FakeWebSocket.CONNECTING;
      setTimeout(() => {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen();
      }, 0);
    }
    send(raw) {
      const message = JSON.parse(raw);
      sent.push(message);
      if (message.type === 'start_page') {
        setTimeout(() => this.onmessage({ data: JSON.stringify({
          type: 'tool_call', ['request' + '_id']: 'request-7',
          actionId: 'run_page_test:page:1:action:1',
          argsHash: `sha256:${'b'.repeat(64)}`,
          expectedDeckRevision: `sha256:${'a'.repeat(64)}`,
          tool: 'validate_slide', args: { page: 1 },
        }) }), 0);
      } else if (message.type === 'tool_result') {
        setTimeout(() => this.onmessage({ data: JSON.stringify({ type: 'page_complete', page: 1, summary: 'Pi 完成' }) }), 0);
      }
    }
    close() { this.readyState = 3; }
  }
  context.WebSocket = FakeWebSocket;
  wb._prepareHarnessTarget = async () => ({ mode: 'replace', after: null });
  wb._executePiTool = async () => ({
    passed: true,
    actionId: 'run_page_test:page:1:action:1',
    argsHash: `sha256:${'b'.repeat(64)}`,
    newDeckRevision: `sha256:${'c'.repeat(64)}`,
  });
  wb._log = () => {};
  wb._startModelStatus = () => {};
  wb._finishModelStatus = () => {};
  wb._activeTask = { userInstruction: '测试 Pi', piSessionId: 'session-test-1', piDeckId: 'deck-test-1' };
  const planSlide = { page: 1, role: 'content', title: '正文', templateId: 'concept-definition-boundary' };
  const result = await wb._runPiHarnessPage(
    { targetSlideCount: 1, slides: [planSlide], execution: {} }, planSlide, {}, '', { rounds: 0, tools: 0 }, { url: 'wss://example.test/pi', token: 'test-token' },
  );
  assert.equal(result, 'Pi 完成');
  assert.equal(FakeWebSocket.last.url, 'wss://example.test/pi');
  assert.deepEqual(Array.from(FakeWebSocket.last.protocols), ['lectureai.pi.v1', 'lectureai.auth.test-token']);
  assert.equal(sent[1].type, 'tool_result');
  assert.equal(sent[1].request_id, 'request-7');
  assert.equal(sent[1].actionId, 'run_page_test:page:1:action:1');
  assert.equal(sent[1].argsHash, `sha256:${'b'.repeat(64)}`);
  assert.equal(sent[1].newDeckRevision, `sha256:${'c'.repeat(64)}`);
  assert.equal(sent[1].ok, true);
  context.WebSocket = OriginalWebSocket;
  wb._prepareHarnessTarget = originalPrepare;
  wb._executePiTool = originalExecute;
  wb._log = originalLog;
  wb._startModelStatus = originalStartStatus;
  wb._finishModelStatus = originalFinishStatus;
}

async function testNativeTaskWebSocketUsesStructuredReceipts() {
  const OriginalWebSocket = context.WebSocket;
  const originalConfig = wb._lecturePiConfig;
  const originalRpc = wb._rpc;
  const originalRefresh = wb._refreshContext;
  const originalAppend = wb._appendAssistantMarkdown;
  const originalLog = wb._log;
  const originalLogAction = wb._logAction;
  const originalFinishAction = wb._finishAction;
  const originalLogResult = wb._logResult;
  const originalSetBusy = wb._setBusy;
  const originalComplete = wb._completeLectureAiTaskRun;
  const sent = [];
  const answers = [];
  const revision = `sha256:${'a'.repeat(64)}`;
  const hash = `sha256:${'b'.repeat(64)}`;
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.readyState = FakeWebSocket.CONNECTING;
      FakeWebSocket.last = this;
      setTimeout(() => { this.readyState = FakeWebSocket.OPEN; this.onopen(); }, 0);
    }
    send(raw) {
      const message = JSON.parse(raw);
      sent.push(message);
      if (message.type === 'start_task') {
        setTimeout(() => this.onmessage({ data: JSON.stringify({
          type: 'tool_call', ['request' + '_id']: 'native-request-1',
          actionId: 'run_native_task_12345678:action:1', argsHash: hash,
          expectedDeckRevision: revision, tool: 'validate_slide', args: { page: 2 },
        }) }), 0);
      } else if (message.type === 'tool_result') {
        setTimeout(() => this.onmessage({ data: JSON.stringify({
          type: 'task_complete', runId: 'run_native_task_12345678', summary: '目标页检查通过',
        }) }), 0);
      }
    }
    close() { this.readyState = 3; }
  }
  context.WebSocket = FakeWebSocket;
  wb._lecturePiConfig = () => ({ url: 'wss://example.test/task', token: 'task-token' });
  wb._rpc = async (type, payload) => {
    assert.equal(type, 'execute-task-action');
    assert.equal(payload.runId, 'run_native_task_12345678');
    return {
      ok: true,
      actionId: payload.envelope.actionId,
      argsHash: payload.envelope.argsHash,
      newDeckRevision: `sha256:${'c'.repeat(64)}`,
      result: { page: 2, passed: true, label: '第 2 页检查通过' },
    };
  };
  wb._refreshContext = async () => {};
  wb._appendAssistantMarkdown = text => answers.push(text);
  wb._log = () => {};
  wb._logAction = () => null;
  wb._finishAction = () => {};
  wb._logResult = () => {};
  wb._setBusy = () => {};
  let completionValidation = null;
  wb._completeLectureAiTaskRun = async (_plan, _pages, validation) => {
    completionValidation = validation;
    return { status: 'completed' };
  };
  wb.manifest = {
    deckId: 'deck-native-test',
    deckRevision: { deckHash: revision },
    slides: [{ id: 's1', title: '封面', slideType: 'cover' }, { id: 's2', title: '内容', slideType: 'content' }],
  };
  const taskSpec = {
    schemaVersion: 1,
    runId: 'run_native_task_12345678',
    intent: 'slide_edit', scope: 'page',
    targets: { pages: [2], outline: false, allowInsert: false, allowDelete: false, allowReorder: false },
    executionStrategy: 'bounded_tool_loop', requiresDeckPlan: false,
    userFacingGoal: '优化第 2 页', acceptanceCriteria: [{ type: 'target_pages_validated', label: '目标页面检查通过' }],
    requiredCapabilities: ['slide.read'], confidence: 1, requiresClarification: false,
  };
  try {
    await wb._runLectureAiNativeTask(taskSpec, '优化第 2 页');
    assert.equal(sent[0].type, 'start_task');
    assert.equal(sent[0].task_spec.runId, taskSpec.runId);
    assert.equal(sent[0].task_context.deckRevision, revision);
    assert.equal(sent[1].request_id, 'native-request-1');
    assert.equal(sent[1].actionId, 'run_native_task_12345678:action:1');
    assert.equal(sent[1].argsHash, hash);
    assert.equal(sent[1].newDeckRevision, `sha256:${'c'.repeat(64)}`);
    assert.equal(sent[1].ok, true);
    assert.equal(completionValidation.passed, false, 'runtime prose alone is not authoritative validation evidence');
    assert.match(answers.at(-1), /任务已完成/);
  } finally {
    context.WebSocket = OriginalWebSocket;
    wb._lecturePiConfig = originalConfig;
    wb._rpc = originalRpc;
    wb._refreshContext = originalRefresh;
    wb._appendAssistantMarkdown = originalAppend;
    wb._log = originalLog;
    wb._logAction = originalLogAction;
    wb._finishAction = originalFinishAction;
    wb._logResult = originalLogResult;
    wb._setBusy = originalSetBusy;
    wb._completeLectureAiTaskRun = originalComplete;
    wb.busy = false;
  }
}

async function testAgentTaskActionIsIdempotentAndRevisionSafe() {
  const originalExecute = agent._executeAction;
  const originalRevision = agent._taskDeckRevision;
  agent._taskReceipts.clear();
  agentContext.window.Settings._pptBuilder = pb;
  let executions = 0;
  let currentRevision = `sha256:${'a'.repeat(64)}`;
  agent._executeAction = async () => { executions += 1; currentRevision = `sha256:${'c'.repeat(64)}`; return 'write_slide 已保存'; };
  agent._taskDeckRevision = async () => currentRevision;
  const action = { tool: 'write_slide', page: 2, html: '<html></html>' };
  const envelope = {
    actionId: 'run_agent_task_12345678:action:1',
    argsHash: `sha256:${'b'.repeat(64)}`,
    expectedDeckRevision: `sha256:${'a'.repeat(64)}`,
  };
  try {
    const first = await agent._executeTaskAction({ runId: 'run_agent_task_12345678', action, envelope });
    const replay = await agent._executeTaskAction({ runId: 'run_agent_task_12345678', action, envelope });
    assert.equal(first.ok, true);
    assert.equal(first.newDeckRevision, `sha256:${'c'.repeat(64)}`);
    assert.equal(replay.replayed, true);
    assert.equal(executions, 1, 'a replayed action must not write twice');
    const conflict = await agent._executeTaskAction({
      runId: 'run_agent_task_12345678', action,
      envelope: { ...envelope, argsHash: `sha256:${'d'.repeat(64)}` },
    });
    assert.equal(conflict.error.code, 'PROTOCOL_ACTION_CONFLICT');
    const stale = await agent._executeTaskAction({
      runId: 'run_agent_task_12345678', action,
      envelope: {
        actionId: 'run_agent_task_12345678:action:2',
        argsHash: `sha256:${'e'.repeat(64)}`,
        expectedDeckRevision: `sha256:${'a'.repeat(64)}`,
      },
    });
    assert.equal(stale.error.code, 'STALE_DECK');
    assert.equal(executions, 1, 'a stale action must be rejected before writing');
  } finally {
    agent._executeAction = originalExecute;
    agent._taskDeckRevision = originalRevision;
    agent._taskReceipts.clear();
  }
}

async function testAgentTaskActionPersistsBeforeWritingAndReplaysAfterRestart() {
  const originalExecute = agent._executeAction;
  const originalRevision = agent._taskDeckRevision;
  const originalInvoke = agentContext.window.__TAURI__.core.invoke;
  agent._taskReceipts.clear();
  agentContext.window.Settings._pptBuilder = pb;
  const events = [];
  const receipts = new Map();
  let executions = 0;
  let currentRevision = `sha256:${'1'.repeat(64)}`;
  agent._taskDeckRevision = async () => currentRevision;
  agent._executeAction = async () => {
    events.push('write');
    executions += 1;
    currentRevision = `sha256:${'3'.repeat(64)}`;
    return 'write_slide 已保存';
  };
  agentContext.window.__TAURI__.core.invoke = async (command, payload) => {
    if (command === 'ppte_task_journal_start') { events.push('start'); return { runId: payload.runId }; }
    if (command === 'ppte_task_journal_receipt_get') return receipts.get(payload.actionId) || null;
    if (command === 'ppte_task_journal_before_write') { events.push('backup'); return { ok: true }; }
    if (command === 'ppte_task_journal_append_receipt') {
      events.push(payload.receipt.status === 'pending' ? 'pending' : 'receipt');
      receipts.set(payload.receipt.actionId, { ...payload.receipt });
      return payload.receipt;
    }
    return null;
  };
  const runId = 'run_agent_disk_replay_12345678';
  const action = { tool: 'write_slide', page: 2, html: '<html></html>' };
  const envelope = {
    actionId: `${runId}:action:1`,
    argsHash: `sha256:${'2'.repeat(64)}`,
    expectedDeckRevision: `sha256:${'1'.repeat(64)}`,
  };
  try {
    const first = await agent._executeTaskAction({ runId, action, envelope });
    assert.equal(first.ok, true);
    assert.deepEqual(events, ['start', 'backup', 'pending', 'write', 'receipt']);
    agent._taskReceipts.clear();
    const replay = await agent._executeTaskAction({ runId, action, envelope });
    assert.equal(replay.replayed, true, 'disk receipt must replay after the in-memory cache is lost');
    assert.equal(executions, 1);

    const secondId = `${runId}:action:2`;
    receipts.set(secondId, {
      actionId: secondId,
      argsHash: `sha256:${'4'.repeat(64)}`,
      expectedDeckRevision: `sha256:${'1'.repeat(64)}`,
      tool: 'write_slide',
      status: 'pending',
    });
    agent._taskReceipts.clear();
    const pending = await agent._executeTaskAction({
      runId, action,
      envelope: { actionId: secondId, argsHash: `sha256:${'4'.repeat(64)}`, expectedDeckRevision: `sha256:${'1'.repeat(64)}` },
    });
    assert.equal(pending.error.code, 'STALE_DECK');
    assert.equal(executions, 1, 'an unresolved disk receipt must not repeat a changed-deck write');
  } finally {
    agent._executeAction = originalExecute;
    agent._taskDeckRevision = originalRevision;
    agentContext.window.__TAURI__.core.invoke = originalInvoke;
    agent._taskReceipts.clear();
  }
}

async function testAgentTaskActionStopsBeforeWriteWhenPendingReceiptCannotPersist() {
  const originalExecute = agent._executeAction;
  const originalRevision = agent._taskDeckRevision;
  const originalInvoke = agentContext.window.__TAURI__.core.invoke;
  agent._taskReceipts.clear();
  agentContext.window.Settings._pptBuilder = pb;
  const events = [];
  let executions = 0;
  agent._taskDeckRevision = async () => `sha256:${'6'.repeat(64)}`;
  agent._executeAction = async () => {
    executions += 1;
    return 'write_slide 已保存';
  };
  agentContext.window.__TAURI__.core.invoke = async (command, payload) => {
    if (command === 'ppte_task_journal_start') { events.push('start'); return { runId: payload.runId }; }
    if (command === 'ppte_task_journal_receipt_get') return null;
    if (command === 'ppte_task_journal_before_write') { events.push('backup'); return { ok: true }; }
    if (command === 'ppte_task_journal_append_receipt' && payload.receipt.status === 'pending') {
      events.push('pending-failed');
      throw new Error('disk full');
    }
    return null;
  };
  const runId = 'run_agent_receipt_failure_12345678';
  try {
    const result = await agent._executeTaskAction({
      runId,
      action: { tool: 'write_slide', page: 2, html: '<html></html>' },
      envelope: {
        actionId: `${runId}:action:1`,
        argsHash: `sha256:${'7'.repeat(64)}`,
        expectedDeckRevision: `sha256:${'6'.repeat(64)}`,
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'RECEIPT_UNAVAILABLE');
    assert.deepEqual(events, ['start', 'backup', 'pending-failed']);
    assert.equal(executions, 0, 'a failed pending receipt must stop before any local file mutation');
  } finally {
    agent._executeAction = originalExecute;
    agent._taskDeckRevision = originalRevision;
    agentContext.window.__TAURI__.core.invoke = originalInvoke;
    agent._taskReceipts.clear();
  }
}

function testTaskJournalPredictsRenderedInsertFile() {
  const previousNextFile = agentContext.window.Settings._nextPpteSlideFile;
  agentContext.window.Settings._nextPpteSlideFile = () => 'slide99.html';
  try {
    const paths = agent._taskTouchedPaths(pb, {
      tool: 'render_template',
      mode: 'insert',
      after: 2,
      template_id: 'content-test',
      payload: { title: '新增页' },
    });
    assert.ok(paths.includes('manifest.json'));
    assert.ok(paths.includes('slide99.html'), 'render_template insert must journal the predicted new slide file');

    const implicitInsert = agent._taskTouchedPaths(pb, {
      tool: 'render_template',
      after: 2,
      template_id: 'content-test',
      payload: { title: '新增页' },
    });
    assert.ok(implicitInsert.includes('slide99.html'), 'render_template without a page defaults to insert mode');
  } finally {
    agentContext.window.Settings._nextPpteSlideFile = previousNextFile;
  }
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

function testStreamingBubbleRendersFinalAnswerProgressively() {
  const appended = [];
  const messages = { appendChild: el => appended.push(el), scrollTop: 0, scrollHeight: 0 };
  const originalGetElementById = context.document.getElementById;
  const hadCreateElement = 'createElement' in context.document;
  const originalCreateElement = context.document.createElement;
  context.document.getElementById = id => (id === 'wb-messages' ? messages : null);
  context.document.createElement = () => {
    const classes = new Set();
    return {
      className: '',
      textContent: '',
      innerHTML: '',
      removed: false,
      classList: {
        add: c => classes.add(c),
        remove: c => classes.delete(c),
        contains: c => classes.has(c),
      },
      remove() { this.removed = true; },
    };
  };
  try {
    wb._streamBubble = null;
    wb._streamFull = '短句';
    wb._renderStreamingBubble();
    assert.equal(wb._streamBubble, null, 'short prose stays in the status line');

    wb._streamFull = '这是一段足够长的最终答复内容，'.repeat(10);
    wb._renderStreamingBubble();
    assert.ok(wb._streamBubble, 'long prose streams into a live bubble');
    assert.ok(wb._streamBubble.textContent.includes('最终答复内容'));
    assert.ok(wb._streamBubble.className.includes('wb-streaming'));

    wb._streamFull += '\n\n```action\n{"tool":"validate_deck"}\n```';
    wb._renderStreamingBubble();
    assert.equal(wb._streamBubble, null, 'a complete action block pulls prose back to the status line');
  } finally {
    context.document.getElementById = originalGetElementById;
    if (hadCreateElement) context.document.createElement = originalCreateElement;
    else delete context.document.createElement;
    wb._streamBubble = null;
    wb._streamFull = '';
  }
}

async function testOutlineMentionResolvesViaRpc() {
  const originalRpc = wb._rpc;
  const calls = [];
  wb._rpc = async (type) => {
    calls.push(type);
    return type === 'get-outline' ? '# 章纲内容' : '';
  };
  wb.manifest = { title: 'T', slides: [{ title: '封面', file: 'slide01.html' }] };
  try {
    const result = await wb._resolveAt('@大纲 参考它继续');
    assert.ok(calls.includes('get-outline'), '@大纲 must fetch the outline via RPC');
    assert.ok(result.content.includes('# 章纲内容'));
    assert.ok(result.content.includes('课件大纲'), 'the mention token is replaced with a readable label');
    assert.ok(!result.content.includes('@大纲'));

    const again = await wb._resolveAt('@outline.md 和 @outline.md 一起');
    assert.equal(again.content.match(/outline\.md）当前内容/g).length, 1, 'duplicate outline mentions resolve once');
  } finally {
    wb._rpc = originalRpc;
  }
}

async function testIconToolsSearchAndDownload() {
  const calls = [];
  agentContext.window.Auth = { getToken() { return 'tok'; } };
  agentContext.window.__TAURI__.core.invoke = async (command, payload) => {
    calls.push({ command, payload });
    if (command === 'lectureai_icon_search') {
      return payload.query === '豆包'
        ? { items: [{ file: 'doubao-logo.png', name: '豆包', aliases: ['doubao', '豆包'] }] }
        : { items: [] };
    }
    if (command === 'ppte_download_icon') return 'resources/doubao-logo.png';
    return null;
  };

  const searchResult = await agent._toolSearchIcons({ query: '豆包' });
  assert.ok(searchResult.includes('doubao-logo.png'));
  assert.ok(searchResult.includes('豆包'));
  assert.equal(calls[0].command, 'lectureai_icon_search');
  assert.equal(calls[0].payload.query, '豆包');
  assert.equal(calls[0].payload.authToken, 'tok');

  const emptyResult = await agent._toolSearchIcons({ query: '不存在的图标' });
  assert.ok(emptyResult.includes('没有匹配'), 'empty search must say so instead of dumping JSON');

  const useResult = await agent._toolUseIcon(pb, { file: 'doubao-logo.png' });
  assert.ok(useResult.includes('resources/doubao-logo.png'));
  assert.ok(useResult.includes('<img src="resources/doubao-logo.png">'), 'result must show the reference snippet');
  const download = calls.find(call => call.command === 'ppte_download_icon');
  assert.equal(download.payload.folderPath, '/tmp/deck');
  assert.equal(download.payload.file, 'doubao-logo.png');

  const missingFile = await agent._toolUseIcon(pb, {});
  assert.ok(missingFile.includes('失败'), 'use_icon without file must be refused');

  assert.match(wb._systemPrompt(), /search_icons \{query\?\}/, 'tool catalog must document icon search');
  assert.match(wb._systemPrompt(), /use_icon \{file\}/);
  assert.equal(wb._toolDisplayNames.search_icons, '检索图标库');
  assert.equal(wb._toolDisplayNames.use_icon, '下载图标');
  assert.equal(wb._toolDisplayNames.read_outline, '读取课件大纲');
  assert.equal(wb._toolDisplayNames.apply_role_template, '套用页面母版');
  assert.equal(wb._toolDisplayNames.delete_slide, '删除页面');
  assert.equal(wb._toolDisplayNames.load_skill, '加载助教技能');
  assert.equal(wb._toolDisplayNames.read_skill_resource, '读取技能资料');
  assert.equal(
    wb._userFacingText('Pi Runtime write_slide tool_call'),
    'LectureAI 写入页面内容 任务步骤',
    'internal runtime and tool terms must not reach workbench output',
  );
}

function testActionJsonTolerantParsing() {
  const valid = wb._parseActions('```action\n{"tool":"validate_deck"}\n```');
  assert.equal(valid[0].tool, 'validate_deck', 'plain action still parses');

  const trailingComma = wb._parseActions('```action\n{"tool":"render_template","payload":{"a":1,},}\n```');
  assert.equal(trailingComma[0].tool, 'render_template', 'trailing commas are repaired');
  assert.equal(trailingComma[0].payload.a, 1);

  const truncated = wb._parseActions('```action\n{"tool":"set_deck_plan","plan":{"targetSlideCount":32\n```');
  assert.equal(truncated[0].tool, '_parse_error', 'truncated JSON stays a parse error');
  assert.ok(truncated[0].error.includes('截断'), 'truncation is named so the model re-outputs compactly');

  const broken = wb._parseActions('```action\n{"tool": 请验证}\n```');
  assert.equal(broken[0].tool, '_parse_error', 'genuinely invalid JSON still fails');
  assert.ok(!broken[0].error.includes('截断'), 'non-truncation errors keep the original parser message');

  const ansiGarbage = wb._parseActions('```action\n{"tool":"validate_deck"\x1b[118;1:3u}\n```');
  assert.equal(ansiGarbage[0].tool, 'validate_deck', 'ANSI escape bytes leaked by the model are stripped before parsing');

  const nativeMissingClose = wb._parseActions('<tool_call>action\n{"tool":"read_slide","page":1}\n</action>');
  assert.equal(nativeMissingClose[0].tool, 'read_slide', 'native XML action without </tool_call> parses');
  assert.equal(nativeMissingClose[0].page, 1);
  const nativeClosed = wb._parseActions('<tool_call>action\n{"tool":"read_slide","page":2}\n</action>\n</tool_call>');
  assert.equal(nativeClosed[0].tool, 'read_slide', 'fully closed native XML action parses');
  const nativeMisclosed = wb._parseActions('<tool_call>action\n{"tool":"read_slide","page":2}\n</tool_call>');
  assert.equal(nativeMisclosed[0].tool, 'read_slide', 'native XML action closed directly by </tool_call> parses');
  assert.equal(wb._stripActions('状态\n<tool_call>action\n{"tool":"read_slide","page":2}\n</tool_call>'), '状态');

  assert.equal(wb._hasBareToolPayload('{"tool":"set_deck_plan","plan":{}}'), true, 'bare JSON tool payload detected');
  assert.equal(wb._hasBareToolPayload('任务完成，无需修改。'), false);
  assert.equal(wb._hasBareToolPayload('```action\n{"tool":"validate_deck"}\n```'), false, 'fenced actions are not bare');
}

async function testBareToolJsonTriggersProtocolCorrection() {
  const plan = {
    targetSlideCount: 1,
    visualSystem: { style: 'test' },
    slides: [{ page: 1, role: 'cover', title: '测试', contentKind: 'cover', layoutFamily: 'cover', componentIds: [], motion: 'none', visualIntent: '测试' }],
  };
  const replies = [
    JSON.stringify({ tool: 'set_deck_plan', plan }), // bare JSON, no ```action fence
    `保存蓝图\n\`\`\`action\n${JSON.stringify({ tool: 'set_deck_plan', plan })}\n\`\`\``,
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

  assert.deepEqual(executed, ['set_deck_plan', 'validate_deck'], 'bare JSON neither executes nor silently ends the task');
  assert.equal(wb.history.some(x => String(x.content).includes('[工具协议纠正]') && String(x.content).includes('裸 JSON')), true, 'protocol correction is fed back to the model');
}

async function testLectureAiTaskResolverRequest() {
  const previousTauri = context.window.__TAURI__;
  const previousManifest = wb.manifest;
  const previousConfig = wb.selectedConfig;
  let request = null;
  const taskSpec = {
    schemaVersion: 1,
    runId: 'run_12345678-1234-1234-1234-123456789abc',
    intent: 'slide_edit',
    scope: 'page',
    targets: { pages: [2], outline: false, allowInsert: false, allowDelete: false, allowReorder: false },
    executionStrategy: 'bounded_tool_loop',
    requiresDeckPlan: false,
    userFacingGoal: '优化第 2 页',
    assumptions: [],
    acceptanceCriteria: [{ type: 'target_pages_validated', label: '目标页面检查通过' }],
    requiredCapabilities: ['slide.read', 'slide.write.transactional', 'deck.validate'],
    confidence: 0.99,
    requiresClarification: false,
    taskSpecVersion: 'task-spec-v1',
    promptVersion: 'task-resolver-v1',
  };
  context.window.__TAURI__ = { core: { invoke: async (command, args) => {
    request = { command, args };
    return { ok: true, status: 200, data: { taskSpec, status: 'resolved', missingCapabilities: [] } };
  } } };
  wb.selectedConfig = { aiProvider: 'lectureai', aiApiKey: 'test-token' };
  wb.currentPage = 2;
  wb.manifest = {
    folderPath: '/private/local/deck',
    deckRevision: { deckHash: `sha256:${'a'.repeat(64)}` },
    slides: [{ id: 's1', title: '封面', slideType: 'cover' }, { id: 's2', title: '内容', slideType: 'content' }],
    templateBlueprint: { isStarter: false, roles: [] },
    deckPlan: { plan: null },
  };
  try {
    const resolved = await wb._resolveLectureAiTask('@2 优化这一页');
    assert.equal(resolved.runId, taskSpec.runId);
    assert.equal(request.command, 'auth_api_request');
    assert.equal(request.args.action, 'task_resolve');
    assert.equal(request.args.payload.clientKind, 'desktop');
    assert.equal(request.args.payload.deckRevision, `sha256:${'a'.repeat(64)}`);
    assert.deepEqual(request.args.payload.mentions.pages, [2]);
    assert.equal(JSON.stringify(request.args.payload).includes('/private/local/deck'), false, 'resolver payload must not contain local paths');
    assert.ok(request.args.payload.capabilities.includes('task.receipts.v1'));
  } finally {
    context.window.__TAURI__ = previousTauri;
    wb.manifest = previousManifest;
    wb.selectedConfig = previousConfig;
  }
}

async function testLectureAiWebSocketUrlComesFromAuthenticatedFeatures() {
  const previousTauri = context.window.__TAURI__;
  const previousWebSocket = context.WebSocket;
  const previousProviders = wb.providers;
  const previousSelected = wb.selectedConfig;
  const previousServerUrl = wb.lectureAiServerUrl;
  const previousLoaded = wb._featureFlagsLoaded;
  const previousToken = wb._featureFlagsToken;
  const previousFlags = wb._featureFlags;
  const previousWebSocketUrl = wb._lectureAiWebSocketUrl;
  try {
    context.WebSocket = function TestWebSocket() {};
    wb.providers = [{ id: 'lectureai', config: { aiApiKey: 'feature-token' } }];
    wb.selectedConfig = { aiProvider: 'lectureai', aiApiKey: 'feature-token' };
    wb.lectureAiServerUrl = 'https://design.hz-study-system.com';
    wb._featureFlagsLoaded = false;
    context.window.__TAURI__ = {
      core: {
        invoke: async (command, args) => {
          assert.equal(command, 'auth_api_request');
          assert.equal(args.action, 'features');
          assert.equal(args.token, 'feature-token');
          return {
            ok: true,
            data: {
              flags: { lectureai_task_spec_v2: true },
              websocketUrl: 'wss://design.homework.it.com/api/web/ai/pi/bridge',
            },
          };
        },
      },
    };
    await wb._loadLectureAiFeatures(true);
    assert.equal(wb._lecturePiConfig().url, 'wss://design.homework.it.com/api/web/ai/pi/bridge');

    wb._lectureAiWebSocketUrl = 'ws://remote.example.test/api/web/ai/pi/bridge';
    assert.equal(wb._lecturePiConfig().url, 'wss://design.hz-study-system.com/api/web/ai/pi/bridge');
    wb._lectureAiWebSocketUrl = 'ws://localhost:8090/api/web/ai/pi/bridge';
    assert.equal(wb._lecturePiConfig().url, 'ws://localhost:8090/api/web/ai/pi/bridge');
  } finally {
    context.window.__TAURI__ = previousTauri;
    context.WebSocket = previousWebSocket;
    wb.providers = previousProviders;
    wb.selectedConfig = previousSelected;
    wb.lectureAiServerUrl = previousServerUrl;
    wb._featureFlagsLoaded = previousLoaded;
    wb._featureFlagsToken = previousToken;
    wb._featureFlags = previousFlags;
    wb._lectureAiWebSocketUrl = previousWebSocketUrl;
  }
}

async function testTaskJournalRecoveryCleanupAndRevertCompensation() {
  const previousJournalInvoke = wb._taskJournalInvoke;
  const previousTaskApi = wb._taskApi;
  const previousRender = wb._renderTaskCard;
  const previousLoad = wb._loadTaskJournal;
  const previousLog = wb._log;
  const previousConfirm = context.window.confirm;
  const previousTauri = context.window.__TAURI__;
  const previousManifest = wb.manifest;
  const previousDeckPath = wb._deckPath;
  const previousRun = wb._taskCardRun;
  const previousSpec = wb._taskCardSpec;
  const calls = [];
  const run = {
    runId: 'run_revert_compensation_12345678',
    status: 'reverted',
    currentDeckRevision: `sha256:${'b'.repeat(64)}`,
    serverSync: { status: 'pending', action: 'revert', attempts: 0, restoredDeckRevision: `sha256:${'b'.repeat(64)}` },
  };
  try {
    wb._deckPath = '/tmp/task-recovery';
    context.window.__TAURI__ = { core: { invoke: async () => null } };
    wb.manifest = { deckPlan: {} };
    wb._taskJournalInvoke = async (command, payload = {}) => {
      calls.push({ command, payload });
      if (command === 'ppte_task_journal_list') return [{
        runId: 'run_resume_local_12345678', status: 'paused', userInstruction: '继续处理',
        taskSpec: { runId: 'run_resume_local_12345678', intent: 'deck_rewrite', userFacingGoal: '重做课件' },
        plan: { taskSpecRef: { runId: 'run_resume_local_12345678' }, slides: [{ page: 1 }] },
      }];
      if (command === 'ppte_task_journal_clear') return { removed: [{ runId: 'run_old_12345678' }] };
      return { ...run, ...(payload.patch || {}) };
    };
    let rendered = null;
    wb._renderTaskCard = (value, spec) => { rendered = { value, spec }; wb._taskCardRun = value; };
    await wb._loadTaskJournal();
    assert.equal(rendered.spec.intent, 'deck_rewrite', 'local TaskSpec is restored before contacting the server');
    assert.equal(wb.manifest.deckPlan.plan.slides.length, 1, 'the task plan is restored with the journal');

    calls.length = 0;
    wb._taskApi = async (action, payload) => {
      calls.push({ action, payload });
      return { ok: true, data: { status: 'reverted' } };
    };
    const synced = await wb._retryPendingTaskSync(run);
    assert.equal(synced, true, 'a pending local revert is compensated automatically');
    assert.ok(calls.some(item => item.action === 'task_revert'), 'the idempotent server revert endpoint is retried');
    assert.ok(calls.some(item => item.command === 'ppte_task_journal_update' && item.payload.patch.serverSync.status === 'synced'), 'the durable sync marker is cleared after success');

    calls.length = 0;
    context.window.confirm = () => true;
    wb._taskCardRun = { runId: 'run_finished_12345678', status: 'completed' };
    wb._log = () => {};
    wb._loadTaskJournal = async () => {};
    await wb._handleTaskCardAction('clear-history');
    assert.ok(calls.some(item => item.command === 'ppte_task_journal_clear' && item.payload.keepRecent === 0), 'history cleanup only runs after explicit user action');
  } finally {
    for (const timer of wb._taskSyncTimers.values()) clearTimeout(timer);
    wb._taskSyncTimers.clear();
    wb._taskJournalInvoke = previousJournalInvoke;
    wb._taskApi = previousTaskApi;
    wb._renderTaskCard = previousRender;
    wb._loadTaskJournal = previousLoad;
    wb._log = previousLog;
    context.window.confirm = previousConfirm;
    context.window.__TAURI__ = previousTauri;
    wb.manifest = previousManifest;
    wb._deckPath = previousDeckPath;
    wb._taskCardRun = previousRun;
    wb._taskCardSpec = previousSpec;
  }
}

(async () => {
  await testLectureAiTaskResolverRequest();
  await testLectureAiWebSocketUrlComesFromAuthenticatedFeatures();
  await testTaskJournalRecoveryCleanupAndRevertCompensation();
  await testLectureAiRetriesOneTransientUpstreamFailure();
  await testInputUiBindsWithoutTauriEvents();
  await testExternalSkillImportRefreshesCatalog();
  agentContext.window.Settings._pptBuilder = pb;
  await testConceptAnimationContextIncludesCurrentNeighborsAndStylesheet();
  await testTemplateAwareInsertKeepsFinishLast();
  await testStarterDeckExpandsToExactlyFifteenPages();
  await testFinalizeDeckRemovesOnlyUnplannedStarterPages();
  await testNativeDeleteSlideIsManifestOnlyAndPlanBound();
  testStructuredTaskReceiptDetails();
  await testCancelledSaveRollsBackAgentMutation();
  await testWorkbenchStopsAfterDiskSaveFailure();
  await testLongDeckJobRunsToCompletion();
  await testDeckTaskRequiresPlanBeforeMutationAndValidationBeforeFinish();
  await testDeckInspectionRequiresValidationButNotPlan();
  await testOutlineOnlyTaskCannotMutateSlides();
  await testSlashCommandRequiresInspectionAndReinspection();
  await testSlashCommandKeepsPageScope();
  await testOptionalPlanToolsUseSeparateTauriStorage();
  await testPlannedPlaceholderRoleConversion();
  await testPrivateTemplateRenderUsesServerHtmlAndSafeSave();
  await testPageHarnessResetsMessagesBetweenSlides();
  await testHarnessFinalizesBeforeDeckValidation();
  await testHarnessCompletionWaitsForServerAuthority();
  await testHarnessValidationFailureBecomesRepairable();
  await testPiWebSocketReturnsMatchingToolResult();
  await testNativeTaskWebSocketUsesStructuredReceipts();
  await testAgentTaskActionIsIdempotentAndRevisionSafe();
  await testAgentTaskActionPersistsBeforeWritingAndReplaysAfterRestart();
  await testAgentTaskActionStopsBeforeWriteWhenPendingReceiptCannotPersist();
  testTaskJournalPredictsRenderedInsertFile();
  await testAgentImportsSelectedExternalSkillFolder();
  testStreamingBubbleRendersFinalAnswerProgressively();
  testActionJsonTolerantParsing();
  await testBareToolJsonTriggersProtocolCorrection();
  await testOutlineMentionResolvesViaRpc();
  await testIconToolsSearchAndDownload();
  await testSessionPersistence();
})()
  .then(() => console.log('test-workbench-window: all assertions passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
