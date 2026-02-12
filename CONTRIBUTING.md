# Contributing to Discoclaw

## Quick Start

```bash
git clone <repo-url> && cd discoclaw
pnpm setup                 # guided interactive setup (or: cp .env.example .env)
pnpm install
pnpm doctor                # preflight check
pnpm dev                   # start dev mode
```

## Architecture

Read `.context/architecture.md` for a system overview: data flow, directory layout,
key concepts, and entry points.

## Dev Workflow

After completing a unit of work:

1. `pnpm build` — must compile cleanly
2. `pnpm test` — all tests must pass
3. Commit with a clear message (stage only relevant files)
4. `git push`

See `CLAUDE.md` for the full workflow including deploy steps.

## Context Modules

Developer docs live in `.context/*.md` and are loaded on-demand. See
`.context/README.md` for the loading table and quick reference.

## Commands

```bash
pnpm doctor     # preflight check (Node, pnpm, Claude CLI, .env)
pnpm dev        # start dev mode
pnpm build      # compile TypeScript
pnpm test       # run tests
```

## Style

- Small, auditable changes.
- Prefer editing existing files over creating new ones.
- Keep commits focused — don't batch unrelated changes.
