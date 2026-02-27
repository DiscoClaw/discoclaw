# DiscoClaw Memory System

DiscoClaw's memory system gives your assistant persistent context across conversations, channels, and restarts. It combines five runtime layers so the bot remembers what you told it, what you were discussing, and what's happening across your server.

## Memory Layers

### 1. Rolling Summaries — conversation continuity

Compresses conversation history into a running summary, updated every N turns (default 5). Keyed per session (user + channel pair). Automatic and invisible.

**What you see:**
- The bot "remembers" what you were discussing, even after a gap.
- After restarting, it still knows you were debugging a CI pipeline or planning a trip.

```
User (turn 1):  Hey, I'm working on migrating our API from Express to Fastify
Bot:             Nice — what version of Fastify? Any middleware you need to port?
User (turn 6):  What were we talking about?
Bot:             We've been working through your Express → Fastify migration.
                 You've ported the auth middleware and are stuck on the
                 request validation layer.
```

### 2. Durable Memory — long-term user facts

A structured store of user facts that persists across all conversations and restarts. Each item has a kind (fact, preference, project, constraint, person, tool, workflow), deduplication by content hash, and a 200-item cap per user. Injected into every prompt.

**What you see:**
- The bot knows your preferences, projects, and key facts across all channels.
- Works everywhere, not just where the fact was stored.
- Survives restarts, deploys, and long gaps.

```
User:  !memory remember I prefer Rust over Go for systems work
Bot:   Remembered: "I prefer Rust over Go for systems work"

(days later, different channel)
User:  Should I write this CLI tool in Go or Rust?
Bot:   Given your preference for Rust in systems work, I'd lean that way —
       especially since this is a low-level networking tool.
```

#### Consolidation

When the active item count crosses a threshold (default 50), consolidation prunes and merges the list. A fast-tier model receives all active items and returns a revised list — removing duplicates, merging near-duplicates, and dropping stale items. The model cannot invent new facts.

Safety guards:
- The revised list must contain at least 50% of the original count, or consolidation is aborted.
- Runs at most once per session per user.

### 3. Memory Commands — user-facing control

Manual interface for reading and writing memory. These commands are intercepted before the AI runtime.

| Command | What it does |
|---------|-------------|
| `!memory show` | Lists all durable items + rolling summary |
| `!memory remember <text>` | Adds a fact to durable memory |
| `!memory forget <substring>` | Deprecates matching durable items |
| `!memory reset rolling` | Clears rolling summary for current session |

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

### 4. Auto-Extraction — passive fact collection

After summary refreshes, a separate fast-tier call extracts up to 3 notable facts from the user's message and writes them to durable memory. Enabled by default.

**What you see:**
- The bot passively picks up things you mention without being asked.
- No `!memory remember` needed — facts accumulate naturally.
- Only extracts what the user explicitly stated, not inferences.

```
User:  I just switched teams — I'm on the platform team now, working with
       Kubernetes and Terraform mostly.
Bot:   Cool, platform work! What's your first project?

(behind the scenes, auto-extracted to durable memory:)
  [fact]  On the platform team
  [tool]  Works with Kubernetes and Terraform
```

**Supersession:** When a new fact contradicts an older one (e.g., "I switched to Neovim" supersedes "I prefer Vim"), the old item is automatically deprecated.

### 5. Short-Term Memory — cross-channel awareness

Records brief summaries of recent exchanges across public guild channels. Entries expire after 6 hours (configurable). Creates continuity across the server.

**What you see:**
- Switching from #dev to #general doesn't lose context.
- The bot knows what you were just doing in other channels.

```
(in #dev)
User:  Can you help me debug this failing test? It's the auth middleware one.
Bot:   Sure — looks like the mock isn't returning the right token format...

(switch to #general, 10 minutes later)
User:  Hey, quick question about JWT expiry
Bot:   Sure — is this related to the auth middleware test you were debugging
       in #dev? The token format issue might be connected to expiry handling.
```

### 6. Workspace Files — human-curated memory

Curated long-term notes (`workspace/MEMORY.md`) and daily scratch logs (`workspace/memory/YYYY-MM-DD.md`). Loaded in DMs only. These hold things too nuanced for structured durable items — decisions, lessons, project context.

## Token Budget & Overhead

Each layer has its own character budget. Empty layers are omitted entirely (no header, no separator). The three memory builders run in parallel so they add no latency.

| Layer | Default budget | Default state |
|-------|---------------|---------------|
| Durable memory | 2000 chars | on |
| Rolling summary | 2000 chars | on |
| Message history | 3000 chars | on |
| Short-term memory | 1000 chars | on |
| Auto-extraction | n/a (write-side only) | on |
| Workspace files | no budget | on (DMs only) |

