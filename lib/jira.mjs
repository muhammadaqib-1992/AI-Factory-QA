// Minimal Jira Cloud REST client (API-token auth), shared by the Jira MCP server and the
// post-run scripts.
import { env } from './env.mjs';

export const base = () => env('JIRA_BASE_URL').replace(/\/+$/, '');
export const projectKey = () => env('JIRA_PROJECT_KEY').toUpperCase();
export const browseUrl = (key) => `${base()}/browse/${key}`;
export const authHeader = () =>
  'Basic ' + Buffer.from(`${env('JIRA_EMAIL')}:${env('JIRA_API_TOKEN')}`).toString('base64');

export async function jira(method, path, body, extraHeaders = {}) {
  const headers = { Authorization: authHeader(), Accept: 'application/json', ...extraHeaders };
  let payload;
  if (body instanceof FormData) {
    payload = body;
    headers['X-Atlassian-Token'] = 'no-check';
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${base()}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text.slice(0, 1000) };
  }
  if (!res.ok) {
    const msgs = [...(json.errorMessages || []), ...Object.entries(json.errors || {}).map(([k, v]) => `${k}: ${v}`)];
    const err = new Error(`Jira ${method} ${path} → HTTP ${res.status}: ${msgs.join(' | ') || text.slice(0, 300)}`);
    err.status = res.status;
    err.fields = Object.keys(json.errors || {});
    throw err;
  }
  return json;
}
