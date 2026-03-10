# Compound Lessons

This file is the single checked-in durable artifact for distilled engineering lessons learned from audits, forge runs, incidents, and repeated workflow failures. If a lesson should survive chat history and alter future engineering behavior, it belongs here.

## Canonical Boundary

Store only durable lessons here: short, reusable guidance that future plans, implementations, or reviews should be able to rely on.

Do not create competing lesson logs in plan files, audit notes, `.context/`, or workspace memory. Those surfaces may hold raw evidence, local context, or task history, but `docs/compound-lessons.md` is the only checked-in place where those inputs are distilled into standing engineering guidance.

Do not use this file for task status, one-off debugging notes, or personal workspace context. Keep raw findings in the originating audit, forge run, incident writeup, or task thread. Keep shipped-document coverage in `docs/INVENTORY.md`.

## Ownership

- The engineer landing the codified change owns adding or updating the lesson entry when a recurring pattern is discovered.
- The reviewer approving that change owns checking whether the lesson was promoted here or explicitly judged unnecessary.
- If the lesson is discovered before the codification lands, record the lesson first and backfill the applied reference once the fix or guidance exists.

## Promotion Rules

- Add an entry when an audit, forge run, or repeated workflow failure reveals a pattern that should change how the project is planned, built, reviewed, or operated.
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

Before adding an entry, search this file for the same pattern, affected subsystem, and likely tags. If an existing lesson already covers the issue, update that entry with the refined lesson text, source, or applied reference instead of creating a duplicate. Add a new entry only when the new lesson is materially distinct.

The review gate is mandatory: every PR that introduces or codifies one of the triggers above must be reviewed for lesson promotion before merge. If no new or updated lesson is needed, the PR description or review discussion should make that judgment explicit.

## Entry Format

Each lesson entry stays short and uses this template:

```md
### YYYY-MM-DD - Short title
Tags: #audit #forge #workflow
Lesson: 1-3 sentences describing the durable lesson and the behavior future work should follow.
Source: audit ID, forge run, incident, or repeated workflow failure
Applied: commit, PR, or doc that codified the lesson (optional until it exists)
Status: active
```

Format notes:

- `Lesson:` is the distilled rule, not a replay of the full incident.
- `Source:` points back to the raw evidence.
- `Applied:` is where the lesson became checked-in guidance or code.
- `Status:` is optional while active; use it when marking an entry `superseded` or `stale`.

## Review Expectations

- Reviewers should use the promotion workflow above when checking audits, postmortems, and workflow-driven changes for durable lessons.
- Plan, forge, and audit reviewers should ask whether the change exposed a reusable lesson that belongs here.
- A change that claims to close a recurring workflow, quality, or process gap should usually update this file or explain why no durable lesson was produced.
- PR review should include an explicit dedup check: confirm the author searched for an existing lesson first and updated it instead of adding a near-duplicate entry.
- Refer to this file during drafting and auditing to avoid rediscovering known failures.

## Lessons

No compound lessons recorded yet.
