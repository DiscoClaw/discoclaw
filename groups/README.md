# Groups

This directory is reserved for per-channel/per-thread state and optional per-group instructions.

If `USE_GROUP_DIR_CWD=1`, the bot can set the Claude runtime working directory to a group directory (so runtime-specific instruction loading can be scoped per Discord channel/thread).

Typical layout (example):

- `groups/discord-channel-<id>/CLAUDE.md`
- `groups/discord-thread-<id>/CLAUDE.md`
