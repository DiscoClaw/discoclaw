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

## Pattern: Stateful JSON Router

**Use case:** Poll an external source, deduplicate against previously seen items, and route each item to a different channel based on its content. Combines stateful polling with JSON routing.

### Example: Inbox Triage

A cron that checks for new messages (email, RSS, alerts — anything with unique IDs), skips ones it's already seen, classifies each new item, and routes it to the right channel.

Create the job:

```json
{
  "action": "cronCreate",
  "name": "inbox-triage",
  "schedule": "*/15 * * * *",
  "timezone": "America/New_York",
  "channel": "general",
  "routingMode": "json",
  "prompt": "Run ~/scripts/check-inbox.sh to get recent items as JSON.\n\nCheck the Persistent State section for `seen_ids`. Filter out any items whose `id` is already in that list. Only process new items.\n\nFor each new item, write a brief summary and route it to the appropriate channel:\n- Finance, billing, invoices → #finance\n- Infrastructure, ops, alerts → #ops\n- Project updates, PRs, CI → #dev\n- Everything else → #general\n\nReturn a JSON array: [{\"channel\": \"#finance\", \"content\": \"summary here\"}, ...]\n\nAfter routing, emit a <cron-state> block with the updated seen_ids (all existing IDs plus newly processed ones, capped at 200 most recent):\n<cron-state>{\"seen_ids\": [\"id1\", \"id2\", ...]}</cron-state>\n\nIf there are no new items, return [] and do not update state."
}
```

Enable silent mode so empty runs don't post:

```json
{
  "action": "cronUpdate",
  "cronId": "inbox-triage",
  "silent": true
}
```

On each run the AI:

1. Executes the script and gets raw items
2. Reads `{{state}}` to find previously seen IDs
3. Filters to only new items
4. Returns a JSON array with per-channel routing
5. Emits `<cron-state>` with updated `seen_ids`

When there's nothing new, the AI returns `[]` — the JSON router's empty-array sentinel — and silent mode suppresses the post.

### Gotchas

- **State and JSON routing work together.** The `<cron-state>` block is stripped before the JSON router parses the array. The AI can emit both in the same response.
- **Cap your ID list.** Without a cap, `seen_ids` grows unbounded. Instruct the AI to keep only the N most recent IDs (200 is a reasonable default).
- **`[]` is the silent sentinel for JSON mode.** In default (non-JSON) mode, the sentinel is `HEARTBEAT_OK`. Your prompt must use the correct one for the routing mode.
- **Routing rules in the prompt are suggestions, not enforcement.** The AI decides which channel each item goes to based on your instructions. Be specific about classification criteria to get consistent routing.
- **The script must be executable and return valid JSON.** If the script fails or returns garbage, the AI will likely produce an error message that falls back to the default channel.

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

---

## Pattern: Accumulation / Rollup

**Use case:** Aggregate data points across frequent runs and emit a periodic summary — hourly counts rolled into a daily digest, error tallies, metric tracking, etc.

### Example: Hourly Error Counter with Daily Rollup

An hourly job accumulates error counts. When 24 runs have passed (or a day boundary is hit), it emits a summary and resets.

```json
{
  "action": "cronCreate",
  "name": "error-rollup",
  "schedule": "0 * * * *",
  "timezone": "America/Los_Angeles",
  "channel": "ops-alerts",
  "model": "fast",
  "prompt": "Run ~/scripts/count-errors.sh to get the current error count as a number.\n\nPrevious state: {{state}}\n\nAccumulate the count into state.totals (an array of {hour, count} entries). Increment state.runCount.\n\nIf state.runCount reaches 24:\n- Post a daily summary: total errors, peak hour, trend vs yesterday (if state.yesterdayTotal exists).\n- Move the current total to state.yesterdayTotal.\n- Reset state.totals to [] and state.runCount to 0.\n\nIf state.runCount < 24, respond with HEARTBEAT_OK.\n\nAlways emit a <cron-state> block with the full updated state."
}
```

Enable silent mode so intermediate runs stay quiet:

```json
{
  "action": "cronUpdate",
  "cronId": "error-rollup",
  "silent": true
}
```

