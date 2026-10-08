#!/usr/bin/env node
// Closes a parent ticket once its QA is complete:
//   - its first pipeline run finished with every case Passed (no bugs), or
//   - every Failed case has a bug, and every bug the pipeline filed is now closed
//     (JIRA_CLOSE_STATUS) — after retests, or closed by someone else
// and nothing was Blocked / Not Run. Then it moves the ticket to JIRA_CLOSE_STATUS and comments.
//
//   node scripts/close-completed.mjs              check every ticket the pipeline has tested
//   node scripts/close-completed.mjs NU-4040      check one ticket
//   add --dry-run to report the decision without changing Jira
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { REPO_ROOT, env, envBool, loadEnv } from '../lib/env.mjs';
import { JIRA_SITE, callJira, connectJira, transitionTo } from '../lib/jira-mcp-client.mjs';
import { STATE_FILE, readState } from './pick-tickets.mjs';

loadEnv();
const norm = (s) => String(s || '').trim().toLowerCase();

// Pure decision, unit-tested in tests/close-completed.test.mjs.
export function decideClosure(firstResults, bugStatuses, closeStatus, extraBugs = []) {
  if (!firstResults) return { close: false, reason: 'no first-iteration results' };
  if (!firstResults.complete) return { close: false, reason: 'first iteration incomplete' };
  const cases = firstResults.testCases || [];
  if (!cases.length) return { close: false, reason: 'no test cases ran' };
  const unfinished = cases.filter((c) => !['Passed', 'Failed'].includes(c.status));
  if (unfinished.length) return { close: false, reason: `${unfinished.length} case(s) ${[...new Set(unfinished.map((c) => c.status))].join('/')}` };
  const unbugged = cases.filter((c) => c.status === 'Failed' && !(c.bugs || []).length);
  if (unbugged.length) return { close: false, reason: `${unbugged.length} failed case(s) without a bug` };
  // extraBugs: bugs filed later (new failures found while retesting) — they must close too.
  const bugs = [...new Set([...cases.flatMap((c) => c.bugs || []), ...extraBugs])];
  const open = bugs.filter((b) => norm(bugStatuses[b]) !== norm(closeStatus));
  if (open.length) return { close: false, reason: `bug(s) not closed yet: ${open.map((b) => `${b} (${bugStatuses[b] || 'unknown'})`).join(', ')}` };
  return { close: true, reason: bugs.length ? `all ${bugs.length} bug(s) closed: ${bugs.join(', ')}` : 'all test cases passed, no bugs' };
}

function firstResultsFor(entry) {
  const file = entry?.firstReport ? join(REPO_ROOT, dirname(entry.firstReport), 'results.json') : null;
  return file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

export async function closeCompleted({ keys, dryRun = false, log = console.log } = {}) {
  if (!envBool('QA_CLOSE_PARENT', true)) return [];
  const site = JIRA_SITE();
  const closeStatus = env('JIRA_CLOSE_STATUS', 'Done / Closed');
  const state = readState();
  const parents = (keys?.length ? keys : Object.keys(state)).filter((k) => state[k] && state[k].mode !== 'retest' && !state[k].closedAt);
  if (!parents.length) return [];
  const client = await connectJira({ quietAuth: true, connectTimeoutMs: Number(env('JIRA_CONNECT_TIMEOUT_SEC', '90')) * 1000 });
  const decisions = [];
  try {
    for (const key of parents) {
      const entry = state[key];
      const issue = await callJira(client, 'getJiraIssue', { cloudId: site, issueIdOrKey: key, fields: ['status', 'subtasks'] });
      const fields = (issue?.issues?.nodes?.[0] || issue)?.fields || {};
      if (norm(fields.status?.name) === norm(closeStatus)) {
        decisions.push({ key, close: false, reason: 'already closed' });
        continue;
      }
      const bugStatuses = Object.fromEntries((fields.subtasks || []).map((s) => [s.key, s.fields?.status?.name]));
      const d = { key, ...decideClosure(firstResultsFor(entry), bugStatuses, closeStatus, entry.bugs || []) };
      decisions.push(d);
      if (!d.close) {
        log(`${key}: stays open — ${d.reason}`);
        continue;
      }
      if (dryRun) {
        log(`${key}: would close — ${d.reason}`);
        continue;
      }
      try {
        const to = await transitionTo(client, site, key, closeStatus);
        await callJira(client, 'addCommentToJiraIssue', {
          cloudId: site,
          issueIdOrKey: key,
          commentBody: `QA complete — ${d.reason}. Closed by the QA pipeline (first run ${entry.executionId}, report ${entry.firstReport}).`,
        });
        const fresh = readState();
        fresh[key] = { ...fresh[key], closedAt: new Date().toISOString(), closedReason: d.reason };
        writeFileSync(STATE_FILE, JSON.stringify(fresh, null, 2));
        log(`${key}: moved to "${to}" — ${d.reason}`);
      } catch (e) {
        d.error = e.message;
        log(`${key}: could not close — ${e.message}`);
      }
    }
  } finally {
    await client.close().catch(() => {});
  }
  return decisions;
}

if (process.argv[1]?.endsWith('close-completed.mjs')) {
  const args = process.argv.slice(2);
  closeCompleted({ keys: args.filter((a) => !a.startsWith('--')), dryRun: args.includes('--dry-run') }).catch((e) => {
    console.error(`close-completed: ${e.message}`);
    process.exit(1);
  });
}
