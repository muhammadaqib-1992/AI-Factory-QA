#!/usr/bin/env node
// Post-run step. For every ticket report folder that has a results.json not yet finalized:
//   1. builds its PDF (reports/<date>_<KEY>/report.pdf)
//   2. records the QA cycle in state/processed-tickets.json, so the next run skips the ticket
//      until it re-enters "Ready for QA" (incomplete runs are NOT recorded — they retry)
//   3. optionally (JIRA_POST_REPORT_TO_TICKET=true) attaches the PDF to the ticket with a
//      one-line result comment
// When more than one ticket was finalized, also builds a run-summary PDF covering them all.
//
//   node scripts/finalize-run.mjs            finalize everything pending
//   node scripts/finalize-run.mjs --rebuild  rebuild PDFs for every folder, finalized or not
import { existsSync, mkdirSync, openAsBlob, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { REPO_ROOT, envBool } from '../lib/env.mjs';
import { jira } from '../lib/jira.mjs';
import { buildPdf, loadResults } from './build-report.mjs';

const REPORTS = join(REPO_ROOT, 'reports');
const STATE_FILE = join(REPO_ROOT, 'state', 'processed-tickets.json');
const rebuild = process.argv.includes('--rebuild');
const rel = (p) => relative(REPO_ROOT, p).replace(/\\/g, '/');

function pendingFolders() {
  if (!existsSync(REPORTS)) return [];
  return readdirSync(REPORTS)
    .filter((d) => /^\d{4}-\d{2}-\d{2}_[A-Z][A-Z0-9_]+-\d+$/.test(d))
    .map((d) => join(REPORTS, d))
    .filter((d) => existsSync(join(d, 'results.json')))
    .filter((d) => {
      if (rebuild) return true;
      const r = JSON.parse(readFileSync(join(d, 'results.json'), 'utf8'));
      return !r.finalizedAt || !existsSync(join(d, 'report.pdf'));
    })
    .sort();
}

async function postToTicket(r, pdfPath) {
  const key = r.ticket.key;
  const form = new FormData();
  form.append('file', await openAsBlob(pdfPath), `QA-report_${basename(r._dir)}.pdf`);
  await jira('POST', `/rest/api/3/issue/${key}/attachments`, form);
  const bugs = r.bugs.map((b) => `[${b.key}|${b.url}]`).join(', ') || 'none';
  const n = r.testCases.length;
  const passed = r.testCases.filter((t) => t.status === 'Passed').length;
  await jira('POST', `/rest/api/2/issue/${key}/comment`, {
    body: `*Automated QA run — ${r.overall}*\n${passed}/${n} test cases passed on ${r.environment?.name || 'the test environment'}. Bugs: ${bugs}.\nFull report attached: QA-report_${basename(r._dir)}.pdf`,
  });
}

async function main() {
  const folders = pendingFolders();
  if (!folders.length) {
    console.log('Nothing to finalize.');
    return;
  }
  mkdirSync(join(REPO_ROOT, 'state'), { recursive: true });
  const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
  const post = envBool('JIRA_POST_REPORT_TO_TICKET', false);
  const done = [];

  for (const dir of folders) {
    try {
      const pdf = await buildPdf([dir]);
      const r = loadResults(dir);
      console.log(`${r.ticket?.key}: ${r.overall} → ${rel(pdf)}`);

      if (r.complete && r.ticket?.key) {
        state[r.ticket.key] = {
          statusEnteredAt: r.ticket.statusEnteredAt || null,
          testedAt: r.finishedAt || new Date().toISOString(),
          result: r.overall,
          report: rel(pdf),
          bugs: r.bugs.map((b) => b.key),
        };
        if (post && !r.postedToJiraAt) {
          try {
            await postToTicket(r, pdf);
            r.postedToJiraAt = new Date().toISOString();
            console.log(`  posted report to ${r.ticket.key}`);
          } catch (e) {
            console.error(`  could not post report to ${r.ticket.key}: ${e.message}`);
          }
        }
      } else {
        console.log(`  run incomplete — not marked as tested; the next run will retry ${r.ticket?.key}`);
      }

      const raw = JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8'));
      raw.finalizedAt = new Date().toISOString();
      if (r.postedToJiraAt) raw.postedToJiraAt = r.postedToJiraAt;
      writeFileSync(join(dir, 'results.json'), JSON.stringify(raw, null, 2));
      done.push(dir);
    } catch (e) {
      console.error(`${rel(dir)}: ${e.message}`);
      process.exitCode = 1;
    }
  }
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  if (done.length > 1) {
    const stamp = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '');
    const out = join(REPORTS, `${stamp}_run-summary.pdf`);
    await buildPdf(done, out, 'QA Run Summary');
    console.log(`Run summary → ${rel(out)}`);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
