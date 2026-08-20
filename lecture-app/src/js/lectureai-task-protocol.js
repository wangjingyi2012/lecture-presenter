// Public LectureAI task protocol helpers. Server-owned prompts and policies are
// deliberately not represented here; this module only validates wire data and
// keeps user-facing state deterministic.
(function attachLectureAiTaskProtocol(global) {
  'use strict';

  const CONTRACT = Object.freeze({
    protocolVersion: 'lectureai-task-v1',
    taskSpecSchemaVersion: 1,
    eventSchemaVersion: 1,
    errorSchemaVersion: 1,
    capabilitySchemaVersion: 1,
    intents: Object.freeze(['answer', 'outline_write', 'slide_edit', 'slide_insert', 'deck_cleanup', 'deck_rewrite', 'deck_validate', 'resume_run']),
    executionStrategies: Object.freeze(['direct_reply', 'bounded_tool_loop', 'planned_harness']),
    scopes: Object.freeze(['none', 'outline', 'page', 'deck']),
    states: Object.freeze(['created', 'awaiting_user', 'resolving', 'resolved', 'planning', 'ready', 'running', 'paused', 'repairing', 'validating', 'needs_repair', 'completed', 'failed', 'cancelled', 'reverted']),
    terminalStates: Object.freeze(['completed', 'cancelled', 'failed', 'reverted']),
    eventTypes: Object.freeze(['task_resolved', 'task_status', 'progress', 'tool_call', 'tool_result', 'validation', 'task_completed', 'task_paused', 'task_failed', 'task_reverted']),
    errorCategories: Object.freeze(['model_correctable', 'stale_state', 'permission', 'quota', 'transient', 'client_unavailable', 'validation_failed', 'protocol']),
    capabilities: Object.freeze(['deck.plan.v3', 'slide.read', 'slide.write.transactional', 'slide.insert', 'slide.delete', 'slide.reorder', 'outline.write', 'deck.validate', 'render.diagnostics.v1', 'task.receipts.v1', 'task.revert.v1']),
    transitions: Object.freeze({
      created: ['awaiting_user', 'resolving', 'cancelled'],
      awaiting_user: ['resolving', 'cancelled'],
      resolving: ['resolved', 'awaiting_user', 'failed', 'cancelled'],
      resolved: ['planning', 'ready', 'cancelled'],
      planning: ['ready', 'paused', 'failed', 'cancelled'],
      ready: ['running', 'paused', 'cancelled'],
      running: ['paused', 'repairing', 'validating', 'failed', 'cancelled'],
      paused: ['planning', 'running', 'failed', 'cancelled'],
      repairing: ['running', 'validating', 'paused', 'failed', 'cancelled'],
      validating: ['completed', 'needs_repair', 'paused', 'failed', 'cancelled'],
      needs_repair: ['repairing', 'failed', 'cancelled'],
      completed: ['reverted'],
      failed: ['planning', 'running', 'reverted'],
      cancelled: ['reverted'],
      reverted: [],
    }),
  });

  const WRITE_INTENTS = new Set(['outline_write', 'slide_edit', 'slide_insert', 'deck_cleanup', 'deck_rewrite']);
  const INTERNAL_TERMS = /\b(?:pi(?:\s+(?:agent|runtime))?|runtime|write_slide|insert_slide|render_template|validate_slide|validate_deck|set_deck_plan)\b/gi;
  const FRIENDLY_ERRORS = Object.freeze({
    STALE_DECK: '课件已在任务执行期间发生变化，LectureAI 已暂停写入。',
    PROTOCOL_ACTION_CONFLICT: '任务回执不一致，LectureAI 已停止本轮操作。',
    TEMPLATE_SLOT_MAX_ITEMS: '当前页面内容超过版式容量，LectureAI 正在自动精简。',
    TEMPLATE_CATALOG_CHANGED: 'LectureAI 页面模板已更新，需要重新规划后再继续。',
    DECK_PLAN_INVALID: '课件蓝图已失效，请重新规划后再继续。',
    QUOTA_EXHAUSTED: '本月 LectureAI 额度已用完，已完成的页面和任务进度均已保留。',
    SERVICE_INTERRUPTED: 'LectureAI 服务连接中断，任务进度已保存，请稍后继续。',
    TEMPLATE_SLOT_REQUIRED: '当前页面缺少版式所需内容，LectureAI 正在补全。',
    TEMPLATE_TABLE_SHAPE: '当前表格内容与版式不匹配，LectureAI 正在调整。',
    CLIENT_UNAVAILABLE: '课件窗口暂时不可用，任务进度已保存。',
    VALIDATION_FAILED: '课件检查未通过，LectureAI 将只修复相关页面。',
    RECEIPT_WRITE_FAILED: '无法建立安全恢复点，LectureAI 未继续写入。',
  });

  function newRunId() {
    const uuid = global.crypto?.randomUUID?.();
    if (uuid) return `run_${uuid}`;
    return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 14)}`;
  }

  function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value === undefined ? null : value);
  }

  async function argsHash(args) {
    if (!global.crypto?.subtle || typeof global.TextEncoder !== 'function') {
      throw new Error('当前环境无法生成任务动作摘要');
    }
    const bytes = new global.TextEncoder().encode(canonicalJson(args ?? {}));
    const digest = await global.crypto.subtle.digest('SHA-256', bytes);
    return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
  }

  function finalizationFingerprint(plan, taskRunId) {
    const reference = plan?.taskSpecRef && typeof plan.taskSpecRef === 'object'
      ? plan.taskSpecRef
      : {};
    return {
      schemaVersion: 1,
      taskRunId: String(taskRunId || reference.runId || ''),
      targetSlideCount: Number(plan?.targetSlideCount || 0),
      pageOrder: (Array.isArray(plan?.slides) ? plan.slides : []).map((slide) => ({
        sourcePageId: String(slide?.sourcePageId || '') || null,
        targetPageId: String(slide?.targetPageId || '') || null,
      })),
      deletedPageIds: [...new Set((Array.isArray(plan?.deletedPageIds) ? plan.deletedPageIds : [])
        .map(value => String(value || '').trim()).filter(Boolean))].sort(),
      taskSpecRef: {
        runId: String(reference.runId || taskRunId || ''),
        revision: Number(reference.revision || 0),
        hash: String(reference.hash || ''),
      },
    };
  }

  function validateTaskSpec(spec, supportedCapabilities = CONTRACT.capabilities) {
    const errors = [];
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return { valid: false, errors: ['TaskSpec 必须是对象'] };
    if (spec.schemaVersion !== CONTRACT.taskSpecSchemaVersion) errors.push('TaskSpec schemaVersion 不受支持');
    if (!/^run_[a-zA-Z0-9._-]{8,120}$/.test(String(spec.runId || ''))) errors.push('TaskSpec runId 无效');
    if (!CONTRACT.intents.includes(spec.intent)) errors.push('TaskSpec intent 无效');
    if (!CONTRACT.scopes.includes(spec.scope)) errors.push('TaskSpec scope 无效');
    if (!CONTRACT.executionStrategies.includes(spec.executionStrategy)) errors.push('TaskSpec executionStrategy 无效');
    if (typeof spec.userFacingGoal !== 'string' || !spec.userFacingGoal.trim()) errors.push('TaskSpec 缺少用户目标');
    if (!Number.isFinite(spec.confidence) || spec.confidence < 0 || spec.confidence > 1) errors.push('TaskSpec confidence 无效');
    if (!Array.isArray(spec.requiredCapabilities)) errors.push('TaskSpec requiredCapabilities 必须是数组');
    const supported = new Set(supportedCapabilities || []);
    const missingCapabilities = (spec.requiredCapabilities || []).filter(item => !supported.has(item));
    if (missingCapabilities.length) errors.push(`当前客户端缺少能力：${missingCapabilities.join('、')}`);
    if (WRITE_INTENTS.has(spec.intent) && !Array.isArray(spec.acceptanceCriteria)) errors.push('可写任务必须声明验收条件');
    if (!spec.targets || typeof spec.targets !== 'object' || !Array.isArray(spec.targets.pages)) errors.push('TaskSpec targets 无效');
    return { valid: errors.length === 0, errors, missingCapabilities };
  }

  function canTransition(from, to) {
    return Array.isArray(CONTRACT.transitions[from]) && CONTRACT.transitions[from].includes(to);
  }

  function normalizeEvent(event, lastSequence = -1) {
    if (!event || typeof event !== 'object') return { ok: false, error: '任务事件格式无效' };
    if (event.schemaVersion !== CONTRACT.eventSchemaVersion) return { ok: false, error: '任务事件版本不受支持' };
    if (!CONTRACT.eventTypes.includes(event.type)) return { ok: false, error: '任务事件类型无效' };
    if (!/^run_[a-zA-Z0-9._-]{8,120}$/.test(String(event.runId || ''))) return { ok: false, error: '任务事件 runId 无效' };
    if (!Number.isInteger(event.sequence) || event.sequence < 0) return { ok: false, error: '任务事件序号无效' };
    if (event.sequence <= lastSequence) return { ok: true, duplicate: true, event };
    return { ok: true, duplicate: false, event };
  }

  function receiptDecision(receipt, action) {
    if (receipt) {
      if (receipt.actionId !== action.actionId || receipt.argsHash !== action.argsHash) return { decision: 'conflict', code: 'PROTOCOL_ACTION_CONFLICT' };
      if (receipt.ok === true) return { decision: 'replay', receipt };
      return { decision: 'blocked', code: receipt.error?.code || 'ACTION_PREVIOUSLY_FAILED' };
    }
    const expected = String(action.expectedDeckRevision || '');
    const current = String(action.currentDeckRevision || '');
    if (expected && current && expected !== current) return { decision: 'stale', code: 'STALE_DECK' };
    return { decision: 'execute' };
  }

  function friendlyError(error) {
    const raw = error && typeof error === 'object' ? error : { code: 'UNKNOWN', userMessage: String(error || '') };
    const code = String(raw.code || 'UNKNOWN');
    const fallback = FRIENDLY_ERRORS[code] || 'LectureAI 未能完成当前步骤，任务进度已保存。';
    const candidate = String(raw.userMessage || fallback).replace(INTERNAL_TERMS, 'LectureAI').replace(/\s+/g, ' ').trim();
    return {
      code,
      category: CONTRACT.errorCategories.includes(raw.category) ? raw.category : 'protocol',
      retryable: raw.retryable === true,
      userMessage: candidate || fallback,
    };
  }

  function taskCard(spec, run = {}) {
    const criteria = (spec?.acceptanceCriteria || []).map(item => typeof item === 'string' ? item : item?.label || item?.type).filter(Boolean);
    const total = Number(run.totalActions || run.totalPages || 0);
    const completed = Number(run.completedActions || run.completedPages || 0);
    const stateLabels = {
      awaiting_user: '等待补充信息', resolving: '正在理解任务', planning: '正在规划课件', ready: '准备执行', running: '正在处理',
      paused: '任务已暂停', repairing: '正在修复相关页面', validating: '正在检查课件', needs_repair: '需要定向修复', completed: '任务已完成',
      failed: '任务未完成', cancelled: '任务已取消', reverted: '已撤销本次任务',
    };
    return {
      runId: spec?.runId || run.runId || '',
      goal: spec?.userFacingGoal || '',
      scope: spec?.scope || 'none',
      criteria,
      status: run.status || 'resolved',
      statusLabel: stateLabels[run.status] || '任务已识别',
      completed,
      total,
      progress: total > 0 ? Math.max(0, Math.min(1, completed / total)) : 0,
      current: String(run.currentLabel || ''),
      canResume: ['paused', 'failed', 'needs_repair'].includes(run.status),
      canRetryFailed: ['failed', 'needs_repair'].includes(run.status),
      canRevert: ['paused', 'failed', 'cancelled', 'completed'].includes(run.status) && run.revertAvailable === true,
    };
  }

  const api = Object.freeze({ CONTRACT, argsHash, canonicalJson, canTransition, finalizationFingerprint, friendlyError, newRunId, normalizeEvent, receiptDecision, taskCard, validateTaskSpec });
  global.LectureAiTaskProtocol = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
