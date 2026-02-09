import 'dotenv/config';
import pino from 'pino';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';

import { createClaudeCliRuntime } from './runtime/claude-code-cli.js';
import { SessionManager } from './sessions.js';
import { parseAllowChannelIds, parseAllowUserIds } from './discord/allowlist.js';
import { loadDiscordChannelContext } from './discord/channel-context.js';
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
const contentDir = (process.env.DISCOCLAW_CONTENT_DIR ?? '').trim() || (dataDir
  ? path.join(dataDir, 'content')
  : path.join(__dirname, '..', 'content'));

// Best-effort: load only the channel index (small) and ensure placeholder channel files exist.
let discordChannelContext = undefined as Awaited<ReturnType<typeof loadDiscordChannelContext>> | undefined;
try {
  await fs.mkdir(contentDir, { recursive: true });
  discordChannelContext = await loadDiscordChannelContext({ contentDir, log });
} catch (err) {
  log.warn({ err, contentDir }, 'Failed to initialize discord channel context; continuing without it');
  discordChannelContext = undefined;
}

const requireChannelContext = (process.env.DISCORD_REQUIRE_CHANNEL_CONTEXT ?? '1') === '1';
const autoIndexChannelContext = (process.env.DISCORD_AUTO_INDEX_CHANNEL_CONTEXT ?? '1') === '1';
const autoJoinThreads = (process.env.DISCORD_AUTO_JOIN_THREADS ?? '0') === '1';
const useRuntimeSessions = (process.env.DISCOCLAW_RUNTIME_SESSIONS ?? '1') === '1';
if (requireChannelContext && !discordChannelContext) {
  log.error({ contentDir }, 'DISCORD_REQUIRE_CHANNEL_CONTEXT=1 but channel context failed to initialize');
  process.exit(1);
}

const defaultWorkspaceCwd = dataDir
  ? path.join(dataDir, 'workspace')
  : path.join(__dirname, '..', 'workspace');
// Treat empty env vars as "unset" so `.env` placeholders don't override defaults.
const workspaceCwd = (process.env.WORKSPACE_CWD ?? '').trim() || defaultWorkspaceCwd;
const groupsDir = (process.env.GROUPS_DIR ?? '').trim() || path.join(__dirname, '..', 'groups');
const useGroupDirCwd = (process.env.USE_GROUP_DIR_CWD ?? '0') === '1';

const claudeBin = process.env.CLAUDE_BIN ?? 'claude';
const dangerouslySkipPermissions = (process.env.CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS ?? '0') === '1';
const outputFormat = (process.env.CLAUDE_OUTPUT_FORMAT ?? 'text') === 'stream-json'
  ? 'stream-json'
  : 'text';
const echoStdio = (process.env.CLAUDE_ECHO_STDIO ?? '0') === '1';
const claudeDebugFile = (process.env.CLAUDE_DEBUG_FILE ?? '').trim() || null;
const strictMcpConfig = (process.env.CLAUDE_STRICT_MCP_CONFIG ?? '1') === '1';

// Debug: surface common "works in terminal but not in systemd" issues without logging secrets.
if ((process.env.DISCOCLAW_DEBUG_RUNTIME ?? '0') === '1') {
  log.info(
    {
      env: {
        HOME: process.env.HOME,
        USER: process.env.USER,
        PATH: process.env.PATH,
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
        DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ? '(set)' : '(unset)',
        DISPLAY: process.env.DISPLAY ? '(set)' : '(unset)',
        WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY ? '(set)' : '(unset)',
      },
      claude: {
        bin: claudeBin,
        outputFormat,
        echoStdio,
        dangerouslySkipPermissions,
      },
      runtime: {
        model: runtimeModel,
        toolsCount: runtimeTools.length,
        timeoutMs: runtimeTimeoutMs,
        workspaceCwd,
        groupsDir,
        useRuntimeSessions,
      },
    },
    'debug:runtime config',
  );
}

const runtime = createClaudeCliRuntime({
  claudeBin,
  dangerouslySkipPermissions,
  outputFormat,
  echoStdio,
  debugFile: claudeDebugFile,
  strictMcpConfig,
  log,
});

const sessionManager = new SessionManager(path.join(__dirname, '..', 'data', 'sessions.json'));

await startDiscordBot({
  token,
  allowUserIds,
  allowChannelIds: restrictChannelIds ? allowChannelIds : undefined,
  log,
  discordChannelContext,
  requireChannelContext,
  autoIndexChannelContext,
  autoJoinThreads,
  useRuntimeSessions,
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
