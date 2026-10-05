#!/usr/bin/env node
// Runs after `npm install`. @suiteinsider/netsuite-mcp keeps its OAuth tokens in
// node_modules/@suiteinsider/netsuite-mcp/sessions — which a reinstall wipes, forcing a
// new browser sign-in. Point that folder at .auth/netsuite-mcp/ so tokens survive.
import { existsSync, lstatSync, mkdirSync, renameSync, rmSync, symlinkSync, readdirSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../lib/env.mjs';

const pkg = join(REPO_ROOT, 'node_modules', '@suiteinsider', 'netsuite-mcp');
if (!existsSync(pkg)) process.exit(0);

const target = join(REPO_ROOT, '.auth', 'netsuite-mcp');
const link = join(pkg, 'sessions');
mkdirSync(target, { recursive: true });

if (existsSync(link) || lstatSync(link, { throwIfNoEntry: false })) {
  const st = lstatSync(link);
  if (st.isSymbolicLink()) process.exit(0);
  // A real folder: keep any session in it, then replace it with the link.
  if (st.isDirectory()) {
    for (const f of readdirSync(link)) cpSync(join(link, f), join(target, f), { recursive: true });
    rmSync(link, { recursive: true, force: true });
  } else {
    renameSync(link, `${link}.bak`);
  }
}
symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
console.log('netsuite-mcp sessions → .auth/netsuite-mcp/');
