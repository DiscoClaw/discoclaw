# Discoclaw

Small, CLI-first Discord bridge that routes Discord messages into provider runtimes.

Modeled after the structure/philosophy of nanoclaw: keep the codebase small, make behavior explicit, and treat "customization" as code changes (not a sprawling plugin system).

## Local dev

1. Install deps (pick one):

```bash
pnpm i
# or npm i
```

2. Configure env:

```bash
cp .env.example .env
```

3. Run:

```bash
pnpm dev
```

## Notes

- Default runtime is Claude Code via the `claude` CLI.
- Session mapping is stored locally in `data/sessions.json`.
