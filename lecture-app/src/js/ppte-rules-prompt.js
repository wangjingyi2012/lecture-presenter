// ppte-rules-prompt.js - PPTE formatting-rule access layer.
//
// The rule text and the linter implementation live in the Rust backend
// (loaded from a bundled prompt asset). This module is a thin async wrapper so
// the workbench agent can request lint results via invoke('ppte_lint').
//
// PpteRules.lint(html)        -> Promise<[{rule,severity,message,sample}]>
// PpteRules.lintSummary(html) -> Promise<string>
window.PpteRules = {
  async lint(html) {
    if (!window.__TAURI__ || !window.__TAURI__.core) return [];
    try {
      return await window.__TAURI__.core.invoke('ppte_lint', { html: html || '' });
    } catch (e) {
      console.warn('ppte_lint failed', e);
      return [];
    }
  },

  async lintSummary(html) {
    const issues = await this.lint(html);
    if (!issues || !issues.length) return '合规：未发现排版规范问题。';
    return issues.map((i, n) => `${n + 1}. [${i.severity}] ${i.rule}：${i.message}${i.sample ? `  ｜  "${i.sample}"` : ''}`).join('\n');
  }
};
