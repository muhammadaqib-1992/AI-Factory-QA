#!/usr/bin/env node
// Jira MCP server for the QA pipeline. Jira Cloud REST, API-token auth from .env.
//
// Deliberately narrow: it can find "Ready for QA" tickets, read everything on a ticket,
// download its attachments, file a bug UNDER a ticket (Sub-task, assigned to the configured
// bug assignee), comment, and attach evidence. It cannot delete, transition or edit issues,
// and every write is refused outside JIRA_PROJECT_KEY.
import { existsSync, mkdirSync, openAsBlob, readFileSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { REPO_ROOT, env } from '../lib/env.mjs';
import { authHeader, base, browseUrl, jira, projectKey } from '../lib/jira.mjs';

const STATE_FILE = join(REPO_ROOT, 'state', 'processed-tickets.json');

const ok = (data) => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] });
const fail = (err) => ({ isError: true, content: [{ type: 'text', text: String(err?.message || err) }] });

function assertProjectKey(key) {
  if (!/^[A-Z][A-Z0-9_]+-\d+$/i.test(key)) throw new Error(`"${key}" is not an issue key.`);
  if (key.split('-')[0].toUpperCase() !== projectKey()) {
    throw new Error(`Refused: ${key} is outside project ${projectKey()} (JIRA_PROJECT_KEY).`);
  }
}

