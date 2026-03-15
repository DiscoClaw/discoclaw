# Skills

This directory is used by Claude Code to load *invocable* skills.

The canonical skill sources live in `skills/` (committed).

To make them invocable in Claude Code, install symlinks into this folder:

```bash
pnpm claude:install-skills
```

Notes:
- `.claude/skills/` is gitignored (local-only).
- The installer uses symlinks so updates to `skills/<name>/` apply immediately.
