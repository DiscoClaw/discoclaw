# Memory System

Five runtime layers plus workspace files, wired together through prompt assembly.

## Layers

### 1. Rolling Summaries — conversation continuity

`src/discord/summarizer.ts`

Compresses conversation history into a running summary using the `fast` tier. Updated every
N turns (default 5). Keyed per session (user+channel pair). Automatic and invisible.

**What the user sees:**
- Nothing directly — the bot just "remembers" what you were discussing.
- After a gap, the bot still knows you were debugging a CI pipeline or planning a trip.
- `!memory show` reveals the current summary if you're curious.
- `!memory reset rolling` clears it for a fresh start in a channel.

**Example:**
```
User (turn 1):  Hey, I'm working on migrating our API from Express to Fastify
Bot:             Nice — what version of Fastify? Any middleware you need to port?
User (turn 6):  What were we talking about?
Bot:             We've been working through your Express → Fastify migration.
                 You've ported the auth middleware and are stuck on the
                 request validation layer.
```

### 2. Durable Memory — long-term user facts

`src/discord/durable-memory.ts`

Structured store of user facts. Each item has a kind (fact, preference, project,
constraint, person, tool, workflow), deduplication by content hash, and a 200-item
cap per user. Items track `hitCount` (incremented each time the item is selected
for prompt injection) and `lastHitAt` (timestamp of most recent selection).
Injected into every prompt using a blended score of recency and usage frequency
rather than raw `updatedAt` alone.

**What the user sees:**
- The bot knows your preferences, projects, and key facts across all conversations.
- Works in every channel, not just the one where the fact was stored.
- Survives restarts, deploys, and long gaps between conversations.

**Example:**
```
User:  !memory remember I prefer Rust over Go for systems work
Bot:   Remembered: "I prefer Rust over Go for systems work"

(days later, different channel)
User:  Should I write this CLI tool in Go or Rust?
Bot:   Given your preference for Rust in systems work, I'd lean that way —
       especially since this is a low-level networking tool.
```

#### Consolidation

When the active item count for a user crosses a threshold (`DISCOCLAW_DURABLE_CONSOLIDATION_THRESHOLD`, default `100`), consolidation can be triggered to prune and merge the list. A single `fast`-tier model call receives all active items and is asked to return a revised list — removing exact duplicates, merging near-duplicates, dropping clearly stale items, and preserving everything that is still plausibly useful. The model must not invent new facts or change the meaning of existing ones. Items with low `hitCount` and stale `lastHitAt` are natural eviction candidates — the blended score surfaces which items the AI actually uses versus those that were added once and never referenced again.

The revised list is applied atomically: items absent from the model's output are deprecated via `deprecateItems()`; new or rewritten items are written via `addItem()`. Items present verbatim in the output are left untouched (no unnecessary writes).

**Safety guards:**
- The revised list must contain at least 50 % of the original count. If the model returns fewer items than that floor, consolidation is aborted and a warning is logged — no writes occur.
- Consolidation runs at most once per session per user, regardless of how many writes happen. This prevents runaway API calls.
- All mutations flow through the existing durable write queue, so consolidation is serialized with concurrent `!memory remember` / auto-extraction writes.

**Config:** `DISCOCLAW_DURABLE_CONSOLIDATION_THRESHOLD=100` sets the item count at which consolidation becomes eligible. `DISCOCLAW_DURABLE_CONSOLIDATION_MODEL=fast` selects the model tier used for the consolidation call.

### 3. Memory Commands — user-facing control surface

`src/discord/memory-commands.ts`

Manual interface for layers 1 and 2. Intercepts messages before they hit the runtime.

| Command | What it does |
|---------|-------------|
| `!memory show` | Lists all durable items + rolling summary |
| `!memory remember <text>` | Adds a fact to durable memory |
| `!memory forget <substring>` | Deprecates matching durable items |
| `!memory reset rolling` | Clears rolling summary for current session |

**Example:**
```
User:  !memory show
Bot:   Durable memory (3 items):
       - [fact] Works at Acme Corp (src: manual)
       - [preference] Prefers Rust over Go for systems work (src: manual)
       - [project] Building a Discord bot called DiscoClaw (src: summary)

       Rolling summary:
       User discussed adding webhook support to their Fastify migration...

User:  !memory forget Acme
Bot:   Deprecated 1 item matching "Acme"
```

### 4. Auto-Extraction — user turn to durable memory

`src/discord/user-turn-to-durable.ts`

