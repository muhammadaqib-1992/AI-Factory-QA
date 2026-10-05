---
name: qa-jira-pipeline
description: "Unattended QA run for one Jira ticket that is Ready for QA: reads everything on the ticket, writes test cases from its description to test-cases/, executes them headless in NetSuite with Playwright, files a Sub-task bug under the ticket for each failure (assigned to the configured bug assignee), and writes results.json with the execution number to reports/. Started by scripts/run-pipeline.mjs as `/qa-jira-pipeline <TICKET-KEY> <EXEC-ID>`; also use when the user says 'run the pipeline for <KEY>' or 'process <KEY> end to end'. Runs without a human: never asks questions, never waits for approval."
---

# QA Jira pipeline — one ticket, no human in the loop

Arguments: `<TICKET-KEY> <EXEC-ID>` (e.g. `NU-4040 EXEC-0007`). Nobody is watching this run.
Do not ask questions or wait for approval; when something is missing, record it in the results
and carry on with what can be done. Everything below writes inside the repo.

Paths for this run:

| What | Path |
|---|---|
| Test cases | `test-cases/<EXEC-ID>_<KEY>.md` |
| Run folder | `reports/<EXEC-ID>_<KEY>/` |
| Screenshots | `reports/<EXEC-ID>_<KEY>/screenshots/<TC id>_<NN>_<what>.png` |
| Results | `reports/<EXEC-ID>_<KEY>/results.json` |

Settings come from the environment (`.env`): `JIRA_SITE` (default `folio3.atlassian.net`),
`JIRA_BUG_ASSIGNEE_ACCOUNT_ID`, `JIRA_BUG_ISSUE_TYPE` (default `Sub-task`),
`NETSUITE_ACCOUNT_ID`. Read them with `node -e` through `lib/env.mjs` if needed — never print
secrets.

## 1. Read the ticket

Jira MCP `getJiraIssue` with `cloudId` = the site, `fields: ["*all"]`, `expand: "names"`,
`responseContentFormat: "markdown"`. Collect: summary, type, priority, labels, description,
acceptance criteria and any other populated custom field (by display name), comments, linked
issues, sub-tasks (existing bugs), attachments (names only — note them; you cannot open them).

## 2. Write the test cases

From the description, acceptance criteria and comments, write atomic cases to
`test-cases/<EXEC-ID>_<KEY>.md` in the format of
`.claude/skills/qa-test-writing/references/test-case-format.md`, with this header:

```markdown
# <KEY> — <summary>

- **Ticket:** [<KEY>](https://<site>/browse/<KEY>) · <type> · <priority>
- **Execution:** <EXEC-ID>
- **Written:** <date> by the QA pipeline from the ticket description
- **Environment:** NetSuite <NETSUITE_ACCOUNT_ID>
- **Cases:** TC_<KEY>_01 – TC_<KEY>_0N
```

Rules: one scenario per case; every expected result checkable; cases taken from the ticket text
are cited ("Description", "AC 2", "Comment by X"); anything you add beyond the text (negative,
edge) is marked **Inferred**. If the description is too thin to know what "pass" means, write the
narrowest case the text supports, mark the gap under `## Notes`, and continue.

## 3. Execute

Follow `.claude/skills/qa-test-execution/SKILL.md` steps 2–4 for every case (session check →
driver → steps with a screenshot each → record-state verification), using
`.claude/skills/qa-test-execution/references/netsuite-ui.md`. Differences for this run:

- Expired NetSuite session: do not ask anyone. Mark every case **Blocked** with
  "NetSuite session expired — login refresh failed", write results (step 5) and stop.
- Record every NetSuite record you create (type, internal id, link) on the case.

## 4. Bugs for failures

For each **Failed** case:

1. Skip if one of the ticket's open sub-tasks already describes the same failure — add a comment
   to that sub-task instead (`addCommentToJiraIssue`, text in `commentBody`) with this run's evidence, and record it with
   `"action": "commented"`.
2. Otherwise `createJiraIssue`: `cloudId` = site, `projectKey` = the ticket's project,
   `issueTypeName` = `JIRA_BUG_ISSUE_TYPE` (default `Sub-task`), `parent` = `<KEY>`,
   `assignee_account_id` = `JIRA_BUG_ASSIGNEE_ACCOUNT_ID`, summary
   `"[<EXEC-ID>] <Area> — <what is wrong>"`, and a description with: environment, role, test case
   id, numbered steps, expected (cite the ticket), actual (values), record links, and the
   screenshot file names.
3. If creation fails (missing setting, permission), record the bug as `"action": "not filed"`
   with the reason in `notes` — never stop the run for it.

Use the format in `.claude/skills/qa-bug-reporting/SKILL.md` for the description content; skip
its draft-and-confirm step, which is for interactive use.

## 5. Results

Write `reports/<EXEC-ID>_<KEY>/results.json` per
`.claude/skills/qa-test-execution/references/results-format.md`, plus:

- `"executionId": "<EXEC-ID>"`
- `"testCasesFile": "test-cases/<EXEC-ID>_<KEY>.md"`
- `"complete": true` only when every case has a final status.

Then build the PDF:

```bash
node scripts/build-report.mjs reports/<EXEC-ID>_<KEY>
```

## 6. Finish

End with a short plain-text summary (it goes to the run log): ticket, execution id, counts per
status, bugs with links, PDF path, anything blocked. Do not transition or edit the ticket itself.
