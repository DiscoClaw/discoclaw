/**
 * One-off script: manually trigger a cron job by cronId.
 * Uses the same executor path as the scheduler — real runtime, real Discord output.
 *
 * Usage: node scripts/trigger-cron.mjs <cronId>
 *   e.g. node scripts/trigger-cron.mjs cron-9e4a642d
 */
import { Client, GatewayIntentBits } from 'discord.js';
import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

const cronId = process.argv[2];
if (!cronId) {
  console.error('Usage: node scripts/trigger-cron.mjs <cronId>');
  process.exit(1);
}

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error('DISCORD_TOKEN not set');

const guildId = process.env.DISCORD_GUILD_ID;
if (!guildId) throw new Error('DISCORD_GUILD_ID not set');

const dataDir = process.env.DISCOCLAW_DATA_DIR;
if (!dataDir) throw new Error('DISCOCLAW_DATA_DIR not set');

const claudeBin = process.env.CLAUDE_BIN ?? 'claude';
const runtimeTools = (process.env.RUNTIME_TOOLS ?? '').split(',').filter(Boolean);
const workspaceCwd = process.env.DISCOCLAW_WORKSPACE_CWD ?? process.env.HOME ?? '/home/davidmarsh';

const resolvedStatsFile = path.join(dataDir.replace(/^~/, process.env.HOME ?? ''), 'cron', 'cron-run-stats.json');

const { loadRunStats } = await import(path.join(rootDir, 'dist/cron/run-stats.js'));
const { executeCronJob } = await import(path.join(rootDir, 'dist/cron/executor.js'));
const { createClaudeCliRuntime } = await import(path.join(rootDir, 'dist/runtime/claude-code-cli.js'));

const statsStore = await loadRunStats(resolvedStatsFile);
const record = statsStore.getRecord(cronId);

if (!record) {
  console.error(`Cron "${cronId}" not found in stats file: ${resolvedStatsFile}`);
  process.exit(1);
}

console.log(`Found cron: ${cronId} (threadId=${record.threadId}, channel=${record.channel}, cadence=${record.cadence})`);

const runtime = createClaudeCliRuntime({
  claudeBin,
  dangerouslySkipPermissions: true,
  outputFormat: 'stream-json',
  echoStdio: false,
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('ready', async () => {
  console.log(`Discord client ready. Triggering ${cronId}...`);

  // Ensure guild is in cache
  let guild = client.guilds.cache.get(guildId);
  if (!guild) {
    guild = await client.guilds.fetch(guildId);
  }

  /** @type {import('../dist/cron/types.js').CronJob} */
  const job = {
    id: `manual-trigger-${cronId}`,
    cronId,
    threadId: record.threadId,
    guildId,
    name: record.channel ?? cronId,
    def: {
      triggerType: 'manual',
      timezone: record.timezone ?? 'America/Los_Angeles',
      channel: record.channel ?? 'general',
      prompt: record.prompt ?? '',
      schedule: record.schedule,
      silent: record.silent,
      routingMode: record.routingMode,
    },
    cron: null,
    running: false,
  };

  /** @type {import('../dist/cron/executor.js').CronExecutorContext} */
  const execCtx = {
    client,
    runtime,
    model: record.model ?? 'capable',
    cwd: workspaceCwd,
    tools: runtimeTools,
    timeoutMs: 600_000,
    status: null,
    log: console,
    discordActionsEnabled: false,
    actionFlags: {
      channels: false,
      messaging: false,
      guild: false,
      moderation: false,
      polls: false,
      tasks: false,
      crons: false,
      botProfile: false,
      forge: false,
      plan: false,
      memory: false,
      config: false,
      defer: false,
    },
    statsStore,
  };

  try {
    await executeCronJob(job, execCtx);
    console.log(`✓ Cron ${cronId} execution complete.`);
  } catch (err) {
    console.error(`✗ Cron ${cronId} execution failed:`, err);
  } finally {
    client.destroy();
    process.exit(0);
  }
});

client.login(token);
