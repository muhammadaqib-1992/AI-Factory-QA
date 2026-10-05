#!/usr/bin/env node
// Signs in to NetSuite headless with the credentials in .env and saves the session to
// .auth/netsuite-state.json. The Playwright MCP starts every run from that file
// (--isolated --storage-state), so the agent never sees or types a password.
//
//   NS_EMAIL / NS_PASSWORD   UI login
//   NS_TOTP_SECRET           optional — base32 secret key of the 2FA authenticator app
//   NS_ROLE_NAME             optional — role to pick if NetSuite shows the role chooser
//
// Exit codes: 0 signed in, 1 failed (a screenshot is left in logs/ for diagnosis).
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { REPO_ROOT, env, netsuiteAppUrl } from '../lib/env.mjs';
import { totp, totpSecondsLeft } from '../lib/totp.mjs';

const STATE = join(REPO_ROOT, '.auth', 'netsuite-state.json');
const LOGS = join(REPO_ROOT, 'logs');
const app = netsuiteAppUrl();
const headed = process.argv.includes('--headed');

const isLoggedIn = (url) => /\/app\/(center|common|accounting|site|login\/secure\/(?!enterpriselogin))/i.test(url) && !/loginpage|customerlogin/i.test(url);

async function firstVisible(page, selectors, timeout = 2000) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible({ timeout }).catch(() => false)) return loc;
  }
  return null;
}

async function main() {
  mkdirSync(join(REPO_ROOT, '.auth'), { recursive: true });
  mkdirSync(LOGS, { recursive: true });
  const browser = await chromium.launch({ headless: !headed, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(`${app}/pages/customerlogin.jsp`, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const email = await firstVisible(page, ['#email', 'input[name="email"]', 'input[type="email"]'], 10000);
    const password = await firstVisible(page, ['#password', 'input[name="password"]', 'input[type="password"]']);
    if (!email || !password) throw new Error('Login form not found on the NetSuite login page.');
    await email.fill(env('NS_EMAIL'));
    await password.fill(env('NS_PASSWORD'));
    const submit = await firstVisible(page, ['#login-submit', 'button[type="submit"]', 'input[type="submit"]']);
    await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), submit ? submit.click() : password.press('Enter')]);
    await page.waitForTimeout(3000);

    // Two-factor authentication: a single code field after the password step.
    const bodyText = async () => (await page.locator('body').innerText().catch(() => '')).toLowerCase();
    if (/verification code|authenticator|two-factor|2fa|one-time/i.test(await bodyText())) {
      const secret = env('NS_TOTP_SECRET', '');
      if (!secret) throw new Error('NetSuite asked for a 2FA code but NS_TOTP_SECRET is not set in .env.');
      if (totpSecondsLeft() < 5) await page.waitForTimeout(6000); // don't submit a code about to expire
      const codeField = await firstVisible(page, [
        'input[autocomplete="one-time-code"]',
        'input[inputmode="numeric"]',
        'input[name*="code" i]',
        'input[id*="code" i]',
        'input[type="tel"]',
        'input[type="text"]:not([readonly])',
      ]);
      if (!codeField) throw new Error('2FA page shown, but no code field was found.');
      await codeField.fill(totp(secret));
      const trust = page.getByLabel(/trust this device/i);
      if (await trust.isVisible({ timeout: 1000 }).catch(() => false)) await trust.check().catch(() => {});
      const go = await firstVisible(page, ['button:has-text("Submit")', 'input[type="submit"]', 'button[type="submit"]', 'a:has-text("Submit")']);
      await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), go ? go.click() : codeField.press('Enter')]);
      await page.waitForTimeout(4000);
    }

    // Role chooser, shown when the user has no default role.
    if (/choose (a )?role/i.test(await bodyText())) {
      const role = env('NS_ROLE_NAME', '');
      if (!role) throw new Error('NetSuite shows the role chooser; set NS_ROLE_NAME in .env.');
      await page.getByRole('link', { name: role, exact: false }).first().click();
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(3000);
    }

    if (/security question/i.test(await bodyText())) {
      throw new Error('NetSuite is asking a security question. Answer it once by hand (npm run login -- --headed on a desktop) or enable 2FA for this user.');
    }
    if (!isLoggedIn(page.url())) {
      await page.goto(`${app}/app/center/card.nl?sc=-29`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    }
    if (!isLoggedIn(page.url()) || (await page.locator('input[type="password"]').count()) > 0) {
      throw new Error(`Login did not reach the NetSuite home page (ended on ${new URL(page.url()).pathname}).`);
    }

    await context.storageState({ path: STATE });
    try {
      chmodSync(STATE, 0o600);
    } catch {}
    console.log(`NetSuite login OK → ${app} (session saved to .auth/netsuite-state.json)`);
  } catch (e) {
    const shot = join(LOGS, `netsuite-login-failed_${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    console.error(`NetSuite login FAILED: ${e.message}\nScreenshot: ${shot}`);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
