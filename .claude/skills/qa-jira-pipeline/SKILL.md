---
name: qa-jira-pipeline
description: "Unattended QA run for Jira tickets in Ready for QA. First iteration (`/qa-jira-pipeline <KEY> <EXEC-ID>`): reads the ticket, writes test cases from its description, executes them headless in NetSuite with Playwright, files a Sub-task bug under the ticket per failure, writes results + PDF with the execution number. Retest (`/qa-jira-pipeline retest <BUG-KEY> <EXEC-ID> <PARENT-KEY>`): re-runs the failed cases and the bug's steps, saves the report under the same ticket, comments the result on the bug and the ticket, and closes the bug if it passes or reopens it if it fails. Started by scripts/run-pipeline.mjs; also use when the user says 'run the pipeline for <KEY>' or 'retest <BUG-KEY>'. Runs without a human: never asks questions, never waits for approval."
---

# QA Jira pipeline — no human in the loop

Nobody is watching this run. Do not ask questions or wait for approval; when something is
missing, record it in the results and carry on with what can be done.

Two modes, chosen by the arguments:

| Mode | Arguments | Ticket under test | Folder key `<T>` |
|---|---|---|---|
| **First iteration** | `<KEY> <EXEC-ID>` | the ticket `<KEY>` | `<KEY>` |
| **Retest** | `retest <BUG-KEY> <EXEC-ID> <PARENT-KEY>` | the bug `<BUG-KEY>` | `<PARENT-KEY>` |

Paths (`<K>` = the ticket under test):

| What | Path |
|---|---|
| Test cases | `test-cases/<T>/<EXEC-ID>_<K>.md` |
| Run folder | `reports/<T>/<EXEC-ID>_<K>/` |
| Screenshots | `reports/<T>/<EXEC-ID>_<K>/screenshots/<TC id>_<NN>_<what>.png` |
| Results / PDF | `reports/<T>/<EXEC-ID>_<K>/results.json`, `report.pdf` |

Settings (`.env`, already in the environment): `JIRA_SITE` (default `folio3.atlassian.net`),
`JIRA_BUG_ASSIGNEE_ACCOUNT_ID`, `JIRA_BUG_ISSUE_TYPE` (default `Sub-task`), `JIRA_PICKUP_LABEL`
(default `AI_FActory`), `JIRA_BUG_LABEL` (default `ai-qa-bug`), `JIRA_CLOSE_STATUS` (default
`Done / Closed`), `JIRA_REOPEN_STATUS` (default `Reopen`), `NETSUITE_ACCOUNT_ID`. Read them with
`node -e "import('./lib/env.mjs').then(m=>console.log(m.env('NAME','default')))"`; never print
secrets.

---

## First iteration

### 1. Read the ticket

Jira MCP `getJiraIssue` with `cloudId` = the site, `fields: ["*all"]`, `expand: "names"`,
`responseContentFormat: "markdown"`. Collect: summary, type, priority, labels, description,
acceptance criteria and any other populated custom field (by display name), comments, linked
issues, sub-tasks (existing bugs), attachments (names only — note them; you cannot open them).

### 2. Write the test cases

From the description, acceptance criteria and comments, write atomic cases to
`test-cases/<T>/<EXEC-ID>_<K>.md` in the format of
`.claude/skills/qa-test-writing/references/test-case-format.md`, with this header:

```markdown
# <KEY> — <summary>

- **Ticket:** [<KEY>](https://<site>/browse/<KEY>) · <type> · <priority>
- **Execution:** <EXEC-ID>
- **Written:** <date> by the QA pipeline from the ticket description
- **Environment:** NetSuite <NETSUITE_ACCOUNT_ID>
- **Cases:** TC_<KEY>_01 – TC_<KEY>_0N
```

One scenario per case; every expected result checkable; cite the source ("Description", "AC 2",
"Comment by X"); anything added beyond the text (negative, edge) is marked **Inferred**. If the
description is too thin to know what "pass" means, write the narrowest case the text supports,
note the gap under `## Notes`, and continue.

### 3. Execute

Follow `.claude/skills/qa-test-execution/SKILL.md` steps 2–4 for every case (session check →
driver → steps with a screenshot each → record-state verification), using
`.claude/skills/qa-test-execution/references/netsuite-ui.md`. Unattended differences:

