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

export async function pickTickets({ includeTested = false } = {}) {
  const site = JIRA_SITE();
  const status = env('JIRA_READY_STATUS', 'Ready for QA');
  const jql = pickupJql();
  const client = await connectJira({ quietAuth: true });
  try {
    const found = await callJira(client, 'searchJiraIssuesUsingJql', {
      cloudId: site,
      jql,
      maxResults: 50,
      fields: ['summary', 'issuetype', 'priority', 'labels', 'status', 'updated'],
    });
    const issues = found?.issues || found?.issues?.nodes || [];
    const state = readState();
    const tickets = [];
    for (const i of issues) {
      const full = await callJira(client, 'getJiraIssue', { cloudId: site, issueIdOrKey: i.key, fields: ['status'], expand: 'changelog' });
      const issue = full?.issues?.nodes?.[0] || full;
      const cycle = enteredStatusAt(issue, status) || i.fields?.updated || null;
      const prior = state[i.key];
      const tested = Boolean(prior && prior.cycle === cycle);
      if (tested && !includeTested) continue;
      tickets.push({
        key: i.key,
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
    return { jql, found: issues.length, toTest: tickets.filter((t) => !t.alreadyTested).length, tickets };
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

