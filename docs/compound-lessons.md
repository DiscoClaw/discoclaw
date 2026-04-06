# Compound Lessons

This file is the single checked-in durable artifact for distilled engineering lessons learned from audits, forge runs, postmortems, incidents, task/chat context, and repeated workflow failures. If a lesson should survive chat history and alter future engineering behavior, it belongs here.

## Canonical Boundary

Store only durable lessons here: short, reusable guidance that future plans, implementations, or reviews should be able to rely on.

Do not create competing lesson logs in plan files, audit notes, `.context/`, or workspace memory. Those surfaces may hold raw evidence, local context, or task history, but `docs/compound-lessons.md` is the only checked-in place where those inputs are distilled into standing engineering guidance.

Do not use this file for task status, one-off debugging notes, or personal workspace context. Keep raw findings in the originating audit, forge run, postmortem, incident writeup, or task thread. Keep shipped-document coverage in `docs/INVENTORY.md`.

## Ownership

- The engineer landing the codified change owns adding or updating the lesson entry when a recurring pattern is discovered.
- The engineer landing the codified change also owns doing the dedup search in this file and carrying the promotion outcome into PR or review text as part of the durable-artifact contract.
- The reviewer approving that change owns checking whether the lesson was promoted here or explicitly judged unnecessary.
- The reviewer approving that change also owns verifying that the dedup search happened and that exactly one explicit promotion decision was recorded before merge: update an existing lesson, add a materially distinct new lesson, or record that no promotion was needed.
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

The review gate is mandatory: every PR that introduces or codifies one of the triggers above must be reviewed for lesson promotion before merge. That review is part of this file's durable-artifact contract: it must record the dedup search and one explicit decision only once per trigger set for the change, namely update an existing lesson, add a materially distinct new lesson, or record that no promotion is needed. If no new or updated lesson is needed, the PR description or review discussion should make that judgment explicit.

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
- PR review should include an explicit dedup check: confirm the author searched for an existing lesson first, record that search in the review trail, and update the existing lesson instead of adding a near-duplicate entry when applicable.
- Refer to this file during drafting and auditing to avoid rediscovering known failures.

## Lessons

### 2026-03-21 - Finalizers must reject claimed Discord work with zero executed actions
Tags: #discord #workflow #runtime
Lesson: Treat the manual Discord message finalization boundary as an enforcement layer, not just a formatting pass. If prose claims DiscoClaw is starting or performing Discord-managed work — whether via present/future-tense intent ("I'm posting…", "I'll send…") or past-tense completion claims ("Posted the plan to the channel", "I've sent the message") — but parsing/execution yields zero actionable or executed `<discord-action>` blocks, convert that into a visible warning or failure instead of posting an ambiguous no-op. Both tenses must be detected: present/future intent catches work announced but never started, while past-tense claims catch fabricated completion with zero actions executed. Keep this runtime guard separate from prompt-time capability guidance and from follow-up lifecycle ownership so malformed, stripped, or empty action outputs cannot silently masquerade as work in progress.
Source: task/chat context - manual Discord reply finalization could leave prose that claimed Discord-managed action execution even when no actionable blocks survived parse/execute; dedup search on 2026-03-21 against the existing capability-refusal lesson and the auto-follow-up lifecycle lesson judged this runtime-boundary enforcement pattern materially distinct, so it was promoted as a new lesson
Applied: `docs/discord-actions.md`, `docs/compound-lessons.md`
Status: active

