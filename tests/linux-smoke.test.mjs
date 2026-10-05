// Smoke test for the parts that differ between operating systems. It starts the local MCP
// servers exactly as .mcp.json defines them (with ${VAR} expanded the way Claude Code does),
// drives headless Chromium through the Playwright MCP, and builds a PDF report.
// CI runs it on Ubuntu (.github/workflows/linux-check.yml). Run locally with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { REPO_ROOT } from '../lib/env.mjs';
import { buildPdf } from '../scripts/build-report.mjs';

const config = JSON.parse(readFileSync(join(REPO_ROOT, '.mcp.json'), 'utf8')).mcpServers;
const testEnv = {
  NETSUITE_ACCOUNT_ID: '1234567-sb1',
  NETSUITE_CLIENT_ID: 'smoke-test-client',
  NETSUITE_OAUTH_CALLBACK_PORT: '8080',
  JIRA_MCP_CALLBACK_PORT: '3334',
  GITHUB_PERSONAL_ACCESS_TOKEN: 'smoke',
  GDRIVE_OAUTH_PATH: '/tmp/x.json',
  GDRIVE_CREDENTIALS_PATH: '/tmp/y.json',
};
const expand = (s) =>
  s.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g, (_, k, d) => {
    const v = testEnv[k] ?? process.env[k] ?? d;
    if (v === undefined) throw new Error(`.mcp.json uses \${${k}} with no value or default`);
    return v;
  });

async function start(name) {
  const s = config[name];
  assert.equal(s.type, 'stdio');
  const transport = new StdioClientTransport({
    command: process.platform === 'win32' && s.command === 'npx' ? 'npx.cmd' : s.command,
    args: s.args.map(expand),
    env: { ...process.env, ...Object.fromEntries(Object.entries(s.env || {}).map(([k, v]) => [k, expand(v)])) },
    cwd: REPO_ROOT,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'smoke', version: '1' });
  await client.connect(transport);
  return client;
}

test('.mcp.json: every ${VAR} is one .env.example defines', () => {
  const example = readFileSync(join(REPO_ROOT, '.env.example'), 'utf8');
  const defined = new Set([...example.matchAll(/^#?\s*([A-Z0-9_]+)=/gm)].map((m) => m[1]));
  const used = [...JSON.stringify(config).matchAll(/\$\{([A-Z0-9_]+)/g)].map((m) => m[1]);
  for (const v of used) assert.ok(defined.has(v), `${v} is used in .mcp.json but missing from .env.example`);
});

test('playwright MCP: headless Chromium opens a page and saves a screenshot in the repo', { timeout: 180000 }, async () => {
  const state = join(REPO_ROOT, '.auth', 'netsuite-state.json');
  const createdState = !existsSync(state);
  if (createdState) {
    mkdirSync(join(REPO_ROOT, '.auth'), { recursive: true });
    writeFileSync(state, JSON.stringify({ cookies: [], origins: [] }));
  }
  const shot = 'logs/smoke/playwright-smoke.png';
  rmSync(join(REPO_ROOT, shot), { force: true });
  const c = await start('playwright');
  try {
    const nav = await c.callTool({ name: 'browser_navigate', arguments: { url: 'data:text/html,<h1>AI Factory QA smoke</h1>' } });
    assert.ok(!nav.isError, nav.content?.[0]?.text);
    const snap = await c.callTool({ name: 'browser_snapshot', arguments: {} });
    assert.match(snap.content.map((p) => p.text || '').join(' '), /AI Factory QA smoke/);
    const r = await c.callTool({ name: 'browser_take_screenshot', arguments: { filename: shot, type: 'png' } });
    assert.ok(!r.isError, r.content?.[0]?.text);
    assert.ok(existsSync(join(REPO_ROOT, shot)), 'screenshot was not written where the skills expect it');
  } finally {
    await c.close();
    if (createdState) rmSync(state, { force: true });
  }
});

test('netsuite MCP: starts and offers sign-in before authentication', { timeout: 60000 }, async () => {
  const c = await start('netsuite');
  try {
    const tools = (await c.listTools()).tools.map((t) => t.name);
    assert.ok(tools.includes('netsuite_authenticate'), tools.join(','));
  } finally {
    await c.close();
  }
});

test('netsuite MCP: its token folder is linked into .auth/ so reinstalls keep the sign-in', () => {
  const link = join(REPO_ROOT, 'node_modules', '@suiteinsider', 'netsuite-mcp', 'sessions');
  assert.ok(existsSync(link), 'run npm install (postinstall creates the link)');
});

test('PDF report builds with Chromium', { timeout: 120000 }, async () => {
  const out = join(REPO_ROOT, 'logs', 'smoke', 'report.pdf');
  mkdirSync(join(REPO_ROOT, 'logs', 'smoke'), { recursive: true });
  rmSync(out, { force: true });
  await buildPdf(['tests/fixtures/reports/2026-01-01_PROJ-1'], out);
  assert.ok(statSync(out).size > 10000, 'PDF looks empty');
  assert.equal(readFileSync(out).subarray(0, 5).toString(), '%PDF-');
});
