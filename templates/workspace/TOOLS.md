# TOOLS.md - Local Tools & Environment

## Browser Automation (agent-browser)

Optional tool for browsing, form filling, and scraping (`npm install -g @anthropic/agent-browser`).

**RSS first:** Before scraping, check for RSS/Atom feeds (`/feed`, `/rss`, `/feed.xml`, or `<link rel="alternate" type="application/rss+xml">` in `<head>`). Use feeds when available — they're more stable and don't trigger bot detection.

### Mode escalation

| Tier | Mode | When to use |
|------|------|-------------|
| 1 | **WebFetch** | Read-only page content; no browser overhead |
| 2 | **Playwright** (`agent-browser open <url>`, add `--headed` for visible window) | Interactive pages — click, fill, scroll. Fresh isolated browser |
| 3 | **CDP** (`agent-browser connect 9222`) | Reuse a real Chrome profile with cookies/auth/extensions. **Ask-first** — gets access to logged-in accounts |

### Commands

All commands work the same across Playwright and CDP modes once connected.

Navigation:    open <url> | close
Snapshot:      snapshot -i — get element refs (@e1, @e2, ...)
Interact:      click @e1 | fill @e2 "text" | select @e1 "option" | check @e1
Keyboard:      press Enter | type @e2 "text"
Scroll:        scroll down 500
Read:          get text @e1 | get url | get title
Wait:          wait @e1 | wait 2000
Capture:       screenshot | screenshot --full

### Constraints

- Do NOT browse internal/localhost/RFC1918 URLs (exception: `agent-browser connect <port>` to localhost is the intended CDP use).
- Do NOT save auth state to tracked/committed locations.

## Service Operations (discoclaw)

Discoclaw runs as a user-level systemd service. Status checks and log reads are fine anytime, but **always ask before restarting or stopping** — a restart kills any active Claude Code sessions (including forge runs), and the user may have work in progress.

### Environment (.env)

Discoclaw loads `.env` from the service **working directory** via `EnvironmentFile` and `dotenv/config`. In a source checkout that is usually the repo root; in npm-managed installs it is the package/install directory. If you need to change env vars, edit that instance's `.env`. The `!secret` command also targets this file.

### Authorized Commands

| Action | Command |
|--------|---------|
| Restart | `systemctl --user restart discoclaw` |
| Stop | `systemctl --user stop discoclaw` |
| Start | `systemctl --user start discoclaw` |
| Status | `systemctl --user status discoclaw` |
| Logs | `journalctl --user -u discoclaw --no-pager -n 50` |

### Procedure

When a restart seems needed (code changes, config updates, etc.):

1. **Ask first** — Confirm with the user before restarting. A restart kills all active sessions.
2. **Check status** — `systemctl --user status discoclaw` (is it running? stuck? already stopped?)
3. **Restart** — `systemctl --user restart discoclaw`
3. **Verify** — Check status again, then tail logs to confirm healthy startup
4. **Report** — Tell the user what happened (was running, restarted, came back clean — or didn't)

### Discord Convenience Commands

These commands are handled directly by discoclaw (no AI invocation):

- `!restart` — restart the discoclaw service (checks status before/after, reports outcome)
- `!restart status` — show current service status
- `!restart logs` — show recent service logs (last 30 lines)
- `!stop` — abort all active AI streams and cancel any running forge
- `!models` — show current model assignments for all roles
- `!models set <role> <model>` — change the model for a role at runtime
- `!models help` — show available roles and usage

### Guardrails

- **Always ask before restart/stop.** Restarts kill active sessions. Never restart without explicit confirmation, even if the user just asked to change something that requires a restart.
- **Only `--user` services.** Never touch system-level services (`--system`). If something needs sudo, hand it to the user.
- **Only discoclaw.** This authorization covers the discoclaw service specifically. Other user services require asking first.
- **Report, don't hide.** Always tell the user the outcome, even if it's routine.
- **If restart fails twice, stop and diagnose.** Don't loop. Check logs, report the error, suggest next steps.

### Rebuild & Restart Workflow

When the user asks for "a rebuild," follow a consistent sequence and wait for confirmation before touching services.

1. Switch to the real repo: `cd ~/code/discoclaw`.
2. Run `git pull` to sync with origin.
3. Run `pnpm install` (it can't hurt even if dependencies are already satisfied).
4. Run `pnpm build` and treat any non‑zero exit as a failure; capture the stdout/stderr snippet that proves the build finished.
5. Offer to run `pnpm preflight` only if the user explicitly asks for it.
6. Report back with the command outputs and explicitly state "build succeeded" or where it failed.
7. Wait for the user to acknowledge the rebuild succeeded before proposing or executing any restart.

If the user separately asks for a restart, only then execute `systemctl --user restart discoclaw`, following the existing restart procedure (status → restart → status/logs). Never restart before the rebuild workflow has succeeded and been confirmed; the rebuild must be confirmed first, then the restart follows as a distinct, second step.

## Webhook Server

Inbound webhook server — lets external services (GitHub, monitoring, etc.) trigger AI-powered responses in Discord channels via `POST /webhook/<source>` with HMAC-SHA256 verification.
Enable with `DISCOCLAW_WEBHOOK_ENABLED=1`, `DISCOCLAW_WEBHOOK_PORT=9400`, and `DISCOCLAW_WEBHOOK_CONFIG=<path-to-webhooks.json>`.
Dispatches through the same cron execution pipeline as automations; webhook jobs run without Discord action permissions or tool access.
See `docs/webhook-exposure.md` for full config format, security details, and external exposure setup (Tailscale Funnel, ngrok, Caddy).

## Plan-Audit-Implement Workflow

A structured dev workflow for producing audited plans before writing code. Use this for any non-trivial change — features, bug fixes, refactors. Triggered by **"plan this"**, **"let's plan"**, or the `!plan` / `!forge` Discord commands.

**Pipeline stages:** DRAFT → REVIEW → REVISE (loop) → APPROVED → IMPLEMENTING → AUDITING → DONE

Plans are stored in `workspace/plans/plan-NNN-slug.md`. Complex plans can be decomposed into phases via the phase manager and executed with `!forge`.

**Canonical reference:** See `docs/plan-and-forge.md` for full command syntax, the forge orchestration loop, phase manager details, configuration options, and end-to-end workflows.

## Task Management

Discoclaw has a built-in task tracker backed by Discord forum threads. Use `taskCreate` for tracking work items — not GitHub issues and not manual thread creation.

**When to create a task:**
- TODOs or action items that come up in conversation
- Follow-up work the user mentions but isn't ready to start
- Bug reports, feature requests, or things to revisit later
- Any work item the user wants tracked

After creating a task, always post a link to its Discord thread so the user can jump straight to it.

## Discord Action Types

Discord action schemas are injected into your prompt at runtime. Use `<discord-action>` blocks as documented there. In DMs, action blocks are not available.
