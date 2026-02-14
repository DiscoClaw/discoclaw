# TOOLS.md - Local Notes

## Available Tools

- **Permissions:** Controlled by `PERMISSIONS.json` in this workspace. If someone asks "what can you do?", check that file first — it defines your access tier (`readonly`, `standard`, `full`, or `custom`).
- **Browser automation:** Via `agent-browser` (optional, separate install). Escalation ladder: WebFetch → Playwright headless → Playwright headed → CDP headless → CDP headed. See `.context/tools.md` in the discoclaw repo for the full reference.

## What Goes Here

Things like:

- SSH hosts and aliases
- Preferred voices for TTS
- Device nicknames
- Anything environment-specific

## Why Separate?

Your setup is yours. Keeping environment-specific notes here means you can update other files without losing your local config.

---

Add whatever helps you do your job. This is your cheat sheet.
