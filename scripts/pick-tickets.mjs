#!/usr/bin/env node
// Finds the Jira tickets the pipeline should test now: those matching the pickup query
// (default: project NU, status "Ready for QA", assigned to the signed-in Jira user, label
// AI_FActory) whose CURRENT QA cycle has not been tested yet.
//
// A QA cycle = the moment a ticket last moved into "Ready for QA". A ticket that goes back to
// development and returns gets a new cycle and is tested again. Tested cycles are recorded in
// state/processed-tickets.json by scripts/run-pipeline.mjs.
//
//   node scripts/pick-tickets.mjs            JSON list of tickets to test
//   node scripts/pick-tickets.mjs --all      include tickets already tested this cycle
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, env } from '../lib/env.mjs';
import { JIRA_SITE, callJira, connectJira } from '../lib/jira-mcp-client.mjs';

export const STATE_FILE = join(REPO_ROOT, 'state', 'processed-tickets.json');

export function pickupJql() {
  const custom = env('JIRA_PICKUP_JQL', '');
  if (custom) return custom;
  const project = env('JIRA_PROJECT_KEY', 'NU');
  const status = env('JIRA_READY_STATUS', 'Ready for QA');
  const assignee = env('JIRA_QA_ASSIGNEE', 'currentUser()');
  const label = env('JIRA_PICKUP_LABEL', 'AI_FActory');
  const who = /\(\)$/.test(assignee) ? assignee : `"${assignee}"`;
  return `project = ${project} AND status = "${status}" AND assignee = ${who}${label ? ` AND labels = "${label}"` : ''} ORDER BY priority DESC, updated ASC`;
}

export function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

// Latest time the ticket moved INTO the ready status, from its changelog.
function enteredStatusAt(issue, status) {
  const histories = issue?.changelog?.histories || [];
  let latest = null;
  for (const h of histories) {
    for (const item of h.items || []) {
      if (item.field === 'status' && String(item.toString || '').toLowerCase() === status.toLowerCase()) {
        if (!latest || h.created > latest) latest = h.created;
      }
    }
  }
  return latest;
}

// Bug sub-tasks the pipeline filed (recorded in state under their parent's first run, or
// labelled JIRA_BUG_LABEL) that are now back in the ready status — i.e. ready for retest.
export function bugRetestJql(state) {
  const project = env('JIRA_PROJECT_KEY', 'NU');
  const status = env('JIRA_READY_STATUS', 'Ready for QA');
  const label = env('JIRA_BUG_LABEL', 'ai-qa-bug');
  const known = [...new Set(Object.values(state).flatMap((s) => (s && s.complete && s.mode !== 'retest' ? s.bugs || [] : [])))];
  const who = [label ? `labels = "${label}"` : '', known.length ? `key in (${known.join(', ')})` : ''].filter(Boolean).join(' OR ');
  if (!who) return null;
  return `project = ${project} AND status = "${status}" AND (${who}) ORDER BY updated ASC`;
}

async function collect(client, site, status, jql, mode, state, includeTested) {
  const found = await callJira(client, 'searchJiraIssuesUsingJql', {
    cloudId: site,
    jql,
    maxResults: 50,
    fields: ['summary', 'issuetype', 'priority', 'labels', 'status', 'updated', 'parent'],
  });
  const issues = found?.issues || [];
  const out = [];
  for (const i of issues) {
    const parentKey = i.fields?.parent?.key || null;
    // A bug is retested only once its parent ticket's first run has finished.
    if (mode === 'retest' && !(parentKey && state[parentKey]?.complete)) continue;
    const full = await callJira(client, 'getJiraIssue', { cloudId: site, issueIdOrKey: i.key, fields: ['status'], expand: 'changelog' });
    const issue = full?.issues?.nodes?.[0] || full;
    const cycle = enteredStatusAt(issue, status) || i.fields?.updated || null;
    const prior = state[i.key];
    const tested = Boolean(prior && prior.cycle === cycle);
    if (tested && !includeTested) continue;
    out.push({
      mode,
      key: i.key,
      parentKey: mode === 'retest' ? parentKey : i.key,
      url: `https://${site}/browse/${i.key}`,
      summary: i.fields?.summary,
      type: i.fields?.issuetype?.name,
      priority: i.fields?.priority?.name,
      labels: i.fields?.labels,
      cycle,
      alreadyTested: tested,
      lastRun: prior || null,
    });
  }
  return { found: issues.length, tickets: out };
}

// Tickets to test now: first iterations for new Ready-for-QA tickets, then retests for the
// pipeline's bugs that developers have moved back to Ready for QA.
export async function pickTickets({ includeTested = false } = {}) {
  const site = JIRA_SITE();
  const status = env('JIRA_READY_STATUS', 'Ready for QA');
  const state = readState();
  const jql = pickupJql();
  const bugJql = bugRetestJql(state);
  const client = await connectJira({ quietAuth: true, connectTimeoutMs: Number(env('JIRA_CONNECT_TIMEOUT_SEC', '90')) * 1000 });
  try {
    const first = await collect(client, site, status, jql, 'test', state, includeTested);
    const retest = bugJql ? await collect(client, site, status, bugJql, 'retest', state, includeTested) : { found: 0, tickets: [] };
    const firstKeys = new Set(first.tickets.map((t) => t.key));
    const tickets = [...first.tickets, ...retest.tickets.filter((t) => !firstKeys.has(t.key))];
    return {
      jql,
      bugJql,
      found: first.found,
      bugsFound: retest.found,
      toTest: tickets.filter((t) => !t.alreadyTested).length,
      tickets,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

if (process.argv[1]?.endsWith('pick-tickets.mjs')) {
  pickTickets({ includeTested: process.argv.includes('--all') })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error(`pick-tickets: ${e.message}`);
      process.exit(1);
    });
}

