// ppte-rules-prompt.js - PPTE formatting rules as a system-prompt fragment plus a
// mechanical linter. This is the moat: a bare Claude Code session does not know
// these rules, so slides produced outside this workbench are not compliant.
//
// PpteRules.RULES_PROMPT  -> injected into the workbench agent system prompt
// PpteRules.lint(html)    -> mechanically-checkable violations [{rule,severity,message,sample}]
// PpteRules.lintSummary(html) -> single string for tool-result feedback to the model
window.PpteRules = {
  RULES_PROMPT: `你是 PPTE（PPT-EXTRA）HTML 幻灯片编辑助手，严格遵循以下排版规范。生成或修改任何页面时必须全部遵守。

## PPTE 排版规范

1. 去讲师痕迹：标题不写"开场""续""案例①""动手实验""附录""课程回顾"等讲师自用提示性字眼，只保留知识点本身。
2. 全面书面化：去掉"裸奔""喂给""上当""骗 AI""黑客""戏剧性结尾"等口语词；金句改客观陈述，不堆段子。
3. 去破折号：正文里的 -- 全部用逗号或句号替代；流程图里的 ↓ -> 等箭头符号保留。
4. 去句末句号：段落末尾的 。 去掉；段落中间的句号保留。代码块、攻击 payload 示例中的句号保留。
5. 重点词高亮保留：段内 <b style="color:#dc2626"> 等红色加粗作为视觉锚点，不动。
6. 卡片不要侧边高亮条：.card、步骤卡、.kpi、.map-card 等卡片容器用统一浅色 4 边边框（如 1px solid #cbd5e1），禁止 border-left / border-top 彩条；卡片背景一律中性（#fff 或 #f8fafc），不要彩色渐变。
7. emoji 全换 SVG：✓ ✗ ⚠️ ✅ ❗ ⚡ ● 等图形 emoji 全部用内联 SVG 实现；箭头符号 -> ↑ ↓ ⬇ 保留（属流程图视觉元素）。
8. 术语第一次出现用弹窗：术语（如 ZoomEye、HuggingFace、SKILL）第一次出现时用 <span class="term" data-popover-title data-popover-body> 包成可点击弹窗；弹窗只显示正文，保留右上角 × 关闭按钮。
9. 全局覆盖样式集中：每个 slide 的 <style> 末尾追加同一段全局覆盖 CSS，避免在每个 slide 里重复定义。`,

  // Mechanically-checkable subset of the rules above. The non-mechanical rules
  // (term popups, global CSS, highlight preservation) stay in RULES_PROMPT as
  // guidance for the model.
  ORAL_WORDS: ['裸奔', '喂给', '上当', '骗AI', '骗 AI', '黑客', '戏剧性结尾'],
  LECTURER_TRACE: /(?:^|[\s·：:])?(?:开场|动手实验|附录|课程回顾)(?:[①②③④⑤]|\b|$)/,
  EMOJI: /[✓✗⚠️✅❗⚡●★☆☑☒⭐✨]/,
  DASH: /--/,

  _inCodeContext(el) {
    let n = el;
    while (n) {
      const tag = n.tagName;
      if (tag === 'PRE' || tag === 'CODE' || tag === 'SCRIPT' || tag === 'STYLE') return true;
      n = n.parentElement;
    }
    return false;
  },

  lint(html) {
    const issues = [];
    if (!html || typeof html !== 'string') return issues;

    let doc;
    try {
      doc = new DOMParser().parseFromString(html, 'text/html');
    } catch (e) {
      return [{ rule: 'HTML 解析', severity: 'error', message: '页面 HTML 无法解析' }];
    }

    // 1. Title lecturer traces (h1-h3, title).
    doc.querySelectorAll('h1, h2, h3, title').forEach(h => {
      const t = (h.textContent || '').replace(/\s+/g, ' ').trim();
      if (t && this.LECTURER_TRACE.test(t)) {
        issues.push({ rule: '去讲师痕迹', severity: 'warn', message: `标题含讲师痕迹词：${t.slice(0, 40)}` });
      }
    });

    // 2. Walk text nodes (skip pre/code/script/style) for oral words, emoji, dashes, trailing 。
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (this._inCodeContext(node.parentElement)) continue;
      const raw = node.nodeValue || '';
      const text = raw.replace(/\s+/g, ' ').trim();
      if (!text) continue;

      this.ORAL_WORDS.forEach(w => {
        if (text.includes(w)) {
          issues.push({ rule: '全面书面化', severity: 'warn', message: `口语词"${w}"`, sample: text.slice(0, 60) });
        }
      });
      if (this.EMOJI.test(text)) {
        issues.push({ rule: 'emoji 换 SVG', severity: 'error', message: '图形 emoji 应用内联 SVG 实现', sample: text.slice(0, 60) });
      }
      if (this.DASH.test(text)) {
        issues.push({ rule: '去破折号', severity: 'warn', message: '正文含 --，应用逗号或句号替代', sample: text.slice(0, 60) });
      }
      // Trailing 。 only when this text node ends a block element (rough heuristic).
      const parent = node.parentElement;
      if (parent && /。$/.test(text) && ['P', 'LI', 'DIV', 'SPAN'].includes(parent.tagName)) {
        // Confirm this is the last text child of the block.
        issues.push({ rule: '去句末句号', severity: 'info', message: '段落末尾句号建议去掉', sample: text.slice(-40) });
      }
    }

    // 3. Card side borders: inline border-left/border-top with a color on card containers.
    const colorRe = /#[0-9a-fA-F]{3,8}|rgb|hsl|red|orange|blue|green|yellow|purple|pink|amber|emerald/i;
    doc.querySelectorAll('.card, .kpi, .map-card, [class*="step-card"], [class*="step_card"]').forEach(el => {
      const style = el.getAttribute('style') || '';
      const m = style.match(/border-(?:left|top)\s*:\s*[^;]+/gi);
      if (m) {
        const hasColor = m.some(s => colorRe.test(s));
        if (hasColor) {
          issues.push({ rule: '卡片不要侧边彩条', severity: 'error', message: `卡片有 ${m.join('; ')}，应用统一 4 边边框` });
        }
      }
    });

    // 4. Card colored gradient backgrounds.
    doc.querySelectorAll('.card, .kpi, .map-card').forEach(el => {
      const style = el.getAttribute('style') || '';
      if (/(?:linear|radial)-gradient/i.test(style)) {
        issues.push({ rule: '卡片中性背景', severity: 'warn', message: '卡片背景含彩色渐变，应改中性 #fff / #f8fafc' });
      }
    });

    return issues;
  },

  lintSummary(html) {
    const issues = this.lint(html);
    if (!issues.length) return '合规：未发现排版规范问题。';
    return issues.map((i, n) => `${n + 1}. [${i.severity}] ${i.rule}：${i.message}${i.sample ? `  ｜  "${i.sample}"` : ''}`).join('\n');
  }
};
