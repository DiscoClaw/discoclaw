import 'dotenv/config';
import pino from 'pino';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createClaudeCliRuntime } from './runtime/claude-code-cli.js';
import { SessionManager } from './sessions.js';
import { parseAllowUserIds } from './discord/allowlist.js';
import { startDiscordBot } from './discord.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const token = process.env.DISCORD_TOKEN ?? '';
if (!token) {
  log.error('Missing DISCORD_TOKEN');
  process.exit(1);
}

const allowUserIds = parseAllowUserIds(process.env.DISCORD_ALLOW_USER_IDS);
if (allowUserIds.size === 0) {
  log.warn('DISCORD_ALLOW_USER_IDS is empty: bot will respond to nobody (fail closed)');
}

const workspaceCwd = process.env.WORKSPACE_CWD ?? '/home/davidmarsh/weston';
const groupsDir = process.env.GROUPS_DIR ?? path.join(__dirname, '..', 'groups');
const useGroupDirCwd = (process.env.USE_GROUP_DIR_CWD ?? '0') === '1';

const claudeBin = process.env.CLAUDE_BIN ?? 'claude';
const dangerouslySkipPermissions = (process.env.CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS ?? '0') === '1';
const outputFormat = (process.env.CLAUDE_OUTPUT_FORMAT ?? 'text') === 'stream-json'
  ? 'stream-json'
  : 'text';

const runtime = createClaudeCliRuntime({
  claudeBin,
  dangerouslySkipPermissions,
  outputFormat,
});

const sessionManager = new SessionManager(path.join(__dirname, '..', 'data', 'sessions.json'));

await startDiscordBot({
  token,
  allowUserIds,
  runtime,
  sessionManager,
  workspaceCwd,
  groupsDir,
  useGroupDirCwd,
});

log.info('Discord bot started');
