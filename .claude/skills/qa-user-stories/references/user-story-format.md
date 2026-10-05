# User Story Format

Reference for `qa-user-stories`. **Only load this when you are about to write the stories.**

Replace the examples with your project's own. The value is in one shape applied consistently, not in this particular one.

---

## The file

One story per file, at `user-stories/YYYY-MM-DD_<US-id>_<short-slug>.md`:

```markdown
# US_PDP_001 — Live stock on the product page

- **Created:** 2026-10-05
- **Source:** Solution Document §14 — Inventory Availability, acceptance criteria 1–3
- **Role:** Anonymous
- **Status:** Approved
- **Jira:** not yet raised
- **Test cases:** TC_PDP_001 – TC_PDP_004

## Story

As a **shopper**, I want **the product page to show how many units are available**, so that **I don't place an order for stock that isn't there**.

## Acceptance criteria

1. The inventory block renders below the price on every product page.
2. The figure shown is the sum of availability across online locations only.
3. Locations flagged offline are excluded from both the total and the breakdown.

## Out of scope

- Per-location breakdown for logged-out users (§14.4, deferred — see call 2026-08-19).

## Open questions

- Behaviour when every location is offline is not specified. Confirm with `<owner>`.

## Notes

- Criterion 3 is the one that failed in the sample report — worth a negative test case.
```

### Header fields

| Field | What it carries |
|---|---|
| `Source` | Document **and section**, or the call date a decision came from. An uncited story cannot be checked |
| `Role` | The single role the story is written for. Two roles means two stories |
| `Status` | `Draft` · `Approved` · `Superseded by <file>` |
| `Jira` | `not yet raised`, or the issue key and URL once Step 5 has run |
| `Test cases` | Filled in later by `qa-test-writing`, once cases exist. Leave it out until then |

---

## Writing the story line

The template is `As a <role>, I want <capability>, so that <outcome>` — and the third clause is the one that does the work. If the "so that" restates the "I want", the story has no user outcome and is probably a task.

| Weak | Strong |
|---|---|
| As a user, I want the inventory feature | As a shopper, I want to see live stock on the product page, so that I don't order what isn't available |
| As an admin, I want a toggle | As an admin, I want to hide stock figures per item, so that pre-release items don't advertise a quantity |
| As a user, I want the integration to work | As a sales rep, I want a new customer to reach the CRM within 15 minutes, so that I can call them the same day |

Name a **real role from the project's role list**, never "user", unless the capability genuinely belongs to everyone including anonymous visitors.

---

## Acceptance criteria

These become the test-case baseline, so they carry the same burden as an expected result: **each one must be able to fail.**

- "The page works correctly" cannot fail. "The total equals the sum of online locations" can.
- One assertion per numbered line. A line with an "and" in it is usually two criteria.
- Copy the wording from the solution document where it exists. Paraphrasing is how a criterion quietly changes meaning between the spec and the test.
- Where you have added a criterion the document does not contain, mark it: `3. *(Inferred)* An empty state shows when no location holds stock.`

**Negative criteria matter more than positive ones.** "A Level 2 user can see their own invoices" is weak on its own; paired with "and cannot reach another account's invoices" it is an actual assertion. For anything scoped, write both halves.

---

## Out of scope, open questions, notes

Three short sections, each omitted when empty:

- **Out of scope** — what a reader would reasonably assume is included but isn't, with the reason. Stops the same argument recurring at UAT.
- **Open questions** — what the document does not settle, and **who to ask**. A named gap is what stops the next person inventing an answer.
- **Notes** — anything a developer or tester needs that isn't a criterion: a dependency, a known collision with another story, a decision from a call that supersedes the written spec.

Where a call decision and the solution document disagree, say so here and name both. Do not silently pick the more recent one — the conflict is itself a finding.

---

## What goes in the Jira ticket

The ticket body is the story file's content from `## Story` down, as markdown. What must **not** go in:

- Credentials, test logins or session URLs — ever, under any heading.
- Pasted passages of the solution document. Cite `§14` and let the reader open the source; the documents are local-only and must not be republished into a tracker.
- Customer or client data used as an example. Use an identifier, not a name.

Summary line is `<US-id> — <story title>`, which is what makes the ticket findable from the file and the file findable from the ticket.
