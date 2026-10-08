# Linux setup — step by step

Everything to do on the Linux machine, in order. Allow ~30 minutes. Each step ends with a
**✅ Check** — don't move on until it passes.

Tested on Ubuntu 22.04 / 24.04 with Node 20 / 22 (CI runs this on every push). Use a **normal
user, not root** — Chromium refuses to start as root, and the cron job, the sign-ins and the
tokens must all belong to the same user.

---

## 1. Prerequisites

```bash
sudo apt-get update && sudo apt-get install -y git curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

Keep the clock in sync — the NetSuite 2FA codes are time-based:

```bash
sudo timedatectl set-ntp true
```

✅ **Check:** `node -v` shows v20+ and `timedatectl` shows `System clock synchronized: yes`.

## 2. Get the code

```bash
cd ~
git clone https://github.com/muhammadaqib-1992/AI-Factory-QA.git
cd AI-Factory-QA
git checkout feature/linux-jira-pipeline     # skip once main has been updated
```

✅ **Check:** `ls` shows `scripts/`, `.mcp.json`, `.env.example`, `README.md`.

## 3. Run the setup script

```bash
bash scripts/setup-linux.sh
```

It installs the Node packages, Chromium plus its system libraries and fonts (asks for your sudo
password), creates `.env` from `.env.example` (mode 600) and the local folders.

✅ **Check:** it ends with "Done. Next steps".

## 4. Install and sign in Claude Code

```bash
sudo npm install -g @anthropic-ai/claude-code
claude auth login
```

`claude auth login` prints a link — open it on any computer, sign in, paste the code back. (Or
put an `ANTHROPIC_API_KEY=…` line in `.env` instead.)

✅ **Check:** `claude auth status` shows `"loggedIn": true`, and `which claude` prints a path.

## 5. Fill in `.env`

```bash
nano .env
```

Set these (the rest can stay as they are):

| Setting | Value |
|---|---|
| `NETSUITE_ACCOUNT_ID` | `TSTDRV2142416` |
| `NS_ROLE_NAME` | `Administrator` |
| `JIRA_BUG_ASSIGNEE_ACCOUNT_ID` | `5fa9107fecdae600684f2658` (Shahzaib Ahmed) |
| `CLAUDE_BIN` | the output of `which claude`, e.g. `/usr/bin/claude` |
| `PLAYWRIGHT_BROWSER` | leave it out / commented — Linux uses the bundled Chromium |

Leave `NS_EMAIL`, `NS_PASSWORD` and `NS_TOTP_SECRET` — step 7 fills them in for you.

> **Don't copy the `.env` from the Windows PC as it is.** It has
> `CLAUDE_BIN=C:\Users\…\claude.cmd` and `PLAYWRIGHT_BROWSER=chrome`, which break on Linux.

The other values already have the right defaults: project `NU`, status `Ready for QA`,
assignee = the signed-in Jira user, label `AI_FActory`, bugs as `Sub-task` labelled `ai-qa-bug`,
`Done / Closed` / `Reopen` for bug retests, and closing the ticket when its QA is complete.

## 6. Sign in to Jira (once)

The Jira sign-in redirects to `localhost:3334` **on the server**, so open an SSH tunnel from your
laptop first:

```bash
# on your laptop
ssh -L 3334:127.0.0.1:3334 <user>@<server>
```

In that SSH session:

```bash
cd ~/AI-Factory-QA
scripts/mcp-auth.sh jira
```

Open the printed `https://mcp.atlassian.com/v1/authorize?...` link **in your laptop's browser**,
sign in with the Atlassian account that QA tickets are assigned to, choose `folio3`, click
**Accept**. The command finishes by listing the Jira tools.

✅ **Check:** `node scripts/pick-tickets.mjs --all` prints a JSON block with the pickup query (no
sign-in prompt).

## 7. Sign in to NetSuite (once)

```bash
node scripts/set-netsuite-login.mjs
```

It asks for the NetSuite email, password and **2FA secret key** (input is hidden), saves them to
`.env`, and logs in headless once.

