// Reports this agent's progress to the AI Factory dashboard:
//   POST <FACTORY_DASHBOARD_URL>/webhooks/stage-status   header x-webhook-secret: <WEBHOOK_SECRET>
//
// Contract (one event per request): projectId, projectName, taskId, taskName, stageId,
// subStageId, status (running | blocked | succeeded | failed), agentName, modelId, tokensUsed
// (an INCREMENT since the previous post for that step), message (short, no secrets).
//
// Guarantees, because reporting must never break the real work:
//   - report() never throws and never blocks: posts are queued and sent in order in the
//     background; await flush() at a safe point if you want them delivered first.
//   - 5 s timeout per request; retries only network errors and 5xx (max 3 retries, backoff);
//     4xx is final — 400 (e.g. stage order) is logged once per task+stage, 401 once.
//   - steps are monotonic: once a step succeeded/failed, later posts for it are dropped.
//   - the secret is never logged and is scrubbed from messages.
import { env } from './env.mjs';

export const TESTING_STEPS = ['plan', 'execute', 'verdict', 'report'];
const STATUSES = new Set(['running', 'blocked', 'succeeded', 'failed']);
const FINAL = new Set(['succeeded', 'failed']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanMessage(message, secret) {
  let m = String(message ?? '').replace(/\s+/g, ' ').trim();
  if (secret) m = m.split(secret).join('***');
  // belt and braces: obvious token shapes never leave this process
  m = m.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 ***').replace(/\b(sk-[A-Za-z0-9_-]{8,}|ATATT[A-Za-z0-9_-]{8,})/g, '***');
  return m.length > 200 ? `${m.slice(0, 197)}...` : m;
}

export function createReporter(opts = {}) {
  const url = (opts.url ?? env('FACTORY_DASHBOARD_URL', '')).replace(/\/+$/, '');
  const secret = opts.secret ?? env('WEBHOOK_SECRET', '');
  const base = {
    projectId: opts.projectId ?? env('FACTORY_PROJECT_ID', ''),
    projectName: opts.projectName ?? env('FACTORY_PROJECT_NAME', ''),
    taskId: opts.taskId ?? env('FACTORY_TASK_ID', ''),
    taskName: opts.taskName,
    agentName: opts.agentName ?? env('FACTORY_AGENT_NAME', 'ai-factory-qa'),
  };
  const log = opts.log ?? ((m) => console.error(`[factory-dashboard] ${m}`));
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const retries = opts.retries ?? 3;
  const backoffMs = opts.backoffMs ?? 500;

  const enabled = Boolean(url && secret && base.projectId && base.taskId);
  const missing = ['FACTORY_DASHBOARD_URL', 'WEBHOOK_SECRET', 'FACTORY_PROJECT_ID', 'FACTORY_TASK_ID'].filter(
    (k, i) => ![url, secret, base.projectId, base.taskId][i],
  );
  if (!enabled && opts.quiet !== true) log(`reporting off — missing ${missing.join(', ')}`);

  const stepState = new Map(); // `${stageId}/${subStageId}` → last status
  const loggedOnce = new Set();
  const sent = []; // for tests / diagnostics: what was attempted
  let queue = Promise.resolve();

  function logOnce(key, msg) {
    if (loggedOnce.has(key)) return;
    loggedOnce.add(key);
    log(msg);
  }

  async function post(payload) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetchImpl(`${url}/webhooks/stage-status`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-webhook-secret': secret },
          body: JSON.stringify(payload),
          signal: ctrl.signal,
        });
        if (res.ok) return { ok: true, status: res.status };
        const text = (await res.text().catch(() => '')).slice(0, 300);
        if (res.status >= 500 && attempt < retries) {
          await sleep(backoffMs * 2 ** attempt);
          continue;
        }
        let detail = text;
        try {
          detail = JSON.parse(text).error ?? text;
        } catch {}
        if (res.status === 400) logOnce(`400:${payload.taskId}:${payload.stageId}`, `${payload.taskId} ${payload.stageId}/${payload.subStageId}: rejected (400) — ${detail}. Not retrying.`);
        else if (res.status === 401 || res.status === 403) logOnce(`auth:${res.status}`, `dashboard refused the webhook secret (${res.status}) — check WEBHOOK_SECRET. Continuing without it.`);
        else logOnce(`http:${res.status}:${payload.subStageId}`, `${payload.taskId} ${payload.stageId}/${payload.subStageId}: HTTP ${res.status} — ${detail}`);
        return { ok: false, status: res.status, error: detail };
      } catch (e) {
        if (attempt < retries) {
          await sleep(backoffMs * 2 ** attempt);
          continue;
        }
        const why = e.name === 'AbortError' ? `timed out after ${timeoutMs} ms` : e.message;
        logOnce(`net:${payload.subStageId}:${payload.status}`, `${payload.taskId} ${payload.stageId}/${payload.subStageId} ${payload.status}: dashboard unreachable (${why})`);
        return { ok: false, error: why };
      } finally {
        clearTimeout(timer);
      }
    }
    return { ok: false, error: 'unreachable' };
  }

  // Queue one event. Returns a promise for its result, but callers need not await it.
  function report({ stageId = 'testing', subStageId, status, tokensUsed = 0, modelId, message = '' }) {
    try {
      if (!STATUSES.has(status)) {
        logOnce(`bad-status:${status}`, `not sending unknown status "${status}"`);
        return Promise.resolve({ ok: false, error: 'bad status' });
      }
      const key = `${stageId}/${subStageId}`;
      const prev = stepState.get(key);
      if (FINAL.has(prev)) {
        logOnce(`late:${key}:${status}`, `${base.taskId} ${key} already ${prev}; dropping a late "${status}" post`);
        return Promise.resolve({ ok: false, error: 'step already final' });
      }
      stepState.set(key, status);
      const payload = { ...base, stageId, subStageId, status, tokensUsed: Math.max(0, Math.round(tokensUsed || 0)), message: cleanMessage(message, secret) };
      if (modelId) payload.modelId = modelId;
      if (!payload.taskName) delete payload.taskName;
      if (!payload.projectName) delete payload.projectName;
      sent.push(payload);
      if (!enabled) return Promise.resolve({ ok: false, error: 'disabled' });
      const p = queue.then(() => post(payload)).catch((e) => ({ ok: false, error: String(e?.message || e) }));
      queue = p;
      return p;
    } catch (e) {
      return Promise.resolve({ ok: false, error: String(e?.message || e) });
    }
  }

  // Wait for queued posts, but never longer than maxMs.
  async function flush(maxMs = 30000) {
    await Promise.race([queue.catch(() => {}), sleep(maxMs)]);
  }

  return { report, flush, enabled, sent, stepStatus: (sub, stage = 'testing') => stepState.get(`${stage}/${sub}`) };
}

