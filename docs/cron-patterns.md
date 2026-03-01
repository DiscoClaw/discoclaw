# Cron Patterns & Recipes

Worked examples showing how to compose the cron system's primitives into real workflows. Each pattern includes copy-pasteable action blocks and prompt templates.

For primitive reference (state, silent mode, routing, chaining, etc.), see [docs/cron.md](cron.md).

**How to read this cookbook:** Each pattern starts with a use case, shows the `cronCreate` and/or `cronUpdate` action blocks needed, provides a prompt template, and ends with gotchas specific to that pattern.

---

## Pattern: Stateful Polling

**Use case:** Track a cursor (tag, timestamp, ID) across runs and only report new items.

### Example: GitHub Release Watcher

Create the job:

```json
{
  "action": "cronCreate",
  "name": "github-release-watcher",
  "schedule": "0 */2 * * *",
  "timezone": "UTC",
  "channel": "dev-alerts",
  "prompt": "Check the GitHub API for new releases of owner/repo. Previous state: {{state}}\n\nIf there are releases newer than the \"lastSeenTag\" in state, post a summary of each new release. Update state with the newest tag.\n\nIf no new releases, respond with HEARTBEAT_OK.\n\nAlways emit a <cron-state> block with the current state, including all existing keys."
}
```

Seed initial state so the first run has a baseline:

```json
{
  "action": "cronUpdate",
  "cronId": "github-release-watcher",
  "state": { "lastSeenTag": "v2.3.0", "lastChecked": "2026-03-01T00:00:00Z" }
}
```

On each run the AI reads `{{state}}`, checks the API, and emits:

```text
New release: v2.3.1 — bug fixes for the widget module.

<cron-state>{"lastSeenTag": "v2.3.1", "lastChecked": "2026-03-01T14:00:00Z"}</cron-state>
```

### Gotchas

- **State replacement is full, not merge.** The `<cron-state>` object replaces the entire state. Always include all keys you want to keep — the `{{state}}` placeholder makes this easy by giving the AI the full current state.
- **`{{state}}` expands to `{}` on first run.** If you don't seed state via `cronUpdate`, the AI sees an empty object. Design your prompt to handle this gracefully.
- **`{{state}}` in the prompt template expands to full JSON without truncation**, but the separate "Persistent State" section injected by the executor is capped at 4000 chars. Keep state concise for best results.

---

## Pattern: Silent-by-Default Monitoring

**Use case:** A job runs on a schedule but only posts to Discord when something noteworthy happens. Channels stay clean.

### Example: Uptime Checker

Step 1 — create the job:

```json
{
  "action": "cronCreate",
  "name": "uptime-check",
  "schedule": "*/5 * * * *",
  "timezone": "UTC",
  "channel": "ops-alerts",
  "prompt": "Check if https://example.com is reachable and responding with HTTP 200.\n\nIf the site is DOWN or returning errors, post an alert with the status code and response time.\n\nIf the site is UP and healthy, respond with exactly: HEARTBEAT_OK"
}
```

Step 2 — enable silent mode (this is an update-only field):

```json
{
  "action": "cronUpdate",
  "cronId": "uptime-check",
  "silent": true
}
```

When the site is healthy, the AI responds `HEARTBEAT_OK` and the executor suppresses the post. When something breaks, the AI posts an alert and it goes through to the channel.

### Gotchas

- **`silent` is an update-only field.** You can't set it on `cronCreate` — use a follow-up `cronUpdate`.
- **Sentinel values:** The executor looks for `HEARTBEAT_OK` in default mode and `[]` in JSON routing mode. Your prompt must instruct the AI to use the correct sentinel.
- **Short responses (<=80 chars) are also suppressed in silent mode.** This prevents terse "all good" messages from leaking through. If you need short affirmative posts, don't use silent mode.
- **Be explicit about what counts as "noteworthy."** Vague instructions like "only post if something interesting happens" lead to inconsistent suppression. Spell out the exact conditions.

---

## Pattern: Multi-Channel Routing

**Use case:** A single job dispatches different content to different channels per run.

### Example: Daily Digest

```json
{
  "action": "cronCreate",
  "name": "daily-digest",
  "schedule": "0 8 * * *",
  "timezone": "America/New_York",
  "channel": "general",
  "routingMode": "json",
  "prompt": "Prepare the daily digest. Post engineering updates to the engineering channel, design updates to the design channel, and a general summary to the general channel.\n\nReturn a JSON array of objects, each with \"channel\" (channel name) and \"content\" (the message text). Return bare JSON — no code fences."
}
```

