# TOOLS.md - Local Tools & Environment

## Browser Automation (agent-browser)

`agent-browser` is an optional tool for browsing, form filling, and scraping. It requires a separate install (`npm install -g @anthropic/agent-browser`) and is not bundled with discoclaw.

### RSS First

Before using browser automation or WebFetch for any recurring or structured data need, check if the site has an RSS/Atom feed. Feeds are more stable than scraped HTML, don't trigger bot detection, and are already structured.

**How to check:**
- Common paths: `/feed`, `/rss`, `/feed.xml`, `/atom.xml`, `/rss.xml`, `/index.xml`
- Look for `<link rel="alternate" type="application/rss+xml">` in the page's `<head>` via WebFetch
- Many CMSes (WordPress, Ghost, Substack, etc.) expose feeds automatically

If a feed covers the needed data, use it. Only fall back to scraping if no feed exists or the feed is too limited.

### Which mode to use

Escalate through these options as needed:

1. **WebFetch** — Read-only page content. Fastest, no browser overhead. Use
   for simple reads where you don't need to interact with the page.
2. **Playwright headless** (`agent-browser open <url>`) — Default. Interact
   with pages (click, fill, scroll) without a visible window. Handles most sites.
3. **Playwright headed** (`agent-browser open <url> --headed`) — Same as
   above but with a visible Chrome window. Use when the user wants to watch or
   co-pilot the session.
4. **CDP headless** — Real Chrome, no window. Reuses an existing persistent
   profile with its cookies, auth state, and extensions. Use for automated
   tasks against sites you've already logged into. Avoids bot detection.
5. **CDP headed** — Real Chrome, visible window. Same as CDP headless but you
   can see and interact with the browser. Use for initial login setup, debugging,
   or when visual confirmation matters.

**Key distinction:** Playwright modes (2-3) launch a fresh, isolated browser.
CDP modes (4-5) connect to a real Chrome instance with persistent state.

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

### Playwright Modes

**Headless (default):**
```
agent-browser open <url>
```

**Headed (visible window):**
```
agent-browser open <url> --headed
```

### CDP Connect (Real Browser)

Connect to a real Chrome instance instead of headless Playwright. The agent
operates inside an existing browser session with its cookies, extensions, and
logged-in accounts intact.

**Security:** This is an **ask-first** action — always get explicit consent
before suggesting or using CDP connect. You'd be operating inside a real
browser session with access to logged-in accounts.

**When to use CDP:**
- Sites behind auth walls that block headless browsers
- Bot-detection / CAPTCHA-heavy sites
- Sites that require browser extensions to function
- Reusing sessions and cookies from previous logins

**CDP headed** (visible window — for initial setup or debugging):
```
google-chrome --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --user-data-dir=$HOME/.config/agent-chrome
```

**CDP headless** (no window — for automated tasks against existing sessions):
```
google-chrome --headless=new --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --user-data-dir=$HOME/.config/agent-chrome
```

Both use a dedicated persistent profile (`~/.config/agent-chrome`) so sessions
survive reboots.

Platform note: command is `google-chrome` on Fedora; differs on macOS/Windows.

**Connect:** `agent-browser connect 9222`

**Confirm it's up:** `agent-browser get url`

After connecting, all normal commands work (snapshot, click, fill, etc.).

**Shutdown:** Close the Chrome window or `agent-browser close` when done.

**Typical CDP workflow:** Start headed to log in and set up the profile. Later,
switch to headless for automated tasks — same profile, same cookies, no window.

### Constraints

- Do NOT browse internal/localhost/RFC1918 URLs (exception: `agent-browser connect <port>` to localhost is the intended CDP use).
- Do NOT save auth state to tracked/committed locations. If using
  `state save`, write to a temp or data directory, never workspace/.

## Service Operations (discoclaw)

Discoclaw runs as a user-level systemd service. Status checks and log reads are fine anytime, but **always ask before restarting or stopping** — a restart kills any active Claude Code sessions (including forge runs), and the user may have work in progress.

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

## Plan-Audit-Implement Workflow

A structured dev workflow for producing audited plans before writing code. Use this for any non-trivial change — features, bug fixes, refactors. Triggered by **"plan this"**, **"let's plan"**, or the `!plan` / `!forge` Discord commands.

**Pipeline stages:** DRAFT → REVIEW → REVISE (loop) → APPROVED → IMPLEMENTING → AUDITING → DONE

Plans are stored in `workspace/plans/plan-NNN-slug.md`. Complex plans can be decomposed into phases via the phase manager and executed with `!forge`.

**Canonical reference:** See `docs/plan-and-forge.md` for full command syntax, the forge orchestration loop, phase manager details, configuration options, and end-to-end workflows.

## Discord Action Types for Forge, Plan & Memory

