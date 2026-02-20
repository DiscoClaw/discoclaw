# Token Usage & Efficiency Guide

Where tokens go on every API call, and how to keep costs down.

---

## 1. Prompt Anatomy — Three Invocation Paths

The orchestrator assembles prompts differently depending on the trigger.

### Message prompts (`src/discord.ts`)

The main path — every Discord message from an allowed user.

1. **Context file list** (references; Claude reads them via Read tool):
   - `BOOTSTRAP.md` (first run only, loaded when present — `prompt-common.ts:12`)
   - `SOUL.md`, `IDENTITY.md`, `USER.md`, `TOOLS.md` (via `loadWorkspacePaFiles()`)
   - DM-only: `MEMORY.md` + daily logs for today/yesterday (inserted before base context)
   - PA context modules from `.context/` (`pa.md`, `pa-safety.md`)
   - Channel-specific context file
2. **Durable memory section** (inline, not file reference)
3. **Rolling summary section** (inline)
4. **Message history section** (inline)
5. **User message**
6. **Discord Actions prompt** (guild only, when `DISCOCLAW_DISCORD_ACTIONS=1`)
7. **Permission note** (when `workspace/PERMISSIONS.json` has a note)

### Reaction prompts (`src/discord/reaction-handler.ts`)

Triggered when an allowed user reacts to a message.

1. **Context file list** (PA files + PA modules + channel context — same as messages, but no DM memory files)
2. **Durable memory section** (inline)
3. **Reaction event metadata** (who reacted, emoji, original message truncated to 1500 chars)

No rolling summary, no message history — lighter than message prompts.

### Cron prompts (`src/cron/executor.ts`)

Triggered by scheduled jobs.

1. Job name, instruction text, target channel — that's it.

No context files, no memory, no history. Very small — prompt length is just the cron instruction itself.

### Note on AGENTS.md

`workspace/AGENTS.md` is NOT loaded via `loadWorkspacePaFiles()`. It's discovered by Claude Code's native AGENTS.md mechanism when the workspace is the working directory. It contributes to the Claude Code system prompt, not the DiscoClaw-assembled user prompt.

---

## 2. Relative Cost of Each Layer

Ordered from largest to smallest typical contribution. No hard token numbers — these are structural proportions.

| Layer | Relative Size | Varies Per-Request | Config Env Var |
|-------|--------------|-------------------|----------------|
| Workspace PA files (SOUL, IDENTITY, USER, TOOLS) | **Large** | No (stable) | `WORKSPACE_CWD` |
| PA context modules (pa.md, pa-safety.md) | **Medium** | No (stable) | `.context/` in repo root |
| Message history | **Medium** | Yes (every message) | `DISCOCLAW_MESSAGE_HISTORY_BUDGET` (default: 3000 chars) |
| Durable memory | **Medium** | Yes (on `!memory` changes) | `DISCOCLAW_DURABLE_INJECT_MAX_CHARS` (default: 2000 chars) |
| Rolling summary | **Medium** | Yes (every N turns) | `DISCOCLAW_SUMMARY_MAX_CHARS` (default: 2000 chars) |
| DM memory files (MEMORY.md + daily logs) | **Medium** | Partially (daily log rotates) | DM-only, no cap env var |
| Channel context | **Small** | No (stable per channel) | `DISCORD_REQUIRE_CHANNEL_CONTEXT` |
| Discord Actions prompt | **Small** | No (static when enabled) | `DISCOCLAW_DISCORD_ACTIONS` |
| User message | **Small–Medium** | Yes (always unique) | — |
| Permission note | **Tiny** | No (stable) | — |

---

## 3. Prompt Caching — Structural Guidance

Anthropic's automatic prompt caching can reuse prompt prefixes that don't change between requests. The Claude CLI runtime does not expose cache-hit telemetry or explicit cache control blocks, so cache behavior cannot be directly measured in this system. This section describes how to structure prompts for cache-friendliness.

**Stable prefix first.** The context file list (PA files → PA modules → channel context) forms the prompt prefix. When this list doesn't change between requests, automatic caching can reuse it.

**Dynamic content after stable content.** Durable memory, summaries, history, and the user message come after the file list. This ordering is already cache-friendly.