The AI returns:

```json
[
  { "channel": "engineering", "content": "**Eng Digest:** 3 PRs merged, CI is green..." },
  { "channel": "design", "content": "**Design Digest:** New mockups for the dashboard..." },
  { "channel": "general", "content": "**Daily Summary:** All systems nominal..." }
]
```

The router sends each entry to its target channel.

### Gotchas

- **The AI must return a bare JSON array** — no markdown code fences, no prose wrapper. Instruct this explicitly in the prompt.
- **Empty `[]` is a valid no-op.** The executor treats it as a successful run with nothing to post.
- **Parse failure falls back to the default channel.** If the AI returns malformed JSON, the raw text is posted to the channel specified in `cronCreate`.
- **Available channels are injected into the prompt automatically.** The AI knows which channels it can target.

---

## Pattern: Chained Pipelines

**Use case:** Multi-step workflows where one job's output feeds the next.

### Example: Fetch → Summarize → Notify

Create each job in the pipeline:

```json
{
  "action": "cronCreate",
  "name": "fetch-data",
  "schedule": "0 7 * * 1-5",
  "timezone": "America/New_York",
  "channel": "data-staging",
  "prompt": "Fetch the latest metrics from the API. Store the raw data in state.\n\nAlways emit a <cron-state> block with the fetched data."
}
```

```json
{
  "action": "cronCreate",
  "name": "summarize",
  "schedule": "0 0 1 1 *",
  "timezone": "UTC",
  "channel": "data-staging",
  "prompt": "Read the upstream data from {{state}} — look under __upstream.state for the fetched metrics.\n\nProduce a concise summary. Emit a <cron-state> block with the summary text."
}
```

```json
{
  "action": "cronCreate",
  "name": "notify-team",
  "schedule": "0 0 1 1 *",
  "timezone": "UTC",
  "channel": "team-updates",
  "prompt": "Read the summary from {{state}} under __upstream.state.\n\nFormat it as a friendly team update and post it."
}
```

Wire the chain (jobs must exist before linking):

```json
{
  "action": "cronUpdate",
  "cronId": "fetch-data",
  "chain": ["summarize"]
}
```

```json
{
  "action": "cronUpdate",
  "cronId": "summarize",
  "chain": ["notify-team"]
}
```

The result:

```
fetch-data  ──chain──▶  summarize  ──chain──▶  notify-team
  (scheduled)            (triggered)             (triggered)
```

Only `fetch-data` runs on a schedule. The downstream jobs fire automatically on success.

### Gotchas

- **Depth limit of 10.** Chain execution stops at depth 10 to prevent runaway cascades.
- **Success-only firing.** Downstream jobs only fire when the upstream job records a `success` status. Errors or interruptions stop the chain.
- **Fire-and-forget semantics.** The upstream job does not wait for downstream jobs. A failure in one downstream job does not block others.
- **Cycle detection at write time.** The system runs BFS to reject chain updates that would create cycles. Self-loops (`A → A`) are always rejected.
- **Downstream must read `__upstream.state` from `{{state}}`.** The upstream job's state is forwarded under the `__upstream` key in the downstream job's state object.
- **Triggered jobs need a dummy schedule.** Even chain-triggered jobs require a valid `schedule` field on `cronCreate`. Use a far-future or rare schedule (like `0 0 1 1 *`) so it effectively never fires on its own.

---

## Pattern: Gated Actions

**Use case:** Constrain which Discord actions a cron job can emit, following least-privilege.

### Example: News Poster (Send-Only)

```json
{
  "action": "cronCreate",
  "name": "news-poster",
  "schedule": "0 9 * * *",
  "timezone": "America/New_York",
  "channel": "news",
  "allowedActions": ["sendMessage"],
  "prompt": "Check the top 3 headlines from the configured news sources. Post a brief summary of each as a separate message."
}
```

This job can emit `sendMessage` actions but nothing else — no channel creation, no moderation, no reactions. If the AI tries to emit an action outside the allow list, it's silently dropped.

### Gotchas

- **Narrowing only.** `allowedActions` can only restrict — it can't grant permissions that the global action flags deny. If `DISCOCLAW_ACTIONS_MESSAGING=false`, adding `sendMessage` to `allowedActions` won't override that.
- **Empty string on `cronUpdate` clears the restriction.** Setting `allowedActions` to an empty string removes the constraint, restoring all globally-enabled actions.
- **Cron jobs can never emit cron actions** regardless of `allowedActions`. This is a hard-coded safety rail — cron jobs cannot create, update, or delete other cron jobs.

