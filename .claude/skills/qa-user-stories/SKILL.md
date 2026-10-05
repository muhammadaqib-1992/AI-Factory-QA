---
name: qa-user-stories
description: "Turns the project's solution document into user stories, saved as one Markdown file per story in user-stories/, and raised as Jira tickets once confirmed. Use whenever the user asks to 'create user stories', 'write user stories', 'generate stories from the solution document', 'extract stories from the SDD', 'break this requirement into stories', or names a feature and wants it expressed as stories with acceptance criteria. Sources every story from the solution document via the knowledge base — never invents an acceptance criterion, and labels anything inferred. ALWAYS drafts the stories in chat for review first; writes files only on approval, and creates Jira tickets (type Task, assigned to Aneeq Fayaz Malik) only on a second explicit confirmation. Do NOT use for writing test cases (qa-test-writing), filing a defect (qa-bug-reporting), or running a test (qa-test-execution)."
---

# QA User Stories

Reads the solution document, breaks it into user stories, saves one Markdown file per story in `user-stories/`, and — on explicit confirmation — raises each as a Jira **Task** assigned to the delivery owner.

Three gates, in order: **draft in chat → files on approval → Jira on a second confirmation.** Never collapse them.

**Only load `references/user-story-format.md` when you are about to write the stories** — it holds the file template, the splitting rules and worked examples.

## Ground rules

1. **Chat first, always.** Post the story list for review before writing anything. Stories are a draft until the user approves them.
2. **Jira is a separate yes.** Approving the stories approves the *files*. Creating tickets needs its own confirmation — "create the tickets", "raise them in Jira", "go ahead". A batch of tickets is visible to the whole team and tedious to unpick; a draft costs nothing.
3. **Ground every story in the solution document.** Pull the section and its acceptance criteria through the knowledge base (`qa-context-lookup` handles the retrieval order). If you add a story the document doesn't cover, label it **Inferred** so a reviewer can challenge it.
4. **Never invent an acceptance criterion.** Where the document is silent, write the gap down as an open question on the story rather than filling it with something plausible. A story whose "acceptance criteria" are really an opinion will be built wrong and argued about later.
5. **Never put credentials, client data or document contents in a ticket.** Cite the solution document section; do not paste it. The documents are local-only (see `knowledge-base/README.md`).
6. **Never hardcode a Jira account id or cloud id.** Both are resolved at run time, every run. See Step 5.

## Step 1 — Locate the source

Route through `knowledge-base/README.md` to `solution-documents/`, read its `INDEX.md`, and open only the section the index points at. Do not read the whole document to find one feature.

Confirm with the user **which scope** they want stories for — a requirement number, a module, or the whole document. "The whole document" on a large solution document is a long run; say roughly how many stories you expect and let them narrow it before you start.

If the solution document is not in the knowledge base yet, stop and say so. Offer `qa-kb-sync` to pull it from Drive. Do not fall back to general knowledge of how such systems usually work.

## Step 2 — Derive the stories

Walk the section one acceptance criterion at a time. A story is **one user-visible capability for one role**, small enough to be built and verified on its own.

Split when you see any of these:

- **Two roles** — a capability an Admin and a Level 2 user both have is two stories; their acceptance criteria differ, and most access defects appear under only one.
- **Two verbs** — "create and approve" is two stories.
- **A configuration toggle** — on and off are different behaviours; if both are specified, both are stories.
- **A boundary crossed** — a UI change plus the integration it triggers is two stories, because they fail differently and are verified differently.

Do **not** split on screen or field. "Add the postcode field" is a task, not a story — it has no user outcome and nothing to accept against.

Number them `US_<Code>_001` upward, using the feature's short code, the same code the test cases will use (see `test-cases/README.md`). The shared code is what later lets a story, its test cases and its defects be traced to each other.

## Step 3 — Draft in chat

Post a single table so the whole set can be judged at once:

| ID | Story | Role | Source | Notes |
|---|---|---|---|---|
| `US_PDP_001` | As a shopper, I want to see live stock on the product page, so that I don't order what isn't available | Anonymous | Solution Document §14, AC 1–3 | — |
| `US_PDP_002` | As a shopper, I want offline locations excluded from the total, so that the figure I see is orderable | Anonymous | §14, AC 3 | — |
| `US_PDP_003` | As an Admin, I want to hide the stock block per item, so that pre-release items don't show figures | Admin | §14, config | **Inferred** — toggle named, behaviour not specified |

Then, in a line or two: what you marked Inferred, any open dependency that changes an acceptance criterion, and any place the solution document contradicts itself or a call decision. That note is usually worth more than the stories — it is where the specification's real gaps surface.

**Stop here.** Wait for the user.

## Step 4 — Save the approved stories

On approval, write **one file per story**:

```
user-stories/YYYY-MM-DD_<US-id>_<short-slug>.md
```

Use today's date — the day they were approved — e.g. `user-stories/2026-10-05_US_PDP_001_live-stock-on-product-page.md`. The date prefix is what turns the folder into a timeline; never drop it.

The file body follows `references/user-story-format.md`. Keep `**Jira:** not yet raised` in the header until Step 5 fills it in.

Say in your reply how many files were written and where. See `user-stories/README.md` for the full convention, including how to revise a story that has already been raised.

## Step 5 — Raise the Jira tickets

**Only after a second, explicit confirmation.** Then, in this order:

**a. Resolve the site.** Call the tracker's discovery tool (`getAccessibleAtlassianResources`) for the `cloudId`. Never hardcode it — it differs per site.

**b. Get the project key** from the `Issue tracker` section of `.claude/qa-test-env.md`. A `<PLACEHOLDER>` there means ask the user for this run only.

**c. Confirm the issue type exists.** `getJiraProjectIssueTypesMetadata` for that project must list a **Task** type. If it doesn't, stop and ask which type to use — do not substitute one.

**d. Resolve the assignee by name.** The default owner is **Aneeq Fayaz Malik**. Call `lookupJiraAccountId` with that name and use the returned `accountId`.

- **Exactly one match** → use it.
- **No match, or more than one** → stop and ask. Never guess, and never write an account id into this file or any other committed file — ids are per-site and go stale.
- The user can name a different assignee for a run; the lookup is the same.

**e. Create one ticket per story**, in story order:

```
createJiraIssue(
  cloudId,  projectKey,
  issueTypeName: "Task",
  summary:     "<US-id> — <story title>",
  description: <the story file's body, markdown>,
  assignee_account_id: <resolved id>
)
```

Tool names may carry a client prefix; match on the suffix.

**f. Write the result back.** Replace `**Jira:** not yet raised` in each story file with the issue key and URL. A story file with no ticket reference is how the same story gets raised twice next month.

**g. Report.** One line per story: ID, Jira key, assignee. If any ticket failed, say which and why, and leave that file's header unchanged — a partial batch that reads as complete is worse than a visible failure. Do not retry a failure blindly; a second attempt on a ticket that actually succeeded creates a duplicate.

## Step 6 — Handoff

The stories are now the baseline for test cases. Offer `qa-test-writing`, pointing it at the story's acceptance criteria and the same short code — then **wait**. Do not chain into writing test cases automatically.