function insideRepo(p) {
  const abs = isAbsolute(p) ? p : resolve(REPO_ROOT, p);
  const rel = relative(REPO_ROOT, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Refused: ${p} is outside the repository.`);
  if (!existsSync(abs)) throw new Error(`File not found: ${p}`);
  return abs;
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

// When did the ticket most recently move INTO the ready-for-QA status? That timestamp
// identifies one QA cycle: a ticket bounced back to dev and returned gets a new one.
async function statusEnteredAt(key, statusName) {
  let startAt = 0;
  let latest = null;
  for (let page = 0; page < 20; page++) {
    const data = await jira('GET', `/rest/api/3/issue/${key}/changelog?startAt=${startAt}&maxResults=100`);
    for (const h of data.values || []) {
      for (const item of h.items || []) {
        if (item.field === 'status' && (item.toString || '').toLowerCase() === statusName.toLowerCase()) {
          if (!latest || h.created > latest) latest = h.created;
        }
      }
    }
    if (data.isLast || !(data.values || []).length) break;
    startAt += data.values.length;
  }
  return latest;
}

function flatten(v) {
  if (v === null || v === undefined) return undefined;
  if (Array.isArray(v)) {
    const parts = v.map(flatten).filter((x) => x !== undefined && x !== '');
    return parts.length ? parts.join(', ') : undefined;
  }
  if (typeof v === 'object') {
    if (v.type === 'doc') return adfToText(v);
    return v.value ?? v.name ?? v.displayName ?? v.key ?? v.title ?? JSON.stringify(v).slice(0, 300);
  }
  return v;
}

function adfToText(node) {
  if (!node) return '';
  if (node.type === 'text') return node.text || '';
  const inner = (node.content || []).map(adfToText).join(node.type === 'doc' ? '\n' : '');
  if (['paragraph', 'heading', 'listItem', 'codeBlock', 'blockquote'].includes(node.type)) return inner + '\n';
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'mention') return node.attrs?.text || '';
  return inner;
}

const server = new McpServer({ name: 'jira', version: '1.0.0' });

server.registerTool(
  'list_ready_for_qa_tickets',
  {
    title: 'List tickets waiting for QA',
    description:
      'Returns the tickets in JIRA_READY_STATUS assigned to JIRA_QA_ASSIGNEE_ACCOUNT_ID in JIRA_PROJECT_KEY ' +
      '(or JIRA_PICKUP_JQL if set). Each ticket carries statusEnteredAt (when it entered the status) and ' +
      'alreadyTested (true when this QA cycle was already run by the pipeline). By default only untested ' +
      'tickets are returned.',
    inputSchema: {
      includeAlreadyTested: z.boolean().default(false),
      maxResults: z.number().int().min(1).max(100).default(25),
    },
  },
  async ({ includeAlreadyTested, maxResults }) => {
    try {
      const status = env('JIRA_READY_STATUS', 'Ready for QA');
      const jql =
        env('JIRA_PICKUP_JQL', '') ||
        `project = ${projectKey()} AND status = "${status}" AND assignee = "${env('JIRA_QA_ASSIGNEE_ACCOUNT_ID')}" ORDER BY priority DESC, updated ASC`;
      const data = await jira('POST', '/rest/api/3/search/jql', {
        jql,
        maxResults,
        fields: ['summary', 'issuetype', 'status', 'priority', 'labels', 'parent', 'updated'],
      });
      const state = readState();
      const tickets = [];
      for (const i of data.issues || []) {
        const entered = await statusEnteredAt(i.key, status);
        const prior = state[i.key];
        const alreadyTested = Boolean(prior && entered && prior.statusEnteredAt === entered);
        tickets.push({
          key: i.key,
          url: browseUrl(i.key),
          summary: i.fields.summary,
          type: i.fields.issuetype?.name,
          priority: i.fields.priority?.name,
          labels: i.fields.labels,
          parent: i.fields.parent?.key,
          statusEnteredAt: entered,
          alreadyTested,
          lastRun: prior ? { testedAt: prior.testedAt, result: prior.result, report: prior.report } : null,
        });
      }
      const picked = includeAlreadyTested ? tickets : tickets.filter((t) => !t.alreadyTested);
      return ok({ jql, found: tickets.length, toTest: picked.length, tickets: picked });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'get_ticket',
  {
    title: 'Read everything on a ticket',
    description:
      'Returns a ticket in full: summary, description, acceptance criteria and every other populated ' +
      'custom field (by display name), comments, attachments list, parent, sub-tasks (including bugs ' +
      'already filed under it), issue links, labels, components and versions. Text is Jira wiki markup.',
    inputSchema: { key: z.string().describe('Issue key, e.g. PROJ-652') },
  },
  async ({ key }) => {
    try {
      const i = await jira('GET', `/rest/api/2/issue/${encodeURIComponent(key)}?fields=*all&expand=names`);
      const f = i.fields;
      const names = i.names || {};
      const customFields = {};
      for (const [id, val] of Object.entries(f)) {
        if (!id.startsWith('customfield_')) continue;
        const flat = flatten(val);
        if (flat === undefined || flat === '' || (typeof flat === 'string' && flat.startsWith('{"'))) continue;
        customFields[names[id] || id] = flat;
      }
      const status = env('JIRA_READY_STATUS', 'Ready for QA');
      return ok({
        key: i.key,
        url: browseUrl(i.key),
        summary: f.summary,
        type: f.issuetype?.name,
        status: f.status?.name,
        statusEnteredAt: await statusEnteredAt(i.key, status).catch(() => null),
        priority: f.priority?.name,
        labels: f.labels,
        components: (f.components || []).map((c) => c.name),
        fixVersions: (f.fixVersions || []).map((v) => v.name),
        reporter: f.reporter?.displayName,
        assignee: f.assignee?.displayName,
        created: f.created,
        updated: f.updated,
        description: f.description,
        environment: f.environment,
        customFields,
        parent: f.parent
          ? { key: f.parent.key, summary: f.parent.fields?.summary, type: f.parent.fields?.issuetype?.name, url: browseUrl(f.parent.key) }
          : null,
        subtasks: (f.subtasks || []).map((s) => ({
          key: s.key,
          url: browseUrl(s.key),
          summary: s.fields?.summary,
          status: s.fields?.status?.name,
          type: s.fields?.issuetype?.name,
        })),
        links: (f.issuelinks || []).map((l) => {
          const other = l.outwardIssue || l.inwardIssue;
          return {
            relation: l.outwardIssue ? l.type?.outward : l.type?.inward,
            key: other?.key,
            url: other ? browseUrl(other.key) : undefined,
            summary: other?.fields?.summary,
            status: other?.fields?.status?.name,
          };
        }),
        comments: (f.comment?.comments || []).map((c) => ({ author: c.author?.displayName, created: c.created, body: c.body })),
        attachments: (f.attachment || []).map((a) => ({
          id: a.id,
          filename: a.filename,
          mimeType: a.mimeType,
          size: a.size,
          created: a.created,
        })),
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'download_attachments',
  {
    title: 'Download ticket attachments',
    description:
      'Saves a ticket\'s attachments under reports/_attachments/<KEY>/ and returns the local paths, so ' +
      'screenshots and documents on the ticket can be read. Skips files over 20 MB.',
    inputSchema: {
      key: z.string(),
      attachmentIds: z.array(z.string()).optional().describe('Only these ids; default all.'),
    },
  },
  async ({ key, attachmentIds }) => {
    try {
      const i = await jira('GET', `/rest/api/2/issue/${encodeURIComponent(key)}?fields=attachment`);
      const dir = join(REPO_ROOT, 'reports', '_attachments', i.key);
      mkdirSync(dir, { recursive: true });
      const saved = [];
      for (const a of i.fields.attachment || []) {
        if (attachmentIds?.length && !attachmentIds.includes(String(a.id))) continue;
        if (a.size > 20 * 1024 * 1024) {
          saved.push({ id: a.id, filename: a.filename, skipped: 'larger than 20 MB' });
          continue;
        }
        const res = await fetch(`${base()}/rest/api/3/attachment/content/${a.id}`, { headers: { Authorization: authHeader() } });
        if (!res.ok) {
          saved.push({ id: a.id, filename: a.filename, error: `HTTP ${res.status}` });
          continue;
        }
        const file = join(dir, `${a.id}_${basename(a.filename).replace(/[^\w.-]+/g, '_')}`);
        writeFileSync(file, Buffer.from(await res.arrayBuffer()));
        saved.push({ id: a.id, filename: a.filename, mimeType: a.mimeType, path: relative(REPO_ROOT, file).replace(/\\/g, '/') });
      }
      return ok({ key: i.key, saved });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'search_issues',
  {
    title: 'Search issues (read-only)',
    description: 'Runs a JQL search and returns key, summary, type, status, assignee, parent and updated. Use it for duplicate checks.',
    inputSchema: {
      jql: z.string(),
      maxResults: z.number().int().min(1).max(100).default(20),
    },
  },
  async ({ jql, maxResults }) => {
    try {
      const data = await jira('POST', '/rest/api/3/search/jql', {
        jql,
        maxResults,
        fields: ['summary', 'issuetype', 'status', 'assignee', 'parent', 'updated', 'labels'],
      });
      return ok(
        (data.issues || []).map((i) => ({
          key: i.key,
          url: browseUrl(i.key),
          summary: i.fields.summary,
          type: i.fields.issuetype?.name,
          status: i.fields.status?.name,
          assignee: i.fields.assignee?.displayName,
          parent: i.fields.parent?.key,
          updated: i.fields.updated,
          labels: i.fields.labels,
        })),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

async function uploadAttachments(key, paths) {
  const results = [];
  for (const p of paths || []) {
    try {
      const abs = insideRepo(p);
      const form = new FormData();
      form.append('file', await openAsBlob(abs), basename(abs));
      await jira('POST', `/rest/api/3/issue/${key}/attachments`, form);
      results.push({ path: p, attached: true });
    } catch (e) {
      results.push({ path: p, attached: false, error: String(e.message || e) });
    }
  }
  return results;
}

server.registerTool(
  'create_bug',
  {
    title: 'File a bug under a ticket',
    description:
      'Creates a defect as a child of the ticket under test (issue type JIRA_BUG_ISSUE_TYPE, default ' +
      '"Sub-task"), assigned to JIRA_BUG_ASSIGNEE_ACCOUNT_ID, labelled with JIRA_BUG_LABELS, and attaches ' +
      'the given evidence files. Description is Jira wiki markup. Check get_ticket\'s subtasks for an ' +
      'existing open bug with the same symptom first — comment on that one instead of duplicating it.',
    inputSchema: {
      parentKey: z.string().describe('The ticket that was tested.'),
      summary: z.string().max(250).describe('"<Area> — <what is wrong>"'),
      description: z.string().describe('Steps, actual, expected, environment, role, test case id — wiki markup.'),
      priority: z.string().optional().describe('Priority name, e.g. High, Medium.'),
      labels: z.array(z.string()).optional(),
      attachments: z.array(z.string()).optional().describe('Evidence file paths inside the repo.'),
    },
  },
  async ({ parentKey, summary, description, priority, labels, attachments }) => {
    try {
      assertProjectKey(parentKey);
      const mode = env('JIRA_BUG_PARENT_MODE', 'parent').toLowerCase();
      const allLabels = [
        ...new Set([
          ...env('JIRA_BUG_LABELS', 'qa-automation')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          ...(labels || []),
        ]),
      ].map((l) => l.replace(/\s+/g, '-'));
      const fields = {
        project: { key: projectKey() },
        issuetype: { name: env('JIRA_BUG_ISSUE_TYPE', 'Sub-task') },
        summary,
        description,
        assignee: { accountId: env('JIRA_BUG_ASSIGNEE_ACCOUNT_ID') },
        labels: allLabels,
      };
      if (mode === 'parent') fields.parent = { key: parentKey };
      if (priority) fields.priority = { name: priority };

      let created;
      const notes = [];
      try {
        created = await jira('POST', '/rest/api/2/issue', { fields });
      } catch (e) {
        if (e.status === 400 && e.fields.includes('priority')) {
          delete fields.priority;
          notes.push(`Priority "${priority}" was rejected by Jira; created without it.`);
          created = await jira('POST', '/rest/api/2/issue', { fields });
        } else throw e;
      }
      if (mode === 'link') {
        await jira('POST', '/rest/api/2/issueLink', {
          type: { name: env('JIRA_BUG_LINK_TYPE', 'Relates') },
          inwardIssue: { key: created.key },
          outwardIssue: { key: parentKey },
        });
      }
      const attached = await uploadAttachments(created.key, attachments);
      return ok({ key: created.key, url: browseUrl(created.key), parentKey, mode, attached, notes });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  'add_comment',
  {
    title: 'Comment on an issue',
    description:
      'Adds a comment (Jira wiki markup) to an issue in JIRA_PROJECT_KEY, optionally attaching evidence ' +
      'files. Use it to add re-test evidence to an existing open bug instead of filing a duplicate.',
    inputSchema: {
      key: z.string(),
      body: z.string(),
      attachments: z.array(z.string()).optional(),
    },
  },
  async ({ key, body, attachments }) => {
    try {
      assertProjectKey(key);
      const attached = await uploadAttachments(key, attachments);
      const c = await jira('POST', `/rest/api/2/issue/${key}/comment`, { body });
      return ok({ key, commentId: c.id, url: `${browseUrl(key)}?focusedCommentId=${c.id}`, attached });
    } catch (e) {
      return fail(e);
    }
  },
);

await server.connect(new StdioServerTransport());
