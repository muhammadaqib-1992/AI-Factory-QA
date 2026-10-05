# Architecture — QA Agentic Workspace

How this workspace is put together, and *why* each piece is where it is. Read this once before you extend it; it will save you from putting knowledge in the wrong primitive.

---

## The core idea

A QA agent is only as good as the context it can reach and the procedures it follows consistently. This workspace supplies both, without paying for either on every turn:

- **Knowledge** lives in `knowledge-base/`, indexed so the agent reads a summary before it ever opens a source document.
- **Procedures** live in `.claude/skills/`, loaded only when the task calls for them.

The whole design serves one constraint: **the context window is shared between your conversation and everything the agent loads.** Every architectural choice below is ultimately about not wasting it.

---

## Four primitives, four jobs

Getting these confused is the most common way to build the wrong thing.

| Primitive | Loads | Use it for |
|---|---|---|
| **CLAUDE.md** | Every conversation, always | Project-wide standards that always apply |
| **Skills** | On demand, when the request matches | Task-specific procedures and expertise |
| **Subagents** | When you delegate | Isolated execution contexts for parallel or noisy work |
| **MCP servers** | Always available as tools | Reaching external systems (browser, tracker, database) |

Rules of thumb:

- If it must be true in **every** conversation → `CLAUDE.md`.
- If it is a **procedure for a kind of task** → a skill.
- If it needs **its own context window** → a subagent.
- If it talks to **something outside this machine** → an MCP server.

Do not force everything into skills. Anything deterministic — signing in, building a PDF, recording which tickets were tested — belongs in a script the skill runs, not in instructions the model re-derives.

---

## Skill anatomy

```
skill-name/
├── SKILL.md          # required — frontmatter + the procedure
├── references/       # documentation loaded only when needed
├── scripts/          # executable code — RUN, never read
└── assets/           # templates, images, data files used in output
```

### Frontmatter fields

| Field | Required | Notes |
|---|---|---|
| `name` | yes | lowercase, digits, hyphens. Max 64 chars. **Must match the directory name.** |
| `description` | yes | **Max 1,024 characters.** The single most important field — matching is done against it. |
| `allowed-tools` | no | Restricts which tools the agent may use while the skill is active |
| `model` | no | Pins a model for this skill |

The 1,024 limit is a hard one. Run `python scripts/validate_skills.py` from the repo root to check every skill at once — an over-length description risks being cut exactly where its trigger words are.

### Writing a description that actually triggers

The description answers **"when should this run?"**, not "what is this about". Be explicit and name the phrases a user would really type. Compare:

- Weak: `"Helps with testing."`
- Strong: `"Writes test cases from requirements... Use whenever the user asks to 'write test cases', 'create TCs', 'cover this requirement', or names a feature and wants it turned into testable steps. Do NOT use for executing existing test cases — that is qa-test-execution."`

State the negative case too. Overlapping skills that don't say what they are *not* for will fight each other.

### Progressive disclosure

`SKILL.md` is loaded in full whenever the skill triggers, so keep it lean — **under 500 lines**, and well under that if you can. Anything that is *lookup material rather than procedure* belongs in `references/`, linked with an explicit condition:

```markdown
**Only load `references/priority-and-labels.md` when you are actually assigning a
priority or label** — it holds the full decision tables.
```

That sentence is doing real work: it tells the agent when the file is worth the tokens.

### Scripts: run, don't read

A script in `scripts/` executes without its source entering the context window — **only its output costs tokens.** Use one whenever the work is:

- **Deterministic data lookup** (query a matrix, parse an export)
- **Environment validation** (is everything connected before a long run?)
- **Anything more reliable as tested code than as code regenerated from scratch each time**

`qa-permission-testing/scripts/lookup_permission.py` is the worked example. Without it, the agent re-derives spreadsheet-parsing code on every run and pulls rows into context to do it. With it, a lookup costs three lines of output.

Say so explicitly in `SKILL.md`: **"Run this script — do not read it."**

### allowed-tools, and when to skip it

A read-only research skill has no business writing files or driving a browser:

```yaml
allowed-tools: Read, Grep, Glob, Bash
```

If its matching ever misfires, the blast radius is capped. **But be careful with MCP tools** — in some clients their names carry a per-connection identifier, so pinning them in a shared repo can break the skill for every other teammate. Restrict on stable built-in tool names; leave MCP-dependent skills open and rely on the skill's own confirmation steps instead.

---

## Skill priority and naming

When two skills share a name, precedence is:

1. **Enterprise** (managed settings) — highest
2. **Personal** (`~/.claude/skills`)
3. **Project** (`.claude/skills` in the repo)
4. **Plugins** — lowest

Two consequences for a shared repo like this one:

- **Personal beats project.** If a teammate has a personal skill with the same name as one here, theirs silently wins and your team stops sharing a procedure.
- **Prefix your names.** Everything here is `qa-*`. Rename to something project-specific (`acme-qa-*`) if collisions are plausible.

---

## Subagents do not inherit skills

This one surprises people. A skill loads into **your** conversation. Delegate to a subagent and it does not see these skills unless:

- it is a **custom** agent in `.claude/agents/`, **and**
- that agent lists them in its frontmatter `skills:` field.

**Built-in agents cannot use skills at all.** So a subagent told to "write test cases" produces something that ignores your format entirely.

`.claude/agents/qa-researcher.md` shows the correct wiring. Otherwise, keep skill-driven work in the main thread.

---

## Knowledge base: index first, source second

`knowledge-base/` holds the project's documents. The rule that makes it affordable:

> **Never let the agent open raw source documents to answer a question it could answer from an index.**

Each folder carries a `README.md` or `INDEX.md` summarising what is inside. For call recordings that means date, topics, decisions, open items and participants per call. A question like *"why did we decide X?"* is then answered from a few index lines instead of a 90-minute transcript. Only when the index points at a specific source does the agent open it.

`qa-context-lookup` enforces that order and runs automatically behind the other skills.

---

## Verification: assume nothing passed until you see it

An agent reporting success is a claim, not evidence. For unattended or long runs:

- Start from the **diff and the actual test output**, not the agent's summary.
- Use **`/goal`** when you can describe "done" better than you can describe the steps — the agent keeps working until a completion condition is confirmed.
- Permission modes matter: auto-accept modes judge *danger*, not *correctness*. Check the results (record state, the report), not the agent's summary.

---

## Extending this workspace

1. Put project documents in `knowledge-base/`, and **write the index** — the index is the point.
2. Fill in the placeholders in `CLAUDE.md`.
3. Adapt the five skills; keep the naming prefix and the draft-before-write discipline.
4. Run `python scripts/validate_skills.py` before committing.
