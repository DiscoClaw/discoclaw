# MCP Server Feasibility Audit

Gap analysis: can/should discoclaw expose its capabilities as an MCP server?

**Status:** Deferred — client-side MCP consumption is sufficient for current needs.
**Date:** 2026-02-28

---

## 1. Current MCP Posture

Discoclaw is an **MCP client** — it consumes external MCP tool servers through Claude Code's
`--strict-mcp-config` flag and a workspace `.mcp.json` file. MCP servers provide tools
(filesystem, search, image generation, etc.) that are available during Claude Code invocations.

This audit evaluates the inverse: exposing discoclaw's own capabilities **as** an MCP server
that external clients could consume.

## 2. Tool Surface Inventory

### 2.1 Runtime Tools (8)

Tools passed to the AI runtime via `--tools` or the OpenAI function-calling adapter:

| Tool | MCP Primitive | Context Required | Notes |
|------|---------------|------------------|-------|
| Bash | Tool | CWD, timeout | Path-scoped to workspace |
| Read | Tool | CWD | File read within workspace |
| Write | Tool | CWD | File create/overwrite |
| Edit | Tool | CWD | Exact string replacement |
| Glob | Tool | CWD | File pattern matching |
| Grep | Tool | CWD | Regex content search |
| WebFetch | Tool | None | SSRF-protected HTTP fetch |
| WebSearch | Tool | None | Stub — not yet implemented |

**MCP fit:** These are already generic tools. However, they're the Claude Code CLI's
built-in tools — exposing them via a discoclaw MCP server would be redundant. Any MCP
client that wants file/shell/web tools can use existing community MCP servers
(`@modelcontextprotocol/server-filesystem`, etc.) directly.

### 2.2 Discord Actions (~84 action types across 17 categories)

Structured JSON actions the AI emits in `<discord-action>` blocks, parsed and executed
by the orchestrator against the Discord API.

| Category | Action Count | Representative Types | MCP Primitive |
|----------|-------------|----------------------|---------------|
| Channels | 12 | `channelCreate`, `channelEdit`, `channelList`, `channelInfo`, `categoryCreate`, `channelMove` | Tool |
| Messaging | 14 | `sendMessage`, `readMessages`, `editMessage`, `react`, `threadCreate`, `sendFile` | Tool |
| Guild | 9 | `memberInfo`, `roleInfo`, `roleAdd`, `roleRemove`, `searchMessages`, `eventList`, `eventCreate` | Tool |
| Moderation | 3 | `timeout`, `kick`, `ban` | Tool |
| Polls | 1 | `poll` | Tool |
| Tasks | 7 | `taskCreate`, `taskUpdate`, `taskList`, `taskSync` | Tool |
| Crons | 10 | `cronCreate`, `cronList`, `cronTrigger`, `cronSync` | Tool |
| Bot Profile | 3 | `botSetStatus`, `botSetActivity`, `botSetNickname` | Tool |
| Forge | 4 | `forgeCreate`, `forgeResume`, `forgeStatus` | Tool |
| Plans | 6 | `planCreate`, `planApprove`, `planRun`, `planList` | Tool |
| Memory | 3 | `memoryRemember`, `memoryForget`, `memoryShow` | Tool |
| Defer | 1 | `defer` | Tool |
| Config | 3 | `modelSet`, `modelReset`, `modelShow` | Tool |
| Imagegen | 1 | `generateImage` | Tool |
| Voice | 5 | `voiceJoin`, `voiceLeave`, `voiceStatus` | Tool |
| Spawn | 1 | `spawnAgent` | Tool |
| Reaction Prompts | 1 | `reactionPrompt` | Tool |

**Total:** ~84 action types that could each map to an MCP tool definition.

### 2.3 Read-Only State (potential MCP Resources)

| Data Source | MCP Primitive | Notes |
|-------------|---------------|-------|
| Durable memory (per-user facts) | Resource | JSONL file, user-scoped |
| Task store (all tasks) | Resource | In-process Map, JSONL-backed |
| Cron definitions | Resource | Forum-thread-backed |
| Channel context files | Resource | Per-channel `.md` files |
| Session state | Resource | Ephemeral, in-memory |
| Rolling summaries | Resource | Per-session, AI-generated |

