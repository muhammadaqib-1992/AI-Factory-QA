// Local stand-in for the AI Factory dashboard, implementing the webhook contract the reporter
// is built against: POST /webhooks/stage-status (x-webhook-secret), GET /api/projects.
//   - wrong / missing secret → 401
//   - stage order: a stage is rejected (400 {error}) until the previous stage succeeded,
//     unless `openStages` lists it (tests open "testing" directly)
//   - steps keep every event; tokensUsed per step = sum of the increments received
//   - `failNext(n, code)` makes the next n posts answer `code` (5xx retry tests)
import { createServer } from 'node:http';

const ORDER = ['planning', 'build', 'review', 'deploy', 'testing'];

export async function startMockDashboard({ secret = 'test-secret', openStages = ['testing'] } = {}) {
  const projects = new Map(); // projectId → { projectId, projectName, tasks: Map }
  const requests = [];
  let failQueue = [];

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.method === 'GET' && req.url === '/api/projects') {
        return send(200, [...projects.values()].map((p) => ({ ...p, tasks: [...p.tasks.values()] })));
      }
      if (req.method !== 'POST' || req.url !== '/webhooks/stage-status') return send(404, { error: 'not found' });
      requests.push({ headers: req.headers, body });
      if (failQueue.length) return send(failQueue.shift(), { error: 'injected failure' });
      if (req.headers['x-webhook-secret'] !== secret) return send(401, { error: 'invalid webhook secret' });
      let e;
      try {
        e = JSON.parse(body);
      } catch {
        return send(400, { error: 'invalid json' });
      }
      for (const f of ['projectId', 'taskId', 'stageId', 'subStageId', 'status']) if (!e[f]) return send(400, { error: `${f} is required` });
      const p = projects.get(e.projectId) || { projectId: e.projectId, projectName: e.projectName, tasks: new Map() };
      projects.set(e.projectId, p);
      const t = p.tasks.get(e.taskId) || { taskId: e.taskId, taskName: e.taskName, stages: {} };
      const idx = ORDER.indexOf(e.stageId);
      if (idx > 0 && !openStages.includes(e.stageId)) {
        const prev = t.stages[ORDER[idx - 1]];
        if (!prev || prev.status !== 'succeeded') return send(400, { error: `stage ${e.stageId} rejected: ${ORDER[idx - 1]} has not succeeded` });
      }
      p.tasks.set(e.taskId, t);
      const st = (t.stages[e.stageId] ||= { status: 'running', steps: {} });
      const step = (st.steps[e.subStageId] ||= { status: null, tokensUsed: 0, modelId: null, events: [] });
      step.events.push({ status: e.status, tokensUsed: e.tokensUsed || 0, modelId: e.modelId || null, message: e.message });
      step.status = e.status;
      step.tokensUsed += e.tokensUsed || 0;
      if (e.modelId) step.modelId = e.modelId;
      return send(200, { ok: true });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    secret,
    requests,
    failNext: (n, code = 503) => (failQueue = Array(n).fill(code)),
    task: (projectId, taskId) => projects.get(projectId)?.tasks.get(taskId),
    close: () => new Promise((r) => server.close(r)),
  };
}
