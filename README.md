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

## Workspace + Dropbox-backed content (recommended)

Discoclaw runs the runtime (Claude CLI) in a separate working directory (`WORKSPACE_CWD`).

- If you set `DISCOCLAW_DATA_DIR`, Discoclaw defaults `WORKSPACE_CWD` to `$DISCOCLAW_DATA_DIR/workspace`.
- If you do not set `DISCOCLAW_DATA_DIR`, Discoclaw defaults `WORKSPACE_CWD` to `./workspace` (relative to this repo).

This lets you keep the repo fast/local, while storing durable "workspace content" in a Dropbox folder.

## Notes

- Default runtime is Claude Code via the `claude` CLI.
- Session mapping is stored locally in `data/sessions.json`.
- Access control is fail-closed by user allowlist (`DISCORD_ALLOW_USER_IDS`). Optionally restrict guild channels via `DISCORD_CHANNEL_IDS`.
