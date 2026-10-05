---
name: qa-test-execution
description: "Executes test cases/scripts end-to-end in NetSuite, headless, without stopping to ask. Use IMMEDIATELY whenever the user says 'execute these scripts', 'execute the scripts', 'execute', 'run these test cases', 'run the scripts', 'execute TC_…', 'execute <file>.md', 'execute <JIRA-KEY>', 'test this ticket', 'run it on NetSuite' or 'verify this works'. Sources the cases from test-cases/*.md, from chat, or from a Jira ticket; checks the saved NetSuite session; drives the Playwright MCP headless (or a Playwright script on the saved session when the MCP cannot start); screenshots every step; verifies record state; writes results.json and builds the PDF report in reports/. Do NOT use for writing new cases (qa-test-writing) or filing a defect on its own (qa-bug-reporting)."
---

# QA Test Execution

"Execute these scripts" means: run every case end to end, now, and come back with results,
screenshots and a PDF. Don't ask for confirmation between cases or steps — the user already
asked. Stop only for something the user must do (an expired login, a missing value).

**Load `references/netsuite-ui.md` before driving a NetSuite form** — it holds the field
locators and quirks already learned. **Load `references/results-format.md` before writing
results.json.**

## Ground rules

1. **Never type a password.** The browser runs on the saved session in
   `.auth/netsuite-state.json`. If it has expired, tell the user to run
   `node scripts/netsuite-login.mjs` (it signs in headless from `.env`, 2FA included) and stop.
2. **Record state is the truth.** A "Transaction successfully Saved" banner is not a pass on its
   own: open the saved record and check the fields the case asserts.
3. **Evidence for every step.** One screenshot per step into the run's `screenshots/` folder,
   numbered in order. Failures always get one.
4. **Report what happened.** Skipped, blocked or substituted data is written down, not hidden.
5. **Record every record you create** (type, internal id, link) — the next run and the report
   need it.

## Step 1 — Find the cases

- A file named or implied (`execute these scripts` right after cases were written or opened) →
  that `test-cases/*.md` file. If several match and context doesn't say which, run the newest.
- Cases pasted in chat → write them to `test-cases/YYYY-MM-DD_<ID>_<slug>.md` first (format:
  `.claude/skills/qa-test-writing/references/test-case-format.md`), then run that file.
- A Jira key → read the ticket through the Jira MCP; if no case file exists for it yet, write the
  cases with `qa-test-writing` first, then run them.

Run id = `YYYY-MM-DD_<ID>` (ticket key, or the case-file short code). Everything for the run goes
in `reports/<run id>/`.

## Step 2 — Preflight (fast, every time)

```bash
node scripts/check-netsuite-session.mjs
```

- `Logged in …` → continue.
- `NOT logged in` → stop and ask the user to run `node scripts/netsuite-login.mjs`; resume when
  they say done.

## Step 3 — Pick the driver

1. **Playwright MCP** (`browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`,
   `browser_select_option`, `browser_take_screenshot`, …). It starts headless on the saved
   session. Try one `browser_navigate` to the NetSuite home page.
2. If that call errors (e.g. `spawn UNKNOWN` — the MCP was started before its browser setting
   changed), use the **script driver**: write `state/run-<run id>.mjs` with Playwright, launching
   through `lib/browser.mjs` (`launchBrowser()`) with
   `storageState: '.auth/netsuite-state.json'`, and run it with `node`. Same steps, same
   screenshots. Say in the report which driver ran, and tell the user `/mcp` → playwright →
   Reconnect restores the MCP.

## Step 4 — Execute each case

For each case, in order:

1. Note the start time. Establish the pre-condition (find test data in the UI or via the NetSuite
   MCP if it is signed in).
2. Do each step. After each: screenshot →
   `reports/<run id>/screenshots/<TC id>_<NN>_<what-it-shows>.png`
   (MCP: `browser_take_screenshot` with that `filename`; script: `page.screenshot`).
3. Compare with the expected result straight away. Write the actual result with values
   ("Order #2445 saved, status Pending Fulfillment, total 1,280.00"), not verdicts.
4. Accept NetSuite `confirm()` dialogs that the step itself triggers; capture any alert text —
   an unexpected alert is a finding.
5. Status per case: **Passed** (verified), **Failed** (contradicts expected), **Blocked** (could
   not run — say why), **Not Run**. A failed step blocks later steps that depend on it; continue
   with the independent ones.
6. Created records: capture internal id (`id=` in the URL) and number, link
   `…/app/accounting/transactions/transaction.nl?id=<id>`.

## Step 5 — Results and PDF

Write `reports/<run id>/results.json` (format in `references/results-format.md`, with
`"complete": true` only when every case has a final status), then:

```bash
node scripts/build-report.mjs reports/<run id>
```

That writes `reports/<run id>/report.pdf` with the summary, every case, Jira links, and the
failure screenshots.

## Step 6 — Failures → bugs

If any case **Failed** and the cases came from a Jira ticket, hand each failure to
`qa-bug-reporting` (it files under the parent ticket per its settings), then add the bug keys to
results.json and rebuild the PDF. Without a ticket, list the failures and offer to file them.

## Step 7 — Tell the user

Reply with: a table (case → status → actual, with created record links), the PDF path, the
screenshots folder, any bugs filed with links, and anything that blocked or needs their action.
Send the PDF with SendUserFile when that tool is available.
