// AI Factory dashboard reporting: lib/factory-reporter.mjs, lib/claude-stream.mjs and the
// runner's Claude streaming (scripts/run-pipeline.mjs runClaude/finishSteps), against a mocked
// dashboard (tests/fixtures/mock-dashboard.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReporter, stageTracker } from '../lib/factory-reporter.mjs';
import { createStreamParser, parseStepCommand } from '../lib/claude-stream.mjs';
import { REPO_ROOT } from '../lib/env.mjs';
import { startMockDashboard } from './fixtures/mock-dashboard.mjs';

process.env.QA_LOG_QUIET = '1';
const { runClaude, finishSteps } = await import('../scripts/run-pipeline.mjs');

const PROJECT = 'folio3/amin-ns-ai-assistant';
let dash;
before(async () => (dash = await startMockDashboard({ secret: 's3cret-value' })));
after(() => dash.close());

function reporter(extra = {}) {
  const logs = [];
  const r = createReporter({
    url: dash.url,
    secret: 's3cret-value',
    projectId: PROJECT,
    projectName: 'NS-UnifiedConnector',
    taskId: extra.taskId || `NU-${Math.floor(Math.random() * 1e6)}`,
    taskName: 'Create a sales order',
    agentName: 'ai-factory-qa',
    backoffMs: 5,
    log: (m) => logs.push(m),
    ...extra,
  });
  return { r, logs };
}

test('payload: exactly the contract fields, secret only in the header', async () => {
  const { r } = reporter({ taskId: 'NU-1' });
  const before = dash.requests.length;
  await r.report({ stageId: 'testing', subStageId: 'plan', status: 'running', tokensUsed: 0, message: 'start' });
  const req = dash.requests[before];
  assert.equal(req.headers['x-webhook-secret'], 's3cret-value');
  assert.match(req.headers['content-type'], /application\/json/);
  const body = JSON.parse(req.body);
  assert.deepEqual(Object.keys(body).sort(), ['agentName', 'message', 'projectId', 'projectName', 'stageId', 'status', 'subStageId', 'taskId', 'taskName', 'tokensUsed'].sort());
  assert.equal(body.projectId, PROJECT);
  assert.equal(body.taskId, 'NU-1');
  assert.ok(!req.body.includes('s3cret-value'));
});

test('messages: secret scrubbed, single line, at most 200 characters', async () => {
  const { r } = reporter();
  const before = dash.requests.length;
  await r.report({ subStageId: 'plan', status: 'running', message: `failed with s3cret-value\nand Bearer abcdefghijkl ${'x'.repeat(400)}` });
  const m = JSON.parse(dash.requests[before].body).message;
  assert.ok(!m.includes('s3cret-value') && !m.includes('abcdefghijkl') && !m.includes('\n'));
  assert.ok(m.length <= 200, String(m.length));
});

test('tokens: each post carries the increment, the dashboard sum equals the tokens spent', async () => {
  const { r } = reporter({ taskId: 'NU-2' });
  const s = stageTracker(r);
  s.start('plan');
  s.addTokens(100, 'claude-sonnet-4-5');
  s.addTokens(50, 'claude-sonnet-4-5');
  s.advance('execute'); // plan succeeded with 150
  s.addTokens(30, 'claude-sonnet-4-5');
  s.addTokens(20, 'claude-haiku-4-5'); // model switch → running post with 30 under sonnet
  s.end('succeeded'); // 20 under haiku
  await r.flush();
  const steps = dash.task(PROJECT, 'NU-2').stages.testing.steps;
  assert.deepEqual(steps.plan.events.map((e) => [e.status, e.tokensUsed]), [['running', 0], ['succeeded', 150]]);
  assert.equal(steps.plan.tokensUsed, 150);
  assert.deepEqual(steps.execute.events.map((e) => [e.status, e.tokensUsed, e.modelId]), [
    ['running', 0, null],
    ['running', 30, 'claude-sonnet-4-5'],
    ['succeeded', 20, 'claude-haiku-4-5'],
  ]);
  assert.equal(steps.execute.tokensUsed, 50);
});

test('monotonic: nothing is posted for a step after it succeeded', async () => {
  const { r, logs } = reporter({ taskId: 'NU-3' });
  r.report({ subStageId: 'plan', status: 'running' });
  r.report({ subStageId: 'plan', status: 'succeeded' });
  const late = await r.report({ subStageId: 'plan', status: 'running' });
  await r.flush();
  assert.equal(late.ok, false);
  assert.deepEqual(dash.task(PROJECT, 'NU-3').stages.testing.steps.plan.events.map((e) => e.status), ['running', 'succeeded']);
  assert.ok(logs.some((l) => /late/.test(l)));
});

