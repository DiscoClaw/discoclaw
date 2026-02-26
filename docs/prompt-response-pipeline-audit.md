# Prompt Response Pipeline Audit (Agent Output -> Discord Response)

Date: 2026-02-22

## Summary

This audit traced all configured response paths from runtime output events to posted Discord payloads:

- Normal message pipeline in `src/discord/message-coordinator.ts`
- Auto-follow-up loop in `src/discord/message-coordinator.ts`
- Deferred follow-up pipeline in `src/index.ts` (`handleDeferredRun`)
- Cron execution pipeline in `src/cron/executor.ts`
- Runtime output normalization in `src/runtime/cli-adapter.ts` and strategy modules
- Final formatting/chunking in `src/discord/output-common.ts` and `src/discord/output-utils.ts`

Targeted tests currently passing:

- `src/discord.render.test.ts`
- `src/discord/output-common.test.ts`
- `src/discord-followup.test.ts`
- `src/discord/actions.test.ts`
- `src/runtime/claude-code-cli.test.ts`
- `src/runtime/codex-cli.test.ts`
- `src/runtime/openai-compat.test.ts`

## End-to-End Flow Map

### 1. Normal Message Flow

1. `messageCreate` routed via `startDiscordBot` in `src/discord.ts` to `createMessageCreateHandler` in `src/discord/message-coordinator.ts`.
2. Prompt is assembled from context files, memory, history, reply/thread references, then user message.
3. Runtime emits `EngineEvent` stream (`text_delta`, `text_final`, `error`, `image_data`, tool events).
4. Streaming preview edits use `selectStreamingOutput` (`src/discord/output-utils.ts`).
5. Final response is post-processed:
   - Parse/strip action blocks (`parseDiscordActions` in `src/discord/actions.ts`)
   - Execute actions (`executeDiscordActions`)
   - Append result lines (`buildDisplayResultLines`)
   - Append unavailable-action notice (`appendUnavailableActionTypesNotice`)
6. Final payload is posted via `editThenSendChunks` in `src/discord/output-common.ts`.

### 2. Auto-Follow-Up Flow

1. If query actions succeed, handler synthesizes `[Auto-follow-up]` prompt with all action results.
2. Re-invokes runtime in-loop (bounded by `actionFollowupDepth`).
3. Suppresses trivial follow-up placeholders with `shouldSuppressFollowUp`.

### 3. Deferred Follow-Up Flow

1. Runtime emits `defer` action and `DeferScheduler` stores delayed job.
2. `handleDeferredRun` in `src/index.ts` rebuilds prompt and invokes runtime.
3. Parses and executes actions, then posts via `channel.send`.

### 4. Cron Flow

1. Scheduler executes `executeCronJob` (`src/cron/executor.ts`).
2. Runtime output accumulated (`text_final` preferred over deltas).
3. Optional action parse/execute.
4. Final posting via `sendChunks` (`src/discord/output-common.ts`).

## Findings (Severity Ordered)

### Resolved: OpenAI-Compat Adapter Sent Entire Prompt As Single User Message

- Location:
  - `src/runtime/openai-compat.ts` (both tool-loop and streaming paths)
- What happened:
  - The OpenAI-compat adapter packed the entire assembled prompt (system policy, workspace context, memory, conversation history, and user message) into a single `user`-role message with no `system` message.
  - Non-Claude models (Gemini Flash via OpenRouter, etc.) treated behavioral instructions as user content, leading to sycophancy, broken action block emission, and identity confusion.
- Resolution (ws-1004, c862755):
  - Added `splitSystemPrompt()` that auto-detects the sentinel delimiter (`---\nThe sections above are internal system context.`) and splits the prompt into proper `system` + `user` messages.
  - Both the tool-loop path and streaming text path now use the split.
  - Added optional `systemPrompt` field to `RuntimeInvokeParams` for explicit caller override.
  - Tests cover: explicit systemPrompt, sentinel-based auto-split, no-sentinel passthrough.