### 2.4 Prompt Templates (potential MCP Prompts)

| Template | MCP Primitive | Notes |
|----------|---------------|-------|
| PA context preamble | Prompt | Identity + safety modules |
| Channel context | Prompt | Per-channel instructions |
| Action prompt sections | Prompt | Per-category action teaching blocks |
| Cron prompt templates | Prompt | With `{{channel}}`/`{{channelId}}` expansion |

## 3. Structural Gaps

### 3.1 Discord Context Dependency (Blocking)

Every Discord action requires an `ActionContext` containing:

```typescript
type ActionContext = {
  guild: Guild;        // discord.js Guild object (live API connection)
  client: Client;      // discord.js Client (authenticated bot session)
  channelId: string;   // current channel
  messageId: string;   // triggering message
  // ...
};
```

An MCP client has no Discord guild, no authenticated bot client, and no channel context.
Exposing Discord actions as MCP tools would require either:

- **Option A:** A synthetic context layer that maps MCP tool parameters to Discord API calls
  (guild ID, channel ID as explicit params). This inverts the current design where context
  is ambient from the triggering message.
- **Option B:** Restricting MCP-exposed tools to non-Discord capabilities only (tasks, memory,
  config). This eliminates ~80% of the action surface.

Neither option is trivial. Option A requires significant refactoring of every action executor
to accept explicit IDs instead of live discord.js objects. Option B leaves too little surface
to justify the effort.

### 3.2 Security Model Mismatch (Blocking)

Discoclaw's security boundary is the **Discord user allowlist** (`DISCORD_ALLOW_USER_IDS`).
Every action flows through this gate before execution. MCP has no equivalent — MCP servers
are typically trusted by the client that connects to them, with no per-user authorization.

Exposing actions via MCP would require building an entirely separate auth layer (API keys,
OAuth, or similar) that doesn't exist today. The current fail-closed allowlist design
cannot be mapped onto MCP's transport model.

### 3.3 Stateful Subsystems

Several action categories depend on in-process stateful subsystems:

| Subsystem | State Type | MCP Impact |
|-----------|------------|------------|
| `DeferScheduler` | In-process timers | Cannot be invoked from external MCP clients |
| `ProcessPool` | Long-running subprocesses | Tied to discoclaw's process lifecycle |
| `ForgeContext` | Singleton forge run state | Module-level mutex, not shareable |
| `VoiceConnectionManager` | Per-guild voice connections | Requires live discord.js voice state |
| `TaskStore` | EventEmitter-backed Map | In-process only, not serializable |

These subsystems would need to be decomposed into a client-server architecture to work
over MCP's request-response transport.

### 3.4 Action Category Gating

Discoclaw's action surface is controlled by 17 env-var flags (`DISCOCLAW_DISCORD_ACTIONS_*`)
that enable/disable categories at startup. MCP's tool listing (`tools/list`) is static for
the server lifetime — there's no standard mechanism for conditional tool availability.

This is solvable (filter the tool list at startup based on flags) but adds complexity to
the MCP server implementation.

### 3.5 Fire-and-Forget Actions

Several action types are asynchronous fire-and-forget (`forgeCreate`, `forgeResume`,
`planRun`, `defer`). MCP tools are synchronous request-response — the client expects
a result. Mapping async actions to MCP would require either:

- Blocking until completion (potentially minutes for forge runs)
- Returning an opaque job ID and requiring a separate polling tool
- Using MCP's experimental notification mechanism (not widely supported)

Note: `spawnAgent` is **not** fire-and-forget — it streams the sub-agent invocation
via `for await` and returns `{ ok, summary }` synchronously. It maps cleanly to MCP tools.

### 3.6 Redundancy with Existing MCP Ecosystem

The runtime tools (Read, Write, Edit, Glob, Grep, Bash, WebFetch) are already available
as mature, purpose-built MCP servers in the community ecosystem. Discoclaw wrapping them
in its own MCP server adds no value — it's a layer of indirection over tools the client
can use directly.