The 2FA secret key is the text behind the authenticator QR code. Use the same key as on the
Windows PC (it's in that PC's `.env` as `NS_TOTP_SECRET`) — or reset 2FA in NetSuite (*Settings →
Reset 2FA Settings* → log in again → **Authenticator App** → **"Can't scan the code?"**) and add
the new key to your phone app too.

✅ **Check:** it prints `NetSuite login OK`, and

```bash
node scripts/check-netsuite-session.mjs
```

prints `Logged in to tstdrv2142416.app.netsuite.com (headless)`.

## 8. Check everything

```bash
node scripts/check-setup.mjs
npm test
node scripts/run-pipeline.mjs --dry-run
```

✅ **Check:** `check-setup` ends with "All required checks passed" (sign-in lines may say WARN
for the optional NetSuite MCP / Google Drive — fine); `npm test` shows `fail 0`; the dry run
prints the pickup queries and "Nothing to test" or the tickets it would run.

## 9. First real run

Pick a ticket, then:

```bash
node scripts/run-pipeline.mjs --ticket NU-4041
```

It takes a few minutes. Watch it with `tail -f logs/EXEC-*_NU-4041.log` in a second terminal.

✅ **Check:** `reports/NU-4041/EXEC-NNNN_NU-4041/report.pdf` exists, and the ticket has a QA
comment in Jira.

## 10. Schedule it (every 15 minutes)

```bash
crontab -e
```

Add this line (replace `<user>`). `bash -lc` loads your profile so cron finds `node` and
`claude`:

```
*/15 * * * * bash -lc 'cd /home/<user>/AI-Factory-QA && node scripts/run-pipeline.mjs' >> /home/<user>/AI-Factory-QA/logs/pipeline.log 2>&1
```

✅ **Check:** after 15 minutes `tail logs/pipeline.log` shows a `Pickup:` line.

From now on nothing needs to be typed: put a ticket in **Ready for QA**, assigned to the QA user,
with the label **`AI_FActory`**, and the next run moves it to **In QA**, tests it, files bugs, retests them when they
come back to Ready for QA, and closes the ticket when its QA is complete.

---

## Day to day

| Task | Command |
|---|---|
| What happened on the last runs | `tail -50 logs/pipeline.log` |
| One run's details | `less logs/EXEC-0007_NU-1234.log` |
| What would be picked up now | `node scripts/run-pipeline.mjs --dry-run` |
| Run one ticket now | `node scripts/run-pipeline.mjs --ticket NU-1234` |
| Retest one bug now | `node scripts/run-pipeline.mjs --retest NU-1235 --parent NU-1234` |
| Why isn't a ticket closed? | `node scripts/close-completed.mjs NU-1234 --dry-run` |
| Is NetSuite still logged in? | `node scripts/check-netsuite-session.mjs` |
| Get the latest code | `git pull && npm ci` |
| Commit new reports | `git add reports test-cases && git commit -m "QA reports" && git push` |
| Pause the schedule | `crontab -e` and put `#` in front of the line |

## If something goes wrong

| You see | Do |
|---|---|
| `Claude Code CLI not available` | Step 4; set `CLAUDE_BIN` to `which claude` |
| `NetSuite login FAILED … NS_TOTP_SECRET is not set` | Step 7 with the 2FA key |
| `NetSuite rejected the 2FA code` | Clock out of sync (`timedatectl`) or wrong key |
| `NetSuite sent the 2FA code by email/SMS` | Authenticator setup not finished in NetSuite — finish it, rerun step 7 |
| `Executable doesn't exist … chromium` | `npx playwright install --with-deps chromium` |
| Chromium won't start | You're root — use a normal user |
| Jira asks to sign in again | Step 6 again (tokens in `~/.mcp-auth` expired) |
| Cron does nothing | Check the `bash -lc` line, and that `logs/pipeline.log` is being written |
| `Nothing to test` but a ticket is waiting | It needs status *Ready for QA*, assignee = the signed-in Jira user, label `AI_FActory`; or it was already tested this QA cycle |

More detail: [README.md](../README.md).