// Tracks one stage's steps: opens/closes them in order and turns token usage into increments.
//   const s = stageTracker(reporter);
//   s.start('plan'); s.addTokens(1200, 'claude-sonnet-4'); s.advance('execute'); …; s.finish('succeeded')
export function stageTracker(reporter, { stageId = 'testing', steps = TESTING_STEPS } = {}) {
  let current = null;
  let pending = 0; // tokens since the last post for the current step
  let pendingModel = null;

  const flushTokensAs = (status, message) => {
    reporter.report({ stageId, subStageId: current, status, tokensUsed: pending, modelId: pendingModel || undefined, message });
    pending = 0;
  };

  return {
    get current() {
      return current;
    },
    start(sub, message = '') {
      if (current && current !== sub) this.end('succeeded');
      current = sub;
      pending = 0;
      pendingModel = null;
      reporter.report({ stageId, subStageId: sub, status: 'running', message });
    },
    // A model change inside a step: post the tokens so far under the old model, keep running.
    addTokens(n, modelId) {
      if (!current || !n) return;
      if (pendingModel && modelId && modelId !== pendingModel && pending > 0) flushTokensAs('running', `continuing with ${modelId}`);
      pending += n;
      if (modelId) pendingModel = modelId;
    },
    blocked(message) {
      if (current) flushTokensAs('blocked', message);
    },
    resume(message = '') {
      if (current) reporter.report({ stageId, subStageId: current, status: 'running', message });
    },
    end(status, message = '') {
      if (!current) return;
      flushTokensAs(status, message);
      current = null;
    },
    // Close the open step as succeeded and open `next` (only forwards in the step order).
    advance(next, message = '') {
      const i = steps.indexOf(next);
      if (i === -1) return;
      if (current && steps.indexOf(current) >= i) return; // never go backwards
      if (current) this.end('succeeded');
      this.start(next, message);
    },
  };
}