### 3.7 MCP Sampling Overlap

MCP's `sampling` capability allows an MCP server to request that the connected client
perform LLM inference on its behalf (the server sends a `sampling/createMessage` request
and the client returns a model response). This inverts the usual tool-calling direction:
the server asks the client's model to think, rather than the client calling the server's tools.

Discoclaw's pipeline engine (`src/pipeline/engine.ts`) and spawn action (`actions-spawn.ts`)
serve an analogous role — they invoke AI runtimes to generate text, then feed results back
into subsequent steps or the originating channel. However, the overlap is structural, not
practical:

- **Pipeline steps** chain multiple runtime invocations with template interpolation between
  them. MCP sampling provides a single request-response exchange with no chaining primitive.
- **Spawn** invokes a sub-agent in a target channel with full action dispatch capabilities.
  MCP sampling has no concept of channel routing or action execution on the response.
- **Runtime selection:** Discoclaw selects runtimes per-step (model, adapter, timeout).
  MCP sampling delegates model choice to the client, giving the server no control over
  which model or adapter is used.

If discoclaw were an MCP server, it could use sampling to delegate LLM work to the
connected client rather than invoking its own runtimes. This would only be useful if
the MCP client had access to models discoclaw does not — an unlikely scenario given
discoclaw already has adapters for Claude, OpenAI, Gemini, and OpenRouter. The pipeline
and spawn models are strictly more capable than MCP sampling for discoclaw's use cases.

## 4. What Would Be Feasible (If Pursued)

A minimal MCP server exposing **non-Discord, stateless** capabilities:

| Tool | Feasibility | Value |
|------|-------------|-------|
| `memoryShow` | High | Read durable memory items |
| `memoryRemember` / `memoryForget` | Medium | Mutate memory (needs user-scoping) |
| `taskList` / `taskShow` | High | Read task data |
| `taskCreate` / `taskUpdate` | Medium | Mutate tasks (no Discord sync) |
| `modelShow` | High | Read model config |
| `cronList` / `cronShow` | High | Read cron definitions |

This is ~10 tools out of ~84 — a small fraction of the surface, and the most
useful ones (Discord interaction, forge, plans) are excluded.

## 5. Recommendation: Defer

**Do not implement an MCP server at this time.** The cost/benefit ratio is unfavorable:

1. **High cost:** Discord context dependency and security model mismatch require
   significant architectural changes to the action dispatch layer.
2. **Low incremental value:** The non-Discord tools that are MCP-feasible are either
   available as community MCP servers (file/shell/web) or too narrow to justify a
   custom server (~10 stateless read/write operations on tasks and memory).
3. **Client-side is working:** Discoclaw already consumes MCP servers effectively
   through Claude Code's native MCP support. External tools (filesystem, search,
   image generation) are plugged in via `.mcp.json` with zero custom code.
4. **No external demand:** Discoclaw is a personal orchestrator. There are no
   third-party consumers requesting programmatic access to its capabilities.

### When to Revisit

Re-evaluate if any of these conditions change:

- **Transport abstraction completes:** If `src/transport/types.ts` evolves to fully
  decouple action executors from discord.js types, the context dependency gap shrinks.
- **Multi-user or API access needed:** If discoclaw needs to serve clients beyond
  Discord (CLI, web UI, other AI agents), MCP becomes a natural integration point.
- **MCP adds auth primitives:** If the MCP spec gains standardized authentication
  and authorization, the security model gap closes.
- **Stateful MCP extensions mature:** If MCP supports subscriptions, notifications,
  or streaming results, the fire-and-forget gap becomes manageable.

## 6. References

- Current MCP client setup: `docs/mcp.md`
- MCP server detection: `src/mcp-detect.ts`
- Action dispatch: `src/discord/actions.ts`
- Runtime adapter interface: `src/runtime/types.ts`
- Transport abstraction: `src/transport/types.ts`
- Discord actions reference: `docs/discord-actions.md`
