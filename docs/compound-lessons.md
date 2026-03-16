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

### 2026-03-14 - Give Discord auto-follow-up turns explicit lifecycle ownership
Tags: #discord #workflow #task
Lesson: Interactive Discord action auto-follow-up turns must attach to a concrete placeholder message with a user-visible lifecycle instead of starting silently in the background. Post the placeholder first, start the single watchdog against that Discord message before launching the follow-up runtime turn, and let that watchdog own timeout/dedupe plus terminal state updates such as `pending`, `stalled`, `completed`, `failed`, and `completed after delay`.
Source: task/chat context - interactive action follow-up chains could go silent when runtime execution started before placeholder posting and watchdog ownership were established
Applied: docs/compound-lessons.md
Status: active

### 2026-03-14 - Separate research from final artifact turns
Tags: #forge #workflow #prompting
Lesson: For plan- and artifact-producing flows, separate open-ended research from the final strict-output turn whenever possible. Bounded inputs and fixed candidate sets are more reliable than asking one turn to both discover context and emit the final durable artifact, and this guidance should be treated as cross-runtime default shaping unless an adapter proves it can handle the combined turn robustly.
Source: multi-day `ws-1223` forge/native audit, where both native and CLI Codex behaved better once discovery and final artifact emission were split into separate stages
Applied: docs/audit/codex-native-forge-route-audit.md
Status: active

### 2026-03-14 - Do not treat Codex native turns as a drop-in file-tool agent
Tags: #runtime #codex #forge #workflow
Lesson: When routing forge or planning work to Codex, do not assume prompt-time tool labels like `Read`, `Glob`, and `Grep` are a real enforced Codex-side contract. Codex native/app-server turns behave more like a lower-level transport over generic shell-style actions, and long strict artifact-revision turns can be nondeterministic even when chat and audit turns are healthy. Separate discovery from final artifact writing, prefer bounded inputs over open-ended research, and design Codex flows expecting hybrid/native-to-CLI recovery rather than pure-native determinism.
Source: multi-day `ws-1223` native forge audit and harness repros, including repeated native revision-grounding/revision-write stalls with the app-server path while CLI salvage remained healthy
Applied: docs/audit/codex-native-forge-route-audit.md
Status: active

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

### 2026-03-15 - Local cron persistence is canonical; Discord threads are a projection
Tags: #cron #discord #architecture #state
Lesson: `CronRunStats` local persistence is the single canonical source of truth for automation existence, schedule, and run history. Discord cron threads are a synchronized projection and operator-facing UI, not the authority. Discord thread deletion, Discord outages, or startup healing that re-creates threads must never imply that the canonical automation was deleted or should be removed. Reconciliation flows must treat the local store as authoritative and rebuild the Discord projection from it, never the reverse.
Source: task/chat context - cron lifecycle work (ws-1235 follow-up) exposed that thread loss during restart healing or Discord-side deletion could be misread as automation removal if Discord state were treated as canonical
Applied: docs/compound-lessons.md
Status: active

### 2026-03-15 - Classify capability refusals as code-path vs prompt-behavior bugs
Tags: #prompting #discord #workflow
Lesson: When the AI refuses a capability the user expects, first classify the bug: (a) code-path availability — the action was never injected into the turn's action inventory, so the AI correctly reported it unavailable; or (b) prompt-behavior — the action was present in the per-turn inventory but the AI refused anyway, treating a live capability as manual-only. Category (a) is fixed by ensuring the action surfaces in the guild-chat prompt's action list for eligible turns. Category (b) is fixed by grounding the AI's capability statements in the actual action inventory injected for that turn, not in stale training-data assumptions about what is or is not available. Always check the live action inventory before assuming either cause.
Source: task/chat context - `cronCreate` was present in the per-turn Discord action inventory but Weston still answered as if cron creation were manual-only, revealing that the refusal was a prompt-behavior problem, not a missing code path
Applied: docs/compound-lessons.md
Status: active