With all layers at default settings, worst-case memory overhead is ~8000 chars (~2000 tokens). In practice most prompts use far less — a user with 5 durable items and a short summary might add ~500 chars total.

## How to Tune Memory

**Want more memory context?** Increase the character budgets:
- `DISCOCLAW_DURABLE_INJECT_MAX_CHARS` — more durable facts per prompt
- `DISCOCLAW_SUMMARY_MAX_CHARS` — longer rolling summaries
- `DISCOCLAW_MESSAGE_HISTORY_BUDGET` — more message history
- `DISCOCLAW_SHORTTERM_INJECT_MAX_CHARS` — more cross-channel context

**Want less memory overhead?** Disable layers you don't need:
- `DISCOCLAW_DURABLE_MEMORY_ENABLED=false` — no long-term facts
- `DISCOCLAW_SUMMARY_ENABLED=false` — no rolling summaries
- `DISCOCLAW_SHORTTERM_MEMORY_ENABLED=false` — no cross-channel awareness
- `DISCOCLAW_SUMMARY_TO_DURABLE_ENABLED=false` — no auto-extraction

**Control auto-extraction aggressiveness:**
- `DISCOCLAW_SUMMARY_EVERY_N_TURNS` — how often extraction runs (default 5)
- `DISCOCLAW_DURABLE_MAX_ITEMS` — cap per user (default 200)
- `DISCOCLAW_DURABLE_SUPERSESSION_SHADOW=true` — observe supersession without acting (shadow mode)

**Control consolidation:**
- `DISCOCLAW_MEMORY_CONSOLIDATION_THRESHOLD` — item count before consolidation triggers (default 50)
- `DISCOCLAW_MEMORY_CONSOLIDATION_MODEL` — model tier for consolidation (default fast)

## Configuration Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCOCLAW_MESSAGE_HISTORY_BUDGET` | `3000` | Character budget for message history |
| `DISCOCLAW_SUMMARY_ENABLED` | `true` | Enable rolling summaries |
| `DISCOCLAW_SUMMARY_MODEL` | `fast` | Model tier for summary generation |
| `DISCOCLAW_SUMMARY_MAX_CHARS` | `2000` | Max chars for rolling summary |
| `DISCOCLAW_SUMMARY_EVERY_N_TURNS` | `5` | Turns between summary updates |
| `DISCOCLAW_DURABLE_MEMORY_ENABLED` | `true` | Enable durable memory |
| `DISCOCLAW_DURABLE_INJECT_MAX_CHARS` | `2000` | Max chars injected per prompt |
| `DISCOCLAW_DURABLE_MAX_ITEMS` | `200` | Max items per user |
| `DISCOCLAW_MEMORY_COMMANDS_ENABLED` | `true` | Enable `!memory` commands |
| `DISCOCLAW_SUMMARY_TO_DURABLE_ENABLED` | `true` | Enable auto-extraction |
| `DISCOCLAW_DURABLE_SUPERSESSION_SHADOW` | `false` | Shadow mode for supersession |
| `DISCOCLAW_MEMORY_CONSOLIDATION_THRESHOLD` | `50` | Items before consolidation triggers |
| `DISCOCLAW_MEMORY_CONSOLIDATION_MODEL` | `fast` | Model tier for consolidation |
| `DISCOCLAW_SHORTTERM_MEMORY_ENABLED` | `true` | Enable short-term cross-channel memory |
| `DISCOCLAW_SHORTTERM_MAX_ENTRIES` | `20` | Max short-term entries |
| `DISCOCLAW_SHORTTERM_MAX_AGE_HOURS` | `6` | Expiry for short-term entries |
| `DISCOCLAW_SHORTTERM_INJECT_MAX_CHARS` | `1000` | Max chars for short-term injection |

## Troubleshooting

**Bot doesn't remember anything across restarts:**
- Check that `DISCOCLAW_DURABLE_MEMORY_ENABLED=true` (the default). Durable memory is the cross-restart layer.
- Rolling summaries reset on restart; durable facts persist.

**Too many durable items / memory feels noisy:**
- Lower `DISCOCLAW_DURABLE_MAX_ITEMS` to cap total items.
- Use `!memory forget <substring>` to prune specific items.
- Consolidation auto-prunes when the threshold is crossed.

**Auto-extraction picking up irrelevant facts:**
- Disable with `DISCOCLAW_SUMMARY_TO_DURABLE_ENABLED=false`.
- Or increase `DISCOCLAW_SUMMARY_EVERY_N_TURNS` to extract less frequently.

**Short-term memory creating confusion:**
- Disable with `DISCOCLAW_SHORTTERM_MEMORY_ENABLED=false`.
- Or reduce `DISCOCLAW_SHORTTERM_MAX_AGE_HOURS` for shorter context windows.
