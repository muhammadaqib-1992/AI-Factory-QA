#!/usr/bin/env node
// Checks that the saved NetSuite session (.auth/netsuite-state.json) still logs headless
// Playwright straight into NetSuite — the same way the Playwright MCP starts every run.
// Uses only the saved cookies; it never types a password.
//
//   node scripts/check-netsuite-session.mjs
// Exit 0 = logged in, 1 = not logged in (run: node scripts/netsuite-login.mjs).
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchBrowser } from '../lib/browser.mjs';
import { REPO_ROOT, netsuiteAppUrl } from '../lib/env.mjs';

const STATE = join(REPO_ROOT, '.auth', 'netsuite-state.json');
if (!existsSync(STATE)) {
  console.error('No saved session. Run: node scripts/netsuite-login.mjs');
  process.exit(1);
}

const app = netsuiteAppUrl();
const browser = await launchBrowser();
try {
  const context = await browser.newContext({ storageState: STATE, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${app}/app/center/card.nl?sc=-29`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(3000);
  const url = new URL(page.url());
  const onLogin = /customerlogin|loginpage|login\.nl/i.test(url.pathname) || (await page.locator('input[type="password"]').count()) > 0;
  mkdirSync(join(REPO_ROOT, 'logs'), { recursive: true });
  const shot = join(REPO_ROOT, 'logs', 'netsuite-session-check.png');
  await page.screenshot({ path: shot });
  if (onLogin) {
    console.error(`NOT logged in — NetSuite sent the browser to ${url.pathname}. Run: node scripts/netsuite-login.mjs`);
    process.exitCode = 1;
  } else {
    const role = (await page.locator('.ns-role, #ns-header-menu-userrole, [data-automation-id="roleName"]').first().innerText({ timeout: 3000 }).catch(() => ''))
      .replace(/\s+/g, ' ')
      .trim();
    console.log(`Logged in to ${url.host}${role ? ` as role "${role}"` : ''} (headless). Page: ${await page.title()}`);
  }
  console.log(`Screenshot: logs/netsuite-session-check.png`);
} finally {
  await browser.close();
}
