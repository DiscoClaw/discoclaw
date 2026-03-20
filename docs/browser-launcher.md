# Browser Launcher

This guide documents the shipped `ws-1274` browser path. It supersedes the cancelled companion-service direction from `plan-600` / `ws-1272`.

The current design is intentionally thin:

- Discoclaw owns one managed Chrome/Chromium profile under its data directory.
- `discoclaw browser launch` starts Chrome/Chromium on demand with remote debugging bound to `127.0.0.1`.
- Discoclaw only records a reusable instance after it verifies the CDP endpoint over both `/json/version` and a WebSocket probe.
- No long-lived helper daemon or localhost control service is part of this path.

## Managed Storage

Managed browser state lives under `DISCOCLAW_DATA_DIR/browser/`:

- Profile directory: `DISCOCLAW_DATA_DIR/browser/profile`
- Launcher state file: `DISCOCLAW_DATA_DIR/browser/state.json`

If `DISCOCLAW_DATA_DIR` is unset in a source checkout, Discoclaw uses `./data/browser/`.

Source-install restriction:

- Repo-local source installs may only use the default `./data/browser/` location.
- If `DISCOCLAW_DATA_DIR` points to another path inside the repo, browser setup, doctor, and launch reject it.
- If you want custom browser storage from a source checkout, move `DISCOCLAW_DATA_DIR` outside the repo.

## Executable Discovery

Set `AGENT_BROWSER_EXECUTABLE_PATH` when Chrome/Chromium is not discoverable on `PATH` or in a common install location.

If it is unset, Discoclaw falls back to:

- common `PATH` names such as `google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser`, and `chrome`
- common absolute install paths on macOS and Windows

## Supported Commands

Local CLI:

- `discoclaw browser setup`
- `discoclaw browser doctor`
- `discoclaw browser launch`
- `discoclaw browser launch --headless`

Discord surfaces:

- `!browser setup`
- `!browser doctor`
- `!browser launch`
- `!browser launch --headless`
- `!browser help`

The Discord command only reports guidance and current state. It does not launch the browser for you. Run the CLI command locally on the Discoclaw machine.

## Setup Flow

1. Run `discoclaw browser setup`.
2. Discoclaw validates the storage rule, checks browser executable discovery, and creates the managed profile directory.
3. Run `discoclaw browser launch` locally to open the managed profile in headed Chrome/Chromium.
4. Discoclaw verifies the new browser instance over CDP.
5. Complete the one-time site login in that headed browser window, then close it when finished.

`setup` prepares the profile directory. It does not spawn a browser.

## Headed Login Flow

Use the headed launch first:

```bash
discoclaw browser launch
```

Launch behavior:

- Discoclaw starts Chrome/Chromium with the managed profile and a loopback-only remote debugging endpoint.
- A fresh free CDP port is selected for the new spawn instead of assuming a fixed port.
- The launch is only considered successful after Discoclaw can fetch `/json/version` and complete a WebSocket CDP probe.
- On success, `state.json` is updated with the verified PID, port, executable path, launch mode, and CDP WebSocket URL.

After that verification succeeds, use the browser normally for the manual login flow. Close it when finished so later launches can reuse the same profile cleanly.

## Later Headless Reuse

Once the headed login has populated the managed profile, you can reuse that same profile later:

```bash
discoclaw browser launch --headless
```

That headless path reuses the same `profile/` directory. It does not create a separate login profile.

You can also launch headed again later with:

```bash
discoclaw browser launch
```

## Verified-Instance Reuse Policy

Discoclaw only reuses an already-running managed browser when the stored launcher state still verifies against the live CDP endpoint.

Reuse requires all of the following to match:

- the stored PID is still alive
- `http://127.0.0.1:<port>/json/version` is reachable
- the reported `webSocketDebuggerUrl` matches the stored verified CDP URL when one exists
- a WebSocket probe to that CDP URL succeeds

If that verification passes, `discoclaw browser launch` returns the verified instance details instead of spawning a second browser.

If stored state exists but does not verify, Discoclaw treats it as stale, clears it, and continues with fresh-launch logic.

## Lock Conflicts

Discoclaw checks for Chrome profile lock files in the managed profile directory.

If the profile is locked and no verified managed instance can be reused:

- launch fails immediately
- Discoclaw does not attach to an arbitrary browser process
- the operator is told to close the other browser and rerun `discoclaw browser launch`

This is deliberate. A locked profile without verified state is treated as ambiguous, not reusable.

## Failed Verification Cleanup

Discoclaw writes tentative launcher state as soon as it has a spawned browser PID, then waits for CDP verification.

If post-spawn verification fails:

- Discoclaw terminates the newly launched browser process
- Discoclaw removes the tentative `state.json`
- the command returns a failure instead of leaving behind unverified launcher state

If browser termination succeeds but state-file cleanup fails, the command still reports that cleanup failure explicitly so the stale state can be removed manually.

## Service-Managed Environment Limits

This path is designed around local launches from the Discoclaw machine, not around GUI spawning from a long-lived service process.

Operationally, that means:

- `!browser launch` in Discord only prints the local command to run
- the headed login launch should be run from an interactive desktop session on the Discoclaw machine
- service-managed environments such as `systemd` user services may not have the display or session access needed to open a visible browser window

Headless launch can still be useful later, but the initial one-time login remains a local operator step.