### High: Streaming Keepalive/Tool Queue Cleanup Leak On Thrown Runtime Invocation

- Location:
  - `src/discord/message-coordinator.ts:2020`
  - `src/discord/message-coordinator.ts:2035`
  - `src/discord/message-coordinator.ts:2142`
  - `src/discord.status-wiring.test.ts:107`
- What happens:
  - In the normal message handler, keepalive interval and tool-aware queue disposal occur only on the success path after the runtime loop.
  - If `params.runtime.invoke(...)` throws (not emits `error` event), control jumps to the outer catch path before `clearInterval(keepalive)` and `taq?.dispose()` run.
  - By contrast, the reaction pipeline already protects this with `try/finally` cleanup in `src/discord/reaction-handler.ts:480` and `src/discord/reaction-handler.ts:524`.
- Impact:
  - Orphaned intervals continue firing every 5s.
  - Repeated runtime-throw scenarios can accumulate timers and stale edit attempts.
  - Increased memory/CPU churn and noisy edit failures over time.
- Reproduction:
  1. Use a runtime adapter whose `invoke` async generator throws immediately (pattern already used in `src/discord.status-wiring.test.ts:109`).
  2. Trigger multiple messages.
  3. Observe keepalive interval cleanup gap from code path and persistent periodic edit attempts.
- Patch-ready remediation:
  1. Move keepalive lifecycle into `try/finally` around each invoke iteration.
  2. Dispose `ToolAwareQueue` in the same `finally`.
  3. Drain `streamEditQueue` in `finally` to preserve final-write ordering guarantees.
  4. Keep outer error handling unchanged for user-visible error messages.
- Required tests:
  1. Add `message-coordinator` test asserting `clearInterval` is called when `runtime.invoke` throws.
  2. Add test asserting no leaked follow-up edits after thrown invocation.

### High: Destructive Action Confirmation Is Policy-Only, Not Enforced In Executor

- Location:
  - `src/discord/actions.ts:321`
  - `src/discord/actions.ts:502`
  - `src/discord/actions-moderation.ts:21`
  - `src/discord/actions-channels.ts:102`
  - `src/discord/actions-messaging.ts:178`
- What happens:
  - Prompt sections say destructive actions must be user-confirmed.
  - Execution path does not enforce confirmation server-side.
  - Any parsed destructive action is executed immediately.
- Impact:
  - Model-side misfires can directly perform destructive operations.
  - Safety posture relies entirely on model compliance, not runtime guardrails.
- Reproduction:
  1. Emit a destructive action block (for example `channelDelete`, `deleteMessage`, `kick`, `ban`) in a valid response.
  2. Action executes immediately through `executeDiscordActions`.
- Patch-ready remediation:
  1. Add a destructive action gate in `executeDiscordActions`.
  2. Maintain a short-lived confirmation token store keyed by session/channel + action fingerprint.
  3. First destructive request returns a required-confirmation message and token (no side effect).
  4. Only execute when token is explicitly confirmed by user command/response in-window.
  5. Emit structured rejection result lines for unconfirmed destructive attempts.
- Required tests:
  1. Destructive actions are blocked without confirmation.
  2. Confirmed actions execute once.
  3. Expired/replayed confirmations are rejected.

### Medium: Deferred Runs Advertise Memory Actions But Use Invalid User Context

- Location:
  - `src/index.ts:805`
  - `src/index.ts:901`
  - `src/index.ts:1106`
  - `src/discord/actions-memory.ts:66`
  - `src/discord/durable-memory.ts:22`
- What happens:
  - Deferred action prompt flags can enable memory actions (`memory: Boolean(botParams.discordActionsMemory)`).
  - Deferred executor passes template `memoryCtx` with placeholder `userId: ''`.
  - Memory writes require valid user IDs and fail via `safeUserId`.
