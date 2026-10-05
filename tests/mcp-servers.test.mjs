// Starts both MCP servers over stdio against a local mock of Jira and NetSuite and checks
// the requests they build. Run with: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { REPO_ROOT } from '../lib/env.mjs';

const calls = [];
let baseUrl;
let http;

before(async () => {
  http = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, headers: req.headers, body });
      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const u = req.url;
      if (u.startsWith('/rest/api/3/search/jql')) {
        return send(200, {
          issues: [
            { key: 'PROJ-1', fields: { summary: 'Fix A', issuetype: { name: 'Bug' }, priority: { name: 'High' }, labels: [] } },
            { key: 'PROJ-2', fields: { summary: 'Fix B', issuetype: { name: 'Task' }, labels: [] } },
          ],
        });
      }
      if (u.startsWith('/rest/api/3/issue/') && u.includes('/changelog')) {
        return send(200, {
          isLast: true,
          values: [
            { created: '2026-10-01T10:00:00.000+0000', items: [{ field: 'status', toString: 'Ready for QA' }] },
            { created: '2026-10-03T10:00:00.000+0000', items: [{ field: 'status', toString: 'Ready for QA' }] },
            { created: '2026-10-02T10:00:00.000+0000', items: [{ field: 'status', toString: 'In Progress' }] },
          ],
        });
      }
      if (u.startsWith('/rest/api/2/issue/PROJ-1?')) {
        return send(200, {
          key: 'PROJ-1',
          names: { customfield_100: 'Acceptance Criteria', customfield_101: 'Empty' },
          fields: {
            summary: 'Fix A',
            issuetype: { name: 'Bug' },
            status: { name: 'Ready for QA' },
            description: 'h3. Steps',
            customfield_100: 'AC1 | AC2',
            customfield_101: null,
            subtasks: [{ key: 'PROJ-5', fields: { summary: 'old bug', status: { name: 'Open' }, issuetype: { name: 'Sub-task' } } }],
            comment: { comments: [{ author: { displayName: 'Dev' }, created: 'x', body: 'fixed in build 3' }] },
            attachment: [{ id: '9', filename: 'shot.png', mimeType: 'image/png', size: 10 }],
          },
        });
      }
      if (u === '/rest/api/2/issue' && req.method === 'POST') return send(201, { key: 'PROJ-99' });
      if (u.endsWith('/attachments')) return send(200, [{ id: '1' }]);
      if (u.endsWith('/comment')) return send(201, { id: '77' });
      if (u.startsWith('/services/rest/query/v1/suiteql')) {
        return send(200, { count: 1, totalResults: 1, hasMore: false, items: [{ links: [], id: '42', tranid: 'SO1' }] });
      }
      send(404, { errorMessages: [`no mock for ${req.method} ${u}`] });
    });
  });
  await new Promise((r) => http.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${http.address().port}`;
  mkdirSync(join(REPO_ROOT, 'state'), { recursive: true });
});

after(() => http.close());

async function connect(script) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(REPO_ROOT, 'mcp-servers', script)],
    env: {
      ...process.env,
      JIRA_BASE_URL: baseUrl,
      JIRA_EMAIL: 'qa@example.com',
      JIRA_API_TOKEN: 'test-token',
      JIRA_PROJECT_KEY: 'PROJ',
      JIRA_QA_ASSIGNEE_ACCOUNT_ID: 'qa-acct',
      JIRA_BUG_ASSIGNEE_ACCOUNT_ID: 'dev-acct',
      JIRA_READY_STATUS: 'Ready for QA',
      JIRA_BUG_ISSUE_TYPE: 'Sub-task',
      JIRA_BUG_PARENT_MODE: 'parent',
      JIRA_BUG_LABELS: 'qa-automation',
      JIRA_PICKUP_JQL: '',
      NS_ACCOUNT_ID: '123456-sb2',
      NETSUITE_ACCOUNT_ID: '123456-sb2',
      NS_REST_URL: baseUrl,
      NS_CONSUMER_KEY: 'ck',
      NS_CONSUMER_SECRET: 'cs',
      NS_TOKEN_ID: 'tk',
      NS_TOKEN_SECRET: 'ts',
    },
  });
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(transport);
  return client;
}

const parse = (r) => JSON.parse(r.content[0].text);

test('jira: lists tickets, skips the cycle already tested, uses the right JQL', async () => {
  const stateFile = join(REPO_ROOT, 'state', 'processed-tickets.json');
  writeFileSync(stateFile, JSON.stringify({ 'PROJ-2': { statusEnteredAt: '2026-10-03T10:00:00.000+0000', testedAt: 'x', result: 'Passed' } }));
  try {
    const c = await connect('jira.mjs');
    const tools = (await c.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ['add_comment', 'create_bug', 'download_attachments', 'get_ticket', 'list_ready_for_qa_tickets', 'search_issues']);
    const r = parse(await c.callTool({ name: 'list_ready_for_qa_tickets', arguments: {} }));
    assert.match(r.jql, /project = PROJ AND status = "Ready for QA" AND assignee = "qa-acct"/);
    assert.equal(r.found, 2);
    assert.deepEqual(r.tickets.map((t) => t.key), ['PROJ-1']);
    assert.equal(r.tickets[0].statusEnteredAt, '2026-10-03T10:00:00.000+0000');
    const auth = calls.find((x) => x.url.startsWith('/rest/api/3/search/jql')).headers.authorization;
    assert.equal(auth, 'Basic ' + Buffer.from('qa@example.com:test-token').toString('base64'));
    await c.close();
  } finally {
    rmSync(stateFile, { force: true });
  }
});

test('jira: get_ticket returns custom fields by name, sub-tasks and comments', async () => {
  const c = await connect('jira.mjs');
  const t = parse(await c.callTool({ name: 'get_ticket', arguments: { key: 'PROJ-1' } }));
  assert.equal(t.customFields['Acceptance Criteria'], 'AC1 | AC2');
  assert.ok(!('Empty' in t.customFields));
  assert.equal(t.subtasks[0].key, 'PROJ-5');
  assert.equal(t.comments[0].body, 'fixed in build 3');
  assert.equal(t.url, `${baseUrl}/browse/PROJ-1`);
  await c.close();
});

test('jira: create_bug files a Sub-task under the parent, assigned from .env, with evidence', async () => {
  const evid = join(REPO_ROOT, 'state', 'evidence-test.png');
  writeFileSync(evid, 'png');
  try {
    const c = await connect('jira.mjs');
    const r = parse(
      await c.callTool({
        name: 'create_bug',
        arguments: { parentKey: 'PROJ-1', summary: 'SO — total wrong', description: 'h3. Steps', priority: 'High', attachments: ['state/evidence-test.png'] },
      }),
    );
    assert.equal(r.key, 'PROJ-99');
    assert.equal(r.attached[0].attached, true);
    const create = JSON.parse(calls.filter((x) => x.url === '/rest/api/2/issue').at(-1).body);
    assert.deepEqual(create.fields.parent, { key: 'PROJ-1' });
    assert.deepEqual(create.fields.issuetype, { name: 'Sub-task' });
    assert.deepEqual(create.fields.assignee, { accountId: 'dev-acct' });
    assert.deepEqual(create.fields.labels, ['qa-automation']);
    assert.equal(calls.at(-1).headers['x-atlassian-token'], 'no-check');

    const refused = await c.callTool({ name: 'create_bug', arguments: { parentKey: 'OTHER-1', summary: 's', description: 'd' } });
    assert.equal(refused.isError, true);
    const outside = parse(await c.callTool({ name: 'add_comment', arguments: { key: 'PROJ-1', body: 'b', attachments: ['../etc/passwd'] } }));
    assert.equal(outside.attached[0].attached, false);
    await c.close();
  } finally {
    rmSync(evid, { force: true });
  }
});

test('netsuite: SuiteQL is signed with TBA and refuses anything but SELECT', async () => {
  const c = await connect('netsuite.mjs');
  const r = parse(await c.callTool({ name: 'suiteql', arguments: { query: 'SELECT id, tranid FROM transaction', limit: 5 } }));
  assert.deepEqual(r.rows, [{ id: '42', tranid: 'SO1' }]);
  const call = calls.find((x) => x.url.startsWith('/services/rest/query/v1/suiteql'));
  assert.match(call.url, /limit=5&offset=0/);
  assert.match(call.headers.authorization, /^OAuth realm="123456_SB2", oauth_consumer_key="ck".*oauth_signature_method="HMAC-SHA256".*oauth_token="tk"/);
  assert.equal(call.headers.prefer, 'transient');
  assert.deepEqual(JSON.parse(call.body), { q: 'SELECT id, tranid FROM transaction' });

  for (const bad of ['DELETE FROM transaction', 'select 1; drop x', 'UPDATE customer SET x=1']) {
    const res = await c.callTool({ name: 'suiteql', arguments: { query: bad } });
    assert.equal(res.isError, true, bad);
  }
  await c.close();
});
