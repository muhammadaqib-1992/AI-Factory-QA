# Knowledge Base

Every project document the QA agent is allowed to reason from. Drop files into the right folder, then **write the index** — the index is what makes this affordable.

## The rule that makes this work

> **Never open a raw source document to answer a question an index could answer.**

A 200-page solution document or a 90-minute call transcript will happily consume most of a context window. Each folder therefore carries an index summarising what is inside; the agent reads the index, and opens a source file **only when the index points at a specific one**. `qa-context-lookup` enforces this order automatically.

If you add documents but skip the index, you have made the knowledge base *worse* — the agent now has more to wade through and no map.

## Routing map

Keep this table current. It is the first thing the agent consults.

| Topic / keyword | Folder | Index |
|---|---|---|
| Feature behaviour, acceptance criteria, functional spec | `solution-documents/` | `solution-documents/INDEX.md` |
| Implementation detail, config paths, field/script identifiers, data flow | `technical-design/` | `technical-design/INDEX.md` |
| Business requirements, scope, BRD | `requirements/` | `requirements/INDEX.md` |
| Contractual scope, deliverables, SOW | `contracts/` | `contracts/INDEX.md` |
| Decisions, rationale, "was this discussed", timeline, open items | `call-recordings/` | `call-recordings/INDEX.md` |
| Permission matrices, config exports, lookup tables, test data | `reference-data/` | `reference-data/INDEX.md` |

## Folders

| Folder | What goes in it |
|---|---|
| **`solution-documents/`** | Functional specification — how features are meant to behave, acceptance criteria, availability by user role. The baseline for "what does pass mean". |
| **`technical-design/`** | TDD / technical design — implementation spec for the same features: components and versions, configuration paths, field and script identifiers, prerequisites, data flow. Reach for this when a defect might be a configuration root cause rather than a functional gap. |
| **`requirements/`** | BRD and requirement sources upstream of the solution document. Useful for "was this ever in scope". |
| **`contracts/`** | SOW and contractual scope. Rarely needed for test execution — keep it here so scope questions have an answer. |
| **`call-recordings/`** | Meeting transcripts plus `INDEX.md`. **The index is mandatory here** — raw transcripts are the single most expensive thing in the repo to read. |
| **`reference-data/`** | Structured lookup data: permission matrices, configuration exports, test-data catalogues. If a file here is queried often, give the querying skill a script rather than parsing it by hand each run (see `ARCHITECTURE.md`). |

## Cross-document rule

Most application behaviour traces back to a decision recorded somewhere else. Before concluding a defect is UI-only, check whether an upstream document or a call decision explains it. Where two sources conflict — a call decision versus a written spec — **flag the conflict rather than silently choosing one**. Written documents are frequently not updated after a decision changes.

## Documents never go to GitHub

Only the **map** is committed: this README, each folder's `INDEX.md`, and `sync-config.json`. The documents themselves — solution documents, TDD, BRD, SOW, call recordings, client data — live **only on each person's machine**.

Client documents pushed to GitHub stay in history permanently, even after deletion. `.gitignore` keeps them out of a normal `git add` — never use `git add -f` on anything in this folder.

Every index row carries its document's Google Drive link, so a teammate who hasn't synced can still open the source.

## Automatic sync from Google Drive

Each folder here is linked to a Drive folder in `sync-config.json`. Every **Monday at 09:00**, a scheduled task on each teammate's machine runs the `qa-kb-sync` skill, which:

1. Lists each linked Drive folder and compares it with what this machine already has.
2. Downloads only **new or changed** files. Google Docs, Sheets and Slides are exported; video, audio and very large files get a link in the index instead of a download.
3. Updates that folder's `INDEX.md` for the changed files only, marking each row `auto-summary — needs review`.
4. Flags files removed from Drive — it never deletes a local copy.
5. Appends a line to `SYNC_LOG.md`.

The sync never commits anything. After a run, review the new index rows and commit the `INDEX.md` changes yourself.

**Set it up:** paste the Drive folder links into `sync-config.json`, then say *"set up the knowledge-base sync"* in Claude. To run it outside the schedule, say *"sync the knowledge base"*.
