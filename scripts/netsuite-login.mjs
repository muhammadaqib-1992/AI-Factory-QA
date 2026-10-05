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
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { launchBrowser } from '../lib/browser.mjs';
import { REPO_ROOT, env, netsuiteAppUrl } from '../lib/env.mjs';
import { totp, totpSecondsLeft } from '../lib/totp.mjs';

const STATE = join(REPO_ROOT, '.auth', 'netsuite-state.json');
const LOGS = join(REPO_ROOT, 'logs');
const app = netsuiteAppUrl();
const headed = process.argv.includes('--headed');

// Logged in = a page under /app/ that is not part of the login flow, with no password field.
const isAppPage = (url) => {
  const path = new URL(url).pathname;
  return path.startsWith('/app/') && !path.startsWith('/app/login/') && !/loginpage|customerlogin/i.test(path);
};

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
  const browser = await launchBrowser({ headless: !headed });
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
    await (submit ? submit.click() : password.press('Enter'));

    // Walk whatever NetSuite shows next (2FA, role chooser, …) until the app or a dead end.
    const bodyText = async () => (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
    const hasPassword = async () => (await page.locator('input[type="password"]:visible').count()) > 0;
    let codeSent = false;
    let roleChosen = false;
    for (let step = 0; step < 8; step++) {
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(1500);
      const url = page.url();
      const text = await bodyText();
      if (isAppPage(url) && !(await hasPassword())) break;

      if (/verification code|authenticator|two-factor|2fa|one-time|security code|enter (the|your) code/i.test(text) || /twofactor|mfa|verif/i.test(url)) {
        if (/email message containing a verification code|code has been sent to|sent .*text message/i.test(text)) {
          throw new Error(
            'NetSuite sent the 2FA code by email/SMS, so the authenticator app is not this user\'s active 2FA method. ' +
              'Finish the authenticator setup in NetSuite (enter the code from the phone app so it is saved as primary), then run this again.',
          );
        }
        if (codeSent) throw new Error('NetSuite rejected the 2FA code. Check NS_TOTP_SECRET (and that this machine\'s clock is correct).');
        const secret = env('NS_TOTP_SECRET', '');
        if (!secret) throw new Error('NetSuite asked for a 2FA verification code but NS_TOTP_SECRET is not set in .env.');
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
        const go = await firstVisible(page, ['button:has-text("Submit")', 'button:has-text("Verify")', 'input[type="submit"]', 'button[type="submit"]', 'a:has-text("Submit")']);
        const before = page.url();
        await (go ? go.click() : codeField.press('Enter'));
        // NetSuite takes a few seconds to move on after an accepted code; only a code page
        // that is still there afterwards means the code was rejected.
        await page.waitForURL((u) => u.toString() !== before, { timeout: 45000 }).catch(() => {});
        codeSent = true;
        continue;
      }
      if (/choose (a )?role|select (a )?role/i.test(text) && !roleChosen) {
        const role = env('NS_ROLE_NAME', '');
        if (!role) throw new Error('NetSuite shows the role chooser; set NS_ROLE_NAME in .env.');
        await page.getByRole('link', { name: role, exact: false }).first().click();
        roleChosen = true;
        continue;
      }
      if (/security question/i.test(text)) {
        throw new Error('NetSuite is asking a security question. Answer it once by hand (node scripts/netsuite-login.mjs --headed on a desktop) or enable 2FA for this user.');
      }
      if (await hasPassword()) {
        const msg = text.match(/(invalid[^.]*\.|incorrect[^.]*\.|locked[^.]*\.|too many[^.]*\.)/i)?.[1];
        throw new Error(`NetSuite stayed on the login page${msg ? `: "${msg.trim()}"` : ''}. Check NS_EMAIL / NS_PASSWORD in .env.`);
      }
      if (step === 7) {
        const heading = (await page.locator('h1, h2').first().innerText().catch(() => '')).trim();
        throw new Error(`Unexpected page after login: ${new URL(url).pathname}${heading ? ` ("${heading}")` : ''}.`);
      }
    }

    // Confirm the session really opens the app before saving it.
    await page.goto(`${app}/app/center/card.nl?sc=-29`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);
    if (!isAppPage(page.url()) || (await hasPassword())) {
      throw new Error(`Login did not reach the NetSuite home page (ended on ${new URL(page.url()).pathname}).`);
    }

    await context.storageState({ path: STATE });
    try {
      chmodSync(STATE, 0o600);
    } catch {}
    console.log(`NetSuite login OK → ${app} (session saved to .auth/netsuite-state.json)`);
  } catch (e) {
    rmSync(STATE, { force: true }); // never leave a half-finished session behind
    const shot = join(LOGS, `netsuite-login-failed_${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    console.error(`NetSuite login FAILED: ${e.message}\nScreenshot: ${shot}`);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
