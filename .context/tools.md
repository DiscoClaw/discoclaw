# tools.md — Tool Capabilities

Canonical reference for tools available to the discoclaw agent.
`agent-browser` is optional — it requires a separate `npm install -g @anthropic/agent-browser` and is not bundled with discoclaw.

## WebFetch / Browser Escalation Ladder

Use the lightest tool that works. Escalate only when a lighter level fails.

1. **WebFetch (read-only)** — Built-in. Fetches raw page content. No JS rendering, no interaction. Try this first for any URL.
2. **Playwright headless** — `agent-browser` launches a fresh, isolated browser with no saved state. Good for JS-rendered pages, simple form fills, screenshots. No extensions, no cookies from real sessions.
3. **Playwright headed** — Same as above but with a visible browser window. Useful for debugging or when a site blocks headless user agents.
4. **CDP headless (connect)** — Connects to an already-running Chrome instance via Chrome DevTools Protocol. Persistent state: logged-in sessions, cookies, extensions. Use when Playwright can't get past auth walls or bot detection.
5. **CDP headed (connect)** — Same as CDP headless but with a visible window. Use for initial login flows where you need to watch what's happening, then switch to CDP headless for ongoing automation.

Key distinction: Playwright = fresh/isolated (no persistent state). CDP = persistent (real browser session with real cookies and extensions).

## agent-browser Commands

These are `agent-browser`-specific commands, not generic browser automation.

| Command | Purpose |
|---------|---------|
| `navigate` | Go to a URL |
| `snapshot` | Get an accessibility snapshot of the current page |
| `interact` | Click, fill, select, check/uncheck elements |
| `keyboard` | Type text, press keys, keyboard shortcuts |
| `scroll` | Scroll the page or a specific element |
| `read` | Extract text content from elements |
| `wait` | Wait for elements, navigation, or a timeout |
| `capture` | Take a screenshot of the page or an element |

## Playwright Modes

- **Headless (default):** No visible browser window. Faster, works on servers without a display.
- **Headed:** Visible browser window. Requires a display (or Xvfb). Use when debugging or when headless is detected/blocked.

## CDP Connect

Use CDP when you need persistent browser state that Playwright can't provide.

**When to use:**
- Auth walls that require a real logged-in session
- Bot detection that blocks Playwright's browser fingerprint
- Sites that require specific extensions
- Reusing an existing session (e.g., already logged into a service)

**Setup — headed (for initial login):**

Launch Chrome with remote debugging enabled. The binary name varies by platform (`google-chrome`, `chromium`, `chrome`, `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, etc.).

```bash
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-cdp-profile
```

Use a dedicated profile directory (`--user-data-dir`) to avoid clobbering your daily browser profile.

**Setup — headless (for automation after login):**

```bash
google-chrome --headless --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-cdp-profile
```

**Workflow:**
1. Launch Chrome headed with `--remote-debugging-port=9222`
2. Log in manually or let the agent navigate the login flow
3. Verify the connection: `agent-browser` connects to `http://localhost:9222`
4. For ongoing automation, relaunch headless with the same `--user-data-dir`
5. Shut down Chrome when done — don't leave debug ports open

## Security Guardrails

- **CDP is ask-first.** Never connect to a real browser session without explicit user consent. CDP exposes the user's live cookies, passwords, and session tokens.
- **No browsing internal networks.** Don't navigate to `localhost`, `127.0.0.1`, `::1`, or RFC 1918 addresses (`10.*`, `172.16-31.*`, `192.168.*`) — except the CDP connect port itself (`localhost:9222`).
- **No saving auth state to tracked locations.** Cookies, tokens, screenshots with sensitive data, and browser profiles must not be saved anywhere that gets committed or pushed. Use `/tmp/` or the workspace's gitignored directories.