### 2026-03-20 - Automated readiness surfaces must not claim manual auth success
Tags: #audit #workflow #setup
Lesson: Setup, preflight, doctor, and install-mode-specific smoke surfaces must only claim prerequisites they can directly verify. When end-to-end readiness still depends on a separate auth step, a runtime-visible credential probe, repo smoke-path workload evidence, daemon/runtime-path parity, an explicit runtime subpath split, or a live Discord rehearsal surface, keep that boundary explicit in operator docs and point to the audit or smoke path that owns that gate instead of implying full readiness from binary presence, `.env` presence, or interactive-shell success alone. Fresh-clone source-checkout claims also need a real clone-local `.env`, and first-login/manual-auth claims only close when the same no-session shell or account records the pre-login failure, interactive login, and post-login success in sequence. Any release-readiness or rehearsal surface that touches live Discord state must also enforce or explicitly disclose its config source, namespace, teardown contract, and blocked-verdict rule for unresolved leftovers. When one provider exposes multiple runtime subpaths with different guarantees, name those subpaths explicitly in operator docs and inventory instead of collapsing them into a single support claim; for Gemini, `gemini-api` and `gemini-cli` must stay distinct, `gemini` is only a compatibility alias for `gemini-api`, and the CLI path's limited status should be tied to the existing capability gate that strips unsupported tools before invocation.
Source: `docs/audit/claude-blank-machine-readiness.md` blank-machine audit; `docs/audit/claude-npm-managed-path.md` npm-managed audit; `docs/audit/openrouter-api-key-support-boundary.md` OpenRouter support-boundary audit; Gemini runtime-boundary doc slice for `ws-1288`; `docs/audit/claude-blank-machine-path.md` throwaway source-checkout audit; `CLAUDE SOURCE-CHECKOUT STATUS.md` closeout memo; release-rehearsal doc refinement for the blessed Claude source-checkout Discord path; dedup search on 2026-03-22 against this readiness-boundary lesson plus the existing cron/task state lessons concluded the rehearsal-contract disclosure was a refinement of this lesson rather than a materially distinct new entry; before-merge promotion decision for this change: updated existing lesson
Applied: `docs/configuration.md`, `docs/runtime-switching.md`, `docs/discord-bot-setup.md`, `docs/releasing.md`, `docs/INVENTORY.md`, `docs/compound-lessons.md`, `scripts/release-rehearsal.ts`, `docs/audit/claude-blank-machine-readiness.md`, `docs/audit/claude-npm-managed-path.md`, `docs/audit/openrouter-api-key-support-boundary.md`, `docs/audit/claude-blank-machine-path.md`, `CLAUDE SOURCE-CHECKOUT STATUS.md`
Status: active

### 2026-03-20 - Stage terminal Discord summaries durably before risky delivery
Tags: #discord #workflow #state
Lesson: When a run is about to emit its terminal user-visible Discord artifact, stage the final recovery payload durably before any risky edit/send so retries and startup recovery can repost the real summary instead of inventing one later. Durable recovery is a promotion path, not a second visible artifact: if a transient interruption placeholder already exists, the recovered payload must replace that placeholder in place; if the run ends with an explicit abort summary such as `*(Response aborted.)*`, that abort artifact owns visibility alone and any staged-but-unposted recovery payload must be cleared so restart recovery cannot repost a competing second message later. Treat that staged payload as part of this file's durable-artifact contract: normalize and bound it before persistence, explicitly acknowledge successful visible delivery back into the durable state, and convert staging failure into an explicit visible failure notice rather than a silent recoverable-success path.
Source: task/chat context - long-run Discord reply finalization could lose the only visible success reply on successful no-prose or tool-heavy paths because recovery persisted completion state without enough user-visible summary detail; follow-up interruption and restart-recovery handling showed the same durable payload could also compete with interruption placeholders and explicit abort summaries unless recovered delivery replaced transient placeholders in place and cleared staged payloads after visible aborts; dedup search on 2026-03-23 against this restart/final-delivery lesson and the existing auto-follow-up lifecycle ownership entry concluded this was a refinement of the durable final-delivery contract rather than a materially distinct new lesson; before-merge promotion decision for this change: updated existing lesson
Applied: docs/configuration.md, docs/compound-lessons.md
Status: active

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

### 2026-03-10 - Prompt and input-stage changes can orphan cron state
Tags: #workflow #cron #state
Lesson: When a cron job's reasoning boundary changes, existing persisted state may become obsolete even if the schedule stays the same. Treat prompt rewrites, `inputMode` flips, `inputShell` changes, and moves between prompt-only and shell-input collection as state-schema changes; the system warns but does not auto-clear, so operators must clear or reseed stale state via `cronUpdate` in the same change that moves the logic.
Source: task thread ws-1211 - email cron carried stale seen_ids state after prompt moved dedup to shell script; dedup search on 2026-03-20 found this as the closest existing cron-state lesson and updated it instead of adding a near-duplicate shell-input lesson
Applied: docs/cron.md, docs/cron-patterns.md, docs/compound-lessons.md
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

