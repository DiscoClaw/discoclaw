import 'dotenv/config';
import pino from 'pino';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createClaudeCliRuntime } from './runtime/claude-code-cli.js';
import { SessionManager } from './sessions.js';
import { parseAllowChannelIds, parseAllowUserIds } from './discord/allowlist.js';
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

const allowChannelIdsRaw = process.env.DISCORD_CHANNEL_IDS;
const restrictChannelIds = (allowChannelIdsRaw ?? '').trim().length > 0;
const allowChannelIds = parseAllowChannelIds(allowChannelIdsRaw);
if (restrictChannelIds && allowChannelIds.size === 0) {
  log.warn('DISCORD_CHANNEL_IDS was set but no valid IDs were parsed: bot will respond to no guild channels (fail closed)');
}

const runtimeModel = (process.env.RUNTIME_MODEL ?? 'opus').trim() || 'opus';
const runtimeTools = String(process.env.RUNTIME_TOOLS ?? 'Bash,Read,Edit,WebSearch,WebFetch')
  .split(/[,\s]+/g)
  .map((t) => t.trim())
  .filter(Boolean);
const runtimeTimeoutMsRaw = (process.env.RUNTIME_TIMEOUT_MS ?? '').trim();
const runtimeTimeoutMs = runtimeTimeoutMsRaw ? Math.max(1, Number(runtimeTimeoutMsRaw)) : 10 * 60_000;

const dataDir = process.env.DISCOCLAW_DATA_DIR;
const defaultWorkspaceCwd = dataDir
  ? path.join(dataDir, 'workspace')
  : path.join(__dirname, '..', 'workspace');
const workspaceCwd = process.env.WORKSPACE_CWD ?? defaultWorkspaceCwd;
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
  allowChannelIds: restrictChannelIds ? allowChannelIds : undefined,
  log,
  runtime,
  sessionManager,
  workspaceCwd,
  groupsDir,
  useGroupDirCwd,
  runtimeModel,
  runtimeTools,
  runtimeTimeoutMs,
});

log.info('Discord bot started');
