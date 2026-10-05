# QA Agentic Workspace

A reusable Claude Code workspace for software QA. Clone it, point it at your project's documents, fill in a few placeholders, and your team shares one agent that researches, writes test cases, executes them, tests permissions, and drafts defects — all in your formats.

Nothing here is tied to a particular product, tracker, or industry. It is a **starting skeleton**, not a finished configuration.

**Read [`ARCHITECTURE.md`](ARCHITECTURE.md) once before extending it.** It explains why each piece lives where it does — mostly so you don't put knowledge in the wrong primitive and wonder why it never loads.

---

## Quick start — step by step

Follow these in order. Each step ends with a **✅ Check** so you know it worked before moving on. Allow about 20 minutes, plus however long it takes to load your project documents.

Commands are shown for **Git Bash / macOS / Linux**. Where Windows PowerShell differs, the PowerShell version is given too.

### Step 0 — Check you have the tools

```bash
node -v
```
```bash
python --version
```
```bash
git --version
```
```bash
claude --version
```

✅ **Check:** Node 18+, Python 3.9+, and a version number for both git and Claude Code. Claude Code missing? Install the desktop app, or run `npm install -g @anthropic-ai/claude-code`. On Windows, Claude Code also needs **Git for Windows** — it provides the `bash` the hooks run in.

### Step 1 — Clone the workspace

```bash
git clone https://github.com/muhammadaqib-1992/QA_Agentic_Workspace.git
```
```bash
cd QA_Agentic_Workspace
```

✅ **Check:** the folder contains `CLAUDE.md`, `README.md`, `ARCHITECTURE.md`, `.claude/` and `knowledge-base/`.

### Step 2 — Open it in Claude Code

- **Desktop app:** Code tab → **Open project** → pick the `QA_Agentic_Workspace` folder.
- **CLI:** run `claude` from inside the folder.

`CLAUDE.md` and the skills load automatically — there is nothing to activate.

✅ **Check:** type `/skills` (CLI) or open the skills menu (desktop). You should see the seven `qa-*` skills: `qa-context-lookup`, `qa-user-stories`, `qa-test-writing`, `qa-test-execution`, `qa-permission-testing`, `qa-bug-reporting`, `qa-kb-sync`.

### Step 3 — Create your personal environment file

This holds your URLs and test logins. It is git-ignored and never leaves your machine.

```bash
cp .claude/qa-test-env.example.md .claude/qa-test-env.md
```

PowerShell:
```powershell
Copy-Item .claude/qa-test-env.example.md .claude/qa-test-env.md
```

Open `.claude/qa-test-env.md` and fill in what you have: environment URLs, tracker project key, and a login **per role** you test. Leave anything you don't have as `<PLACEHOLDER>` — the agent will simply ask you for it when a run needs it.

✅ **Check:** run `git status` — `qa-test-env.md` must **not** appear. If it does, stop and don't commit; the `.gitignore` has been changed.

### Step 4 — Turn on the safety hooks