Seed initial state:

```json
{
  "action": "cronUpdate",
  "cronId": "error-rollup",
  "state": "{\"totals\": [], \"runCount\": 0, \"yesterdayTotal\": 0}"
}
```

On the 24th run, the AI posts:

```text
**Daily Error Rollup**
- Total errors: 47 (yesterday: 62, down 24%)
- Peak hour: 14:00 PT (12 errors)
- Quietest: 03:00 PT (0 errors)

<cron-state>{"totals": [], "runCount": 0, "yesterdayTotal": 47}</cron-state>
```

### Gotchas

- **Use `runCount` or timestamps for cadence, not external clocks.** The AI doesn't inherently know how many times it's run. Include a counter in state so it can trigger rollups reliably.
- **State grows linearly between rollups.** If you're accumulating per-run entries, keep individual entries small. A 24-element array is fine; storing raw log output per run is not.
- **Missed runs don't reset the counter.** If the service is down for 6 hours, `runCount` will be 6 short at the expected rollup time. Design prompts to handle this gracefully — check timestamps, not just counts, if exact cadence matters.
- **Silent mode + `HEARTBEAT_OK` suppresses the 23 intermediate runs.** The rollup post on run 24 exceeds 80 chars and passes through normally.

---

## Pattern: Web Fetch / RSS Monitoring

**Use case:** Periodically check a website, API endpoint, or RSS feed and report changes or new items.

### Example: RSS Feed Watcher

```json
{
  "action": "cronCreate",
  "name": "rss-watcher",
  "schedule": "0 */4 * * *",
  "timezone": "UTC",
  "channel": "news",
  "model": "fast",
  "prompt": "Fetch the RSS feed at https://example.com/feed.xml using WebFetch.\n\nPrevious state: {{state}}\n\nParse the feed and extract article titles and URLs. Compare against state.seenUrls (an array of URLs from previous runs).\n\nFor each new article not in seenUrls, post a one-line summary with the link.\n\nUpdate state.seenUrls with all current URLs (keep the 100 most recent to prevent unbounded growth).\n\nIf no new articles, respond with HEARTBEAT_OK.\n\nAlways emit a <cron-state> block."
}
```

```json
{
  "action": "cronUpdate",
  "cronId": "rss-watcher",
  "silent": true
}
```

### Example: Page Change Detector

For non-feed pages, track content hashes:

```json
{
  "action": "cronCreate",
  "name": "page-monitor",
  "schedule": "0 8,20 * * *",
  "timezone": "America/New_York",
  "channel": "alerts",
  "prompt": "Fetch https://example.com/pricing using WebFetch.\n\nPrevious state: {{state}}\n\nCompare the page content against state.lastSnapshot (a brief text summary of the previous version). If the content has meaningfully changed (ignore minor formatting or timestamp differences), post a summary of what changed.\n\nUpdate state.lastSnapshot with a concise summary of the current page content.\n\nIf nothing meaningful changed, respond with HEARTBEAT_OK.\n\nAlways emit a <cron-state> block."
}
```

### Gotchas

- **WebFetch converts HTML to markdown.** The AI receives processed text, not raw HTML. This is usually what you want for comparison, but minor formatting differences between fetches can cause false positives. Instruct the AI to focus on semantic changes.
- **RSS feeds are more stable than scraped pages.** Always check for an RSS/Atom feed before scraping. Common paths: `/feed`, `/rss`, `/feed.xml`, `/atom.xml`, `/index.xml`.
- **Don't store full page content in state.** State has a practical size limit. Store summaries, hashes, or extracted data points — not the entire page.
- **Rate limiting.** Running a fetch every 5 minutes against an external site may trigger rate limits or bot detection. Use reasonable intervals (every few hours for most sites).

---

## Pattern: Script Execution + Structured Output

**Use case:** Run a local script or command, parse its output, and act on the results. Covers system monitoring (disk space, process health, log scanning), data collection, and any workflow driven by shell commands.

### Example: Disk Space Monitor

