#!/usr/bin/env node
// Builds a PDF execution report from one or more ticket report folders.
//
//   node scripts/build-report.mjs reports/2026-10-05_PROJ-652
//       → reports/2026-10-05_PROJ-652/report.pdf
//   node scripts/build-report.mjs --out reports/2026-10-05_run-summary.pdf <folder> <folder> …
//       → one combined PDF, a summary table first, then every ticket
//
// Each folder holds results.json (format: .claude/skills/qa-jira-pipeline/references/results-format.md).
// The test cases are rendered from the .md file that results.json points at.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { marked } from 'marked';
import { launchBrowser } from '../lib/browser.mjs';
import { REPO_ROOT, env } from '../lib/env.mjs';

const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const link = (url, text) => (url ? `<a href="${esc(url)}">${esc(text ?? url)}</a>` : esc(text));
const STATUS_ORDER = ['Failed', 'Blocked', 'Not Run', 'Passed'];

export function loadResults(folder) {
  const dir = resolve(REPO_ROOT, folder);
  const file = join(dir, 'results.json');
  if (!existsSync(file)) throw new Error(`${folder}: results.json not found`);
  const r = JSON.parse(readFileSync(file, 'utf8'));
  r._dir = dir;
  r.testCases ||= [];
  r.bugs ||= [];
  r.overall = overallResult(r);
  return r;
}

export function overallResult(r) {
  if (!r.complete) return 'Incomplete';
  const statuses = new Set((r.testCases || []).map((t) => t.status));
  if (!statuses.size) return 'Not Run';
  for (const s of STATUS_ORDER) if (statuses.has(s)) return s === 'Not Run' ? 'Incomplete' : s;
  return 'Passed';
}

function counts(r) {
  const c = { total: r.testCases.length, Passed: 0, Failed: 0, Blocked: 0, 'Not Run': 0 };
  for (const t of r.testCases) c[t.status] = (c[t.status] || 0) + 1;
  return c;
}

function badge(status) {
  const cls = { Passed: 'pass', Failed: 'fail', Blocked: 'block', Incomplete: 'block', 'Not Run': 'muted' }[status] || 'muted';
  return `<span class="badge ${cls}">${esc(status)}</span>`;
}

