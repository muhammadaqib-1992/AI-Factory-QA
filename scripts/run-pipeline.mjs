#!/usr/bin/env node
// The unattended QA pipeline. Run it on a schedule (cron / Task Scheduler) — nobody has to say
// anything:
//
//   1. picks the Jira tickets that are Ready for QA, assigned to the QA user and labelled
//      (scripts/pick-tickets.mjs), skipping QA cycles already tested
//   2. makes sure the NetSuite session is valid (refreshes the headless login from .env if not)
//   3. gives each ticket the next execution number (EXEC-0001, EXEC-0002, …) and moves it to
//      JIRA_IN_QA_STATUS ("In QA") with a "QA started" comment
//   4. runs Claude headless with the qa-jira-pipeline skill: ticket → test cases → execution →
//      bugs → results.json
//   5. builds reports/<TICKET>/<EXEC>_<KEY>/report.pdf and records the tested cycle
//   7. closes a ticket (JIRA_CLOSE_STATUS) once its QA is complete: every case passed, or every
//      bug it filed is closed (scripts/close-completed.mjs) — checked on every run
//   6. retests the bug sub-tasks it filed once developers move them back to Ready for QA
//      (only after the ticket's first run finished): same process, report saved under the same
//      ticket, result commented on the bug and the ticket, bug closed (pass) or reopened (fail)
//
//   node scripts/run-pipeline.mjs                              normal run
//   node scripts/run-pipeline.mjs --ticket NU-1                first iteration for one ticket now
//   node scripts/run-pipeline.mjs --retest NU-5 --parent NU-1  retest one bug now
//   node scripts/run-pipeline.mjs --dry-run                    show what would run, run nothing
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, env, loadEnv } from '../lib/env.mjs';
import { createStreamParser } from '../lib/claude-stream.mjs';
import { createReporter, stageTracker } from '../lib/factory-reporter.mjs';
import { JIRA_SITE, callJira, connectJira, transitionTo } from '../lib/jira-mcp-client.mjs';
import { buildPdf } from './build-report.mjs';
import { closeCompleted } from './close-completed.mjs';
import { STATE_FILE, pickTickets, readState } from './pick-tickets.mjs';

loadEnv(); // children (Claude, the MCP servers it starts) inherit .env through process.env

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const argOf = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
const onlyTicket = argOf('--ticket');
const onlyRetest = argOf('--retest');
const retestParent = argOf('--parent');
const STATE_DIR = join(REPO_ROOT, 'state');
const LOCK = join(STATE_DIR, 'pipeline.lock');
const COUNTER = join(STATE_DIR, 'execution-counter.json');
const LOGS = join(REPO_ROOT, 'logs');
const log = (m) => console.log(`[${new Date().toISOString().slice(0, 19).replace('T', ' ')}] ${m}`);

const ALLOWED_TOOLS = [
  'mcp__playwright',
  'mcp__netsuite',
  'mcp__jira__getJiraIssue',
  'mcp__jira__searchJiraIssuesUsingJql',
  'mcp__jira__getJiraProjectIssueTypesMetadata',
  'mcp__jira__getJiraIssueTypeMetaWithFields',
  'mcp__jira__createJiraIssue',
  'mcp__jira__addCommentToJiraIssue',
  'mcp__jira__getTransitionsForJiraIssue',
  'mcp__jira__transitionJiraIssue',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'Skill',
  'Bash(node:*)', // includes scripts/factory-step.mjs, the dashboard step marker
];

function takeLock() {
  mkdirSync(STATE_DIR, { recursive: true });
  if (existsSync(LOCK)) {
    const ageMin = (Date.now() - statSync(LOCK).mtimeMs) / 60000;
    if (ageMin < Number(env('QA_LOCK_STALE_MIN', '240'))) {
      log(`Another pipeline run holds ${LOCK} (${Math.round(ageMin)} min old) — exiting.`);
      process.exit(0);
    }
    log('Removing a stale lock.');
    rmSync(LOCK, { force: true });
  }
  const fd = openSync(LOCK, 'wx');
  writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  closeSync(fd);
  const release = () => rmSync(LOCK, { force: true });
  process.on('exit', release);
  process.on('SIGINT', () => process.exit(130));
  process.on('SIGTERM', () => process.exit(143));
}

