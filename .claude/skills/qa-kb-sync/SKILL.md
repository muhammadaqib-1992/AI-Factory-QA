---
name: qa-kb-sync
description: "Keeps the knowledge base in sync with the project's Google Drive folders. Each knowledge-base folder is linked to a Drive folder in knowledge-base/sync-config.json; this skill downloads new and changed files into the local folder, summarises only what changed into that folder's INDEX.md (marked for review), and logs the run. Runs automatically every Monday through a scheduled task on each teammate's own machine, and on demand. Use when the user says 'sync the knowledge base', 'pull the latest documents', 'update the knowledge base from Drive', 'set up the knowledge-base sync', 'schedule the Drive sync', or asks whether the documents are up to date. Never commits, pushes or deletes anything: documents stay local and are blocked from git, and INDEX.md changes are left for the user to review and commit."
---

# QA Knowledge-Base Sync

Pulls new and changed documents from the project's Google Drive folders into `knowledge-base/`, and keeps each folder's `INDEX.md` current, so the agent's map of the project never goes stale.

Drive access is through the **Google Drive connector**; everything deterministic — config, change detection, decoding, the manifest, the log — is in **`scripts/kb_sync.py`**. **Run that script; never read it.**

## Ground rules

1. **Documents never go to git.** This skill runs no git command at all. Documents are git-ignored (`.gitignore`). The only git-visible change a sync makes is to `INDEX.md` files, and the **user** reviews and commits those.
2. **Never delete a local file.** A file that disappears from Drive is flagged in the index and the manifest, never deleted. Someone may still be testing against it.
3. **Only read what changed.** Unchanged files are never downloaded or summarised. That is what keeps a run cheap however large the knowledge base grows.
4. **Never overwrite a person's index work.** Add rows for new files; touch only the rows of files that changed. Mark every row you write `auto-summary — needs review`, and leave hand-written rows and the "Known gaps" section alone.
5. **A wrong summary is worse than none**, because the agent trusts the index. If you cannot tell what a document covers, say so in the row rather than guessing.

---

## Setup — once per machine

Do this when the user says "set up the knowledge-base sync".

**1. Check the config.**

```bash
python .claude/skills/qa-kb-sync/scripts/kb_sync.py check
```

If no folder has a link, stop and ask for them. They go in `knowledge-base/sync-config.json` — one Drive **folder** link per knowledge-base folder. A folder left as `<PASTE…>` is skipped, which is fine.

**2. Confirm Google Drive is connected** with a small `search_files` call. If it fails, the user connects Google Drive under **Settings → Connectors**, then retry.

**3. Run a first sync** (below) so any problem surfaces now rather than silently on a Monday.

**4. Register the schedule** with `create_scheduled_task`:

- `taskId`: `qa-kb-sync`
- `cronExpression`: `0 9 * * 1` — every Monday 09:00 **local** time
- `title`: `Knowledge-base sync (Mondays)`
- `description`: `Pull new/changed Google Drive documents into the QA knowledge base and update the indexes`
- `prompt`: must be self-contained, because each run starts with no memory of this conversation. Use this, replacing `<WORKSPACE>` with the **absolute path** of this workspace on this machine:

  > Sync the QA knowledge base for the workspace at `<WORKSPACE>`. Read `<WORKSPACE>/.claude/skills/qa-kb-sync/SKILL.md` and follow its **Run** section exactly, running every command from `<WORKSPACE>`. Use the Google Drive connector. Run no git command. Finish with the run summary the skill describes.

Then tell the user: the task runs while the Claude app is open — if it is closed on Monday morning, it runs at the next launch. Each teammate does this same setup on their own machine.

---

## Run

**1. Check.**

```bash
python .claude/skills/qa-kb-sync/scripts/kb_sync.py check
```

Skip any folder that isn't configured.

**2. For each configured folder:**