### 2026-03-15 - Derive operator-facing runtime/model surfaces from the shared runtime contract
Tags: #prompting #workflow #runtime
Lesson: When operator-facing surfaces describe runtime names, defaults, persistence, or reset behavior, derive that text from the same runtime-resolved config and shared runtime-path contract that startup parsing and live switching enforce. `!models`, prompt sections, doctor/docs, and similar surfaces must render canonical runtime names, accepted aliases, supported placements, and persistence semantics from that shared source instead of static literals or hand-maintained tables; otherwise they drift into invalid names, imply nonexistent overlays such as `chatRuntime`, or erase intentional differences such as `anthropic` being voice-only.
Source: task/chat context - `imagegenActionsPromptSection()` previously emitted static model guidance while `resolveDefaultModel()` and `!models set imagegen` used runtime config, and later runtime-path work exposed the same drift pattern across startup parsing, `!models`, doctor/docs, and operator guidance; dedup search on 2026-03-21 against the existing readiness-boundary lesson and this runtime-resolved-config lesson concluded this was a refinement of the existing runtime-resolved-config pattern rather than a distinct new lesson; before-merge promotion decision for this change: updated existing lesson
Applied: `src/runtime/runtime-path-contract.ts`, `src/discord/models-command.ts`, `src/discord/actions-config.ts`, `src/health/config-doctor.ts`, `docs/configuration.md`, `docs/runtime-switching.md`, `docs/compound-lessons.md`
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
Lesson: Two reusable patterns for follow-up prompt reliability: (1) action-result payloads (e.g. `readMessages`, `cronShow`) must be bounded via microcompaction before they are injected into follow-up prompts, not pasted back as full raw payloads. Keep the continuation-critical details already present in current summaries and errors — identifiers, paths, labeled status/context fields, section headers with first values, actionable failures, and retry/next-action clues — while omitting repetitive bulk text that does not help the next turn; (2) model response truncation caused by output-token limits must be surfaced as explicit runtime metadata (e.g. a `finish_reason` or `truncated` flag) rather than inferred from stream termination alone, so the orchestrator can detect incomplete responses and retry or inform the user instead of silently forwarding a cut-off answer.
Source: task/chat context - oversized `readMessages`/`cronShow` action results caused follow-up prompt failures; later follow-up-payload refinements showed the bounded path must preserve representative IDs, paths, labeled fields, failure context, and next-step clues instead of only truncating for size. Dedup search on 2026-04-05 found this was the same durable lesson rather than a materially distinct new one, so the before-merge promotion decision for the refinement was: updated existing lesson
Applied: `docs/discord-actions.md`, `docs/compound-lessons.md`
Status: active

### 2026-03-16 - Design self-improvement pipelines as a frozen-input data pipeline before wiring orchestration
Tags: #workflow #prompting #architecture
Lesson: When building a self-improvement or prompt-tuning harness, implement the core data pipeline (load frozen test cases → mutate instruction text → score against expected output) as standalone pure-function modules with full test coverage before wiring CLI runners, keep/revert logic, or reporting. Frozen test suites (`action-compliance.json`) must be schema-validated at load time and test cases must carry stable IDs so scoring results are reproducible across mutation iterations. Separating the pipeline from the orchestrator prevents the scoring logic from coupling to execution concerns and makes each stage independently testable.
Source: plan-587 Phase A implementation — self-improve harness built as loader/mutator/scorer modules with frozen action-compliance test suite, validated by dedicated test files before any CLI or Discord integration
Applied: `src/self-improve/` (types, loader, mutator, scorer), `test-suites/action-compliance.json`
Status: active