```json
{
  "action": "cronCreate",
  "name": "disk-monitor",
  "schedule": "0 */6 * * *",
  "timezone": "UTC",
  "channel": "ops-alerts",
  "model": "fast",
  "prompt": "Run `df -h --output=target,pcent,avail /home /tmp /var` and parse the output.\n\nIf any filesystem is above 85% usage, post an alert with the mount point, usage percentage, and available space.\n\nIf all filesystems are healthy, respond with HEARTBEAT_OK."
}
```

```json
{
  "action": "cronUpdate",
  "cronId": "disk-monitor",
  "silent": true
}
```

### Example: Log Scanner with Structured JSON

For scripts that produce JSON output:

```json
{
  "action": "cronCreate",
  "name": "log-scanner",
  "schedule": "*/30 * * * *",
  "timezone": "UTC",
  "channel": "ops-alerts",
  "model": "fast",
  "prompt": "Run ~/scripts/scan-errors.sh which outputs a JSON array of {timestamp, level, message} objects representing recent log errors.\n\nPrevious state: {{state}}\n\nFilter out any entries with timestamps earlier than state.lastTimestamp.\n\nIf there are new errors:\n- Group by level (ERROR, WARN, FATAL)\n- Post a summary: count per level, plus the full text of any FATAL entries\n- Update state.lastTimestamp to the newest entry's timestamp\n\nIf no new errors, respond with HEARTBEAT_OK.\n\nAlways emit a <cron-state> block."
}
```

### Gotchas

- **The script must be executable.** The AI runs commands via a shell — ensure scripts have `chmod +x` and the correct shebang line.
- **Use absolute paths.** The working directory during cron execution may not be what you expect. Always use full paths to scripts and files.
- **Capture exit codes in your prompt.** If the script might fail, instruct the AI to check for errors and report them instead of silently ignoring bad output.
- **Keep script output concise.** The AI's context window is finite. Scripts that dump thousands of lines will get truncated. Design scripts to output summaries or filtered results.
- **Shell commands run with the bot's user permissions.** No sudo, no access to other users' files. Plan accordingly.

---

## Pattern: Discord Actions from Crons

**Use case:** Emit Discord actions (send messages to other channels, create tasks, add reactions) from a cron job. Different from JSON routing — this uses the full action system, not just channel dispatch.

### Example: Stale PR Reminder

A daily job that checks for stale PRs and creates tasks:

```json
{
  "action": "cronCreate",
  "name": "stale-pr-check",
  "schedule": "0 9 * * 1-5",
  "timezone": "America/Los_Angeles",
  "channel": "dev",
  "model": "capable",
  "allowedActions": ["taskCreate", "sendMessage"],
  "prompt": "Run `gh pr list --repo owner/repo --json number,title,updatedAt,author --search 'is:open sort:updated-asc'` to get open PRs.\n\nFor each PR not updated in the last 3 days:\n1. Create a task with title 'Review stale PR #N: <title>' and tag 'pr-review'\n2. Post a reminder to the #dev channel mentioning the PR number, author, and days since last update\n\nIf all PRs are recently active, respond with HEARTBEAT_OK."
}
```

```json
{
  "action": "cronUpdate",
  "cronId": "stale-pr-check",
  "silent": true
}
```

### Example: Cross-Channel Notification

Post the same update to multiple channels without JSON routing:

```json
{
  "action": "cronCreate",
  "name": "weekly-standup-reminder",
  "schedule": "0 9 * * 1",
  "timezone": "America/New_York",
  "channel": "general",
  "allowedActions": ["sendMessage"],
  "prompt": "It's Monday morning. Send a standup reminder to #engineering and #design:\n\n\"Weekly standup reminder: post your updates in this channel by EOD.\"\n\nAlso post a summary to #general noting that standup reminders have been sent."
}
```

### When to use actions vs. JSON routing

- **JSON routing** — dispatching different content to different channels in a single response. The router handles delivery. Best for fan-out patterns.
- **Discord actions** — creating tasks, adding reactions, sending files, or any operation beyond simple message posting. Actions give you the full API surface.
- You can combine both: use `routingMode: "json"` for multi-channel posts, plus `allowedActions` to permit specific non-message actions.

### Gotchas