Use these as `<discord-action>` blocks in responses — never send `!forge`/`!plan`/`!memory` as text messages (bot-sent messages don't trigger command handlers).

### Forge Actions

**forgeCreate** — Start a new forge run (drafts a plan, then audits/revises iteratively):
```
<discord-action>{"type":"forgeCreate","description":"Add retry logic to webhook handler","context":"Optional extra context"}</discord-action>
```
- `description` (required): What to plan for.
- `context` (optional): Additional context appended to the plan.

**forgeResume** — Resume auditing an existing plan:
```
<discord-action>{"type":"forgeResume","planId":"plan-042"}</discord-action>
```
- `planId` (required): The plan ID to resume.

**forgeStatus** — Check if a forge is currently running:
```
<discord-action>{"type":"forgeStatus"}</discord-action>
```

**forgeCancel** — Cancel a running forge:
```
<discord-action>{"type":"forgeCancel"}</discord-action>
```

Only one forge can run at a time. Forge runs are asynchronous — progress updates are posted to the channel. Use forgeResume to re-audit a plan after manual edits.

### Plan Actions

**planList** — List all plans (optionally filter by status):
```
<discord-action>{"type":"planList"}</discord-action>
<discord-action>{"type":"planList","status":"APPROVED"}</discord-action>
```
- `status` (optional): Filter by DRAFT, REVIEW, APPROVED, IMPLEMENTING, CLOSED.

**planShow** — Show plan details:
```
<discord-action>{"type":"planShow","planId":"plan-042"}</discord-action>
```

**planApprove** — Approve a plan for implementation:
```
<discord-action>{"type":"planApprove","planId":"plan-042"}</discord-action>
```

**planClose** — Close/abandon a plan:
```
<discord-action>{"type":"planClose","planId":"plan-042"}</discord-action>
```

**planCreate** — Create a new plan (drafts a plan file and backing bead):
```
<discord-action>{"type":"planCreate","description":"Add retry logic to webhook handler","context":"Optional extra context"}</discord-action>
```
- `description` (required): What the plan is for.
- `context` (optional): Additional context.

**planRun** — Execute all remaining phases of an approved plan (fire-and-forget):
```
<discord-action>{"type":"planRun","planId":"plan-042"}</discord-action>
```
- Plan must be in APPROVED status. Phases run sequentially.

Use planList to check existing plans before creating duplicates. Use forgeCreate to draft+audit a plan, or planCreate for a bare plan file without forge auditing.

### Memory Actions

**memoryRemember** — Store a fact in durable memory:
```
<discord-action>{"type":"memoryRemember","text":"Prefers Rust over Go for systems work"}</discord-action>
<discord-action>{"type":"memoryRemember","text":"Working on API migration","kind":"project"}</discord-action>
```
- `text` (required): The fact or note to remember.
- `kind` (optional): One of `fact`, `preference`, `project`, `constraint`, `person`, `tool`, `workflow`. Defaults to `fact`.

**memoryForget** — Deprecate matching items from durable memory:
```
<discord-action>{"type":"memoryForget","substring":"Prefers Rust over Go"}</discord-action>
```
- `substring` (required): Text to match against. Items where this covers >= 60% of the item's text length are deprecated.

**memoryShow** — Show the user's current durable memory items:
```
<discord-action>{"type":"memoryShow"}</discord-action>
```

Use memoryRemember to proactively store important facts (preferences, projects, tools, constraints). Pick the most specific `kind` that fits. Memory items persist across sessions, channels, and restarts.

### Model Configuration

**modelShow** — Show current model assignments for all roles:
```
<discord-action>{"type":"modelShow"}</discord-action>
```

**modelSet** — Change the model for a role at runtime:
```
<discord-action>{"type":"modelSet","role":"chat","model":"sonnet"}</discord-action>
<discord-action>{"type":"modelSet","role":"fast","model":"haiku"}</discord-action>
```
- `role` (required): One of `chat`, `fast`, `forge-drafter`, `forge-auditor`, `summary`, `cron`, `cron-exec`.
- `model` (required): Model tier (`fast`, `capable`), concrete model name (`haiku`, `sonnet`, `opus`), or `default` (for cron-exec only, to revert to following chat).

**Roles:**
| Role | What it controls |
|------|-----------------|
| `chat` | Discord messages, plan runs, deferred runs, forge fallback |
| `fast` | All small/fast tasks (summary, cron auto-tag, beads auto-tag) |
| `forge-drafter` | Forge plan drafting/revision |
| `forge-auditor` | Forge plan auditing |
| `summary` | Rolling summaries only (overrides fast) |
| `cron` | Cron auto-tagging and model classification (overrides fast) |
| `cron-exec` | Default model for cron job execution (overridden by per-job settings) |

Changes are **ephemeral** -- they take effect immediately but revert on restart. Use env vars (`RUNTIME_MODEL`, `DISCOCLAW_FAST_MODEL`, etc.) for persistent configuration.

**Cron model priority:** per-job override (cronUpdate) > AI-classified model > cron-exec default > chat fallback.
Set `cron-exec` to `default` to clear the override and fall back to the chat model.

Note: The `cron` role controls auto-tagging only. Use `cron-exec` to set the default execution model for all cron jobs.
