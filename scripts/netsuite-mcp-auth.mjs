#!/usr/bin/env node
// One-time NetSuite MCP sign-in (OAuth 2.0 PKCE) for a machine without a desktop browser.
// Prints the authorization URL, waits for NetSuite to call back on localhost, and stores
// the tokens where the netsuite MCP server reads them (.auth/netsuite-mcp/).
// Run it through scripts/mcp-auth.sh netsuite.
import { join } from 'node:path';
import { REPO_ROOT, env } from '../lib/env.mjs';
import { OAuthManager } from '../node_modules/@suiteinsider/netsuite-mcp/src/oauth/manager.js';

const port = parseInt(env('NETSUITE_OAUTH_CALLBACK_PORT', '8080'), 10);
const manager = new OAuthManager({ storagePath: join(REPO_ROOT, '.auth', 'netsuite-mcp'), callbackPort: port });

try {
  await manager.startAuthFlow({ accountId: env('NETSUITE_ACCOUNT_ID'), clientId: env('NETSUITE_CLIENT_ID') });
  console.log('NetSuite MCP signed in. Tokens saved to .auth/netsuite-mcp/ — they refresh automatically.');
  process.exit(0);
} catch (e) {
  console.error(`NetSuite MCP sign-in failed: ${e.message}`);
  process.exit(1);
}
