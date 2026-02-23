# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in DiscoClaw, please report it through
[GitHub's private vulnerability reporting](https://github.com/DiscoClaw/discoclaw/security/advisories/new).

Do **not** open a public issue for security vulnerabilities.

## Scope

**In scope:**
- The DiscoClaw orchestration layer (context assembly, runtime routing, Discord event handling, task scheduling)
- Configuration parsing and validation
- Task/cron subsystem logic

**Out of scope:**
- Claude Code itself (report to [Anthropic](https://www.anthropic.com/responsible-disclosure))
- Discord API or discord.js (report to [Discord](https://discord.com/security) or [discord.js](https://github.com/discordjs/discord.js/security))
- Anthropic services and APIs

## Response

We aim to acknowledge reports within 48 hours and provide a fix or mitigation plan
within 7 days for confirmed vulnerabilities.
