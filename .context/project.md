# Project Context — Discoclaw

Standing constraints for planning and auditing. These apply to all forge/plan operations.

## Architecture

- Single-user system (one Discord bot, one human operator). No concurrent access guards needed.
- Phase runner already has its own writer lock — don't design new locking mechanisms.
- No cancellation/abort support required beyond what already exists.

## Stack

- TypeScript, Node >=20, pnpm
- Vitest for tests
- Plans stored in workspace/plans/

## Conventions

- Keep changes minimal — don't over-engineer for hypothetical multi-user scenarios.
- Prefer wiring existing systems together over building new abstractions.
- Tests are required for new functionality.

## Plan Scope & Size Constraints

Plans that grow too large fail — they blow past token limits, cause audit/revise loops to diverge, and produce specs no human will review. These constraints prevent that.

### Scope limits
- A plan should target **3–5 files** max. If a feature touches more, decompose into multiple sequential plans before drafting.
- If a plan requires more than **3 new exported functions/types**, it's too big. Split it.

### Size limits
- Plan content (excluding the Audit Log section) should not exceed **200 lines**. If the draft exceeds this, the scope is too large.
- Audit resolutions should be **1–3 sentences**. If a resolution needs multiple paragraphs, the concern reveals a scope problem — recommend splitting the plan rather than elaborating.

### Detail level
- Describe **what to change and why**, not exact line numbers or inline code. The implementing agent reads the codebase itself — it doesn't need the plan to be a diff.
- File-by-file changes: name the file, describe the modification in 2–4 sentences. No type signatures, no code blocks, no "at line N" references.
- Test cases: describe the scenario and expected outcome. Don't write the test code in the plan.

### Auditor guidance
- Do NOT flag "underspecified implementation details" as medium/high. The plan describes intent and scope — the implementing agent fills in the details.
- DO flag: missing scope items, incorrect assumptions about existing code, safety/correctness issues, missing error handling for external boundaries.
- If a plan is too large or touches too many files, flag that as **high severity** with recommendation to split.