- Expired NetSuite session: mark every case **Blocked** ("NetSuite session expired — login
  refresh failed"), write results (step 5) and stop.
- Record every NetSuite record you create (type, internal id, link) on the case.

### 4. Bugs for failures

For each **Failed** case:

1. If an open sub-task of the ticket already describes the same failure, comment on it instead
   (`addCommentToJiraIssue`, text in `commentBody`) with this run's evidence; record
   `"action": "commented"`.
2. Otherwise `createJiraIssue`: `cloudId` = site, `projectKey` = the ticket's project,
   `issueTypeName` = `JIRA_BUG_ISSUE_TYPE`, `parent` = `<KEY>`, `assignee_account_id` =
   `JIRA_BUG_ASSIGNEE_ACCOUNT_ID`, `additional_fields` =
   `{"labels": ["<JIRA_PICKUP_LABEL>", "<JIRA_BUG_LABEL>"]}`, summary
   `"[<EXEC-ID>] <Area> — <what is wrong>"`, and a description with: environment, role, **test
   case id**, numbered steps, expected (cite the ticket), actual (values), record links,
   screenshot file names, and the line `Test cases: test-cases/<T>/<EXEC-ID>_<K>.md`.
   The labels are what lets the pipeline find the bug again for its retest.
3. If creation fails, record the bug as `"action": "not filed"` with the reason in `notes` —
   never stop the run for it.

### 5. Results, report, comment

1. Write `results.json` per `.claude/skills/qa-test-execution/references/results-format.md`, plus
   `"executionId"`, `"mode": "test"`, `"testCasesFile"`, and `"complete": true` only when every
   case has a final status.
2. `node scripts/build-report.mjs reports/<T>/<EXEC-ID>_<K>`
3. Comment on the ticket (`addCommentToJiraIssue`):
   `QA <EXEC-ID>: <n> passed, <n> failed, <n> blocked. Bugs: <keys>. Report: reports/<T>/<EXEC-ID>_<K>/report.pdf`

---

## Retest of a bug

### R1. Read the bug and its history

- `getJiraIssue` on `<BUG-KEY>` (all fields, comments): steps to reproduce, expected, actual,
  test case id, developer's fix comments.
- The parent's earlier run(s): `reports/<PARENT-KEY>/*/results.json` — find the case(s) whose
  `bugs` include `<BUG-KEY>`, and their test-case file.

### R2. Write the retest cases

`test-cases/<T>/<EXEC-ID>_<BUG-KEY>.md`, same header (Ticket = the bug, plus
`**Parent:** <PARENT-KEY>` and `**Retest of:** <original TC ids>`), containing:

1. the original failed case(s), copied unchanged (keep their TC ids);
2. a case for the bug's own reproduction steps, if they differ;
3. comment-driven cases if the developer described the fix's scope (mark **Inferred**).

### R3. Execute

Exactly as step 3 above.

### R4. Close or reopen the bug

- **All cases Passed** → close: `getTransitionsForJiraIssue` on the bug, pick the transition whose
  target status name equals `JIRA_CLOSE_STATUS`, then `transitionJiraIssue` with that id. If Jira
  rejects it for a missing resolution, retry with `fields: {"resolution": {"name": "Done"}}`.
- **Any case Failed** → reopen: same, with `JIRA_REOPEN_STATUS`. A *new* failure unrelated to
  this bug gets its own bug per step 4 (parent = `<PARENT-KEY>`).
- **Blocked / incomplete** → no transition; say why in the comment.
- If the target transition is not available, record that in `notes` and leave the status.

Record it in results.json: `"bugTransition": {"from": "<status>", "to": "<status or null>"}`.

### R5. Results, report, comments

1. results.json as in step 5, with `"mode": "retest"`, `"retestOf": "<BUG-KEY>"`,
   `"parentKey": "<PARENT-KEY>"`, and `"ticket"` = the bug (key, summary, url, `parentKey`).
2. `node scripts/build-report.mjs reports/<T>/<EXEC-ID>_<BUG-KEY>`
3. Comment on the **bug**: verdict (Passed → closed / Failed → reopened), per-case actuals,
   record links, report path.
4. Comment on the **parent ticket**: `QA <EXEC-ID> retest of <BUG-KEY>: <Passed — closed |
   Failed — reopened | Blocked>. Report: reports/<T>/<EXEC-ID>_<BUG-KEY>/report.pdf`

---

## Finish (both modes)

End with a short plain-text summary for the run log: ticket, mode, execution id, counts per
status, bugs filed / transitions made with links, PDF path, anything blocked. Never change the
parent ticket's status.