After summary refreshes (default every 5 turns), fires a separate `fast`-tier call to
extract up to 3 notable facts from the user's message and writes them to durable memory.
Enabled by default.

**What the user sees:**
- The bot passively picks up on things you mention without being asked.
- No `!memory remember` needed — facts accumulate naturally.
- Only extracts what the user explicitly stated, not inferences.

**Example:**
```
User:  I just switched teams — I'm on the platform team now, working with
       Kubernetes and Terraform mostly.
Bot:   Cool, platform work! What's your first project?

(behind the scenes, auto-extracted to durable memory:)
  [fact]  On the platform team
  [tool]  Works with Kubernetes and Terraform
```

**Supersession:** When extraction runs, active durable items for the user are appended
to the prompt. The model may return a `supersedes` field on any extracted item, containing
a substring that uniquely identifies the old item's text. The old item is then deprecated
atomically before the new item is written — no additional API call required. This prevents
stale preferences from accumulating (e.g. "I prefer Vim" is deprecated when "I switched to
Neovim" is later extracted).

**Config:** `DISCOCLAW_SUMMARY_TO_DURABLE_ENABLED=false` to disable extraction entirely.
`DISCOCLAW_DURABLE_SUPERSESSION_SHADOW=1` to observe what the model would supersede without
actually deprecating (shadow mode logs matches to stdout). Live supersession is on by default.

### 5. Short-Term Memory — cross-channel awareness

`src/discord/shortterm-memory.ts`

Records brief summaries of recent exchanges across public guild channels.
Entries expire after 6 hours (configurable). Only logs public channels. On by default.

**What the user sees:**
- The bot knows what you were just doing in other channels.
- Switching from #dev to #general doesn't lose context.
- Creates a sense of continuity across the server, not just within one channel.

**Example:**
```
(in #dev)
User:  Can you help me debug this failing test? It's the auth middleware one.
Bot:   Sure — looks like the mock isn't returning the right token format...

(switch to #general, 10 minutes later)
User:  Hey, quick question about JWT expiry
Bot:   Sure — is this related to the auth middleware test you were debugging
       in #dev? The token format issue might be connected to expiry handling.
```

**Config:** `DISCOCLAW_SHORTTERM_MEMORY_ENABLED=false` to disable.

### 6. Workspace Files — human-curated memory

`workspace/MEMORY.md` + `workspace/memory/YYYY-MM-DD.md`

Curated long-term notes and daily scratch logs. Loaded in DMs only. These hold
things too nuanced for structured durable items — decisions, lessons, project
context, relationship dynamics.

**What the user sees:**
- In DMs, the bot has deep context about ongoing projects and past decisions.
- Daily logs capture session-level notes that auto-rotate.
- The bot (or the user) can write to these files to preserve important context.

**Example (MEMORY.md):**
```markdown
## Project: API Migration
- Decided on Fastify over Hono — better ecosystem for our middleware needs
- Auth team wants OAuth2 support by Q3, blocking the migration timeline
- Dave prefers incremental migration (route-by-route), not big-bang
```

## Token Budget & Optimization

Each layer has its own character budget. Empty layers are omitted entirely (no header,
no separator). The three memory builders run in `Promise.all` so they add no latency.

### Character budgets

| Layer | Default budget | Default state | How it stays within budget |
|-------|---------------|---------------|---------------------------|
| Durable memory | 2000 chars | on | Ranks active items by blended score (recency + hit frequency), adds one at a time, stops when next line would exceed budget. Low-scoring items silently excluded. |
| Rolling summary | 2000 chars | on | The `fast`-tier model is prompted with `"Keep the summary under {maxChars} characters"`. Replaces itself each update rather than growing. |
| Message history | 3000 chars | on | Fetches up to 10 messages, walks backward from newest. Bot messages truncated to fit; user messages that don't fit cause a hard stop. |
| Short-term memory | 1000 chars | **on** | Filters by max age (default 6h), sorts newest-first, accumulates lines until budget hit. |
| Open tasks | 600 chars | **on** | Queries TaskStore for non-closed tasks at invocation time, formats as a compact list. |
| Auto-extraction | n/a | **off** | Write-side only — extracts facts for future prompts, adds nothing to the current turn. |
| Workspace files | no budget | on (DMs only) | Loaded as file paths, not inlined. The runtime reads them on demand. |

### Default prompt overhead

With the four enabled layers at default settings, worst-case memory overhead is
**~8600 chars (~2150 tokens)**.
This is modest against typical `capable`-tier context windows.

In practice most prompts use far less — a user with 5 durable items and a short summary
might add ~500 chars total. Sections with no data produce zero overhead.

### Where the budgets are enforced

- **Durable**: `selectItemsForInjection()` in `durable-memory.ts:152` — scores items using `hitCount`, `lastHitAt`, and `updatedAt`; increments hit counters on selected items
- **Short-term**: `selectEntriesForInjection()` in `shortterm-memory.ts:113`
- **Summary**: `fast`-tier prompt constraint in `summarizer.ts:63`
- **History**: `fetchMessageHistory()` in `message-history.ts:38`

All budgets are configurable via env vars (see Config Reference below).

## Prompt Assembly

Memory sections are injected into every prompt in this order:

```
Context files (PA + MEMORY.md + daily logs + channel context)
  → Durable memory section (up to 2000 chars)
  → Short-term memory section (up to 1000 chars)
  → Open tasks section (up to 600 chars)
  → Rolling summary section (up to 2000 chars)
  → Message history (up to 3000 chars)
  → Discord actions
  → Current message
```

Built by `src/discord/prompt-common.ts` and assembled in `src/discord.ts`.

## Concurrency

- **Durable write queue** (`src/discord/durable-write-queue.ts`) — shared KeyedQueue
  serializing per-user writes across memory commands and auto-extraction.
- **Short-term memory** has its own internal KeyedQueue instance.
- Both use atomic writes (`.tmp.${pid}` + `rename()`) safe for single-process.

## Provenance

Every durable item stores a `source` object with Discord metadata:

```typescript
source: {
  type: 'discord' | 'manual' | 'summary';
  channelId?: string;   // Discord channel ID
  messageId?: string;   // Discord message ID
  guildId?: string;     // Discord guild ID (omitted in DMs)
  channelName?: string; // Channel name for display (omitted in DMs)
}
```

- `!memory remember` stores `type: 'manual'` with all four metadata fields.
- Auto-extraction stores `type: 'summary'` with metadata from the trigger message.
- DMs omit `guildId` and `channelName`; `channelId`/`messageId` are still stored.
- Threads use their own name (`ch.name`), not the parent channel name.

**Prompt rendering:** Channel names appear in durable memory lines when present:
`- [fact] Prefers Rust (src: manual, #dev, updated 2025-01-15)`. Full IDs are in
the data layer only (for future message links / citations).

Short-term entries also store `channelId` alongside the existing `channelName`.

## Config Reference

| Variable | Default | Layer |
|----------|---------|-------|
| `DISCOCLAW_MESSAGE_HISTORY_BUDGET` | `3000` | Message history |
| `DISCOCLAW_SUMMARY_ENABLED` | `true` | Rolling summaries |
| `DISCOCLAW_SUMMARY_MODEL` | `fast` | Rolling summaries |
| `DISCOCLAW_SUMMARY_MAX_CHARS` | `2000` | Rolling summaries |
| `DISCOCLAW_SUMMARY_EVERY_N_TURNS` | `5` | Rolling summaries |
| `DISCOCLAW_DURABLE_MEMORY_ENABLED` | `true` | Durable memory |
| `DISCOCLAW_DURABLE_INJECT_MAX_CHARS` | `2000` | Durable memory |
| `DISCOCLAW_DURABLE_MAX_ITEMS` | `200` | Durable memory |
| `DISCOCLAW_MEMORY_COMMANDS_ENABLED` | `true` | Memory commands |
| `DISCOCLAW_SUMMARY_TO_DURABLE_ENABLED` | `true` | Auto-extraction |
| `DISCOCLAW_DURABLE_SUPERSESSION_SHADOW` | `false` | Auto-extraction |
| `DISCOCLAW_DURABLE_CONSOLIDATION_THRESHOLD` | `100` | Durable memory |
| `DISCOCLAW_DURABLE_CONSOLIDATION_MODEL` | `fast` | Durable memory |
| `DISCOCLAW_SHORTTERM_MEMORY_ENABLED` | `true` | Short-term memory |
| `DISCOCLAW_SHORTTERM_MAX_ENTRIES` | `20` | Short-term memory |
| `DISCOCLAW_SHORTTERM_MAX_AGE_HOURS` | `6` | Short-term memory |
| `DISCOCLAW_SHORTTERM_INJECT_MAX_CHARS` | `1000` | Short-term memory |

Storage directories are configurable via `_DATA_DIR` / `_DIR` env vars;
defaults are under `$DISCOCLAW_DATA_DIR/`.