function nextExecutionId() {
  let last = 0;
  try {
    last = JSON.parse(readFileSync(COUNTER, 'utf8')).last || 0;
  } catch {}
  const next = last + 1;
  writeFileSync(COUNTER, JSON.stringify({ last: next, updatedAt: new Date().toISOString() }, null, 2));
  return `EXEC-${String(next).padStart(4, '0')}`;
}

function runNode(script, label) {
  const r = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', script)], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 300000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  log(`${label}: ${out.split('\n').filter(Boolean).slice(-1)[0] || `exit ${r.status}`}`);
  return r.status === 0;
}

function ensureNetSuiteSession() {
  if (runNode('check-netsuite-session.mjs', 'NetSuite session')) return true;
  log('Refreshing the NetSuite login from .env…');
  return runNode('netsuite-login.mjs', 'NetSuite login') && runNode('check-netsuite-session.mjs', 'NetSuite session');
}

// Runs Claude headless with streamed JSON output, so token usage and step markers are seen as
// they happen and fed to the dashboard tracker. Resolves { ok, reason }; never rejects.
// opts.command / opts.prefixArgs let tests substitute a fake Claude.
export function runClaude(ticket, execId, logFile, tracker, opts = {}) {
  const claude = opts.command || env('CLAUDE_BIN', 'claude');
  const timeoutMin = Number(env('QA_TICKET_TIMEOUT_MIN', '45'));
  const prompt = ticket.mode === 'retest' ? `/qa-jira-pipeline retest ${ticket.key} ${execId} ${ticket.parentKey}` : `/qa-jira-pipeline ${ticket.key} ${execId}`;
  const cliArgs = ['-p', prompt, '--permission-mode', 'acceptEdits', '--allowedTools', ALLOWED_TOOLS.join(','), '--output-format', 'stream-json', '--verbose'];
  if (env('CLAUDE_MODEL', '')) cliArgs.push('--model', env('CLAUDE_MODEL'));
  log(`${execId} ${ticket.key}${ticket.mode === 'retest' ? ` (retest, parent ${ticket.parentKey})` : ''}: running Claude (timeout ${timeoutMin} min) → ${logFile.replace(REPO_ROOT, '.')}`);

  return new Promise((resolve) => {
    const raw = createWriteStream(logFile.replace(/\.log$/, '.jsonl'));
    const parser = createStreamParser();
    let resultText = '';
    let resultError = false;
    let stderr = '';
    let buf = '';
    let timedOut = false;
    let child;
    const onLine = (line) => {
      if (!line.trim()) return;
      raw.write(`${line}\n`);
      for (const ev of parser.push(line)) {
        if (ev.type === 'usage') tracker.addTokens(ev.tokens, ev.model);
        else if (ev.type === 'step') {
          if (ev.status === 'blocked') tracker.blocked(ev.message || 'waiting on a person');
          else if (ev.status === 'failed') tracker.end('failed', ev.message || 'step failed');
          else tracker.advance(ev.sub, ev.message); // running / succeeded / bare boundary marker
        } else if (ev.type === 'result') {
          resultText = ev.text;
          resultError = ev.isError;
        }
      }
    };
    try {
      // A shell is only needed to resolve claude.cmd on Windows; an explicit command runs directly.
      // Through cmd.exe, arguments with spaces or special characters must be quoted by hand.
      const useShell = process.platform === 'win32' && !opts.command;
      const quote = (x) => (/[\s"&|<>^(),]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x);
      const args = [...(opts.prefixArgs || []), ...cliArgs];
      child = spawn(useShell ? quote(claude) : claude, useShell ? args.map(quote) : args, { cwd: REPO_ROOT, env: process.env, shell: useShell });
    } catch (e) {
      raw.end();
      resolve({ ok: false, reason: `could not start Claude: ${e.message}` });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      log(`${execId} ${ticket.key}: timed out after ${timeoutMin} min — stopping Claude`);
      child.kill('SIGTERM');
    }, timeoutMin * 60000);
    child.on('error', (e) => (stderr += `\n${e.message}`));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        onLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (buf) onLine(buf);
      raw.end();
      writeFileSync(
        logFile,
        `$ ${claude} -p "${prompt}"\n\n${resultText}\n${stderr ? `\n--- stderr ---\n${stderr}` : ''}\nexit: ${code}${signal ? ` (${signal})` : ''}\n(full stream: ${logFile.replace(REPO_ROOT, '.').replace(/\.log$/, '.jsonl')})\n`,
      );
      if (code === 0 && !resultError) return resolve({ ok: true });
      resolve({ ok: false, reason: timedOut ? `timed out after ${timeoutMin} min` : `Claude exited ${code ?? signal}${resultError ? ' with an error result' : ''}` });
    });
  });
}