### 2026-03-18 - Harden long-running test harnesses with isolation, diagnostics, progress, and cleanup
Tags: #workflow #architecture #task
Lesson: Long-running test suite runners must implement four hardening layers: (1) error isolation — wrap each test case in try/catch so individual failures produce error results instead of aborting the suite; (2) actionable diagnostics — surface per-case error messages at the end of the run so operators can triage without re-running; (3) progress feedback — emit per-case status callbacks (index, total, ID, pass/error, duration) so operators see forward motion during multi-minute runs; (4) interrupt cleanup — register signal handlers that abort in-flight work, clean up staging artifacts, and sweep orphaned files from prior interrupted runs on startup. These layers are independent and should be designed as composable concerns (callback hooks, error-result factories, orphan sweepers) rather than monolithic try/catch blocks.
Source: plan-589 self-improve harness hardening — runner `safeSingle()` isolation, CLI `printFailureDiagnostics()`, `logProgress()` progress callback, and SIGINT/SIGTERM signal handling with `cleanupStagingFiles`/`cleanupOrphanedStagingFiles`
Applied: `src/self-improve/runner.ts` (error isolation, progress, abort signal), `src/self-improve/cli.ts` (diagnostics, progress logging, signal handling, orphan cleanup), `src/self-improve/keeper.ts` (staging file cleanup)
Status: active

### 2026-03-19 - Verify commits are on a remote branch before marking forge tasks complete
Tags: #forge #workflow #task
Lesson: The forge runner must not mark a task as complete based solely on local commits landing. A post-implementation verification step must check that commits have been pushed to a remote branch and/or a PR has been opened before allowing task completion. Local-only commits are invisible to collaborators and CI, and treating them as "done" causes false "already merged" reports when unpushed work sits on a local branch. The verification should compare `HEAD` against the remote tracking ref (e.g. `git log @{u}..HEAD`) and check for an open PR (e.g. `gh pr view`), warning or blocking completion if either is missing.
Source: forge run incident — unpushed commits on local main were reported as "already merged" because the forge runner checked only local commit state, not remote push or PR status
Applied: docs/compound-lessons.md
Status: active

### 2026-03-23 - Guild-originated onboarding must prefer the originating channel over DMs
Tags: #discord #onboarding #workflow
Lesson: When onboarding starts from a guild channel, the conversation should stay in that channel by default — falling back to DMs only when the guild channel is unavailable or the bot lacks send permissions. Defaulting to DM-first for guild-originated flows creates a confusing redirect that breaks the user's context. The channel-selection decision must happen at `start()` time using explicit `ChannelContext` (guild channel ID + send-permission check), and the message coordinator must verify `ViewChannel | SendMessages` permissions before committing to guild mode. The flow's `channelMode` property then drives all downstream routing: reply targets, redirect notices for wrong-channel messages, write-completion send targets, and timeout-default completion targets.
Source: task/chat context - guild-originated onboarding defaulted to DM-first because `OnboardingFlow.channelMode` initialized to `'dm'` and no `ChannelContext` was passed to `start()`; fixed by adding `ChannelContext` to the flow and permission-checking in message-coordinator before selecting channel mode
Applied: `src/onboarding/onboarding-flow.ts`, `src/discord/message-coordinator.ts`, `src/discord/message-coordinator.onboarding.test.ts`
Status: active

### 2026-03-19 - Discord Activity proxy blocks chained ESM sub-module imports
Tags: #discord #canvas #architecture
Lesson: When serving JavaScript to a Discord Activity iframe, all vendor code must be pre-bundled into single self-contained files because Discord's Activity proxy does not follow chained ES module import chains. Multi-file SDK output (the default for `@discord/embedded-app-sdk`) causes silent "Module load failed" errors as secondary network requests for sub-modules are blocked by the proxy. Build vendor dependencies into single ESM bundles at build time (e.g. via esbuild) and serve those instead of the raw SDK output directory.
Source: task ws-1266 — canvas server proxying individual module files from the SDK's `output/` directory triggered cascading load failures in the Activity iframe
Applied: vendor bundling of `@discord/embedded-app-sdk` via esbuild
Status: active