- Impact:
  - Deferred pipeline can suggest memory actions that are guaranteed to fail.
  - Produces avoidable action failures and inconsistent behavior vs normal message path.
- Reproduction:
  1. Enable memory actions.
  2. Schedule deferred run and have model emit `memoryRemember`.
  3. Observe failure from invalid durable-memory user ID path.
- Patch-ready remediation:
  1. Immediate safe fix: force deferred `memory` flag off in `deferredActionFlags`.
  2. Longer-term: extend deferred job context to carry originating user ID and build per-run memory context like normal message flow.
- Required tests:
  1. Deferred flow with memory enabled should either hard-disable memory action parsing or provide valid user-scoped memory context.
  2. No invalid userId errors in deferred-memory path.

### Medium: Action Parser Executes Tags Inside Code Fences/Quoted Examples

- Location:
  - `src/discord/actions.ts:142`
  - `src/discord/actions.ts:213`
  - `src/discord/actions.ts:268`
- What happens:
  - Parser scans raw text for `<discord-action>...</discord-action>` without markdown-context awareness.
  - Code-fenced examples are parsed/executed like live actions.
  - Verified with runtime check: fenced `channelDelete` block is parsed into executable action.
- Impact:
  - Example snippets, quoted content, or echoed user text can trigger side effects.
  - Increases accidental-action risk and complicates safe instructional responses.
- Reproduction:
  1. Return:
     ```text
     ```
     <discord-action>{"type":"channelDelete","channelId":"123"}</discord-action>
     ```
     ```
  2. Parser returns a live `channelDelete` action (clean text leaves empty fence block).
- Patch-ready remediation:
  1. Update scanner to ignore action tags when inside fenced code blocks and inline code spans.
  2. Optionally require actions to appear in a dedicated action footer segment.
  3. Preserve backward compatibility by allowing strict-mode parsing behind a feature flag, then flipping default.
- Required tests:
  1. Tags inside triple-backtick blocks are ignored.
  2. Tags in inline code are ignored.
  3. Non-fenced action tags still parse as before.

### Medium: Deferred Pipeline Lacks Runtime/Action Observability Parity

- Location:
  - `src/index.ts:856`
  - `src/index.ts:895`
  - `src/index.ts:916`
- What happens:
  - Deferred runs do not emit `metrics.recordInvokeStart/Result`.
  - No status-channel runtime/action failure reporting parity with normal and cron flows.
  - Failures are log-only unless outgoing text is successfully posted.
- Impact:
  - Reduced operational visibility for delayed failures.
  - Harder to debug deferred pipeline regressions and user-reported misses.
- Reproduction:
  1. Trigger deferred run with a runtime/auth failure.
  2. Compare metrics/status behavior vs normal message and cron flows.
- Patch-ready remediation:
  1. Add metrics start/result emission in deferred handler.
  2. Route runtime/action failures to status poster with deferred session keys.
  3. Add explicit log fields (`flow: 'defer'`, schedule metadata, channel).
- Required tests:
  1. Deferred runtime errors increment failure metrics.
  2. Deferred action failures emit status notifications.

## Regression Test Matrix To Add

1. Message invoke throw path cleans up keepalive and tool queue.
2. Code-fenced and inline-code action tags are non-executable.
3. Destructive actions require server-side confirmation.
4. Deferred memory actions are either disabled or correctly user-scoped.
5. Deferred flow metrics/status parity with message/cron pipelines.

## Recommended Implementation Order

1. Fix cleanup leak in `message-coordinator` (low risk, high stability gain).
2. Disable deferred memory actions until user-scoped context exists.
3. Add markdown-aware action parsing guardrails.
4. Add server-side destructive confirmation enforcement.
5. Add deferred observability parity instrumentation.

## Assumptions

- This audit focuses on response transformation and delivery paths, not onboarding/task-sync internals unless they affect output posting.
- The allowlist model remains the primary trust boundary.
- Findings are based on current repository state on 2026-02-22.
