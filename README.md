# AI-Factory-QA

Automated QA for NetSuite, driven by Jira. When a ticket reaches **Ready for QA** with the
**`AI_FActory`** label and is assigned to the QA user, the pipeline — with nobody typing anything:

1. reads everything on the ticket (description, acceptance criteria, comments),
2. writes test cases from it → `test-cases/<KEY>/EXEC-NNNN_<KEY>.md`,
3. executes them **headless** in NetSuite with Playwright, a screenshot per step, and checks the
   saved records,
4. files a **Sub-task bug under the ticket**, assigned to the bug assignee, for every failure,
5. saves a **PDF report with the execution number** → `reports/<KEY>/EXEC-NNNN_<KEY>/report.pdf`
   and comments the result on the ticket.

**Then it watches those bugs.** When a developer moves a bug sub-task to **Ready for QA**, the
pipeline retests it the same way (the failed cases + the bug's steps), saves the report under
the **same ticket** (`reports/<KEY>/EXEC-NNNN_<BUG>/`), comments the result on the bug and the
ticket, and **closes** the bug if everything passes or **reopens** it if it still fails. This
repeats on every round until the bugs are closed.

**Finally it closes the task.** As soon as a ticket's QA is complete — every case passed on the
first run, or every bug the pipeline filed for it is closed — the ticket itself is moved to
**Done / Closed** with a comment saying why.

You can also work interactively: say **"execute these scripts"** in a Claude session in this
folder and the cases you point at are run the same way.

Built for **Linux** (Ubuntu 22.04/24.04, Node 20/22 — proven in CI on every push); also runs on
Windows.

---

## Contents

- [How it works](#how-it-works)
- [Setup on Linux](#setup-on-linux)
- [Sign-ins (once per machine)](#sign-ins-once-per-machine)
- [Run it](#run-it)
- [Schedule it](#schedule-it)
- [Where things are saved](#where-things-are-saved)
- [Configuration (.env)](#configuration-env)
- [Repository layout](#repository-layout)
- [Troubleshooting](#troubleshooting)
- [Security](#security)

---

## How it works

```
cron / Task Scheduler (every 15 min)
        │
        ▼
scripts/run-pipeline.mjs
  ├─ pick-tickets.mjs ──── Jira MCP: project NU · status "Ready for QA" · assignee = me
  │                         · label AI_FActory · not yet tested in this QA cycle
  ├─ check-netsuite-session.mjs ─ expired? → netsuite-login.mjs (headless, from .env, 2FA)
  ├─ next execution number ────── EXEC-0001, EXEC-0002, … (state/execution-counter.json)
  │                       + its own bug sub-tasks back in "Ready for QA" (label ai-qa-bug),
  │                         once the parent ticket's first run has finished
  ├─ claude -p "/qa-jira-pipeline <KEY> <EXEC>"                  ← first iteration
  │  claude -p "/qa-jira-pipeline retest <BUG> <EXEC> <KEY>"     ← bug retest
  │     ├─ Jira MCP ........ read tickets, create Sub-task bugs, comment, close / reopen bugs
  │     ├─ Playwright MCP .. drive NetSuite headless, screenshots
  │     └─ NetSuite MCP .... read records to verify (when signed in)
  ├─ build-report.mjs ──── reports/<KEY>/EXEC-NNNN_<KEY or BUG>/report.pdf
  └─ close-completed.mjs ─ ticket → Done / Closed once all cases passed or all its bugs closed
                           (checked every run, also catches bugs closed by hand)
```

- **QA cycle:** the moment a ticket last moved into *Ready for QA*. A ticket is tested once per
  cycle; if it goes back to development and returns, it is tested again.
- **One run at a time** (lock file), **at most 5 tickets per run**, **45 min per ticket**. A run
  that does not finish is retried once, then left until the ticket's next QA cycle.
- Status changes the pipeline makes:
  - **as a run starts**: the ticket — or the bug being retested — → `JIRA_IN_QA_STATUS`
    (*In QA*), with a "QA started — execution EXEC-NNNN" comment. A run that stops part-way is
    retried from *In QA* on the next pass;
  - **its own bugs** after a retest: all passed → `JIRA_CLOSE_STATUS` (*Done / Closed*), any
    failed → `JIRA_REOPEN_STATUS` (*Reopen*);
  - **the ticket** → *Done / Closed* when QA is complete: the first run's cases are all Passed,
    or every failed case has a bug and every bug the pipeline filed (including ones found during
    retests) is closed. A Blocked case, a failure without a bug, or an incomplete run keeps the
    ticket open. Turn this off with `QA_CLOSE_PARENT=false`.
- Bugs are retested **only after the ticket's first run has finished**, and only the bugs the
  pipeline filed (label `ai-qa-bug`).

## Setup on Linux

> **Step-by-step guide with checks after every step: [docs/LINUX-SETUP.md](docs/LINUX-SETUP.md).**

Prerequisites: **Node.js 20+**, **git**, a normal (non-root) user with `sudo` for installing
system libraries.

```bash
git clone https://github.com/muhammadaqib-1992/AI-Factory-QA.git
cd AI-Factory-QA
bash scripts/setup-linux.sh
npm install -g @anthropic-ai/claude-code
```

`setup-linux.sh` installs the Node packages, Chromium with its system libraries and fonts,
creates `.env` from `.env.example` (mode 600) and the local folders. Then:

```bash
nano .env                       # fill in the values — see Configuration below
claude                          # once, to sign Claude Code in (or set ANTHROPIC_API_KEY in .env)
node scripts/check-setup.mjs    # reports what is configured and what is missing
```

On **Windows**, run `npm ci` instead of the setup script, and add `PLAYWRIGHT_BROWSER=chrome` to
`.env` if Windows blocks Playwright's bundled Chromium (it uses your installed Chrome instead).

## Sign-ins (once per machine)

| What | How | Kept in |
|---|---|---|
| **NetSuite UI** (Playwright) | `node scripts/set-netsuite-login.mjs` — asks for email, password (hidden) and the 2FA secret key, saves them to `.env`, logs in headless once | `.env`, session in `.auth/netsuite-state.json` |
| **Jira** (Atlassian MCP) | `scripts/mcp-auth.sh jira` — open the printed link and approve | `~/.mcp-auth/` |
| **NetSuite MCP** (AI Connector, optional) | `scripts/mcp-auth.sh netsuite` | `.auth/netsuite-mcp/` |
| **Google Drive** (optional) | `scripts/mcp-auth.sh gdrive` | path in `GDRIVE_CREDENTIALS_PATH` |

**Headless server, no browser:** sign in from your laptop through an SSH tunnel —

```bash
ssh -L 3334:127.0.0.1:3334 -L 8080:127.0.0.1:8080 <user>@<server>
scripts/mcp-auth.sh jira        # then open the printed URL in your laptop's browser
```

**NetSuite 2FA:** the headless login generates the authenticator code itself from the **secret
key** behind your authenticator QR code. Get it in NetSuite: *Settings → Reset 2FA Settings*, log
in again, choose **Authenticator App**, click **"Can't scan the code?"**, copy the key, add the
same key to your phone app and **finish the setup there** (enter the phone's code). Then run
`set-netsuite-login.mjs` and paste the key.

Check the NetSuite session any time (uses only the saved cookies, never the password):

```bash
node scripts/check-netsuite-session.mjs
```

## Run it

| Command | Does |
|---|---|
| `node scripts/run-pipeline.mjs` | One pipeline pass: pick tickets → test → bugs → PDFs |
| `node scripts/run-pipeline.mjs --dry-run` | Show which tickets would be tested |
| `node scripts/run-pipeline.mjs --ticket NU-4040` | First iteration for one ticket now, whatever its status |
| `node scripts/run-pipeline.mjs --retest NU-4041 --parent NU-4040` | Retest one bug now |
| `node scripts/close-completed.mjs [KEY] [--dry-run]` | Close tickets whose QA is complete (the runner does this every run) |
| `node scripts/pick-tickets.mjs [--all]` | List matching tickets (with `--all`, include ones already tested) |
| `node scripts/build-report.mjs reports/<run>` | Rebuild a run's PDF |
| `scripts/with-env.sh claude` | Interactive Claude session with `.env` loaded (Linux) |

In an interactive session, these phrases start work without further questions:

| Say | Happens |
|---|---|
| "execute these scripts" / "run these test cases" / "execute NU-4040" | `qa-test-execution`: run the cases headless, screenshots, results, PDF |
| "write test cases for NU-4040" | `qa-test-writing` |
| "run the pipeline for NU-4040" | `qa-jira-pipeline`, exactly as the scheduler would |

## Schedule it

**Linux** — `crontab -e`:

```
*/15 * * * * cd /path/to/AI-Factory-QA && node scripts/run-pipeline.mjs >> logs/pipeline.log 2>&1
```

**Windows** — Task Scheduler:

```powershell
schtasks /Create /TN "AI-Factory-QA pipeline" /SC MINUTE /MO 15 /TR "cmd /c cd /d \"D:\AI factory\AI-Factory-QA\" && node scripts\run-pipeline.mjs >> logs\pipeline.log 2>&1"
```

Remove it with `schtasks /Delete /TN "AI-Factory-QA pipeline" /F`.

## Where things are saved

| Path | Holds | In git |
|---|---|---|
| `test-cases/<KEY>/EXEC-NNNN_<KEY or BUG>.md` | Test cases written for the ticket, and retest cases for its bugs | yes |
| `reports/<KEY>/EXEC-NNNN_<KEY or BUG>/report.pdf` | The report: execution number, ticket link, results per case, bugs with links, retest outcome, test cases, failure screenshots | yes |
| `reports/<KEY>/EXEC-NNNN_<KEY or BUG>/results.json` | Machine-readable results (format: `.claude/skills/qa-test-execution/references/results-format.md`) | yes |
| `reports/<KEY>/EXEC-NNNN_<KEY or BUG>/screenshots/` | One screenshot per step | yes |
| `logs/EXEC-NNNN_<KEY>.log`, `logs/pipeline.log` | What Claude and the runner did | no |
| `state/execution-counter.json` | Last execution number used | no |
| `state/processed-tickets.json` | Which QA cycle of each ticket/bug was tested, bugs filed per ticket, retest outcomes | no |

Example after a full round on NU-4040:

```
reports/NU-4040/
├── EXEC-0001_NU-4040/   first iteration — 1 failure → bug NU-4041 filed
├── EXEC-0004_NU-4041/   retest of NU-4041 — still failing → reopened
└── EXEC-0009_NU-4041/   retest of NU-4041 — passed → closed      ⇒ NU-4040 moved to Done / Closed
```
| `.auth/` | NetSuite session and MCP tokens | no |

## Configuration (.env)

Copy `.env.example` to `.env`. Never commit `.env`.

| Setting | Meaning | Default |
|---|---|---|
| `NETSUITE_ACCOUNT_ID` | NetSuite account, e.g. `TSTDRV2142416` | — |
| `NS_EMAIL`, `NS_PASSWORD` | NetSuite UI login (quote the password if it has `#` or spaces) | — |
| `NS_TOTP_SECRET` | 2FA secret key (base32) | empty = no 2FA |
| `NS_ROLE_NAME` | Role to pick if NetSuite shows the role chooser | — |
| `PLAYWRIGHT_BROWSER` | `chromium` (bundled) or `chrome` / `msedge` (installed) | `chromium` |
| `JIRA_SITE` | Jira site | `folio3.atlassian.net` |
| `JIRA_PROJECT_KEY` | Project picked up | `NU` |
| `JIRA_READY_STATUS` | Status picked up | `Ready for QA` |
| `JIRA_QA_ASSIGNEE` | Assignee picked up | `currentUser()` (the signed-in Jira account) |
| `JIRA_PICKUP_LABEL` | Label required | `AI_FActory` |
| `JIRA_PICKUP_JQL` | Replaces all four pickup settings above | — |
| `JIRA_IN_QA_STATUS` | Status set when a ticket's / bug's execution starts (empty = don't change it) | `In QA` |
| `JIRA_BUG_ISSUE_TYPE` | Type of the bug filed under the ticket | `Sub-task` |
| `JIRA_BUG_ASSIGNEE_ACCOUNT_ID` | Who bugs are assigned to | — |
| `JIRA_BUG_LABEL` | Label on every bug the pipeline files (how it finds them for retest) | `ai-qa-bug` |
| `JIRA_CLOSE_STATUS`, `JIRA_REOPEN_STATUS` | Status for a passed / failed bug retest; `JIRA_CLOSE_STATUS` is also used to close the ticket | `Done / Closed`, `Reopen` |
| `QA_CLOSE_PARENT` | Close the ticket automatically when its QA is complete | `true` |
| `QA_MAX_TICKETS_PER_RUN`, `QA_TICKET_TIMEOUT_MIN`, `QA_MAX_ATTEMPTS` | Limits | `5`, `45`, `2` |
| `CLAUDE_BIN`, `CLAUDE_MODEL` | Claude Code command and model | `claude`, CLI default |
| `NETSUITE_CLIENT_ID`, `GITHUB_PERSONAL_ACCESS_TOKEN`, `GDRIVE_*` | Optional MCP servers | — |

MCP servers are defined in `.mcp.json` and read these values as `${VAR}`. The runner loads `.env`
itself; for an interactive session on Linux start Claude with `scripts/with-env.sh claude`.

## Repository layout

```
.mcp.json                     MCP servers: playwright, jira, netsuite, github, gdrive
.env.example                  every setting, documented
CLAUDE.md                     rules Claude follows in every session
.claude/skills/
  qa-jira-pipeline/           unattended run for one ticket (used by the scheduler)
  qa-test-execution/          "execute these scripts" — run cases headless; NetSuite UI notes
  qa-test-writing/            ticket/requirement → test cases
  qa-bug-reporting/           defect format
  qa-context-lookup/ …        knowledge base, user stories, permissions, Drive sync
scripts/
  run-pipeline.mjs            the scheduled pipeline
  pick-tickets.mjs            which tickets to test now
  netsuite-login.mjs          headless NetSuite login (2FA) → .auth/netsuite-state.json
  set-netsuite-login.mjs      asks for the login, saves it, logs in once
  check-netsuite-session.mjs  is the saved session still logged in?
  build-report.mjs            results.json + test cases → PDF
  check-setup.mjs             machine readiness report
  setup-linux.sh              one-time Linux setup
  mcp-auth.sh                 one-time MCP sign-ins (SSH-tunnel friendly)
  jira-mcp.mjs                call any Jira MCP tool from the shell
  with-env.sh / load-env.sh   load .env safely
lib/                          shared code: env, browser launcher, Jira MCP client, TOTP
tests/                        node --test: MCP servers, headless Playwright, PDF
.github/workflows/linux-check.yml   CI on Ubuntu 22.04/24.04 × Node 20/22
knowledge-base/               project documents (local only) + committed indexes
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `NetSuite login FAILED: … 2FA code … NS_TOTP_SECRET is not set` | Add the 2FA secret key: `node scripts/set-netsuite-login.mjs` |
| `NetSuite sent the 2FA code by email/SMS` | The authenticator app isn't your active 2FA method — finish its setup in NetSuite (enter the phone's code), then rerun |
| `NetSuite rejected the 2FA code` | Wrong key, or the machine clock is off — sync the clock (`timedatectl`), re-copy the key |
| `Executable doesn't exist … chromium` / `spawn UNKNOWN` | Linux: `npx playwright install --with-deps chromium`. Windows: set `PLAYWRIGHT_BROWSER=chrome` |
| Chromium won't start as root | Run the pipeline as a normal user |
| `"claude" not found` | `npm install -g @anthropic-ai/claude-code` (or set `CLAUDE_BIN`) |
| Pipeline says "Nothing to test" | Check the ticket: status *Ready for QA*, assigned to the signed-in Jira user, label `AI_FActory`; `node scripts/pick-tickets.mjs --all` shows what matches |
| A ticket is never re-tested | It was tested in this QA cycle; move it out of and back into *Ready for QA*, or run `--ticket <KEY>` |
| A bug in Ready for QA is not retested | It needs the `ai-qa-bug` label and a parent whose first run finished; or run `--retest <BUG> --parent <KEY>` |
| Ticket not closed although its bugs are | `node scripts/close-completed.mjs <KEY> --dry-run` prints the reason (blocked case, failure without a bug, a bug still open) |
| Bug not closed / reopened after retest | The transition to `JIRA_CLOSE_STATUS` / `JIRA_REOPEN_STATUS` isn't available from its status — see the run's `results.json` notes |
| Jira MCP asks to sign in again | `scripts/mcp-auth.sh jira` (tokens in `~/.mcp-auth` expired) |
| `logs/netsuite-login-failed_*.png` | Screenshot of the page the login stopped on |

## Security

- `.env`, `.auth/`, `state/` and `logs/` are git-ignored — never commit them, never `git add -f`.
- Claude never types a password: the NetSuite UI runs on the saved session, refreshed by
  `netsuite-login.mjs`, which reads `.env` directly.
- Reports and screenshots are committed; keep real customer data out of test cases.
- Don't paste passwords or 2FA keys into chat — use `set-netsuite-login.mjs`, which hides input.
