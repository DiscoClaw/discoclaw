# dev.md — Development

## Install / Build / Run

```bash
cd /path/to/discoclaw
pnpm i
pnpm build
pnpm dev
```

## Environment

- Copy `.env.example` -> `.env`
- Required:
  - `DISCORD_TOKEN`
  - `DISCORD_ALLOW_USER_IDS` (comma/space-separated Discord user IDs; fail-closed if empty)
- Useful:
  - `DISCOCLAW_DATA_DIR=/path/to/dropbox/discoclaw-data` (defaults `WORKSPACE_CWD` to `$DISCOCLAW_DATA_DIR/workspace`)
  - `WORKSPACE_CWD=/some/dir` (overrides the default)
  - `CLAUDE_BIN=claude`
  - `CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS=1`
  - `CLAUDE_OUTPUT_FORMAT=text` (switch to `stream-json` once the event schema is solid)
- Group-scoped CWD (nanoclaw-style):
  - `USE_GROUP_DIR_CWD=1`
  - `GROUPS_DIR=./groups` (optional; defaults to `./groups`)

## Notes
- Runtime invocation defaults are configurable via env (`RUNTIME_MODEL`, `RUNTIME_TOOLS`, `RUNTIME_TIMEOUT_MS`).
- If `pnpm dev` fails with “Missing DISCORD_TOKEN”, your `.env` isn’t loaded or the var is unset.