### 2026-03-24 - Runtime registry naming must encode transport semantics
Tags: #runtime #architecture #workflow
Lesson: Runtime registry keys must follow a consistent naming convention that encodes transport semantics: `-cli` suffix for local subprocess runtimes, `-api` suffix or plain name for HTTP API runtimes. Redundant aliases (`gemini` as a compatibility alias for `gemini-api`) and entries with unresolved risk (`gemini-cli` for TOS concerns) must be removed rather than carried as special cases. When consolidating, rename keys in a single coordinated change (`claude` → `claude-cli`, `anthropic` → `claude-api`, `codex` → `codex-cli`) and update all downstream consumers — runtime path contract, accepted aliases, operator docs, doctor checks, `!models` output, and prompt sections — from the shared contract so they cannot drift. The 8→6 reduction (removing `gemini` alias and `gemini-cli`, renaming three keys) eliminated ambiguity about which runtimes are local subprocesses vs HTTP calls.
Source: runtime registry consolidation — `gemini` was a redundant alias for `gemini-api`, `gemini-cli` carried TOS risk with limited capability, and `claude`/`anthropic`/`codex` keys did not encode their transport type; the existing runtime-resolved-config lesson (2026-03-15) covers deriving operator surfaces from the shared contract, but this lesson is materially distinct because it addresses the naming convention and registry-entry elimination rather than surface derivation
Applied: `src/runtime/runtime-path-contract.ts`, `docs/runtime-switching.md`, `docs/configuration.md`, `docs/compound-lessons.md`
Status: active

### 2026-03-25 - Default multi-stage workflow flags to off to prevent accidental triggers
Tags: #workflow #discord #prompting
Lesson: Feature flags that gate multi-stage workflows (plan, forge) must default to off when those workflows can be triggered by natural language patterns in normal chat. Phrases like "plan this" or "let's plan" are common enough in casual conversation that defaulting on pulls users into a heavyweight multi-step process they didn't intend. Explicit commands (`!plan`, `!forge`) issued while the flags are off should respond with a friendly nudge naming the env var that enables the feature, not silently ignore the attempt. Simple single-turn features can still default on; the default-off rule applies specifically to workflows with multi-stage execution, dedicated threads, or long-running runtime sessions.
Source: plan/forge default-off change — four flags (`DISCOCLAW_PLAN_COMMANDS_ENABLED`, `DISCOCLAW_FORGE_COMMANDS_ENABLED`, `PLAN_PHASES_ENABLED`, `FORGE_AUTO_IMPLEMENT`) flipped to default-off after natural language triggers caused unintended workflow starts for casual users
Applied: `src/config.ts`, `src/discord/plan-forge-availability.ts`, `docs/philosophy.md`, `docs/compound-lessons.md`
Status: active

### 2026-03-24 - Stateless invocations require prefix stability, not cross-turn retention assumptions
Tags: #prompting #workflow #runtime
Lesson: Each runtime invocation is stateless — the model receives only the prompt string passed to `invoke()` and retains nothing from prior turns. Optimization strategies that assume cross-turn system prompt retention (e.g., hash placeholders, omitting previously-sent preamble sections) are correctness bugs. The correct approach has two complementary parts: (1) structure prompt assembly so the static preamble (`buildPromptPreamble()`) produces byte-identical output across turns and channels, enabling Anthropic's automatic prefix matching to cache the longest matching prefix at ~90% cost reduction — this requires no explicit `cache_control` parameters; (2) reduce dynamic sections on follow-up turns by excluding per-channel context from the preamble's `contextFiles` array (via `buildPreambleContextFiles()`) and placing it in a separate post-preamble section, and by trimming conversation history to only new messages in the post-preamble zones. The preamble must be sent in full every turn; the savings come from the provider caching it automatically when the prefix bytes match.
Source: task/chat context — multi-turn follow-up token cost analysis; `buildPreambleContextFiles()` in `src/discord/prompt-common.ts` separates channel context from the preamble prefix; `docs/prompt-token-audit.md` and `docs/prompt-ordering.md` document the static vs dynamic section split
Applied: `src/discord/prompt-common.ts` (`buildPreambleContextFiles()`), `docs/compound-lessons.md`
Status: active