test('4xx is not retried: 400 logged once, 401 logged once, nothing thrown', async () => {
  const { r, logs } = reporter({ taskId: 'NU-4' });
  const before = dash.requests.length;
  dash.failNext(1, 400);
  const res = await r.report({ subStageId: 'plan', status: 'running' });
  assert.equal(res.status, 400);
  assert.equal(dash.requests.length - before, 1, '400 must not be retried');

  const bad = reporter({ secret: 'wrong' });
  const b2 = dash.requests.length;
  const r401 = await bad.r.report({ subStageId: 'plan', status: 'running' });
  await bad.r.report({ subStageId: 'execute', status: 'running' });
  assert.equal(r401.status, 401);
  assert.equal(dash.requests.length - b2, 2, 'one request per post, no retries');
  assert.equal(bad.logs.filter((l) => /401/.test(l)).length, 1, '401 logged once');
  assert.ok(!bad.logs.join(' ').includes('wrong'), 'the secret is never logged');
  assert.equal(logs.filter((l) => /400/.test(l)).length, 1);
});

test('stage rejected by order (400) is logged once per task and stage', async () => {
  const { r, logs } = reporter({ taskId: 'NU-5' });
  const s = stageTracker(r, { stageId: 'deploy', steps: ['build', 'release', 'verify'] });
  s.start('build');
  s.advance('release');
  s.end('succeeded');
  await r.flush();
  assert.equal(logs.filter((l) => /rejected \(400\)/.test(l)).length, 1);
});

test('5xx is retried, then succeeds', async () => {
  const { r } = reporter({ taskId: 'NU-6' });
  const before = dash.requests.length;
  dash.failNext(2, 503);
  const res = await r.report({ subStageId: 'plan', status: 'running' });
  assert.equal(res.ok, true);
  assert.equal(dash.requests.length - before, 3);
});

test('never throws: dashboard down, or slower than the timeout', async () => {
  const down = createReporter({ url: 'http://127.0.0.1:1', secret: 'x', projectId: PROJECT, taskId: 'NU-7', backoffMs: 1, log: () => {} });
  const r1 = await down.report({ subStageId: 'plan', status: 'running' });
  assert.equal(r1.ok, false);
  const slow = createReporter({ url: dash.url, secret: 's3cret-value', projectId: PROJECT, taskId: 'NU-8', timeoutMs: 1, retries: 0, log: () => {} });
  const r2 = await slow.report({ subStageId: 'plan', status: 'running' });
  assert.equal(typeof r2.ok, 'boolean');
  const off = createReporter({ url: '', secret: '', projectId: '', taskId: '', log: () => {} });
  assert.equal(off.enabled, false);
  assert.equal((await off.report({ subStageId: 'plan', status: 'running' })).error, 'disabled');
  assert.equal((await off.report({ subStageId: 'plan', status: 'pending' })).ok, false, 'pending is never sent');
});

test('stream parser: usage counted once per message, markers parsed', () => {
  const p = createStreamParser();
  const ev = (o) => p.push(JSON.stringify(o));
  assert.deepEqual(ev({ type: 'assistant', message: { id: 'a', model: 'm', content: [], usage: { input_tokens: 10, output_tokens: 1 } } }), [{ type: 'usage', tokens: 11, model: 'm' }]);
  assert.deepEqual(ev({ type: 'assistant', message: { id: 'a', model: 'm', content: [], usage: { input_tokens: 10, output_tokens: 5 } } }), [{ type: 'usage', tokens: 4, model: 'm' }]);
  assert.deepEqual(ev({ type: 'assistant', message: { id: 'a', model: 'm', content: [], usage: { input_tokens: 10, output_tokens: 5 } } }), []);
  assert.deepEqual(parseStepCommand('node scripts/factory-step.mjs execute blocked "NetSuite session expired"'), { sub: 'execute', status: 'blocked', message: 'NetSuite session expired' });
  assert.deepEqual(parseStepCommand('cd x && node scripts/factory-step.mjs verdict'), { sub: 'verdict', status: undefined, message: '' });
  assert.equal(parseStepCommand('node scripts/build-report.mjs'), null);
});

