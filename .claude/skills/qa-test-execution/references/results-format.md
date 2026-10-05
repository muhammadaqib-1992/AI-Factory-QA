# results.json — format

Reference for `qa-test-execution`. One file per run: `reports/<run id>/results.json`.
`scripts/build-report.mjs` turns it (plus the test-case .md file) into `report.pdf`, and
`scripts/finalize-run.mjs` uses it to record which tickets were tested.

```json
{
  "complete": true,
  "ticket": {
    "key": "NU-4040",
    "summary": "Test ai factory",
    "type": "Bug",
    "priority": "Medium",
    "url": "https://folio3.atlassian.net/browse/NU-4040",
    "parentKey": null,
    "parentUrl": null,
    "statusEnteredAt": null
  },
  "environment": { "name": "TSTDRV2142416", "url": "https://tstdrv2142416.app.netsuite.com" },
  "role": "Administrator",
  "driver": "Playwright MCP (headless)",
  "startedAt": "2026-10-05T18:10:00Z",
  "finishedAt": "2026-10-05T18:14:00Z",
  "testCasesFile": "test-cases/2026-10-05_NU-4040_customer-create.md",
  "summary": "One sentence: what ran and what decided the result.",
  "testCases": [
    {
      "id": "TC_NU-4040_01",
      "title": "Customer saves with name A1w",
      "status": "Passed",
      "actual": "Customer 1234 saved; name A1w shown on the record",
      "records": [{ "type": "customer", "id": "1234", "url": "https://…/app/common/entity/custjob.nl?id=1234" }],
      "evidence": ["reports/2026-10-05_NU-4040/screenshots/TC_NU-4040_01_03_saved.png"],
      "bugs": []
    }
  ],
  "bugs": [
    { "key": "NU-4041", "url": "https://folio3.atlassian.net/browse/NU-4041", "summary": "…", "action": "created", "testCaseIds": ["TC_NU-4040_02"], "assignee": "…" }
  ],
  "notes": ["Data substitutions, blocked reasons, anything a reader must know."]
}
```

Rules:

- `status` is one of `Passed`, `Failed`, `Blocked`, `Not Run`.
- `complete` is `true` only when every case has a final status; a partial run stays `false` (the
  PDF then says so, and the pipeline retries the ticket).
- `ticket` may be `{ "key": "<case-file code>", "summary": "…" }` with no `url` when the cases did
  not come from Jira.
- Evidence paths are relative to the repo root. Failure screenshots are embedded in the PDF.
- Never put credentials, session URLs or tokens in this file.
