#!/usr/bin/env node
// Calls the Jira MCP server from .mcp.json (Atlassian remote MCP via mcp-remote) without
// starting Claude. Useful to test the connection and to script one-off reads.
//
//   node scripts/jira-mcp.mjs tools                         list the tools
//   node scripts/jira-mcp.mjs call <tool> '<json args>'     call one tool, print the result
//
// The first run opens the Atlassian sign-in (see scripts/mcp-auth.sh for headless machines);
// tokens are then cached in ~/.mcp-auth.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { REPO_ROOT, env } from '../lib/env.mjs';

const [cmd, tool, rawArgs] = process.argv.slice(2);
if (!['tools', 'call'].includes(cmd) || (cmd === 'call' && !tool)) {
  console.error("Usage: node scripts/jira-mcp.mjs tools | call <tool> '<json args>'");
  process.exit(2);
}

const transport = new StdioClientTransport({
  command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
  args: ['--no-install', 'mcp-remote', 'https://mcp.atlassian.com/v1/mcp', env('JIRA_MCP_CALLBACK_PORT', '3334')],
  cwd: REPO_ROOT,
  stderr: 'inherit', // sign-in URL and auth progress show here
});
const client = new Client({ name: 'jira-mcp-cli', version: '1.0.0' });

try {
  await client.connect(transport, { timeout: 600000 }); // first run waits for the browser sign-in
  if (cmd === 'tools') {
    for (const t of (await client.listTools()).tools) console.log(`${t.name}\t${(t.description || '').split('\n')[0].slice(0, 100)}`);
  } else {
    const result = await client.callTool({ name: tool, arguments: rawArgs ? JSON.parse(rawArgs) : {} }, undefined, { timeout: 120000 });
    for (const part of result.content || []) console.log(part.type === 'text' ? part.text : JSON.stringify(part));
    if (result.isError) process.exitCode = 1;
  }
} catch (e) {
  console.error(`Jira MCP error: ${e.message}`);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