- **Cron jobs can never emit cron actions.** This is a hard-coded safety rail — a cron job cannot create, modify, or delete other cron jobs, regardless of `allowedActions`.
- **Use `allowedActions` for least privilege.** Don't give a reminder cron access to `channelDelete`. Restrict to only the action types the job needs.
- **Action batching limits apply.** The system processes one action per type per response. If the AI tries to create 5 tasks, only the first fires. For bulk operations, use the `sendMessage` action to post a summary instead.
- **Actions execute with the bot's Discord permissions.** If the bot can't post in a channel, the action fails silently.

---

## Pattern: Image Generation on Schedule

**Use case:** Generate images on a recurring basis — daily art prompts, rotating server banners, chart visualizations, or periodic creative content.

### Example: Daily Art Prompt

```json
{
  "action": "cronCreate",
  "name": "daily-art",
  "schedule": "0 10 * * *",
  "timezone": "America/Los_Angeles",
  "channel": "art",
  "model": "capable",
  "allowedActions": ["generateImage"],
  "prompt": "Previous state: {{state}}\n\nGenerate a creative image prompt based on today's theme. Use state.themes (an array of past themes) to avoid repeats.\n\nPick a theme you haven't used recently and generate an image using the generateImage action with a detailed, evocative prompt. Include a brief caption describing the theme.\n\nUpdate state.themes with the new theme (keep the last 30).\n\nAlways emit a <cron-state> block."
}
```

Seed with initial themes so the first run has context:

```json
{
  "action": "cronUpdate",
  "cronId": "daily-art",
  "state": "{\"themes\": []}"
}
```

### Example: Weekly Chart

```json
{
  "action": "cronCreate",
  "name": "weekly-metrics-chart",
  "schedule": "0 9 * * 1",
  "timezone": "UTC",
  "channel": "metrics",
  "model": "capable",
  "allowedActions": ["generateImage"],
  "prompt": "Run ~/scripts/weekly-metrics.sh to get this week's key metrics as JSON.\n\nGenerate an image that visualizes the metrics as a clean, readable chart or infographic. Use the generateImage action with a prompt that describes the chart layout and data points.\n\nPost it with a caption summarizing the week's highlights."
}
```

### Gotchas

- **Image generation is slow and costs more than text.** Don't run image-gen crons on tight schedules (every 5 min). Daily or weekly is typical.
- **The AI writes the image prompt, not the image.** Quality depends on how well the AI crafts the `generateImage` prompt. Instruct it to be specific and descriptive.
- **Model and provider options.** The `generateImage` action supports `model` and `provider` fields for selecting specific image models (DALL-E 3, gpt-image-1, Imagen, Gemini native). If you need a specific model, instruct the AI to include it in the action.
- **Use `allowedActions: ["generateImage"]`** to prevent the cron from emitting other actions. A rogue image cron shouldn't be creating channels.

---

## Pattern: Manual Trigger / Dev-Test Workflow

**Use case:** Rapidly iterate on a cron job's prompt without waiting for the schedule. Create, trigger, inspect, tweak, repeat.

### The Loop

**Step 1 — Create the job:**

```json
{
  "action": "cronCreate",
  "name": "my-new-job",
  "schedule": "0 9 * * *",
  "timezone": "America/Los_Angeles",
  "channel": "test",
  "prompt": "Check the API for new items and post a summary."
}
```

**Step 2 — Trigger immediately:**

```json
{
  "action": "cronTrigger",
  "cronId": "my-new-job"
}
```

The job runs right now and posts output to the target channel. No need to wait for 9 AM.

**Step 3 — Inspect the output.** Read the channel, check if the format and content are what you want.

**Step 4 — Tweak the prompt:**

```json
{
  "action": "cronUpdate",
  "cronId": "my-new-job",
  "prompt": "Check the API for new items since {{state}}. Only report items with priority >= high. Format as bullet points with timestamps.\n\nIf no new high-priority items, respond with HEARTBEAT_OK.\n\nAlways emit a <cron-state> block with the latest item timestamp."
}
```

**Step 5 — Trigger again:**

