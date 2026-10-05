#!/usr/bin/env node
// Reports what is configured and what is missing on this machine. Changes nothing.
//
//   node scripts/check-setup.mjs          full check (needs .env)
//   node scripts/check-setup.mjs --ci     skip the checks that need real credentials/sign-ins
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { REPO_ROOT, loadEnv } from '../lib/env.mjs';

const ci = process.argv.includes('--ci');
let failures = 0;
const ok = (m) => console.log(`  OK    ${m}`);
const warn = (m) => console.log(`  WARN  ${m}`);
const bad = (m) => {
  failures++;
  console.log(`  FAIL  ${m}`);
};

console.log(`AI-Factory-QA setup check (${process.platform}, node ${process.version})\n`);

console.log('Runtime');
parseInt(process.versions.node, 10) >= 20 ? ok(`Node ${process.version}`) : bad(`Node 20+ required, found ${process.version}`);
if (process.platform === 'linux' && process.getuid?.() === 0) warn('running as root — Chromium needs a normal user (or --no-sandbox)');
existsSync(join(REPO_ROOT, 'node_modules', '@playwright', 'mcp')) ? ok('node_modules installed') : bad('run npm ci');
try {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  await browser.close();
  ok('Chromium starts headless');
} catch (e) {
  bad(`Chromium does not start: ${e.message.split('\n')[0]} — run: npx playwright install --with-deps chromium`);
}

console.log('\nConfiguration');
try {
  const cfg = JSON.parse(readFileSync(join(REPO_ROOT, '.mcp.json'), 'utf8'));
  ok(`.mcp.json: ${Object.keys(cfg.mcpServers).join(', ')}`);
  const settings = JSON.parse(readFileSync(join(REPO_ROOT, '.claude', 'settings.json'), 'utf8'));
  if (settings.hooks) warn('.claude/settings.json still defines hooks');
  settings.enableAllProjectMcpServers ? ok('project MCP servers auto-approved') : warn('enableAllProjectMcpServers is off — approve the servers on first run');
} catch (e) {
  bad(`config: ${e.message}`);
}

if (!ci) {
  const envFile = join(REPO_ROOT, '.env');
  if (!existsSync(envFile)) {
    bad('.env missing — cp .env.example .env');
  } else {
    if (process.platform !== 'win32' && (statSync(envFile).mode & 0o077) !== 0) warn('.env is readable by other users — chmod 600 .env');
    loadEnv();
    const used = [...readFileSync(join(REPO_ROOT, '.mcp.json'), 'utf8').matchAll(/\$\{([A-Z0-9_]+)(:-)?/g)];
    const required = [...new Set(used.filter((m) => !m[2]).map((m) => m[1])), 'NS_EMAIL', 'NS_PASSWORD'];
    const missing = required.filter((k) => !process.env[k] || /^<.*>$|<[A-Z_]+>/.test(process.env[k]));
    missing.length ? bad(`.env values still missing/placeholder: ${missing.join(', ')}`) : ok('.env has every value .mcp.json and the login need');
  }

  console.log('\nSign-ins');
  const mcpAuth = join(homedir(), '.mcp-auth');
  existsSync(mcpAuth) && readdirSync(mcpAuth, { recursive: true }).some((f) => String(f).endsWith('_tokens.json'))
    ? ok('Jira (mcp-remote) tokens cached in ~/.mcp-auth')
    : warn('Jira not signed in yet — scripts/mcp-auth.sh jira');
  const nsSession = join(REPO_ROOT, '.auth', 'netsuite-mcp', 'session.json');
  existsSync(nsSession) && /access_token|accessToken/.test(readFileSync(nsSession, 'utf8'))
    ? ok('NetSuite MCP tokens in .auth/netsuite-mcp/')
    : warn('NetSuite MCP not signed in yet — scripts/mcp-auth.sh netsuite');
  const uiState = join(REPO_ROOT, '.auth', 'netsuite-state.json');
  existsSync(uiState) && JSON.parse(readFileSync(uiState, 'utf8')).cookies?.length
    ? ok(`NetSuite UI session saved ${new Date(statSync(uiState).mtimeMs).toISOString().slice(0, 16)} (runs refresh it)`)
    : warn('NetSuite UI not signed in yet — node scripts/netsuite-login.mjs');
  const gdriveToken = process.env.GDRIVE_CREDENTIALS_PATH;
  gdriveToken && existsSync(gdriveToken) ? ok('Google Drive token present') : warn('Google Drive not signed in yet — scripts/mcp-auth.sh gdrive');
}

console.log(failures ? `\n${failures} problem(s) to fix.` : '\nAll required checks passed.');
process.exit(failures ? 1 : 0);
