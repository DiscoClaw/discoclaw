# Managed Browser Data

This directory is Discoclaw's repo-local storage for the managed Chrome/Chromium profile.

- `profile/` is the dedicated browser `--user-data-dir` used for headed login and later headed or headless reuse.
- `state.json` is written locally when Discoclaw verifies a CDP handoff for a launched browser.
- Browser data here may contain cookies, tokens, and extension state. Keep it local and uncommitted.

Use the CLI to manage this profile:

- `discoclaw browser setup`
- `discoclaw browser launch`
- `discoclaw browser launch --headless`