```json
{
  "action": "cronTrigger",
  "cronId": "my-new-job"
}
```

Repeat steps 3–5 until the output is right. Then enable silent mode, adjust the schedule if needed, and let it run.

### Tips

- **Use a dedicated test channel.** Don't iterate in a production channel — the repeated test output clutters things up.
- **Seed state before triggering.** If your prompt uses `{{state}}`, set initial state via `cronUpdate` so the first trigger has realistic data to work with.
- **Check run stats in the forum thread.** After each trigger, the status message in the cron forum thread updates with the run result — useful for spotting errors the AI might not surface in its output.
- **Switch models during iteration.** Start with `fast` for quick iteration cycles, then switch to `capable` or `deep` once the prompt is stable:

```json
{
  "action": "cronUpdate",
  "cronId": "my-new-job",
  "model": "capable"
}
```

### Gotchas

- **`cronTrigger` respects the overlap guard.** If the job is already running (e.g., from a previous trigger), the trigger is skipped. Wait for the current run to finish.
- **Triggered runs count toward `runCount`.** If your prompt uses `runCount` for rollup cadence (see Accumulation pattern), manual triggers increment the counter.
- **Triggered runs fire chains.** If the job has downstream jobs wired via `chain`, triggering it will also fire those downstream jobs on success. Disconnect the chain during testing if you don't want cascading executions.

---

## Pattern: State Recovery / Migration

**Use case:** Handle corrupted state, schema changes, or cold starts gracefully. Defensive prompt engineering for jobs that depend on state.

### Defensive State Handling

Every stateful prompt should handle three cases:

1. **Empty state** (`{{state}}` is `{}`) — first run or after a reset
2. **Normal state** — expected keys are present
3. **Stale/malformed state** — schema changed, keys missing or renamed

### Example: Resilient Prompt Template

```text
Previous state: {{state}}

If state is empty or missing expected keys (lastChecked, seenIds),
treat this as a fresh start: check the last 24 hours of items and
build initial state from scratch.

If state has the expected keys, proceed normally — only process
items newer than lastChecked.

Always emit a <cron-state> block with the full state object
including all keys, even on first run.
```

### Resetting State

When state is corrupted or the schema needs to change, reset via `cronUpdate`:

```json
{
  "action": "cronUpdate",
  "cronId": "my-job",
  "state": "{}"
}
```

This clears all stored state. The next run sees `{}` and the defensive prompt handles it as a fresh start.

### Migrating State Schema

When you need to rename keys or change the structure, update the prompt to handle both old and new formats during the transition:

```text
Previous state: {{state}}

State migration: if state contains "last_tag" (old key), read it
as the starting cursor and rename to "lastSeenTag" in the emitted
state. If state contains "lastSeenTag" (new key), use it directly.

...

<cron-state>{"lastSeenTag": "...", "lastChecked": "..."}</cron-state>
```

After the job runs once with the migration prompt, the state is in the new format. You can then simplify the prompt to only reference the new keys.

### Inspecting Current State

Use `cronShow` to see what a job's state looks like before changing it:

```json
{
  "action": "cronShow",
  "cronId": "my-job"
}
```

The response includes the full persisted state object. Review it before writing a migration prompt or resetting.

### Gotchas

- **State replacement is full, not merge.** If the AI emits `<cron-state>{"newKey": 1}</cron-state>`, all previous keys are gone. Always include all keys you want to keep.
- **Don't trust state blindly.** The AI is an unreliable narrator — it might emit malformed JSON or miss keys. If state parsing fails, the executor skips the update and logs a warning, but the job continues with the old state.
- **`cronUpdate` state is also full replacement.** Setting `state` via `cronUpdate` overwrites everything. Merge manually if you need to preserve some keys.
- **Test recovery with `cronTrigger`.** After resetting state or changing the prompt, trigger the job manually to verify it handles the empty/migrated state correctly before the next scheduled run.
- **Version your state schema.** Adding a `schemaVersion` key to state lets the prompt detect and handle migrations cleanly:

```text
If state.schemaVersion is missing or < 2, migrate: rename old
keys, set schemaVersion to 2. Otherwise proceed normally.
```
