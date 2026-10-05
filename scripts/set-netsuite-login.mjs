#!/usr/bin/env node
// Asks for the NetSuite UI login in the terminal (password and 2FA key are not echoed),
// saves it to .env, then runs the headless login once to prove it works.
//
//   node scripts/set-netsuite-login.mjs
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { REPO_ROOT } from '../lib/env.mjs';

const ENV = join(REPO_ROOT, '.env');
if (!existsSync(ENV)) copyFileSync(join(REPO_ROOT, '.env.example'), ENV);

function ask(question, { hidden = false, fallback = '' } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => {
        if (s.includes(question)) rl.output.write(s);
        else if (!/[\r\n]/.test(s)) rl.output.write('*');
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim() || fallback);
    });
  });
}

const current = Object.fromEntries(
  [...readFileSync(ENV, 'utf8').matchAll(/^([A-Z0-9_]+)=(.*)$/gm)].map((m) => [m[1], m[2].replace(/^"(.*)"$/, '$1')]),
);
const keep = (v) => (v && !/^<.*>$/.test(v) ? v : '');

const email = await ask(`NetSuite login email [${keep(current.NS_EMAIL) || 'required'}]: `, { fallback: keep(current.NS_EMAIL) });
const password = await ask('NetSuite password (hidden): ', { hidden: true });
const totp = await ask('2FA secret key, if NetSuite asks you for a code (hidden, Enter to skip): ', { hidden: true, fallback: keep(current.NS_TOTP_SECRET) });
const role = await ask(`Role to pick if NetSuite asks [${keep(current.NS_ROLE_NAME) || 'none'}]: `, { fallback: keep(current.NS_ROLE_NAME) });
if (!email || !password) {
  console.error('Email and password are both required. Nothing was saved.');
  process.exit(1);
}

// .env readers take everything between the outer quotes literally (no escapes).
const quote = (v) => (v.includes('"') ? `'${v}'` : `"${v}"`);
let text = readFileSync(ENV, 'utf8');
for (const [k, v] of Object.entries({ NS_EMAIL: email, NS_PASSWORD: quote(password), NS_TOTP_SECRET: totp ? quote(totp) : '', NS_ROLE_NAME: role ? quote(role) : '' })) {
  text = new RegExp(`^${k}=.*$`, 'm').test(text) ? text.replace(new RegExp(`^${k}=.*$`, 'm'), () => `${k}=${v}`) : `${text.trimEnd()}\n${k}=${v}\n`;
}
writeFileSync(ENV, text);
try {
  chmodSync(ENV, 0o600);
} catch {}
console.log('Saved to .env. Running the headless login once…\n');

const r = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'netsuite-login.mjs')], { stdio: 'inherit' });
process.exit(r.status ?? 1);