// ---- end to end: the runner's real Claude streaming against the mock dashboard ----
const fake = { command: process.execPath, prefixArgs: [join(REPO_ROOT, 'tests', 'fixtures', 'fake-claude.mjs')] };
const logFile = () => join(mkdtempSync(join(tmpdir(), 'qa-')), 'run.log');
const allPassed = { complete: true, testCases: [{ status: 'Passed' }, { status: 'Passed' }], bugs: [] };

test('e2e: steps, models and token sums match what the agent spent', async () => {
  const { r } = reporter({ taskId: 'NU-4058' });
  const tracker = stageTracker(r);
  tracker.start('plan', 'EXEC-0001');
  const run = await runClaude({ key: 'NU-4058', mode: 'test' }, 'EXEC-0001', logFile(), tracker, fake);
  assert.equal(run.ok, true);
  finishSteps(tracker, allPassed, '');
  tracker.start('report');
  tracker.end('succeeded', 'report.pdf');
  await r.flush();
  const steps = dash.task(PROJECT, 'NU-4058').stages.testing.steps;
  // fake-claude.mjs: plan = m1 (100+40) + m2 (200+20+30+50) = 440
  assert.equal(steps.plan.status, 'succeeded');
  assert.equal(steps.plan.tokensUsed, 440);
  assert.equal(steps.plan.modelId, 'claude-sonnet-4-5');
  // execute = m3 360 (sonnet) + m4 55 + m5 77 (haiku); history kept, last model haiku
  assert.equal(steps.execute.status, 'succeeded');
  assert.equal(steps.execute.tokensUsed, 492);
  assert.deepEqual(steps.execute.events.map((e) => [e.status, e.tokensUsed]), [['running', 0], ['running', 360], ['succeeded', 132]]);
  assert.equal(steps.execute.modelId, 'claude-haiku-4-5');
  // verdict = m6 480; all passed → succeeded
  assert.equal(steps.verdict.status, 'succeeded');
  assert.equal(steps.verdict.tokensUsed, 480);
  assert.equal(steps.report.status, 'succeeded');
  assert.equal(steps.report.tokensUsed, 0);
});

test('e2e: failed cases → verdict failed with the bug keys', async () => {
  const { r } = reporter({ taskId: 'NU-4059' });
  const tracker = stageTracker(r);
  tracker.start('plan');
  await runClaude({ key: 'NU-4059', mode: 'test' }, 'EXEC-0002', logFile(), tracker, fake);
  finishSteps(tracker, { complete: true, testCases: [{ status: 'Passed' }, { status: 'Failed' }], bugs: [{ key: 'NU-4060' }] }, '');
  await r.flush();
  const v = dash.task(PROJECT, 'NU-4059').stages.testing.steps.verdict;
  assert.equal(v.status, 'failed');
  assert.match(v.events.at(-1).message, /1\/2 passed, 1 failed.*NU-4060/);
});

test('e2e: a crash marks the open step failed; the agent still finishes', async () => {
  const { r } = reporter({ taskId: 'NU-4061' });
  const tracker = stageTracker(r);
  tracker.start('plan');
  process.env.FAKE_CLAUDE_EXIT = '1';
  const run = await runClaude({ key: 'NU-4061', mode: 'test' }, 'EXEC-0003', logFile(), tracker, fake);
  delete process.env.FAKE_CLAUDE_EXIT;
  assert.equal(run.ok, false);
  finishSteps(tracker, { complete: false, testCases: [] }, run.reason);
  await r.flush();
  const steps = dash.task(PROJECT, 'NU-4061').stages.testing.steps;
  assert.equal(steps.verdict.status, 'failed');
  assert.match(steps.verdict.events.at(-1).message, /Claude exited 1/);
});

test('e2e: dashboard down — the run completes exactly the same', async () => {
  const down = createReporter({ url: 'http://127.0.0.1:1', secret: 'x', projectId: PROJECT, taskId: 'NU-4062', backoffMs: 1, log: () => {} });
  const tracker = stageTracker(down);
  tracker.start('plan');
  const t0 = Date.now();
  const run = await runClaude({ key: 'NU-4062', mode: 'test' }, 'EXEC-0004', logFile(), tracker, fake);
  finishSteps(tracker, allPassed, '');
  await down.flush(10000);
  assert.equal(run.ok, true);
  assert.ok(Date.now() - t0 < 15000);
});
