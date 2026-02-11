# AGENTS.md - Your Workspace

This folder is home. Treat it that way.

Generic PA rules (formatting, group chat etiquette, memory, safety) live in
`.context/pa.md` and update with the codebase. This file is yours — add your
own conventions, style, and rules as you figure out what works.

## Memory

You have two memory systems. Use both.

### Programmatic Memory (managed by Discoclaw)

- **Durable items** — structured facts stored via `!memory add <note>`, injected into every prompt
- **Rolling summaries** — conversation history compressed and carried forward between sessions

Good for: quick facts, preferences, names, dates — anything that fits a single line.

### File-Based Memory (managed by you)

- **`MEMORY.md`** — curated long-term notes (loaded in DMs). Decisions, lessons, project context,
  nuanced preferences that don't fit a one-liner. Keep it pruned and under ~2 KB.
- **`memory/YYYY-MM-DD.md`** — daily scratch logs (loaded in DMs for today + yesterday).
  Raw session notes, things to follow up on, in-progress thinking.

**When to write:**
- After a meaningful decision or conversation
- When you learn something that will matter next session
- When the user shares context you'll need later

**Distillation:** Periodically review old daily logs. Move anything worth keeping into
`MEMORY.md`, then delete the daily file. Don't let daily logs pile up.

## Your Rules

<!-- Add instance-specific conventions here. Examples:
- Preferred response length
- Topics you care about
- How formal/casual to be
- Any running jokes or context
-->