// Close the dashboard steps from the run's actual outcome (results.json is the truth).
export function finishSteps(tracker, results, runFailure) {
  if (runFailure) return tracker.end('failed', runFailure);
  const cases = results.testCases || [];
  if (!results.complete) {
    const blocked = cases.filter((c) => c.status === 'Blocked');
    const why = blocked[0]?.actual || (results.notes || [])[0] || 'run incomplete';
    if (/session|login|expired|2fa/i.test(why)) return tracker.blocked(`waiting for NetSuite login: ${why}`);
    return tracker.end('failed', `incomplete: ${why}`);
  }
  tracker.advance('verdict'); // closes plan/execute if the skill didn't mark them
  const n = (s) => cases.filter((c) => c.status === s).length;
  const counts = `${n('Passed')}/${cases.length} passed, ${n('Failed')} failed, ${n('Blocked')} blocked`;
  const bugs = (results.bugs || []).map((b) => b.key).filter(Boolean);
  if (n('Failed') || n('Blocked')) return tracker.end('failed', `${counts}${bugs.length ? ` — bugs ${bugs.join(', ')}` : ''}`);
  return tracker.end('succeeded', counts);
}

// Ticket (or bug) → "In QA" as its execution starts. Never blocks the run: a missing transition
// or a Jira hiccup is logged and testing goes ahead.
async function markInQa(ticket, execId) {
  const inQa = env('JIRA_IN_QA_STATUS', 'In QA');
  if (!inQa) return;
  const site = JIRA_SITE();
  let client;
  try {
    client = await connectJira({ quietAuth: true, connectTimeoutMs: Number(env('JIRA_CONNECT_TIMEOUT_SEC', '90')) * 1000 });
    const issue = await callJira(client, 'getJiraIssue', { cloudId: site, issueIdOrKey: ticket.key, fields: ['status'] });
    const current = (issue?.issues?.nodes?.[0] || issue)?.fields?.status?.name || '';
    if (current.trim().toLowerCase() !== inQa.trim().toLowerCase()) {
      const to = await transitionTo(client, site, ticket.key, inQa);
      log(`${execId} ${ticket.key}: status ${current || '?'} → ${to}`);
    }
    const what = ticket.mode === 'retest' ? `Retest of this bug (parent ${ticket.parentKey})` : 'QA execution';
    await callJira(client, 'addCommentToJiraIssue', {
      cloudId: site,
      issueIdOrKey: ticket.key,
      commentBody: `QA started — ${what}, execution ${execId}${ticket.retry ? ' (retry of an unfinished run)' : ''}. Results will follow in a comment when it finishes.`,
    });
  } catch (e) {
    log(`${execId} ${ticket.key}: could not move to "${inQa}" — ${e.message} (testing continues)`);
  } finally {
    await client?.close().catch(() => {});
  }
}

function ensureResults(dir, ticket, execId, reason) {
  const file = join(dir, 'results.json');
  if (existsSync(file)) {
    const r = JSON.parse(readFileSync(file, 'utf8'));
    if (!r.executionId) {
      r.executionId = execId;
      writeFileSync(file, JSON.stringify(r, null, 2));
    }
    return r;
  }
  const r = {
    executionId: execId,
    complete: false,
    ticket: { key: ticket.key, summary: ticket.summary, type: ticket.type, priority: ticket.priority, url: ticket.url, statusEnteredAt: ticket.cycle },
    environment: { name: env('NETSUITE_ACCOUNT_ID', ''), url: '' },
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    testCasesFile: `test-cases/${ticket.parentKey}/${execId}_${ticket.key}.md`,
    mode: ticket.mode,
    ...(ticket.mode === 'retest' ? { retestOf: ticket.key, parentKey: ticket.parentKey } : {}),
    summary: 'The run ended before results were written.',
    testCases: [],
    bugs: [],
    notes: [reason],
  };
  writeFileSync(file, JSON.stringify(r, null, 2));
  return r;
}