### 2026-03-15 - Derive prompt text from runtime-resolved config, not static literals
Tags: #prompting #workflow #runtime
Lesson: When generated action documentation or prompt sections describe runtime defaults (e.g. the default image-generation model), derive that text from the same runtime-resolved config that the execution path uses. Static literals in prompt text will drift after `!models set` overrides, env changes, or provider fallbacks, causing the AI to explicitly force a stale model name instead of omitting the field and letting the runtime default take effect.
Source: task/chat context - `imagegenActionsPromptSection()` emitted static model guidance while `resolveDefaultModel()` and `!models set imagegen` used runtime config, causing the AI to hard-code `gpt-image-1` even when a different default was configured
Applied: (PR implementing runtime-resolved imagegen default in prompt section and `!models set imagegen` persistence)
Status: active

### 2026-03-16 - Never interpolate untrusted identifiers into URL path segments without strict validation
Tags: #audit #workflow #runtime
Lesson: Never interpolate user-controlled or externally sourced identifiers (model names, resource IDs, etc.) into URL path segments without strict allowlist or pattern validation at the interpolation site. Even when the caller already validates, keep sink-level validation so that future call sites or refactors cannot bypass the check. The Gemini REST paths (`.../models/${model}:predict`, `:generateContent`, `:streamGenerateContent`) were vulnerable to path injection via crafted model values containing slashes, colons, or percent-encoded characters; a shared `validateGeminiModelId` guard now enforces a safe character set before any URL is constructed.
Source: security audit of Gemini REST URL interpolation sites in `src/runtime/gemini-rest.ts` and `src/discord/actions-imagegen.ts`
Applied: `src/gemini-model-validation.ts`, sink-level calls in `gemini-rest.ts` and `actions-imagegen.ts`
Status: active

### 2026-03-10 - Keep interactive Discord trigger context in sync
Tags: #workflow #task #discord
Lesson: Interactive Discord trigger paths, including the message handler and reaction handler, must hydrate equivalent conversational context, including nearby channel history. When adding or changing an interactive trigger path, audit it against the main message handler's context-gathering steps so the AI does not ask for information that is already present in-channel; cron and webhook paths are non-interactive and exempt from this invariant.
Source: task thread/chat context - reaction handler missed recent channel history that the main message handler already includes
Applied: docs/compound-lessons.md
Status: active

### 2026-03-16 - New mutating action categories must opt into requester gating
Tags: #audit #workflow #discord
Lesson: Any new Discord action category that performs config mutations or privileged operations must be requester-gated behind the `DISCORD_ALLOW_USER_IDS` allowlist. When a new category is added, `withoutRequesterGatedActionFlags` in `src/discord/action-flags.ts` must be updated in lockstep to strip that category's flag for non-allowlisted requesters. Forgetting to add the category there means untrusted requesters (bot-triggered turns, non-allowlisted users, cron with untrusted authors) silently retain access to the mutating actions.
Source: security audit of config-mutating bot actions — model selection, model reset, image-generation role, and voice settings were exposed to arbitrary requesters before requester gating was applied
Applied: `src/discord/action-flags.ts`, `src/discord/actions.ts`, `src/config/config-actions.ts`, requester-gating checks in message-coordinator and cron executor
Status: active

### 2026-03-16 - Bound action-result payloads and surface model truncation explicitly
Tags: #discord #prompting #runtime #workflow
Lesson: Two reusable patterns for follow-up prompt reliability: (1) action-result payloads (e.g. `readMessages`, `cronShow`) must be bounded/truncated before they are injected into follow-up prompts — unbounded output crowds out the reasoning and action blocks the model needs to produce a useful next turn; (2) model response truncation caused by output-token limits must be surfaced as explicit runtime metadata (e.g. a `finish_reason` or `truncated` flag) rather than inferred from stream termination alone, so the orchestrator can detect incomplete responses and retry or inform the user instead of silently forwarding a cut-off answer.
Source: task/chat context - oversized `readMessages`/`cronShow` action results caused follow-up prompt failures; silently truncated model responses were mistaken for complete answers
Applied: docs/compound-lessons.md
Status: active