### 2026-03-25 - Decouple cron scheduling state from Discord thread archive state
Tags: #cron #discord #state #architecture
Lesson: Discord thread lifecycle events (auto-archive from inactivity, manual archive/unarchive) must not mutate cron scheduling state. Only explicit operator commands (`cronPause`/`cronResume`) should persist `disabled: true` to the canonical stats store. The `threadUpdate` handler must treat archive events as a UI-layer change — the cron keeps firing to its target channel because Discord threads are a synchronized projection, not the authority. Persisting `disabled: true` on auto-archive makes the flag sticky: unarchiving the thread and rebooting the bot cannot recover the cron because the stats store still reads `disabled: true` on next load. Use `pauseSource` (`'user'` vs `'system'`) to distinguish intentional pauses from automated disables so reconciliation logic can reason about recoverability.
Source: task/chat context — Discord auto-archive permanently disabled crons because `threadUpdate` persisted `disabled: true` to the stats store without distinguishing auto-archive from explicit `cronPause`; dedup search on 2026-03-25 against the existing cron-state lesson (2026-03-10) and the canonical-persistence lesson (2026-03-15) concluded this is materially distinct: those lessons address state schema drift and projection authority respectively, while this lesson addresses the specific boundary between Discord lifecycle events and scheduling state mutation
Applied: `src/cron/forum-sync.ts`, `docs/compound-lessons.md`
Status: active

### 2026-03-25 - Prompt token reduction compounds through dedup-first, compress-second, conditional-third layering
Tags: #prompting #workflow #architecture
Lesson: Prompt token optimization yields diminishing returns per round unless each round follows a strict priority order: (1) eliminate duplication across prompt layers first — this is free savings with zero behavioral risk; (2) compress retained sections by shortening field descriptions, merging rules, and tightening boilerplate; (3) make always-injected sections conditional based on context (channel type, conversation state, keyword triggers). Rounds that skip dedup and jump to compression or conditional injection leave the hardest-to-find waste in place and risk behavioral regression from removing content that was actually load-bearing. The dedup search must cross all prompt layers (preamble static text, runtime-filtered template sections, hardcoded inline text, and dynamically built sections) because duplication between layers is invisible when auditing any single layer in isolation. Measure actual injected sizes after runtime filtering, not raw file sizes — runtime section-dropping can reduce a 9,451-char file to 442 chars of injected content, making file-size audits misleading.
Source: Round 2 prompt token audit (`docs/prompt-token-audit.md`) — cross-layer dedup between trackedDefaults ("Discord Action Grounding"), hardcoded capability-refusal rule, and actionsReference rules was invisible in Round 1 because each layer was audited against its adjacent layer (trackedDefaults ↔ pa.md, TOOLS.md ↔ actionsReference) but not against hardcoded inline text in message-coordinator.ts; dedup search on 2026-03-25 against the existing prefix-stability lesson (2026-03-24) concluded that lesson addresses cross-turn prefix caching while this lesson addresses cross-layer dedup within a single turn — materially distinct
Applied: `docs/prompt-token-audit.md`, `docs/compound-lessons.md`
Status: active

### 2026-03-25 - Prefer deterministic parsing of bot-generated content before AI fallback
Tags: #cron #architecture #workflow
Lesson: When the system produces structured output (starter messages, status embeds, etc.), parse it deterministically on re-read rather than routing through an LLM. Bot-formatted content from `buildStarterContent` has a known, deterministic structure that can be matched with regex — no LLM call needed. The AI parser becomes a fallback for user-authored or legacy content only. This layering (stats-store fast path → deterministic regex parser → AI parser) eliminates unnecessary LLM calls on fresh installs and data resets, avoids timeout/API-error failures on the boot path, and makes cron-sync recoverable on subsequent cycles when all parsers fail instead of hard-disabling the cron.
Source: task/chat context — `initCronForum` boot path fell through to `parseCronDefinition` (an LLM call) when the stats store had no record for a cron thread, causing timeout and API failures that hard-disabled crons with a scary error; dedup search on 2026-03-25 against existing lessons for cron state authority (2026-03-15), state schema drift (2026-03-10), and archive-state decoupling (2026-03-25) confirmed none address parser fallback ordering for bot-generated content — this is materially distinct
Applied: `docs/compound-lessons.md`
Status: active

