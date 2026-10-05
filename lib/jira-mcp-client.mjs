// Connects to the Jira MCP server from .mcp.json (Atlassian remote MCP via mcp-remote) from a
// plain Node script — used by the pipeline scripts and scripts/jira-mcp.mjs.
// Sign-in tokens are cached by mcp-remote in ~/.mcp-auth (scripts/mcp-auth.sh jira).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { REPO_ROOT, env } from './env.mjs';

export const JIRA_SITE = () => env('JIRA_SITE', 'folio3.atlassian.net').replace(/^https?:\/\//, '').replace(/\/+$/, '');

// interactive: wait up to 10 min for a browser sign-in. Unattended callers pass a short
// connectTimeoutMs so a missing sign-in fails fast instead of holding the pipeline lock.
export async function connectJira({ quietAuth = false, connectTimeoutMs = 600000 } = {}) {
  const transport = new StdioClientTransport({
    command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    args: ['--no-install', 'mcp-remote', 'https://mcp.atlassian.com/v1/mcp', env('JIRA_MCP_CALLBACK_PORT', '3334')],
    cwd: REPO_ROOT,
    stderr: quietAuth ? 'pipe' : 'inherit', // the sign-in URL appears on stderr when a sign-in is needed
  });
  const client = new Client({ name: 'ai-factory-qa', version: '1.0.0' });
  try {
    await client.connect(transport, { timeout: connectTimeoutMs });
  } catch (e) {
    await client.close().catch(() => {});
    if (/timed out|timeout/i.test(e.message) && connectTimeoutMs < 600000) {
      throw new Error('Jira MCP is not signed in on this machine (or Atlassian is unreachable). Run once: scripts/mcp-auth.sh jira');
    }
    throw e;
  }
  return client;
}

// Calls a tool and returns its JSON payload (or text if it is not JSON). Throws on tool errors.
export async function callJira(client, name, args) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  const text = (result.content || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  if (result.isError) throw new Error(`${name}: ${text.slice(0, 500)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
