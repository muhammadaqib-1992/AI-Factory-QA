// Loads the repo's .env into process.env (values already set in the environment win),
// and gives every script and MCP server one way to read required settings.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseDotenv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    out[m[1]] = value;
  }
  return out;
}

let loaded = false;
export function loadEnv() {
  if (loaded) return;
  loaded = true;
  const file = resolve(REPO_ROOT, '.env');
  if (!existsSync(file)) return;
  for (const [k, v] of Object.entries(parseDotenv(readFileSync(file, 'utf8')))) {
    if (process.env[k] === undefined || process.env[k] === '') process.env[k] = v;
  }
}

export function env(name, fallback) {
  loadEnv();
  const v = process.env[name];
  if (v === undefined || v === '' || /^<.*>$/.test(v)) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing setting ${name} — set it in .env (see .env.example).`);
  }
  return v;
}

export function envBool(name, fallback = false) {
  const v = env(name, String(fallback)).toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(v);
}

// NetSuite account ids: "1234567_SB1" is the realm form, "1234567-sb1" the URL form.
export function netsuiteAccount() {
  const id = env('NETSUITE_ACCOUNT_ID', env('NS_ACCOUNT_ID', '')).trim();
  if (!id) throw new Error('Missing setting NETSUITE_ACCOUNT_ID — set it in .env (see .env.example).');
  return {
    realm: id.toUpperCase().replace(/-/g, '_'),
    host: id.toLowerCase().replace(/_/g, '-'),
  };
}

export function netsuiteAppUrl() {
  return env('NS_APP_URL', `https://${netsuiteAccount().host}.app.netsuite.com`).replace(/\/+$/, '');
}
