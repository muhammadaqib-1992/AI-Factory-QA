# User Stories

One file per user story, written from the project's solution document. This folder is the team's record of **what was specified as a story, when, and from which section** — it is tracked in git on purpose.

`qa-user-stories` writes here once you approve a draft in chat, and fills in the Jira key once you confirm the tickets.

## Naming

```
YYYY-MM-DD_<US-id>_<short-slug>.md
```

| Part | Meaning | Example |
|---|---|---|
| `YYYY-MM-DD` | Date the story was **approved** | `2026-10-05` |
| `<US-id>` | `US_<ShortCode>_<nnn>` — the short code is shared with the feature's test cases | `US_PDP_001` |
| `<short-slug>` | A few words describing the story, hyphenated | `live-stock-on-product-page` |

→ `2026-10-05_US_PDP_001_live-stock-on-product-page.md`

The date prefix turns the folder into a timeline — sort by name and you see the order work was specified in. Never drop it.

The **short code is the thread through the whole workspace**: `US_PDP_001` in this folder, `TC_PDP_*` in `test-cases/`, and the same code in the execution reports. Reuse it rather than inventing a second code per folder.

## File layout

Header, story, acceptance criteria, then the optional sections. The full template, including what each header field carries, is in `.claude/skills/qa-user-stories/references/user-story-format.md`.

```markdown
# US_PDP_001 — Live stock on the product page

- **Created:** 2026-10-05
- **Source:** Solution Document §14, acceptance criteria 1–3
- **Role:** Anonymous
- **Status:** Approved
- **Jira:** PROJ-412 — https://<site>.atlassian.net/browse/PROJ-412
- **Test cases:** TC_PDP_001 – TC_PDP_004

## Story
As a **shopper**, I want ... so that ...

## Acceptance criteria
1. ...
```

## Statuses

| Status | Meaning |
|---|---|
| `Draft` | Saved on request before approval — not yet agreed |
| `Approved` | Reviewed and agreed; ready to raise and build |
| `Superseded by <file>` | Replaced by a newer story for the same capability |

## The Jira field

| Value | Meaning |
|---|---|
| `not yet raised` | The file exists; no ticket. This is the state a freshly approved story is saved in |
| `<KEY> — <url>` | Raised. **Never raise it again** — a second ticket for the same story is how a backlog gets duplicates |

Tickets are created as type **Task**, assigned to the delivery owner (**Aneeq Fayaz Malik** by default), and only on an explicit confirmation separate from approving the files.

## Changing a story

- **Before it is raised** → edit in place and add `- **Updated:** YYYY-MM-DD — <what changed>` under the header.
- **After it is raised** → edit in place the same way, **and** say so on the Jira ticket. A story file and its ticket that have quietly diverged are worse than either being wrong on its own, because each reader trusts the one in front of them.
- **A genuinely different capability** → a new story with a new id, and the old one's status becomes `Superseded by <file>`.

## What doesn't go here

Test cases go to `test-cases/`, execution results to `reports/`, defect evidence to `bug-evidence/`. This folder holds what was **asked for**; `test-cases/` holds how it will be checked.
