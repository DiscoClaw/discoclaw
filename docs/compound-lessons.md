# Compound Lessons

This file is the single checked-in durable artifact for distilled engineering lessons learned from audits, forge runs, postmortems, incidents, task/chat context, and repeated workflow failures. If a lesson should survive chat history and alter future engineering behavior, it belongs here.

## Canonical Boundary

Store only durable lessons here: short, reusable guidance that future plans, implementations, or reviews should be able to rely on.

Do not create competing lesson logs in plan files, audit notes, `.context/`, or workspace memory. Those surfaces may hold raw evidence, local context, or task history, but `docs/compound-lessons.md` is the only checked-in place where those inputs are distilled into standing engineering guidance.

Do not use this file for task status, one-off debugging notes, or personal workspace context. Keep raw findings in the originating audit, forge run, postmortem, incident writeup, or task thread. Keep shipped-document coverage in `docs/INVENTORY.md`.

## Ownership

- The engineer landing the codified change owns adding or updating the lesson entry when a recurring pattern is discovered.
- The reviewer approving that change owns checking whether the lesson was promoted here or explicitly judged unnecessary.
- If the lesson is discovered before the codification lands, record the lesson first and backfill the applied reference once the fix or guidance exists.

## Promotion Rules

- Promote a lesson entry when an audit, forge run, postmortem, incident, task thread, implementation chat, or repeated workflow failure reveals a pattern that should change how the project is planned, built, reviewed, or operated.
- Update an existing entry instead of creating a near-duplicate when the new evidence reinforces or refines the same lesson.
- Prefer landing the lesson in the same change that updates the code, prompt, doc, or workflow rule it affects.
- If a lesson stops being current, do not delete it silently. Mark it as superseded or stale and link the replacement guidance.

## Promotion Workflow

Promotion is an explicit workflow step, not an optional cleanup task. Check this flow whenever work exposes a reusable lesson:

1. Audit pattern trigger: when a forge audit, manual audit, or review loop finds a repeated failure mode, control gap, or implementation pattern that future work should proactively avoid or apply.
2. Postmortem trigger: when an incident writeup, plan postmortem, rollback summary, or failed execution review identifies a durable corrective lesson beyond the one-off timeline.
3. Chat/workflow discovery trigger: when a task thread, implementation chat, or repeated operator workflow reveals a planning, review, prompting, or execution habit that should become standing guidance.

Use the following source taxonomy when deciding whether raw material qualifies for promotion:

- Audits: promoted lessons should come from repeated findings, systemic gaps, reviewer notes, or audit conclusions that generalize beyond one diff.
- Postmortems: promote the corrective principle, guardrail, or planning rule derived from incident analysis, not the incident narrative itself.
- Chat and workflow context: promote only discoveries backed by repeated friction, a resolved confusion, or a codified workflow change that future engineers should inherit.

Before adding an entry, search this file for the same pattern, affected subsystem, and likely tags. If an existing lesson already covers the issue, update that entry with the refined lesson text, source, or applied reference instead of creating a duplicate. Add a new entry only when the new lesson is materially distinct. If the search finds no matching entry and the current change still does not yield materially distinct reusable guidance, record an explicit "no promotion needed" decision in the PR or review discussion instead of forcing a lesson entry.

The review gate is mandatory: every PR that introduces or codifies one of the triggers above must be reviewed for lesson promotion before merge. The review must record one explicit decision: update an existing lesson, add a materially distinct new lesson, or record that no promotion is needed. If no new or updated lesson is needed, the PR description or review discussion should make that judgment explicit.

## Entry Format

Each lesson entry stays short and uses this template:

```md
### YYYY-MM-DD - Short title
Tags: #audit #postmortem #workflow #task
Lesson: 1-3 sentences describing the durable lesson and the behavior future work should follow.
Source: audit ID, forge run, postmortem, incident, task thread/chat context, or repeated workflow failure
Applied: commit, PR, or doc that codified the lesson (optional until it exists)
Status: active
```

Format notes:

- `Lesson:` is the distilled rule, not a replay of the full incident.
- `Source:` points back to the raw evidence, including postmortems and task/chat context when those are the promotion trigger.
- `Applied:` is where the lesson became checked-in guidance or code.
- `Status:` is optional while active; use it when marking an entry `superseded` or `stale`.

## Review Expectations

- Reviewers should use the promotion workflow above when checking audits, postmortems, and workflow-driven changes for durable lessons.
- Plan, forge, and audit reviewers should ask whether the change exposed a reusable lesson that belongs here.
- A change that claims to close a recurring workflow, quality, or process gap must either update this file or explicitly record that no durable lesson was produced before merge.
- PR review should record the promotion decision explicitly: existing lesson updated, materially distinct new lesson added, or no promotion needed.
- PR review should include an explicit dedup check: confirm the author searched for an existing lesson first and updated it instead of adding a near-duplicate entry.
- Refer to this file during drafting and auditing to avoid rediscovering known failures.

## Lessons

### 2026-03-12 - Preserve Discord.js instance context in narrowed thread wrappers
Tags: #discord #cron #task
Lesson: When narrowing Discord.js channel or thread objects into custom interfaces, either keep the original object and call its methods directly or bind any copied prototype mutators before invoking them. Methods like `edit()` and `setName()` depend on the live Discord.js instance context (`this.client.rest`), so unbound wrappers can throw before any REST request is attempted.
Source: task-thread lifecycle fix `ws-925` plus task thread `ws-1220` - both exposed wrapper code that copied Discord.js thread mutators without preserving `this`
Applied: docs/compound-lessons.md
Status: active

### 2026-03-10 - Prompt changes can orphan cron state
Tags: #workflow #cron #state
Lesson: When a cron prompt is updated, existing persisted state may become obsolete (for example, dedup IDs for a strategy the prompt no longer uses). The system warns but does not auto-clear, because some prompt changes are compatible with existing state. Operators must explicitly clear stale state via `cronUpdate` with `state: "{}"` in the same action that changes the prompt.
Source: task thread ws-1211 - email cron carried stale seen_ids state after prompt moved dedup to shell script
Applied: docs/compound-lessons.md
Status: active

### 2026-03-10 - Keep interactive Discord trigger context in sync
Tags: #workflow #task #discord
Lesson: Interactive Discord trigger paths, including the message handler and reaction handler, must hydrate equivalent conversational context, including nearby channel history. When adding or changing an interactive trigger path, audit it against the main message handler's context-gathering steps so the AI does not ask for information that is already present in-channel; cron and webhook paths are non-interactive and exempt from this invariant.
Source: task thread/chat context - reaction handler missed recent channel history that the main message handler already includes
Applied: docs/compound-lessons.md
Status: active
