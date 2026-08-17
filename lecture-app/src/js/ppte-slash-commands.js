// ppte-slash-commands.js - Declarative slash commands for the PPTE workbench.
//
// Commands are intentionally data-driven: the chat window owns discovery and
// parsing, while the main window owns deterministic inspection. Adding a new
// command should normally only require one registry entry and (when needed) a
// new inspector category.
window.PpteSlashCommands = {
  commands: [
    {
      name: 'layout-check',
      title: '布局检查',
      description: '检查页面结构、密度、卡片空白和投影可读性并自动重排',
      check: 'quality',
      defaultScope: 'deck',
      workflow: '先明确每页唯一记忆结论，再根据并列、对比、流程或因果关系选择 Grid、双栏、时间线、流程图或关系图。只有真正并列的信息才使用卡片；禁止用等高卡片制造空白。修改后重点复查 density、overflow、font 与 card 问题。',
    },
    {
      name: 'font-check',
      title: '字体检查',
      description: '检查字号、单位和投影可读性，不合规时自动修复',
      check: 'font',
      defaultScope: 'deck',
      workflow: '先检查实际计算字号。正文至少 1.8vw，辅助文字至少 1.5vw，字体声明禁用 px。逐页修复所有错误后重新检查。不得用缩小文字解决溢出。',
    },
    {
      name: 'overflow-check',
      title: '溢出检查',
      description: '检查内容越界、裁切和滚动区域，并自动重排',
      check: 'overflow',
      defaultScope: 'deck',
      workflow: '在 1920×1080 画布检查页面和 .content-area 的真实几何溢出。优先压缩间距、改变布局或拆分信息，不得靠缩小字体或给主容器加 overflow:hidden 掩盖问题。',
    },
    {
      name: 'density-check',
      title: '密度检查',
      description: '检查页面过空、卡片过高和无效留白，并自动收紧布局',
      check: 'density',
      defaultScope: 'deck',
      workflow: '检查内容占用率与卡片内部空白。收紧过高卡片和无效间距，必要时改变 Grid/Flex 结构；保持清晰层级，不用堆装饰填空。',
    },
    {
      name: 'card-check',
      title: '卡片检查',
      description: '检查卡片高度、空白、侧边彩条和过度装饰',
      check: 'card',
      defaultScope: 'deck',
      workflow: '检查卡片空白率、固定高度、彩色侧边条、渐变和重复卡片化。优先让高度随内容收缩；强调使用文字、浅底色或图标。',
    },
    {
      name: 'copy-check',
      title: '文案检查',
      description: '把讲师口吻、提问句和冗长文字改成学员屏显文案',
      check: 'copy',
      defaultScope: 'deck',
      workflow: '可见文案必须干练、直白、无提问、无课堂引导口吻。标题和卡片文字写成可直接记忆的标签或短结论；讲述提示应放入 .note，而不是页面 HTML。',
    },
    {
      name: 'student-copy',
      title: '学员文案',
      description: '把可见文字改成简短、直白、可记忆的学员屏显文案',
      check: 'copy',
      defaultScope: 'deck',
      workflow: '先写出每页唯一记忆结论。可见文字使用标签、名词短语、短结论和紧凑列表；删除“我们、大家、接下来、先看、很关键”等课堂引导语，把提问式标题改为陈述式标题。讲述提示、过渡语和教师提醒放入 .note。',
    },
    {
      name: 'concept-animate',
      title: '概念动画',
      description: '套用标准分步讲解骨架，一次点击推进一个概念',
      check: 'concept-animation',
      defaultScope: 'current',
      commandContext: 'concept-animation',
      workflow: '这是内置 PPTE 分步动画工作流，不是普通动效提示。必须读取客户端附加的目标页、相邻页、样式表和标准骨架；默认沿用骨架制作 click-stepped reveal，不得从零发明另一套交互。一次点击只增加一个概念关系，主画布在步骤之间保持稳定。',
    },
    {
      name: 'quality-check',
      title: '综合检查',
      description: '一次检查字体、溢出、密度、卡片和文案并自动修复',
      check: 'quality',
      defaultScope: 'deck',
      workflow: '先运行综合检查，再按字体、溢出、密度、卡片、文案的顺序修复。每次修改后重新检查，直到没有阻断问题。',
    },
    {
      name: 'help',
      title: '命令帮助',
      description: '查看全部斜杠命令及使用方式',
      local: true,
      defaultScope: 'none',
    },
    {
      name: 'clear',
      title: '清理上下文',
      description: '清除当前对话历史，保留课件连接和页面状态',
      local: true,
      localAction: 'clear',
      defaultScope: 'none',
    },
    {
      name: 'compact',
      title: '压缩上下文',
      description: '保留系统规则和最近对话，压缩较早的上下文',
      local: true,
      localAction: 'compact',
      defaultScope: 'none',
    },
  ],

  get(name) {
    const normalized = String(name || '').replace(/^\//, '').toLowerCase();
    return this.commands.find(command => command.name === normalized) || null;
  },

  tokenAt(value, caret) {
    const text = String(value || '');
    const end = Math.max(0, Math.min(caret == null ? text.length : caret, text.length));
    const before = text.slice(0, end);
    const match = before.match(/(^|\s)([\/／][a-z-]*)$/i);
    if (!match) return null;
    const token = match[2];
    return { start: end - token.length, end, token, query: token.slice(1).toLowerCase() };
  },

  mentionTokenAt(value, caret) {
    const text = String(value || '');
    const end = Math.max(0, Math.min(caret == null ? text.length : caret, text.length));
    const before = text.slice(0, end);
    const match = before.match(/(^|\s)([@＠][^\s@＠，。、,]*)$/u);
    if (!match) return null;
    const token = match[2];
    return { start: end - token.length, end, token, query: token.slice(1).toLowerCase() };
  },

  skillTokenAt(value, caret) {
    const text = String(value || '');
    const end = Math.max(0, Math.min(caret == null ? text.length : caret, text.length));
    const before = text.slice(0, end);
    const match = before.match(/(^|\s)(\$[a-z0-9-]*)$/i);
    if (!match) return null;
    const token = match[2];
    return { start: end - token.length, end, token, query: token.slice(1).toLowerCase() };
  },

  searchSkills(value, caret, skills) {
    const token = this.skillTokenAt(value, caret);
    if (!token) return { token: null, items: [] };
    const query = token.query;
    const items = (Array.isArray(skills) ? skills : []).filter(skill => {
      if (!query) return true;
      return String(skill.name || '').toLowerCase().includes(query)
        || String(skill.description || '').toLowerCase().includes(query)
        || String(skill.sourceLabel || '').toLowerCase().includes(query);
    });
    return { token, items };
  },

  searchPages(value, caret, slides, files = []) {
    const token = this.mentionTokenAt(value, caret);
    if (!token) return { token: null, items: [] };
    const query = token.query;
    const pageItems = (Array.isArray(slides) ? slides : []).map((slide, index) => ({
      kind: 'page',
      page: index + 1,
      title: slide?.title || `第 ${index + 1} 页`,
      file: slide?.file || '',
      slideType: slide?.slideType || slide?.slide_type || 'content',
    })).filter(item => {
      if (!query) return true;
      return String(item.page).includes(query)
        || item.title.toLowerCase().includes(query)
        || item.file.toLowerCase().includes(query)
        || item.slideType.toLowerCase().includes(query);
    });
    const fileItems = (Array.isArray(files) ? files : []).map(entry => ({
      kind: 'file',
      file: entry.file || '',
      label: entry.label || entry.file || '',
      title: entry.label || entry.file || '',
    })).filter(item => {
      if (!query) return true;
      return item.file.toLowerCase().includes(query) || item.label.toLowerCase().includes(query);
    });
    return { token, items: [...fileItems, ...pageItems] };
  },

  search(value, caret) {
    const token = this.tokenAt(value, caret);
    if (!token) return { token: null, items: [] };
    const items = this.commands.filter(command => {
      if (!token.query) return true;
      return command.name.includes(token.query)
        || command.title.includes(token.query)
        || command.description.includes(token.query);
    });
    return { token, items };
  },

  applySuggestion(value, caret, name) {
    const text = String(value || '');
    const hit = this.tokenAt(text, caret);
    if (!hit) return { value: text, caret: caret == null ? text.length : caret };
    const replacement = `/${String(name || '').replace(/^\//, '')} `;
    const next = text.slice(0, hit.start) + replacement + text.slice(hit.end);
    const nextCaret = hit.start + replacement.length;
    return { value: next, caret: nextCaret };
  },

  applyPageSuggestion(value, caret, page) {
    const text = String(value || '');
    const hit = this.mentionTokenAt(text, caret);
    if (!hit) return { value: text, caret: caret == null ? text.length : caret };
    const replacement = `@${Number(page)} `;
    const next = text.slice(0, hit.start) + replacement + text.slice(hit.end);
    const nextCaret = hit.start + replacement.length;
    return { value: next, caret: nextCaret };
  },

  applyFileSuggestion(value, caret, file) {
    const text = String(value || '');
    const hit = this.mentionTokenAt(text, caret);
    if (!hit) return { value: text, caret: caret == null ? text.length : caret };
    const replacement = `@${String(file || '').replace(/^@/, '')} `;
    const next = text.slice(0, hit.start) + replacement + text.slice(hit.end);
    const nextCaret = hit.start + replacement.length;
    return { value: next, caret: nextCaret };
  },

  applySkillSuggestion(value, caret, name) {
    const text = String(value || '');
    const hit = this.skillTokenAt(text, caret);
    if (!hit) return { value: text, caret: caret == null ? text.length : caret };
    const replacement = `$${String(name || '').replace(/^\$/, '')} `;
    const next = text.slice(0, hit.start) + replacement + text.slice(hit.end);
    const nextCaret = hit.start + replacement.length;
    return { value: next, caret: nextCaret };
  },

  parseSkillNames(input) {
    const names = [];
    const seen = new Set();
    for (const match of String(input || '').matchAll(/(?:^|\s)\$([a-z0-9-]+)(?=\s|$)/gi)) {
      const name = match[1].toLowerCase();
      if (!seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }
    return names;
  },

  parse(input, context = {}) {
    const raw = String(input || '').trim();
    const match = raw.match(/(^|\s)\/([a-z-]+)(?=\s|$)/i);
    if (!match) return null;
    const command = this.get(match[2]);
    if (!command) return { unknown: match[2], raw };
    const pages = [];
    const seen = new Set();
    for (const pageMatch of raw.matchAll(/@(\d+)\b/g)) {
      const page = Number(pageMatch[1]);
      if (page > 0 && !seen.has(page)) {
        seen.add(page);
        pages.push(page);
      }
    }
    if (!pages.length && command.defaultScope === 'current' && Number(context.currentPage) > 0) {
      pages.push(Number(context.currentPage));
    }
    const args = raw
      .replace(new RegExp(`(^|\\s)\\/${command.name}(?=\\s|$)`, 'i'), '$1')
      .replace(/\s+/g, ' ')
      .trim();
    const scopeLabel = pages.length ? `第 ${pages.join('、')} 页` : '整套课件';
    const instruction = command.local ? '' : [
      `[斜杠命令 /${command.name}]`,
      `任务：${command.title}；范围：${scopeLabel}。`,
      command.workflow,
      `必须使用 inspect_slides {check:"${command.check}"${pages.length ? `,pages:[${pages.join(',')}]` : ''}} 获取确定性结果。只读取和修改检查范围内的页面。检查有问题时自动修复；修改后必须再次调用同一检查，检查通过后才能结束。`,
      args ? `用户补充：${args}` : '',
    ].filter(Boolean).join('\n');
    return { command, pages, args, raw, scopeLabel, instruction };
  },

  commandWorkflowContext(command) {
    if (command?.commandContext !== 'concept-animation') return '';
    return `[内置工作流：PPTE Concept Animation]

目标：把目标页改造成可控的课堂分步讲解。默认使用 click-stepped reveal，只有用户明确要求流程时间线或悬停聚焦时才改变交互类型。

硬约束：
1. 拆成 3-6 个认知步骤。一次点击只推进一个步骤、增加一个新关系。
2. 保持主画布稳定；在共享对象上增加高亮、路径、标签或结论，不要每一步整屏换场。
3. 根节点必须带 data-ppte-concept-animation、data-step="0"、data-max-step="N"。
4. 底部中央必须有 .ppte-step-rail；每个 .ppte-step-node 使用 data-target-step，并含两行显式 span：.ppte-step-main 与 .ppte-step-sub。禁止依赖自动换行。
5. 右下角必须有 .ppte-step-dots，数量为 N+1（含初始状态）。不得显示“点击继续”等操作提示。
6. 支持页面点击前进、步骤按钮直达、Right/Space/PageDown 前进、Left/PageUp 后退。
7. 只有内部步骤仍可前进/后退时才 preventDefault；到最后一步必须允许宿主演示器翻到下一页。
8. 禁止自动播放、setInterval 和无限循环；每步完成后静止等待。
9. 必须包含 @media (prefers-reduced-motion: reduce)，默认状态无需交互也能理解主题。
10. 沿用原课件 stylesheet、背景、颜色和 .content-area 定位；字体使用 vw，正文至少 1.8vw，辅助文字至少 1.5vw。可见文案面向学员。

必须保留的交互骨架（替换概念内容和局部视觉，不改变控制协议）：
\`\`\`html
<style>
  .ppte-click-stage { position: relative; width: 100%; height: 100%; min-height: 0; }
  .ppte-click-canvas { position: absolute; inset: 0 0 7.1vw; overflow: visible; }
  .ppte-click-layer { position: absolute; inset: 0; opacity: 0; visibility: hidden; pointer-events: none; transform: translateY(.7vw); transition: opacity .38s ease, transform .38s ease, visibility 0s linear .38s; }
  .ppte-click-layer.is-visible { opacity: 1; visibility: visible; pointer-events: auto; transform: translateY(0); transition-delay: 0s; }
  .ppte-step-rail { position: absolute; left: 50%; bottom: .8vw; z-index: 20; display: flex; align-items: stretch; gap: .55vw; width: min(76vw, 86%); transform: translateX(-50%); }
  .ppte-step-node { flex: 1 1 0; min-width: 0; border: 1px solid color-mix(in srgb, currentColor 20%, transparent); border-radius: .7vw; padding: .55vw .65vw; color: inherit; background: color-mix(in srgb, Canvas 88%, transparent); text-align: left; cursor: pointer; opacity: .62; transition: opacity .22s ease, transform .22s ease, border-color .22s ease; }
  .ppte-step-node.active { opacity: 1; transform: translateY(-.18vw); border-color: currentColor; }
  .ppte-step-main, .ppte-step-sub { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ppte-step-main { font-size: 1.8vw; font-weight: 700; line-height: 1.15; }
  .ppte-step-sub { margin-top: .18vw; font-size: 1.5vw; line-height: 1.2; opacity: .72; }
  .ppte-step-dots { position: absolute; right: 1.2vw; bottom: 1.1vw; z-index: 21; display: flex; gap: .34vw; pointer-events: none; }
  .ppte-step-dots span { width: .44vw; height: .44vw; border-radius: 50%; background: currentColor; opacity: .22; transition: opacity .22s ease, transform .22s ease; }
  .ppte-step-dots span.active { opacity: .9; transform: scale(1.3); }
  @media (prefers-reduced-motion: reduce) { .ppte-click-layer, .ppte-step-node, .ppte-step-dots span { transition: none !important; } }
</style>
<div class="content-area ppte-click-stage step-0" data-ppte-concept-animation data-step="0" data-max-step="4">
  <div class="ppte-click-canvas">
    <div class="ppte-click-layer is-visible" data-show-from="0" data-show-to="4"><!-- 稳定共享画布 --></div>
    <div class="ppte-click-layer" data-show-from="1" data-show-to="1"><!-- 第1步新增关系 --></div>
    <div class="ppte-click-layer" data-show-from="2" data-show-to="2"><!-- 第2步新增关系 --></div>
    <div class="ppte-click-layer" data-show-from="3" data-show-to="3"><!-- 第3步新增关系 --></div>
    <div class="ppte-click-layer" data-show-from="4" data-show-to="4"><!-- 第4步结论 --></div>
  </div>
  <div class="ppte-step-rail" aria-label="分步演示控制">
    <button class="ppte-step-node" data-target-step="1"><span class="ppte-step-main">术语</span><span class="ppte-step-sub">正式含义</span></button>
    <!-- 每一步一个按钮 -->
  </div>
  <div class="ppte-step-dots" aria-hidden="true"><span class="active"></span><!-- 共 N+1 个 --></div>
</div>
<script>
(() => {
  const root = document.querySelector('[data-ppte-concept-animation]');
  const maxStep = Number(root.dataset.maxStep);
  const layers = [...root.querySelectorAll('[data-show-from]')];
  const nodes = [...root.querySelectorAll('[data-target-step]')];
  const dots = [...root.querySelectorAll('.ppte-step-dots span')];
  let current = 0;
  function render() {
    for (let i = 0; i <= maxStep; i += 1) root.classList.remove('step-' + i);
    root.classList.add('step-' + current); root.dataset.step = String(current);
    layers.forEach(layer => { const visible = current >= Number(layer.dataset.showFrom) && current <= Number(layer.dataset.showTo ?? maxStep); layer.classList.toggle('is-visible', visible); layer.setAttribute('aria-hidden', String(!visible)); });
    nodes.forEach(node => node.classList.toggle('active', Number(node.dataset.targetStep) === current));
    dots.forEach((dot, i) => dot.classList.toggle('active', i === current));
  }
  function goTo(next) { if (next >= 0 && next <= maxStep && next !== current) { current = next; render(); } }
  root.addEventListener('click', event => { const node = event.target.closest('[data-target-step]'); if (node) { event.stopPropagation(); goTo(Number(node.dataset.targetStep)); } else if (current < maxStep) goTo(current + 1); });
  document.addEventListener('keydown', event => {
    if (['ArrowRight', ' ', 'PageDown'].includes(event.key) && current < maxStep) { event.preventDefault(); goTo(current + 1); }
    if (['ArrowLeft', 'PageUp'].includes(event.key) && current > 0) { event.preventDefault(); goTo(current - 1); }
  });
  render();
})();
</script>
\`\`\`

这段 CSS 是最低可用标准；根据目标课件的颜色和共同对象做视觉适配，但不要删除控制类、稳定画布、显隐层、步骤栏、进度点或 reduced-motion。完成后调用 inspect_slides {check:"concept-animation"}；它会同时验收交互结构、字体、溢出和学员文案。`;
  },

  helpMarkdown() {
    const rows = this.commands
      .map(command => `| \`/${command.name}\` | ${command.description} | ${command.local ? '本地' : (command.defaultScope === 'current' ? '当前页' : '整套课件')} |`)
      .join('\n');
    return `### 可用斜杠命令\n\n| 命令 | 作用 | 默认范围 |\n|---|---|---|\n${rows}\n\n用 \`@页码\` 限定范围，例如 \`@3 /font-check\`。从单页“AI助手”进入时，\`/concept-animate\` 默认处理当前页。`;
  },
};