---

## Pattern: Model Selection

**Use case:** Choose the right model tier per job based on complexity, cost, and latency needs.

### Model Tiers

| Tier | When to use | Example models |
|------|-------------|----------------|
| `fast` | Simple checks, triage, formatting | Haiku (Claude), GPT-4o-mini (OpenAI) |
| `capable` | Standard analysis, summaries, multi-step reasoning | Sonnet (Claude), GPT-4o (OpenAI) |
| `deep` | Complex analysis, nuanced judgment, long-form generation | Opus (Claude), o1 (OpenAI) |

### Example: Fast Triage with Capable Escalation

A fast-tier job triages incoming items and flags complex ones for a capable-tier job:

```json
{
  "action": "cronCreate",
  "name": "issue-triage",
  "schedule": "*/30 * * * *",
  "timezone": "UTC",
  "channel": "triage",
  "model": "fast",
  "prompt": "Check for new issues since {{state}}. For each issue:\n- If straightforward, post a one-line classification.\n- If complex, add it to the escalation list in state.\n\nEmit <cron-state> with updated lastChecked and escalationList."
}
```

```json
{
  "action": "cronCreate",
  "name": "issue-deep-analysis",
  "schedule": "0 0 1 1 *",
  "timezone": "UTC",
  "channel": "triage",
  "model": "capable",
  "prompt": "Read __upstream.state from {{state}}. For each issue in escalationList, provide a detailed analysis with recommended priority and assignee."
}
```

Wire the chain:

```json
{
  "action": "cronUpdate",
  "cronId": "issue-triage",
  "chain": ["issue-deep-analysis"]
}
```

You can also change a job's model after creation:

```json
{
  "action": "cronUpdate",
  "cronId": "issue-triage",
  "model": "capable"
}
```

### Gotchas

- **Priority chain:** per-job override > AI-classified model > `cron-exec` default (`DISCOCLAW_CRON_EXEC_MODEL`) > chat fallback. A per-job `model` field always wins.
- **Model tiers resolve to concrete models per-runtime.** For example, `fast` → Haiku for Claude, GPT-4o-mini for OpenAI. The mapping depends on which runtime adapter is active.
- **Cost awareness.** `deep` tier models cost significantly more and are slower. Use `fast` for high-frequency jobs (every 5 minutes) and reserve `deep` for jobs that truly need it.

---

## Pattern: Webhook-Triggered Automations

**Use case:** React to external events (GitHub pushes, Stripe payments, etc.) in real time rather than on a schedule.

Webhooks are **not cron jobs** and are **not configured via `cronCreate`/`cronUpdate`**. They are defined in a JSON config file and dispatched through the cron executor pipeline as synthetic jobs.

### Example: GitHub Push Notifier

In your webhook config file (pointed to by `DISCOCLAW_WEBHOOK_CONFIG`):

```json
{
  "github": {
    "secret": "whsec_your_github_secret_here",
    "channel": "dev-alerts",
    "prompt": "A GitHub event arrived from {{source}}:\n\n{{body}}\n\nSummarize this event. If it's a push to main, list the commits. If it's a PR, summarize the changes. Otherwise, give a one-line description."
  }
}
```

Enable the webhook server:

```bash
DISCOCLAW_WEBHOOK_ENABLED=true
DISCOCLAW_WEBHOOK_CONFIG=/path/to/webhook-config.json
```

Register the webhook URL with GitHub as `https://<your-host>/webhook/github`.

For tunnel/proxy setup and security details, see [docs/webhook-exposure.md](webhook-exposure.md).

### Gotchas

- **Requires `DISCOCLAW_WEBHOOK_ENABLED=true`** and a config file pointed to by `DISCOCLAW_WEBHOOK_CONFIG`.
- **HMAC-SHA256 signature verification is mandatory.** Every request must include a valid `X-Hub-Signature-256` header. There is no way to disable verification.
- **`{{body}}` and `{{source}}` are webhook-config placeholders**, not cron prompt placeholders. They are expanded from the incoming HTTP request, not from job state. `{{state}}` and other cron placeholders do not apply here.
- **No schedule or forum thread involved.** Webhooks fire on demand when an HTTP POST arrives. They don't appear in the cron forum and have no run-stats thread.
- **Each source is isolated.** Different sources (e.g., `github`, `stripe`) have independent secrets and target channels. Compromising one source's secret doesn't affect others.
