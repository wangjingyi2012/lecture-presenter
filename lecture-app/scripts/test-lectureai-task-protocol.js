const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/js/lectureai-task-protocol.js'), 'utf8');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/lectureai-task-protocol-v1.json'), 'utf8'));
const webcrypto = require('node:crypto').webcrypto;
const sandbox = { console, crypto: { ...webcrypto, subtle: webcrypto.subtle, randomUUID: () => '12345678-1234-1234-1234-123456789abc' }, TextEncoder };
sandbox.window = sandbox;
vm.runInNewContext(source, sandbox);
const protocol = sandbox.LectureAiTaskProtocol;

assert.equal(protocol.CONTRACT.protocolVersion, fixture.protocolVersion);
for (const key of ['intents', 'executionStrategies', 'scopes', 'states', 'terminalStates', 'eventTypes', 'errorCategories', 'capabilities']) {
  assert.deepEqual([...protocol.CONTRACT[key]], fixture[key], `contract ${key} must match fixture`);
}
assert.deepEqual(JSON.parse(JSON.stringify(protocol.CONTRACT.transitions)), fixture.transitions);
assert.equal(protocol.newRunId(), 'run_12345678-1234-1234-1234-123456789abc');

const validSpec = {
  schemaVersion: 1,
  runId: 'run_12345678-1234-1234-1234-123456789abc',
  intent: 'slide_edit',
  scope: 'page',
  targets: { pages: [3], outline: false, allowInsert: false, allowDelete: false, allowReorder: false },
  executionStrategy: 'bounded_tool_loop',
  requiresDeckPlan: false,
  userFacingGoal: '优化第 3 页的信息层级',
  assumptions: [],
  acceptanceCriteria: [{ type: 'target_pages_validated', label: '目标页检查通过' }],
  requiredCapabilities: ['slide.read', 'slide.write.transactional', 'deck.validate'],
  confidence: 0.98,
  requiresClarification: false,
  taskSpecVersion: 'task-spec-v1',
  promptVersion: 'task-resolver-v1',
};
assert.equal(protocol.validateTaskSpec(validSpec).valid, true);
const unsupported = protocol.validateTaskSpec(validSpec, ['slide.read']);
assert.equal(unsupported.valid, false);
assert.deepEqual(unsupported.missingCapabilities, ['slide.write.transactional', 'deck.validate']);
const rulesSpec = {
  ...validSpec,
  intent: 'deck_cleanup',
  scope: 'deck',
  targets: { pages: [], outline: false, allowInsert: false, allowDelete: true, allowReorder: true },
  executionStrategy: 'rules_engine',
  mutations: [{ op: 'delete_slide', page: 12 }, { op: 'delete_slide', page: 13 }],
};
assert.equal(protocol.validateTaskSpec(rulesSpec).valid, true, 'rules_engine specs with a fixed mutation list are valid');
assert.equal(protocol.validateTaskSpec({ ...rulesSpec, mutations: [] }).valid, false, 'mutations must be a non-empty array');
assert.equal(protocol.validateTaskSpec({ ...rulesSpec, mutations: [{ op: 'render_template', page: 3 }] }).valid, false, 'unknown mutation ops are rejected');
assert.equal(protocol.validateTaskSpec({ ...rulesSpec, mutations: [{ op: 'delete_slide', page: 0 }] }).valid, false, 'mutation pages are 1-based');
assert.equal(protocol.validateTaskSpec({ ...rulesSpec, mutations: [{ op: 'reorder_slides', order: [2, 1] }] }).valid, true);
assert.equal(protocol.validateTaskSpec({ ...rulesSpec, mutations: [{ op: 'reorder_slides', order: [1, 1] }] }).valid, false, 'reorder orders must be valid page sequences');
assert.equal(protocol.validateTaskSpec({ ...rulesSpec, mutations: 'delete_slide' }).valid, false, 'mutations must be an array');
assert.equal(protocol.canTransition('running', 'validating'), true);
assert.equal(protocol.canTransition('completed', 'running'), false);

const first = protocol.normalizeEvent({ schemaVersion: 1, type: 'progress', runId: validSpec.runId, sequence: 4 }, 3);
assert.equal(first.ok, true);
assert.equal(first.duplicate, false);
assert.equal(protocol.normalizeEvent({ ...first.event }, 4).duplicate, true);

assert.equal(protocol.receiptDecision(null, { actionId: 'a1', argsHash: 'h1', expectedDeckRevision: 'r1', currentDeckRevision: 'r1' }).decision, 'execute');
assert.equal(protocol.receiptDecision({ actionId: 'a1', argsHash: 'h1', ok: true }, { actionId: 'a1', argsHash: 'h1' }).decision, 'replay');
assert.equal(protocol.receiptDecision({ actionId: 'a1', argsHash: 'h1', ok: true }, { actionId: 'a1', argsHash: 'h2' }).code, 'PROTOCOL_ACTION_CONFLICT');
assert.equal(protocol.receiptDecision(null, { actionId: 'a1', argsHash: 'h1', expectedDeckRevision: 'r1', currentDeckRevision: 'r2' }).code, 'STALE_DECK');

const friendly = protocol.friendlyError({ code: 'VALIDATION_FAILED', category: 'validation_failed', userMessage: 'Pi Runtime 的 validate_deck 失败' });
assert.equal(friendly.userMessage.includes('Pi'), false);
assert.equal(friendly.userMessage.includes('validate_deck'), false);
// Mutation tool ids must never leak into user-facing error text either.
for (const term of ['delete_slide', 'reorder_slides', 'finalize_deck', 'apply_patch']) {
  const scrubbed = protocol.friendlyError({ code: 'CLIENT_TOOL_FAILED', userMessage: `${term} 失败：目标页不存在` });
  assert.equal(scrubbed.userMessage.includes(term), false, `${term} must be scrubbed from user-facing errors`);
}
const card = protocol.taskCard(validSpec, { status: 'failed', completedPages: 2, totalPages: 3, revertAvailable: true });
assert.equal(card.canResume, true);
assert.equal(card.canRetryFailed, true);
assert.equal(card.canRevert, true);
assert.equal(card.progress, 2 / 3);
assert.equal(protocol.canonicalJson({ b: 2, a: { d: 4, c: 3 } }), '{"a":{"c":3,"d":4},"b":2}');

(async () => {
  assert.equal(
    await protocol.argsHash({ b: 2, a: 1 }),
    'sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777',
  );
  const plan = {
    targetSlideCount: 2,
    taskSpecRef: { runId: validSpec.runId, revision: 1, hash: 'sha256:task' },
    deletedPageIds: ['old-b', 'old-a'],
    slides: [
      { page: 1, sourcePageId: 'page-a' },
      { page: 2, targetPageId: 'page-b' },
    ],
    execution: { status: 'running', completedPages: [1] },
  };
  const firstFingerprint = protocol.finalizationFingerprint(plan, validSpec.runId);
  plan.execution = { status: 'validating', completedPages: [1, 2], summaries: { 1: 'changed' } };
  assert.deepEqual(
    JSON.parse(JSON.stringify(protocol.finalizationFingerprint(plan, validSpec.runId))),
    JSON.parse(JSON.stringify(firstFingerprint)),
    'mutable execution progress must not change finalization identity',
  );
  assert.equal(firstFingerprint.deletedPageIds.join(','), 'old-a,old-b');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

console.log('test-lectureai-task-protocol: all assertions passed');