**a. List the Drive folder.** `search_files` with `query: "parentId = '<folder id>'"`, `excludeContentSnippets: true`, `pageSize: 100`. Follow `nextPageToken` until you have every page. Write the combined result to `knowledge-base/<folder>/.sync-listing.json` — either the raw `{"files": [...]}` object or a single merged array; the script accepts both.

**b. Plan.**

```bash
python .claude/skills/qa-kb-sync/scripts/kb_sync.py plan <folder>
```

It compares the listing against this machine's manifest and prints `download`, `link` (too large, or video/audio), `removed`, `subfolders`, and an `unchanged` count. Nothing in `download` or `removed` means move on.

**c. Download each entry in `download`.** Call `download_file_content` with its `id`, plus `exportMimeType` when the plan gives one (Google Docs, Sheets and Slides must be exported). Then:

```bash
python .claude/skills/qa-kb-sync/scripts/kb_sync.py save <folder> <fileId> <result.json>
```

`<result.json>` is a file holding the tool result. When the harness saves a large result to disk, pass that path straight in. When it comes back inline, write it to `knowledge-base/<folder>/.sync-download.json` first. `save` decodes it, writes the file under the name the plan chose, and updates the manifest.

**d. Record the rest.** For each `link` entry: `kb_sync.py record <folder> <fileId> --status linked --note "<why>"`. For each `removed` entry: `kb_sync.py record <folder> <fileId> --status removed`. If a download fails, use `--status failed` so it is retried next run.

**e. Update the index — changed files only.** For each downloaded file, read enough to summarise it. `read_file_content` on the Drive file is usually cheapest; for a very large document read the opening sections and headings rather than the whole thing. Then edit `knowledge-base/<folder>/INDEX.md`:

- **New file** → add a row: name, what it covers, and notes carrying the Drive link, the Drive modified date, and `auto-summary — needs review`.
- **Changed file** → update that file's row, note `updated YYYY-MM-DD — auto-summary, needs review`, and say what changed if you can tell.
- **Linked-only file** → add a row with the Drive link and the reason it wasn't downloaded (e.g. "video", "58 MB — above the limit").
- **Removed file** → keep the row, append `removed from Drive YYYY-MM-DD`.
- **`call-recordings/`** keeps its own shape — date, topics, decisions, open items, participants. Take these from the transcript; never invent a decision that isn't in it.

  A backlog of unread transcripts is the normal starting state, and reading them all is not affordable — an hour of speech is a very large file. Build the index as a **routing table** first:

```bash
python .claude/skills/qa-kb-sync/scripts/profile_transcripts.py knowledge-base/call-recordings
```

  That prints date, length, main speakers and dominant domain terms per call. Turn it into the index table, and label the topic column plainly as a term-frequency profile that nobody has read — it says what a call spent time on, never what was decided. Once a call has actually been read, replace its row's topics with a real summary and move any decision into the index's decisions table. Never let a frequency profile be cited as a decision.

Always include the Drive link in the row. A teammate who hasn't synced can then still open the source.

**3. Log the run.**

```bash
python .claude/skills/qa-kb-sync/scripts/kb_sync.py log --added N --updated N --linked N --removed N --notes "<anything worth knowing>"
```

**4. Report.** One short summary per folder — added / updated / linked / removed / unchanged — plus which `INDEX.md` files changed and need reviewing before they are committed. List anything that failed rather than passing over it: a folder the connector couldn't read, a file that wouldn't download.

---

## When things go wrong

| Problem | What to do |
|---|---|
| `search_files` returns nothing for a folder you know has files | Drive isn't connected, or this account can't see that folder. Report it — do **not** treat it as "no changes", which would look like a clean run |
| A download fails | `record --status failed`, report it, move on. It retries next run |
| The plan shows many `removed` at once | The Drive folder was probably moved or re-shared. Report it and change nothing in the index until the user confirms |
| A Google Doc exports empty | Retry with `exportMimeType: "text/plain"` and note it in the index row |
| `plan` says a file is unchanged but you know it changed | Drive `modifiedTime` didn't move (common for metadata-only edits). Force it with `record --status failed`, then re-run |