**Edits to PA modules break the prefix.** Modifying `.context/pa.md`, `.context/pa-safety.md`, or workspace identity files changes what Claude reads, shifting the effective prefix. Batch edits rather than making frequent small changes.

**Per-channel isolation.** Each channel loads a different channel context file, creating separate cache buckets. More active channels benefit more from caching; cross-channel reuse is limited.

**DM prefix instability.** In DMs, `MEMORY.md` and daily log paths are inserted into the context file list *before* base context (`prompt-common.ts:45`). Daily log rotation (new day = new filename) and MEMORY.md edits shift the file list, which can break prefix stability for DM flows more than guild flows.

**Durable memory churn.** Frequent `!memory add/forget` changes the inline durable memory section, which sits between the stable file list and the dynamic sections. This affects cacheability of everything after it.

**Model tier matters.** Fast-tier calls are inexpensive enough that cache optimization has less impact. Capable-tier calls are expensive enough that prefix stability is a meaningful cost lever.

**Stability over brevity.** A larger but stable prefix that caches well costs less over time than a smaller prefix that changes frequently.

---

## 4. What Changes Affect Token Cost — Developer Checklist

### Permanent per-request cost increases

- Growing PA context modules (`.context/pa.md`, `.context/pa-safety.md`)
- Growing workspace files (SOUL.md, IDENTITY.md, USER.md, TOOLS.md)
- Growing channel context files
- Growing `workspace/AGENTS.md` (loaded by Claude Code on every invocation)
- Growing `MEMORY.md` (DM-only, loaded every DM prompt with no char cap)

### Hidden API calls (costs beyond the main prompt)

- **Rolling summary generation** — fast-tier call every N turns (default: 5, `DISCOCLAW_SUMMARY_EVERY_N_TURNS`)
- **Cron execution** — each scheduled job fires its own API call (tier per `DISCOCLAW_CRON_MODEL`, default: fast)
- **Cron auto-tagging** — fast-tier call per new cron (when `DISCOCLAW_CRON_AUTO_TAG=1`)
- **Task auto-tagging** — fast-tier call per new task (when `DISCOCLAW_TASKS_AUTO_TAG=1`, tier per `DISCOCLAW_TASKS_AUTO_TAG_MODEL`, default: fast)
- **Forge auditor (OpenAI runtime)** — When `FORGE_AUDITOR_RUNTIME=openai`, each audit round in a forge run calls the OpenAI API instead of Claude. These calls are billed by OpenAI, not Anthropic. The forge drafter/reviser still uses Claude.

### Cache-breaking changes

- Editing PA context modules in `.context/` (affects all channels)
- Adding/removing workspace identity files (changes the file list prefix)
- Reordering files in `loadWorkspacePaFiles()` or `buildContextFiles()` in `src/discord/prompt-common.ts`
- Daily log rotation in DMs (new filename = new file list = new prefix)

---

## 5. Best Practices

### For agents

- Keep `MEMORY.md` under ~2 KB — it has no char cap and loads every DM prompt.
- Distill old daily logs into `MEMORY.md`, then delete them — reduces prefix churn.
- Prefer `!memory add` for quick facts over MEMORY.md entries (durable memory has a char cap; MEMORY.md doesn't).
- Keep durable memory items tight — single-line, actionable.
- In group chats, follow the "stay silent when" rules in pa.md — fewer responses = fewer API calls.

### For developers

- Audit context files periodically for stale content.
- Use per-channel context only for channel-specific rules, not general rules that belong in PA modules.
- Keep PA context modules stable — batch edits rather than frequent small changes.
- Background tasks (summaries, auto-tagging, frequent crons) default to fast tier — don't override to capable tier without reason.
- Tune `DISCOCLAW_SUMMARY_EVERY_N_TURNS` based on conversation volume.
- Consider `DISCOCLAW_MESSAGE_HISTORY_BUDGET` tuning — lower for terse channels, higher for context-heavy ones.

---

## 6. Observability Gap

No token usage tracking, cost tracking, or cache-hit metrics exist in the codebase. The `usage` event type is defined in `src/runtime/types.ts` but never consumed. Metrics in `src/observability/metrics.ts` track invocation counts and latency but not token usage or cost. Cost guidance in this document is structural, not empirical — it describes how prompts are assembled and what's relatively expensive, not measured totals.