function imageTag(relPath) {
  const abs = resolve(REPO_ROOT, relPath);
  if (!existsSync(abs) || statSync(abs).size > MAX_IMAGE_BYTES) return `<p class="muted">Evidence: ${esc(relPath)}</p>`;
  const ext = extname(abs).slice(1).toLowerCase();
  if (!['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return `<p class="muted">Evidence: ${esc(relPath)}</p>`;
  const mime = ext === 'jpg' ? 'jpeg' : ext;
  return `<figure><img src="data:image/${mime};base64,${readFileSync(abs).toString('base64')}"><figcaption>${esc(relPath)}</figcaption></figure>`;
}

function ticketSection(r) {
  const c = counts(r);
  const t = r.ticket || {};
  const env_ = r.environment || {};
  const caseRows = r.testCases
    .map(
      (tc) => `<tr>
        <td class="nowrap">${esc(tc.id)}</td>
        <td>${esc(tc.title)}</td>
        <td>${badge(tc.status)}</td>
        <td>${esc(tc.actual)}</td>
        <td>${(tc.bugs || []).map((k) => link(r.bugs.find((b) => b.key === k)?.url || `${t.url?.replace(/\/browse\/.*/, '')}/browse/${k}`, k)).join('<br>')}</td>
      </tr>`,
    )
    .join('');
  const bugRows = r.bugs
    .map(
      (b) => `<tr><td class="nowrap">${link(b.url, b.key)}</td><td>${esc(b.summary)}</td><td>${esc(b.action || 'created')}</td><td>${esc((b.testCaseIds || []).join(', '))}</td><td>${esc(b.assignee || '')}</td></tr>`,
    )
    .join('');

  let testCasesHtml = '<p class="muted">Test case file not found.</p>';
  if (r.testCasesFile && existsSync(resolve(REPO_ROOT, r.testCasesFile))) {
    testCasesHtml = marked.parse(readFileSync(resolve(REPO_ROOT, r.testCasesFile), 'utf8'));
  }
  const evidence = r.testCases
    .filter((tc) => tc.status !== 'Passed' && (tc.evidence || []).length)
    .map((tc) => `<h4>${esc(tc.id)} — ${esc(tc.title)}</h4>${tc.evidence.map(imageTag).join('')}`)
    .join('');

  return `<section class="ticket">
    <h2>${link(t.url, t.key)} — ${esc(t.summary)} ${badge(r.overall)}</h2>
    <table class="meta">
      <tr><th>Execution</th><td><b>${esc(r.executionId || '—')}</b></td>
          <th>Driver</th><td>${esc(r.driver || 'Playwright (headless)')}</td></tr>
      <tr><th>Ticket</th><td>${link(t.url, t.key)} (${esc(t.type)}, ${esc(t.priority || 'no priority')})</td>
          <th>Parent</th><td>${t.parentKey ? link(t.parentUrl, t.parentKey) : '—'}</td></tr>
      <tr><th>Environment</th><td>${esc(env_.name)} ${env_.url ? `(${link(env_.url)})` : ''}</td>
          <th>Role</th><td>${esc(r.role || '—')}</td></tr>
      <tr><th>Ready for QA since</th><td>${esc(t.statusEnteredAt || '—')}</td>
          <th>Executed</th><td>${esc(r.startedAt || '')} → ${esc(r.finishedAt || '')}</td></tr>
      <tr><th>Test cases</th><td colspan="3"><code>${esc(r.testCasesFile || '—')}</code> ·
          ${c.total} total · ${c.Passed} passed · ${c.Failed} failed · ${c.Blocked} blocked · ${c['Not Run']} not run</td></tr>
    </table>
    ${r.summary ? `<p class="summary">${esc(r.summary)}</p>` : ''}
    ${!r.complete ? '<p class="warn">This run did not finish — results below are partial.</p>' : ''}
    <h3>Execution results</h3>
    <table class="grid"><thead><tr><th>ID</th><th>Test case</th><th>Status</th><th>Actual result</th><th>Bug</th></tr></thead><tbody>${caseRows || '<tr><td colspan="5">No test cases executed.</td></tr>'}</tbody></table>
    <h3>Bugs</h3>
    ${bugRows ? `<table class="grid"><thead><tr><th>Bug</th><th>Summary</th><th>Action</th><th>Test cases</th><th>Assignee</th></tr></thead><tbody>${bugRows}</tbody></table>` : '<p class="muted">No bugs raised.</p>'}
    ${(r.notes || []).length ? `<h3>Notes</h3><ul>${r.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    <h3>Test cases</h3>
    <div class="testcases">${testCasesHtml}</div>
    ${evidence ? `<h3>Evidence</h3>${evidence}` : ''}
  </section>`;
}

function summaryTable(results) {
  const rows = results
    .map((r) => {
      const c = counts(r);
      return `<tr><td class="nowrap">${esc(r.executionId || '')} ${link(r.ticket?.url, r.ticket?.key)}</td><td>${esc(r.ticket?.summary)}</td><td>${badge(r.overall)}</td>
        <td>${c.total}</td><td>${c.Passed}</td><td>${c.Failed}</td><td>${c.Blocked}</td>
        <td>${r.bugs.map((b) => link(b.url, b.key)).join(', ') || '—'}</td></tr>`;
    })
    .join('');
  return `<section><h2>Summary</h2><table class="grid"><thead><tr><th>Ticket</th><th>Summary</th><th>Result</th><th>Cases</th><th>Pass</th><th>Fail</th><th>Blocked</th><th>Bugs</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

function html(results, title) {
  const project = env('JIRA_PROJECT_KEY', '');
  const envName = results[0]?.environment?.name || env('NS_ACCOUNT_ID', '');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
    body { font: 10.5px/1.45 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1d2433; margin: 0; }
    header { border-bottom: 3px solid #1f4e9c; padding-bottom: 8px; margin-bottom: 14px; }
    header h1 { font-size: 20px; margin: 0 0 4px; color: #1f4e9c; }
    header p { margin: 0; color: #5b6475; }
    h2 { font-size: 14px; margin: 18px 0 8px; color: #13284f; }
    h3 { font-size: 12px; margin: 14px 0 6px; color: #13284f; border-bottom: 1px solid #dfe3ea; padding-bottom: 2px; }
    h4 { font-size: 11px; margin: 10px 0 4px; }
    a { color: #1f4e9c; text-decoration: none; }
    table { border-collapse: collapse; width: 100%; margin: 4px 0 8px; }
    th, td { border: 1px solid #d5dae3; padding: 4px 6px; vertical-align: top; text-align: left; }
    th { background: #f1f4f9; font-weight: 600; }
    table.meta th { width: 14%; }
    .grid thead th { background: #1f4e9c; color: #fff; }
    .nowrap { white-space: nowrap; }
    .badge { display: inline-block; padding: 1px 7px; border-radius: 9px; font-size: 9.5px; font-weight: 700; color: #fff; vertical-align: middle; }
    .pass { background: #1e7d3a; } .fail { background: #c0392b; } .block { background: #b9770e; } .muted { color: #6b7280; }
    span.muted { background: #8a94a6; color: #fff; }
    .warn { background: #fff4e0; border-left: 4px solid #b9770e; padding: 6px 8px; }
    .summary { background: #f6f8fb; border-left: 4px solid #1f4e9c; padding: 6px 8px; }
    .ticket { page-break-before: always; }
    .ticket:first-of-type { page-break-before: auto; }
    .testcases table { font-size: 9.5px; }
    .testcases h1 { font-size: 13px; } .testcases h2 { font-size: 12px; } .testcases h3 { font-size: 11px; border: 0; }
    figure { margin: 6px 0 12px; } figure img { max-width: 100%; border: 1px solid #d5dae3; } figcaption { color: #6b7280; font-size: 9px; }
    code { background: #f1f4f9; padding: 0 3px; border-radius: 3px; }
  </style></head><body>
    <header><h1>${esc(title)}</h1>
      <p>${esc(project)} · Environment: ${esc(envName)} · Generated ${esc(new Date().toISOString().replace('T', ' ').slice(0, 16))} UTC</p></header>
    ${results.length > 1 ? summaryTable(results) : ''}
    ${results.map(ticketSection).join('')}
  </body></html>`;
}

export async function buildPdf(folders, outPath, title) {
  const results = folders.map(loadResults);
  const out = outPath || join(results[0]._dir, 'report.pdf');
  const one = results[0];
  const docTitle = title || (results.length === 1 ? `QA Report — ${one.executionId ? `${one.executionId} · ` : ''}${one.ticket?.key}` : 'QA Run Summary');
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent(html(results, docTitle), { waitUntil: 'load' });
    await page.pdf({
      path: out,
      format: 'A4',
      landscape: true,
      printBackground: true,
      margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' },
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: `<div style="font-size:8px;color:#8a94a6;width:100%;text-align:center">${esc(docTitle)} · page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`,
    });
  } finally {
    await browser.close();
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('build-report.mjs')) {
  const args = process.argv.slice(2);
  let out;
  const i = args.indexOf('--out');
  if (i !== -1) {
    out = resolve(REPO_ROOT, args[i + 1]);
    args.splice(i, 2);
  }
  if (!args.length) {
    console.error('Usage: node scripts/build-report.mjs [--out file.pdf] <report-folder> [more folders]');
    process.exit(2);
  }
  buildPdf(args, out)
    .then((p) => console.log(`PDF written: ${p}`))
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