The Claude-side hooks are already on: `.claude/settings.json` is committed, so a clone has them from the first session. (Personal tweaks go in `.claude/settings.local.json`, which stays out of git — don't edit the shared file for machine-specific things.)

The git-level guard is the one thing that cannot ship switched on: git never runs hooks that arrive with a clone, by design. Once per clone:

```bash
git config core.hooksPath .githooks
```

That gives you three guards:
- **`PreToolUse`** (Claude) — refuses any `git` command that would commit your credentials file, a `.env`, a `.har` capture, or a project document.
- **`.githooks/pre-commit`** (git) — rejects any commit containing a project document from `knowledge-base/`, including one you make yourself in a terminal.
- **`SessionStart`** — at the start of every session (and after compaction) it reports what is configured and what is missing.

Close and reopen your Claude Code session so the hooks load.

✅ **Check:** the new session opens with a **"QA workspace session"** message listing your setup status. Then prove the guard works — ask Claude to *"run git add .claude/qa-test-env.md"*. It must be **blocked**.

### Step 5 — Connect your MCP servers

The skills need three connections. Each teammate connects their own, with their own logins.

**Browser automation (Playwright)** — required for test execution and permission testing. It runs locally, so it can only be added from the CLI:

```bash
claude mcp add playwright -- npx -y @playwright/mcp@latest
```

**Issue tracker** (e.g. Jira) — for reading tickets and filing defects. Add it with `claude mcp add --transport http <name> <endpoint>`, or through **Settings → Connectors** in the desktop app, then authenticate with `/mcp` inside a session.

**Backend / system of record** — for verifying what the UI shows against the real data. Get the endpoint from your project lead; if it's internal, add it locally and don't commit it.

```bash
claude mcp list
```

✅ **Check:** each server shows `✔ Connected` (or `! Needs authentication` → run `/mcp`, select it, **Authenticate**). The first Playwright add downloads ~150 MB, so give it a minute. Servers added through the desktop Connectors UI don't appear in `claude mcp list` — check those under **Settings → Connectors**.

### Step 6 — Fill in your project in `CLAUDE.md`

Open `CLAUDE.md` and replace every `<PLACEHOLDER>` in **Key project context**: application and environments, test environment of record, tracker key, work streams in scope, user roles, integrations, and any open decisions.

Keep it short. `CLAUDE.md` loads into **every** conversation — anything only sometimes relevant belongs in `knowledge-base/` instead.

✅ **Check:** ask *"What project are we testing and which roles are in scope?"* — the answer should come straight from what you just wrote.

### Step 7 — Load the knowledge base, and write the indexes

This is the step that decides whether the workspace is useful or generic.

1. Get the documents into each folder under `knowledge-base/` — solution documents, TDD, BRD/requirements, SOW, call transcripts, permission matrices. The easy way is the automatic Google Drive sync (Step 7b); you can also drop files in by hand. **Either way they stay on your machine** — git never commits them.
2. **Fill in that folder's `INDEX.md`**: one row per document saying what it covers, plus any known gaps.
3. For calls, add one entry per call to `knowledge-base/call-recordings/INDEX.md` with **date, topics, decisions, open items and participants**.

> Adding documents **without** writing the index makes things worse — more for the agent to wade through, and no map. The agent reads the index first and opens a document only when the index points at it. That is what keeps sessions fast and cheap.

✅ **Check:** ask a question you know the answer to, e.g. *"What did we decide about <topic> and when?"* The answer should **cite the document or call date**. No citation, or an answer from general knowledge, means an index is missing an entry.

### Step 7b — Keep the knowledge base in sync with Google Drive (every Monday)

Rather than copying documents in by hand, link each knowledge-base folder to its Google Drive folder. Every Monday morning a scheduled task on **your** machine pulls anything new or changed and updates that folder's `INDEX.md`.

1. **Connect Google Drive** to Claude — desktop app: **Settings → Connectors → Google Drive**.
2. **Paste the Drive folder links** into `knowledge-base/sync-config.json`, one per folder. Leave a folder as `<PASTE…>` to skip it. The links are the same for the whole project team, so this file is committed once and teammates get them on clone.
3. **In a Claude session in this folder, say:** *"Set up the knowledge-base sync"*. The `qa-kb-sync` skill checks the config and the guards, runs a first sync, then registers a **Monday 09:00** task on your machine.

✅ **Check:** `knowledge-base/SYNC_LOG.md` shows the first run; new index rows are marked *auto-summary — needs review*; and `git status` shows **only** `INDEX.md` changes — never the documents themselves.

Worth knowing:
- The task runs while the Claude app is open. If it's closed on Monday morning, it runs at the next launch.
- The sync never commits or pushes. Review the new index rows, then commit the `INDEX.md` changes yourself.
- To sync outside the schedule, just say *"sync the knowledge base"*.
- Video and audio are linked in the index rather than downloaded, and so is anything above **10 MB** — that is the Google Drive connector's own hard limit, not a setting, so raising `max_download_mb` will not help. The index row carries the Drive URL instead.
- Zoom writes each call twice. `*.cc.vtt` is excluded in `sync-config.json`: no speaker names, coarser timestamps than the `*.transcript.vtt` copy of the same call.
- For a backlog of transcripts, ask for the call index to be built — `scripts/profile_transcripts.py` reports each call's date, speakers and dominant topics without reading hours of speech into the conversation. That output is a routing table, never a summary of what was decided.

### Step 8 — Match the formats to your team (optional but worth it)

The skills ship with sensible defaults. Adapt these to match what your team already uses:

| File | Change it to match |
|---|---|
| `.claude/skills/qa-user-stories/references/user-story-format.md` | Your story template, and the default Jira assignee |
| `.claude/skills/qa-test-writing/references/test-case-format.md` | Your test-case sheet's columns |
| `.claude/skills/qa-bug-reporting/references/priority-and-labels.md` | Your tracker's priorities and labels |
| `knowledge-base/reference-data/permissions-matrix.csv` | Add your roles × features matrix here — see the skill's `references/matrix-guide.md` for the expected shape |

✅ **Check:** once your matrix is in place, the permission lookup can read it:

```bash
python .claude/skills/qa-permission-testing/scripts/lookup_permission.py --list-roles
```

### Step 9 — Validate before you commit anything

```bash
python scripts/validate_skills.py
```

✅ **Check:** `0 error(s)`. It checks every skill against the limits Claude Code enforces — most importantly a description of at most **1,024 characters**, because that is the text Claude matches your request against.

### Step 10 — Run your first end-to-end flow

Ask in plain language — the right skill loads on its own. A good first run, on one feature you were going to test anyway:

| # | You say | What happens |
|---|---|---|
| 1 | *"How is <feature> supposed to work?"* | **qa-context-lookup** answers from the knowledge base and cites its source |
| 2 | *"Create user stories for <feature>"* | **qa-user-stories** drafts them from the solution document, in chat, and **waits** before writing files or raising Jira tickets |
| 3 | *"Write test cases for <feature>"* | **qa-test-writing** drafts them in your format, in chat, marking anything inferred |
| 4 | *"Execute TC_XXX_001 on staging"* | **qa-test-execution** drives the browser, checks the backend, returns pass/fail with real values |
| 5 | *"Can <role> see <data>?"* | **qa-permission-testing** checks matrix → live config → actual behaviour |
| 6 | *"Draft a bug for this"* | **qa-bug-reporting** writes it in your format and **waits** |
| 7 | *"Create it"* | Only now is the defect filed in your tracker |

✅ **Check:** nothing reached your tracker until step 7. That is by design — **drafts always come before writes**.

### Where your work gets saved

You don't have to file anything by hand — the skills write into four folders, all tracked in git so the team shares one record. Each folder's `README.md` has the full convention.

| Folder | What lands there | Named |
|---|---|---|
| `user-stories/` | User stories, once you approve the draft | `2026-10-05_US_PDP_001_live-stock-on-product-page.md` |
| `test-cases/` | Test cases, once you approve the draft | `2026-09-12_PDP_inventory-block.md` |
| `reports/` | One execution or permission-test report per run | `2026-09-12_TC_PDP_002_sandbox.md` |
| `bug-evidence/` | One folder per defect: screenshots, logs, the draft | `DRAFT_2026-09-12_price-not-refreshed/` → renamed to the ticket id once filed |

Two rules worth knowing: a re-run never overwrites an earlier report, because a fail-then-pass history is itself evidence; and nothing here is deleted when a document changes upstream.

✅ **Check:** after your first run, `git status` shows new files in `reports/` (and `bug-evidence/` if something failed). Commit them like any other change.

### Every day after that

- **Start a session** in the folder → read the SessionStart message for anything unconfigured.
- **Ask before you dig** — questions go through the index, not through 200-page documents.
- **Review every draft** before saying "create it". The agent reports gaps rather than guessing, but you are still the reviewer.
- **After each client call**, add its entry to `call-recordings/INDEX.md` the same day — an index that lags reality gets trusted anyway.

### If something doesn't work

| Symptom | Fix |
|---|---|
| Skills don't appear in `/skills` | You opened the wrong folder — open `QA_Agentic_Workspace` itself, not its parent |
| No "QA workspace session" message | `.claude/settings.json` missing (Step 4), or the session wasn't restarted |
| Hook fails with `$'\r': command not found` | The `.sh` files got Windows line endings. Re-clone — `.gitattributes` keeps them LF — or run `git add --renormalize .` |
| Playwright shows as failed | Still downloading — wait a minute and re-run `claude mcp list` |
| Answers don't cite a source | The relevant `INDEX.md` has no entry for that topic (Step 7) |
| The agent asks for a URL or login every run | It's still `<PLACEHOLDER>` in `.claude/qa-test-env.md` (Step 3) |
| A skill never triggers | Run `python scripts/validate_skills.py`, and check you don't have a personal skill with the same name — personal skills override project ones |

The sections below are the reference detail behind these steps.

---

## What you get

| | |
|---|---|
| **7 skills** | Research, user stories, test-case writing, test execution, permission testing, defect reporting, knowledge-base sync |
| **Weekly Drive sync** | `qa-kb-sync` pulls new/changed Google Drive documents every Monday and updates the indexes — documents stay local, never in git |
| **Knowledge base** | Indexed folders for solution docs, technical design, requirements, contracts, call recordings, reference data |
| **Guardrails** | Claude hook + git pre-commit hook: credentials, HAR captures and project documents can't be committed. SessionStart hook reports setup status |
| **1 custom subagent** | Correctly wired for delegated research (subagents don't inherit skills — this shows how) |
| **Work folders** | `user-stories/`, `test-cases/`, `reports/`, `bug-evidence/` — date-stamped records the skills write to as you work |
| **Validator** | `scripts/validate_skills.py` checks every skill against the spec limits |

### Built to stay cheap

Everything the agent could load competes with your conversation for the same context window. The design pushes back in four ways:

- **Skills load on demand** — only a one-line description of each sits in context; full instructions load when that skill is actually needed.
- **Indexes before sources** — the agent reads a summary of your documents, and opens a source file only when the index points at one. A 90-minute transcript never enters context to answer a question a two-line index entry covers.
- **Reference files load conditionally** — lookup tables live in `references/` behind an explicit "only load this when…" instruction.
- **Scripts run instead of being read** — a script's source never enters context; only its output costs tokens.

---

## 1. Prerequisites

| You need | For |
|---|---|
| **Claude Code** (desktop app or CLI) | Everything |
| **Node.js 18+** | The browser-automation MCP |
| **Python 3.9+** | The bundled scripts and validator |
| **Git** | Sharing the workspace with your team |
| An issue tracker account | Filing defects |
| Access to your app's test environment | Actually running tests |

## 2. Set it up

**Get the workspace**

```bash
git clone https://github.com/muhammadaqib-1992/QA_Agentic_Workspace.git
```
```bash
cd QA_Agentic_Workspace
```

Open the folder in Claude Code. `CLAUDE.md` and the skills in `.claude/skills/` are picked up automatically — there is nothing to "activate".

**Create your environment file**

```bash
cp .claude/qa-test-env.example.md .claude/qa-test-env.md
```

Fill in your URLs and per-role test logins. This file is git-ignored and must stay that way. Anything you leave as `<PLACEHOLDER>` simply makes the agent ask you in chat when a run needs it, so fill in only what you actually use.

**Turn on the hooks**

```bash
cp .claude/settings.json.example .claude/settings.json
```

That activates two things: a `PreToolUse` hook that refuses to commit your credentials file, and a `SessionStart` hook that tells each session what is configured and what isn't. The example file also carries commented-out `Stop` and `PostToolUse` hooks to adapt.

**Connect your MCP servers**

Three categories matter. Names and endpoints are yours to choose:

| Category | Used for | Notes |
|---|---|---|
| **Browser automation** | Driving the app under test | Local `stdio` server — CLI or `.mcp.json` only, no Connectors-UI path |
| **Issue tracker** | Reading tickets, filing defects | Usually a remote server; can be added through the Connectors UI |
| **Backend / data** | Verifying what the UI shows against the system of record | Often internal — keep the endpoint out of the repo |

```bash
claude mcp add playwright -- npx -y @playwright/mcp@latest
```
```bash
claude mcp list
```

To share config with the team, copy `.mcp.json.example` to `.mcp.json`. Teammates approve it on first run and authenticate remote servers with their own logins.

## 3. Fill in your project

This is the part that decides whether the workspace is useful or generic.

**Replace the placeholders in `CLAUDE.md`.** Application name, environments, tracker key, roles under test, integrations, open decisions. Keep it short — it loads into *every* conversation.

**Load `knowledge-base/`** — and write the indexes. Drop documents into the right folder, then fill in that folder's `INDEX.md`.

> Adding documents without writing the index makes things **worse**: more for the agent to wade through, and no map. The index is the whole mechanism.

`knowledge-base/README.md` has the routing map and explains what belongs where.

**Adapt the skills.** The seven in `.claude/skills/` are working defaults. The parts most worth editing:

- `qa-user-stories/references/user-story-format.md` — match your story template and default assignee
- `qa-test-writing/references/test-case-format.md` — match your tracker's columns
- `qa-bug-reporting/references/priority-and-labels.md` — match your priority scheme
- `qa-permission-testing` — point the lookup script at your real matrix

**Rename the prefix** if collisions are plausible. Everything is `qa-*`; a personal skill with the same name silently overrides a project one, so `acme-qa-*` is safer in a large org.

**Validate before committing:**

```bash
python scripts/validate_skills.py
```

## 4. Use it

Ask in plain language — the right skill loads on its own:

| You say | What happens |
|---|---|
| *"How is the approval workflow supposed to route orders?"* | Answers from the knowledge base, citing document and section |
| *"Why did we decide the storefront holds no pricing data?"* | Traces it to the call it was decided in, with the date |
| *"Write test cases for the inventory block on the product page"* | Drafts them in your column format, flagging anything inferred |
| *"Write test cases for the CRM customer sync"* | Covers both systems, the field mapping, **and** the failure path |
| *"Execute TC_PDP_002 on the sandbox"* | Drives the app, cross-checks the backend record, reports pass/fail with evidence |
| *"Can Customer Center L2 see another company's invoices?"* | Matrix → live config → actual behaviour, including the negative test |
| *"Draft a bug for this"* | Writes it in your format — **files nothing until you say "create it"** |

Two behaviours are deliberate and worth knowing:

- **Drafts come before writes.** Test cases and defects are posted in chat first. Nothing reaches your tracker without an explicit go-ahead.
- **Gaps are reported, not filled.** If the documents don't answer something, the agent says so rather than producing a confident guess. A guessed expected-result becomes a false defect and costs a developer an afternoon.

## 5. Repo structure

```
QA_Agentic_Workspace/
├── CLAUDE.md                    # Always-on project standards (fill in the placeholders)
├── ARCHITECTURE.md              # Why the workspace is shaped this way — read once
├── README.md                    # This file
├── .gitignore                   # Keeps credentials and run artefacts out of git
├── .gitattributes               # Keeps the hook scripts on LF line endings (Windows-safe)
├── .mcp.json.example            # Shareable MCP config
├── .githooks/
│   ├── pre-commit               # Blocks documents & credentials from ANY commit
│   └── kb-allowlist.sh          # The only knowledge-base paths allowed in git
├── .claude/
│   ├── qa-test-env.example.md   # Env TEMPLATE (committed, no real secrets)
│   ├── qa-test-env.md           # Your local copy (git-ignored — you create this)
│   ├── settings.json.example    # Hook configuration
│   ├── agents/                  # Read-only background helpers
│   │   ├── qa-test-data-prep.md    # Finds the backend records a run needs
│   │   ├── qa-duplicate-check.md   # Checks the tracker before a defect is raised
│   │   └── qa-researcher.md        # Custom subagent — note its `skills:` frontmatter
│   ├── hooks/
│   │   ├── block-secret-commit.sh   # PreToolUse — refuses to commit credentials
│   │   └── session-start-check.sh   # SessionStart — primes each session
│   └── skills/
│       ├── qa-context-lookup/       # + references/
│       ├── qa-user-stories/         # + references/user-story-format.md
│       ├── qa-test-writing/         # + references/test-case-format.md
│       ├── qa-test-execution/       # + references/report-format.md
│       ├── qa-permission-testing/   # + references/ + scripts/lookup_permission.py
│       ├── qa-bug-reporting/        # + references/priority-and-labels.md
│       └── qa-kb-sync/              # + scripts/kb_sync.py — Monday Google Drive sync
├── knowledge-base/              # INDEX.md files committed; documents local-only, NEVER committed
│   ├── sync-config.json         #   Google Drive folder link per folder (committed)
│   ├── solution-documents/      #   functional spec, acceptance criteria
│   ├── technical-design/        #   TDD — config paths, identifiers, data flow
│   ├── requirements/            #   BRD and upstream requirements
│   ├── contracts/               #   SOW, contractual scope
│   ├── call-recordings/         #   transcripts + the mandatory INDEX.md
│   └── reference-data/          #   permission matrices, config exports, test data
├── user-stories/                # Approved user stories — one date-stamped file per story
├── test-cases/                  # Approved test cases — one date-stamped file per batch
├── reports/                     # Execution & permission-test reports — date-stamped, one per run
├── bug-evidence/                # One folder per defect: screenshots, recordings, logs, draft
└── scripts/
    └── validate_skills.py       # Checks every skill against the spec limits
```

## 6. Things that will bite you

Collected because each one fails *silently* — nothing errors, you just get worse results.

| | |
|---|---|
| **Descriptions over 1,024 characters** | Risk being truncated exactly where the trigger words are. Run the validator. |
| **Subagents don't inherit skills** | They see a skill only if a custom agent names it in `skills:`. Built-in agents can't use skills at all. Keep skill-driven work in the main thread. |
| **Personal skills beat project skills** | A teammate's personal `qa-bug-reporting` silently overrides this repo's. Prefix your names. |
| **`PostCompact` doesn't re-inject context** | Use `SessionStart` with the `compact` matcher. That's the one whose output reaches the conversation. |
| **Auto-accept modes judge danger, not correctness** | Broken code isn't dangerous, so it passes. Pair permissive modes with a `Stop` hook that runs your tests. |
| **A passing report is a claim** | For unattended runs, start from the diff and the actual test output, not the summary. |
| **Documents without indexes** | Strictly worse than no documents. Write the index. |
| **`git rm` doesn't shrink history** | Committed credentials or large binaries stay forever. Prevention (the hook, `.gitignore`) is the only cheap fix. |

## 7. Extending it

Adding a new capability? Pick the right primitive — `ARCHITECTURE.md` has the full reasoning:

- Always true, every conversation → **`CLAUDE.md`**
- A procedure for a kind of task → **a skill**
- Must happen whether or not the model remembers → **a hook**
- Needs its own context window → **a subagent** (and list its skills)
- Talks to an external system → **an MCP server**

The most common mistake is putting a rule in `CLAUDE.md` and treating it as enforcement. Instructions are advice. If it genuinely must not happen, it belongs in a `PreToolUse` hook.
