# Claude Discord Shell

CLI-first Discord bridge that routes Discord messages into provider runtimes.

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