// Claude Code CLI must be installed and runnable before any ticket is touched — otherwise every
// ticket would burn an execution number on an empty, incomplete run.
function checkClaude() {
  const claude = env('CLAUDE_BIN', 'claude');
  const r = spawnSync(claude, ['--version'], { encoding: 'utf8', timeout: 60000, shell: process.platform === 'win32' });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  const first = out.split(/\r?\n/)[0];
  if (r.status === 0) return first;
  throw new Error(
    [
      `Claude Code CLI not available ("${claude} --version" failed: ${first || r.error?.message || 'not found'}).`,
      '  Install it:   npm install -g @anthropic-ai/claude-code',
      '  Sign in once: run  claude  in a terminal (or set ANTHROPIC_API_KEY in .env), then run the pipeline again.',
    ].join('\n'),
  );
}

async function main() {
  if (!dryRun) {
    log(`Claude Code: ${checkClaude()}`);
    takeLock();
  }
  let tickets;
  const site = JIRA_SITE();
  const manualCycle = `manual-${new Date().toISOString()}`;
  if (onlyTicket) {
    tickets = [{ mode: 'test', key: onlyTicket, parentKey: onlyTicket, url: `https://${site}/browse/${onlyTicket}`, cycle: manualCycle }];
  } else if (onlyRetest) {
    if (!retestParent) throw new Error('--retest needs --parent <TICKET-KEY>');
    tickets = [{ mode: 'retest', key: onlyRetest, parentKey: retestParent, url: `https://${site}/browse/${onlyRetest}`, cycle: manualCycle }];
  } else {
    const picked = await pickTickets();
    log(`Pickup: ${picked.found} ticket(s) and ${picked.bugsFound} bug(s) Ready for QA; ${picked.toTest} to run now.`);
    log(`  tickets JQL: ${picked.jql}`);
    if (picked.bugJql) log(`  bugs JQL:    ${picked.bugJql}`);
    if (picked.retryJql) log(`  retries JQL: ${picked.retryJql}`);
    tickets = picked.tickets;
  }
  const max = Number(env('QA_MAX_TICKETS_PER_RUN', '5'));
  tickets = tickets.slice(0, max);
  if (!tickets.length) {
    log('Nothing to test.');
    if (!dryRun) await closeCompleted({ log: (m) => log(`close check: ${m}`) });
    return;
  }
  if (dryRun) return log(`Dry run — would run: ${tickets.map((t) => (t.mode === 'retest' ? `${t.key} (retest under ${t.parentKey})` : t.key)).join(', ')}`);

  if (!ensureNetSuiteSession()) {
    log('NetSuite login failed — no ticket was run. Check .env and logs/netsuite-login-failed_*.png.');
    for (const t of tickets) {
      // Tell the dashboard the testing stage is waiting on a person, not failed.
      const r = createReporter({ taskId: t.key, taskName: t.summary, log: (m) => log(`dashboard: ${m}`) });
      const tr = stageTracker(r);
      tr.start('plan', 'picked up');
      tr.blocked('waiting for NetSuite login (session expired, automatic login failed)');
      await r.flush(15000);
    }
    process.exitCode = 1;
    return;
  }

  mkdirSync(LOGS, { recursive: true });
  for (const ticket of tickets) {
    const execId = nextExecutionId();
    const name = `${execId}_${ticket.key}`;
    const rel = `${ticket.parentKey}/${name}`; // every run of a ticket and its bugs sits under the ticket
    const dir = join(REPO_ROOT, 'reports', ticket.parentKey, name);
    mkdirSync(join(REPO_ROOT, 'test-cases', ticket.parentKey), { recursive: true });
    mkdirSync(join(dir, 'screenshots'), { recursive: true });
    let reason = '';
    // AI Factory dashboard: this agent owns the "testing" stage (plan → execute → verdict → report).
    const reporter = createReporter({ taskId: ticket.key, taskName: ticket.summary, log: (m) => log(`dashboard: ${m}`) });
    const tracker = stageTracker(reporter);
    tracker.start('plan', `${execId}${ticket.mode === 'retest' ? ` retest of ${ticket.key} (parent ${ticket.parentKey})` : ''}`);
    await markInQa(ticket, execId);
    try {
      const run = await runClaude(ticket, execId, join(LOGS, `${name}.log`), tracker);
      if (!run.ok) reason = `${run.reason} — see logs/${name}.log`;
    } catch (e) {
      reason = e.message;
    }
    if (reason) log(`${execId} ${ticket.key}: ${reason}`);
    const hadResults = existsSync(join(dir, 'results.json'));
    const results = ensureResults(dir, ticket, execId, reason || `See logs/${name}.log`);
    // A crash before any results is a failed step; otherwise the results decide.
    finishSteps(tracker, results, reason && !hadResults ? reason : '');
    try {
      if (results.complete) tracker.start('report', `building reports/${rel}/report.pdf`);
      await buildPdf([dir]);
      log(`${execId} ${ticket.key}: report → reports/${rel}/report.pdf`);
      if (results.complete) tracker.end('succeeded', `reports/${rel}/report.pdf`);
    } catch (e) {
      log(`${execId} ${ticket.key}: PDF failed — ${e.message}`);
      if (results.complete) tracker.end('failed', `PDF failed: ${e.message}`);
    }
    await reporter.flush(30000);

    // Record the tested cycle. Incomplete runs retry next time, up to QA_MAX_ATTEMPTS.
    const state = readState();
    const prev = state[ticket.key];
    const attempts = prev && prev.cycle === ticket.cycle && !prev.complete ? (prev.attempts || 1) + 1 : 1;
    const giveUp = !results.complete && attempts >= Number(env('QA_MAX_ATTEMPTS', '2'));
    state[ticket.key] = {
      mode: ticket.mode,
      parentKey: ticket.parentKey,
      cycle: results.complete || giveUp ? ticket.cycle : `retry:${ticket.cycle}`,
      complete: Boolean(results.complete),
      attempts,
      executionId: execId,
      report: `reports/${rel}/report.pdf`,
      firstReport: ticket.mode === 'retest' ? prev?.firstReport : `reports/${rel}/report.pdf`,
      testedAt: new Date().toISOString(),
      // first iteration: bugs filed; retest: keep the parent's list untouched
      bugs: ticket.mode === 'retest' ? prev?.bugs || [] : (results.bugs || []).map((b) => b.key).filter(Boolean),
      ...(ticket.mode === 'retest' ? { outcome: results.bugTransition?.to || null } : {}),
    };
    if (ticket.mode === 'retest' && state[ticket.parentKey]) {
      // New bugs found while retesting join the parent's watch list.
      const extra = (results.bugs || []).map((b) => b.key).filter((k) => k && k !== ticket.key);
      state[ticket.parentKey].bugs = [...new Set([...(state[ticket.parentKey].bugs || []), ...extra])];
      state[ticket.parentKey].retests = [...(state[ticket.parentKey].retests || []), { bug: ticket.key, executionId: execId, outcome: results.bugTransition?.to || null, at: new Date().toISOString() }];
    }
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    const counts = (results.testCases || []).reduce((a, t) => ((a[t.status] = (a[t.status] || 0) + 1), a), {});
    log(`${execId} ${ticket.key}: ${results.complete ? 'complete' : giveUp ? 'incomplete — giving up for this cycle' : 'incomplete — will retry'} ${JSON.stringify(counts)}`);
  }

  // Close tickets whose QA is now complete (all passed, or all their bugs closed).
  await closeCompleted({ log: (m) => log(`close check: ${m}`) });
}

if (process.argv[1]?.endsWith('run-pipeline.mjs')) {
  main().catch((e) => {
    log(`Pipeline error: ${e.message}`);
    process.exit(1);
  });
}
