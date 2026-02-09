# Discoclaw Phased Plan (Living Doc)

This is the working plan for getting from "fresh start" to a stable, shareable Discoclaw setup.

Guidelines:
- Keep this file current; check items off as they land.
- Prefer small, auditable PR-sized changes.
- No secrets in this file.

## Definitions
- **Repo workspace**: this git repo (agents run with `cwd` at repo root).
- **Runtime workspace (`WORKSPACE_CWD`)**: where the Claude CLI actually runs.
- **Data root (`DISCOCLAW_DATA_DIR`)**: optional root for durable content, usually Dropbox-backed.

## Phase 0: Fresh Workspace Bootstrap
- [x] Remove hardcoded `WORKSPACE_CWD=/home/davidmarsh/weston` default; use `DISCOCLAW_DATA_DIR` / `./workspace`.
- [x] Keep high-churn dirs out of git (`workspace/`, `exports/`, `legacy/`, `var/`).
- [x] Document defaults in `README.md` and `.context/*.md`.
- [x] Create Dropbox-backed `discoclaw-data/` with `workspace/`, `content/`, `exports/` (machine-specific).
- [x] Wire local symlinks (uncommitted): `workspace` and `exports`.
- [x] Create `discoclaw/.env` locally from existing config (uncommitted).

## Phase 1: Safety + Routing Hardening
- [x] Verify fail-closed behavior end-to-end (empty allowlist responds to nobody).
- [x] Decide whether to support `DISCORD_CHANNEL_IDS` allowlist (supported).
- [x] Add a short “safe operations” checklist for running in production channels.

## Phase 2: Data + Migration From Weston
- [x] Inventory what should be copied from `legacy/weston` into `discoclaw-data/content` (selective, not wholesale).
- [x] Define a stable `content/` layout under `DISCOCLAW_DATA_DIR` (what goes in there, what never should).
- [x] Enforce per-channel context modules (auto-index new channels; no silent fallback).
- [ ] Add a small script (optional) to copy/sync selected “weston” artifacts into the new data root.

## Phase 3: Runtime Reliability
- [x] Make runtime invocation config explicit (model, tool list, timeouts) via env or a small config file.
- [x] Decide on `CLAUDE_OUTPUT_FORMAT=text` vs `stream-json` and tighten parsing if switching.
- [x] Add structured logging around invoke lifecycle and failures.

## Phase 4: Tests + CI Basics
- [x] Add minimal tests for allowlist parsing + session key mapping.
- [ ] Add a smoke test for runtime adapter (mock execa).
- [x] Add a simple CI workflow (build + test) if desired.

## Phase 5: Ops
- [x] Update `systemd/discoclaw.service` template to include `DISCOCLAW_DATA_DIR` guidance.
- [x] Add an ops “rollout” checklist (private channel first, allowlist, logs, restart).

## Progress Log
- 2026-02-09: Implemented new workspace defaults + docs; created Dropbox data root; created local `.env`.
- 2026-02-09: Added optional `DISCORD_CHANNEL_IDS` allowlist and docs; started tests for allowlist parsing.
- 2026-02-09: Added handler-level tests proving fail-closed routing + expanded ops safety checklist.
- 2026-02-09: Switched to `stream-json` parsing path and added invoke lifecycle logging.
- 2026-02-09: Started Phase 2 migration notes and identified initial Discord context import set.
- 2026-02-09: Enforced per-channel context modules; auto-indexes new channels into content on first use.
