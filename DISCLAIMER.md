# Disclaimer

## Important usage terms

> **Warning:** DiscoClaw is **not containerized or sandboxed**. It runs directly on your host machine and has the potential capability to read, modify, or delete critical files. **Do not install this on a production or critical system.** Use a dedicated machine or VM, and understand the risks before running.

DiscoClaw is an **orchestration layer** that coordinates between Discord and AI runtimes (Claude Code by default, with OpenAI and Codex adapters available). It is a coordination layer, not a safety layer. Using DiscoClaw does not add guardrails beyond what the underlying runtimes already provide.

- The AI runtimes have full tool access to your local system — the Discord interface doesn't change that.
- You should take the same precautions you would when running Claude Code directly: use a private server, keep the allowlist tight, and understand what tools are available.
- DiscoClaw is provided **as-is**, without warranty of any kind. See the [LICENSE](LICENSE) for full terms.
- The authors and contributors are not liable for any damages or losses arising from use of this software.

## Terms of Service compliance

By using DiscoClaw, you agree to comply with:

- [Anthropic's Usage Policy](https://www.anthropic.com/policies/aup)
- [Discord's Developer Terms of Service](https://discord.com/developers/docs/policies-and-agreements/developer-terms-of-service)

DiscoClaw does not exempt you from any platform's terms. You are responsible for how you use this software. Abuse may result in Discord banning your bot token or Anthropic restricting your account. The maintainers are not responsible for consequences arising from individual use.

## Attribution

- **Claude Code** is a product of [Anthropic, Inc.](https://www.anthropic.com/) DiscoClaw is not associated with or endorsed by Anthropic.
- **Discord** is a trademark of [Discord Inc.](https://discord.com/) DiscoClaw is not associated with or endorsed by Discord.
- **DiscoClaw** is an independent open-source project licensed under the [MIT License](LICENSE).