### 2026-04-01 - Gate capsule injection on idle detection and TTL expiry at read time, not save time
Tags: #prompting #workflow #state #architecture
Lesson: Continuation capsules must be validated at injection time (before `buildConversationMemorySection`) rather than at save time, using two independent checks ordered by cost: (1) idle detection — skip injection when `currentFocus` matches an idle/awaiting/none pattern, since the capsule carries no useful state to continue; (2) TTL-based expiry — skip injection when the parent summary's `updatedAt` exceeds a configurable staleness threshold (`DISCOCLAW_CAPSULE_TTL_MS`, default 2 hours), even if the capsule appears active. Capsules remain persisted regardless of validation outcome so they are available for debugging and tracing. Both checks are pure functions in `capsule-invalidation.ts` composed via `validateCapsuleForInjection`, and the caller in `message-coordinator.ts` nullifies the capsule before prompt assembly when validation fails, logging the skip reason.
Source: task/chat context — stale continuation capsules from prior conversations bled into unrelated new conversations because there was no injection-time gate; idle capsules with focus values like "idle", "none", or "awaiting input" injected irrelevant state, and capsules from hours-old sessions persisted active-looking focus text that no longer applied
Applied: `src/discord/capsule-invalidation.ts`, `src/discord/capsule-invalidation.test.ts`, `src/discord/message-coordinator.ts`, `.env.example`, `docs/compound-lessons.md`
Status: active

### 2026-03-28 - Do not inject history images as raw content blocks into AI prompts
Tags: #prompting #discord #workflow
Lesson: When assembling the AI prompt from conversation history, do not extract and inject images from earlier turns as raw image content blocks. Unlabeled stale images cause the model to analyze or act on old media unprompted — hallucinating relevance where there is none. The text history already notes `[attachment/embed]` when media was present, which is sufficient context. When the user explicitly wants the model to see an older image, the reply-reference mechanism handles that case by downloading only the referenced message's attachments. Keep the current-message image download path (source #1: direct attachments on the triggering message) and the reply-reference path (source #2: user explicitly replies to an older message), but do not add a third path that bulk-injects history images.
Source: task/chat context — history images from earlier conversation turns were extracted and included alongside the current prompt with no labeling, causing the model to analyze stale images unprompted; the fix removed the history image download block in `message-coordinator.ts`
Applied: `src/discord/message-coordinator.ts`, `docs/compound-lessons.md`
Status: active

### 2026-04-05 - Wire observability through all invocation flows before exposing dashboard surfaces
Tags: #observability #architecture #workflow
Lesson: When adding an observability layer (traces, metrics), wire the store into every invocation flow (message, reaction, cron, defer) before exposing it through API endpoints or dashboard sections. A dashboard that only shows data from one flow creates a false picture of system health — operators see green metrics while untraced flows fail silently. The wiring should follow a consistent pattern across flows: `startTrace` at entry, `addEvent` at each significant stage (invoke start/end, tool calls, action results, errors), and `endTrace` with an outcome at every exit path including error/abort. Expose the store through typed API response builders (`buildTracesResponse`, `buildMetricsResponse`) that delegate to the singleton store's `summary()` and `listRecent()` methods rather than reaching into internal state. Keep the store, the flow instrumentation, and the API surface as three independent layers so each is testable in isolation.
Source: observability layer implementation — TraceStore was implemented and wired into the message flow first, then extended to reaction handler, cron executor, and defer paths; dashboard API endpoints for `/api/metrics` and `/api/traces` were added after all flows were instrumented
Applied: `src/observability/trace-store.ts`, `src/observability/metrics.ts`, `src/observability/trace-utils.ts`, `src/discord/message-coordinator.ts`, `src/discord/reaction-handler.ts`, `src/discord/deferred-runner.ts`, `src/cron/executor.ts`, `src/dashboard/api/traces.ts`, `src/dashboard/api/metrics.ts`
Status: active
