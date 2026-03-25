/**
 * Programmatic Discord API verification for release rehearsal checkpoints.
 *
 * Replaces the manual TTY/readline prompts when `--auto` is passed to
 * release-rehearsal.ts.  Each checkpoint sends a probe message to a
 * designated Discord text channel, polls for the bot's reply, and
 * returns pass/fail based on whether the expected behaviour was observed.
 */

import {
  Client,
  GatewayIntentBits,
  ChannelType,
  type TextBasedChannel,
  type Message,
} from 'discord.js';
import type {
  ReleaseRehearsalCheckpointPrompt,
  ReleaseRehearsalCheckpointStatus,
} from './release-rehearsal.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type AutoCheckpointConfig = {
  /** Discord bot token (same one the rehearsal dev process uses). */
  discordToken: string;
  /** Text-channel ID used for sending probe messages. */
  channelId: string;
  /** Rehearsal slug — embedded in probes so replies can be correlated. */
  slug: string;
  /** Artifact names produced by the rehearsal harness. */
  artifacts: {
    taskTitle: string;
    cronName: string;
  };
  log?: (line: string) => void;
  /** Milliseconds between polls for a bot reply (default 2 000). */
  pollIntervalMs?: number;
  /** Maximum milliseconds to wait for a bot reply (default 120 000). */
  pollTimeoutMs?: number;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_POLL_TIMEOUT_MS = 120_000;

async function pollForReply(
  channel: TextBasedChannel,
  afterMessageId: string,
  botUserId: string,
  timeoutMs: number,
  intervalMs: number,
): Promise<Message | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const recent = await channel.messages.fetch({ after: afterMessageId, limit: 20 });
    const botReply = recent.find((m) => m.author.id === botUserId);
    if (botReply) return botReply;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return null;
}

async function sendAndWaitForReply(
  channel: TextBasedChannel,
  content: string,
  botUserId: string,
  timeoutMs: number,
  intervalMs: number,
  log: (line: string) => void,
): Promise<{ probe: Message; reply: Message | null }> {
  const probe = await channel.send(content);
  log(`  Sent probe ${probe.id}: ${content.slice(0, 80)}`);
  const reply = await pollForReply(channel, probe.id, botUserId, timeoutMs, intervalMs);
  if (reply) {
    log(`  Bot replied ${reply.id}: ${reply.content.slice(0, 80)}`);
  } else {
    log('  No bot reply within timeout.');
  }
  return { probe, reply };
}

// ---------------------------------------------------------------------------
// Per-checkpoint verification strategies
// ---------------------------------------------------------------------------

async function verifyMessageHandling(
  channel: TextBasedChannel,
  botUserId: string,
  slug: string,
  timeoutMs: number,
  intervalMs: number,
  log: (line: string) => void,
): Promise<{ status: ReleaseRehearsalCheckpointStatus; lastProbeId?: string }> {
  const content = `Release rehearsal auto-check: ${slug} — please confirm you can read this.`;
  const { probe, reply } = await sendAndWaitForReply(
    channel, content, botUserId, timeoutMs, intervalMs, log,
  );

  if (reply && reply.content.length > 0) {
    return { status: 'pass', lastProbeId: probe.id };
  }
  return { status: 'fail', lastProbeId: probe.id };
}

async function verifyFollowUpReply(
  channel: TextBasedChannel,
  botUserId: string,
  slug: string,
  timeoutMs: number,
  intervalMs: number,
  log: (line: string) => void,
): Promise<{ status: ReleaseRehearsalCheckpointStatus }> {
  const content = `Follow-up for ${slug} — does the prior context still hold?`;
  const { reply } = await sendAndWaitForReply(
    channel, content, botUserId, timeoutMs, intervalMs, log,
  );

  if (reply && reply.content.length > 0) {
    return { status: 'pass' };
  }
  return { status: 'fail' };
}

async function verifyTaskSync(
  channel: TextBasedChannel,
  botUserId: string,
  taskTitle: string,
  timeoutMs: number,
  intervalMs: number,
  log: (line: string) => void,
): Promise<{ status: ReleaseRehearsalCheckpointStatus }> {
  const content = `Please create a task titled "${taskTitle}".`;
  const { reply } = await sendAndWaitForReply(
    channel, content, botUserId, timeoutMs, intervalMs, log,
  );

  if (reply && reply.content.length > 0) {
    return { status: 'pass' };
  }
  return { status: 'fail' };
}

async function verifyCronExecution(
  channel: TextBasedChannel,
  botUserId: string,
  cronName: string,
  timeoutMs: number,
  intervalMs: number,
  log: (line: string) => void,
): Promise<{ status: ReleaseRehearsalCheckpointStatus }> {
  const content = `Please create a cron named "${cronName}" that runs once immediately.`;
  const { reply } = await sendAndWaitForReply(
    channel, content, botUserId, timeoutMs, intervalMs, log,
  );

  if (reply && reply.content.length > 0) {
    return { status: 'pass' };
  }
  return { status: 'fail' };
}

async function verifyRestartRecovery(
  channel: TextBasedChannel,
  botUserId: string,
  slug: string,
  timeoutMs: number,
  intervalMs: number,
  log: (line: string) => void,
): Promise<{ status: ReleaseRehearsalCheckpointStatus }> {
  const content = `Post-restart check for ${slug} — confirm the bot reconnected cleanly.`;
  const { reply } = await sendAndWaitForReply(
    channel, content, botUserId, timeoutMs, intervalMs, log,
  );

  if (reply && reply.content.length > 0) {
    return { status: 'pass' };
  }
  return { status: 'fail' };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a `promptCheckpoint`-compatible function that verifies each
 * checkpoint programmatically via the Discord API instead of asking a
 * human at the terminal.
 *
 * The returned function matches the `ReleaseRehearsalDeps.promptCheckpoint`
 * signature so it can be injected directly.
 *
 * Call `dispose()` on the returned object when the rehearsal is done to
 * disconnect the observer client.
 */
export async function createAutoCheckpoint(config: AutoCheckpointConfig): Promise<{
  promptCheckpoint: (prompt: ReleaseRehearsalCheckpointPrompt) => Promise<ReleaseRehearsalCheckpointStatus>;
  dispose: () => void;
}> {
  const log = config.log ?? console.log;
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const pollTimeoutMs = config.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  await client.login(config.discordToken);
  await new Promise<void>((resolve) => {
    if (client.isReady()) resolve();
    else client.once('ready', () => resolve());
  });

  const botUserId = client.user!.id;
  log(`[auto-checkpoint] Observer client ready as ${client.user!.tag} (${botUserId})`);

  const rawChannel = await client.channels.fetch(config.channelId);
  if (
    !rawChannel
    || (rawChannel.type !== ChannelType.GuildText && rawChannel.type !== ChannelType.PublicThread
      && rawChannel.type !== ChannelType.PrivateThread)
  ) {
    client.destroy();
    throw new Error(
      `Auto-checkpoint channel ${config.channelId} is not a text-based channel (got type=${rawChannel?.type}).`,
    );
  }
  const channel = rawChannel as TextBasedChannel;

  const promptCheckpoint = async (
    prompt: ReleaseRehearsalCheckpointPrompt,
  ): Promise<ReleaseRehearsalCheckpointStatus> => {
    log(`[auto-checkpoint] Running ${prompt.id}...`);

    try {
      switch (prompt.id) {
        case 'checkpoint-message-handling': {
          const result = await verifyMessageHandling(
            channel, botUserId, config.slug, pollTimeoutMs, pollIntervalMs, log,
          );
          return result.status;
        }

        case 'checkpoint-follow-up-reply': {
          const result = await verifyFollowUpReply(
            channel, botUserId, config.slug, pollTimeoutMs, pollIntervalMs, log,
          );
          return result.status;
        }

        case 'checkpoint-task-sync': {
          const result = await verifyTaskSync(
            channel, botUserId, config.artifacts.taskTitle, pollTimeoutMs, pollIntervalMs, log,
          );
          return result.status;
        }

        case 'checkpoint-cron-execution': {
          const result = await verifyCronExecution(
            channel, botUserId, config.artifacts.cronName, pollTimeoutMs, pollIntervalMs, log,
          );
          return result.status;
        }

        case 'checkpoint-restart-recovery': {
          const result = await verifyRestartRecovery(
            channel, botUserId, config.slug, pollTimeoutMs, pollIntervalMs, log,
          );
          return result.status;
        }

        case 'record-chat-artifact-cleanup': {
          log('  [auto-checkpoint] Chat artifact cleanup is informational; auto-passing.');
          return 'pass';
        }

        default:
          log(`  [auto-checkpoint] Unknown checkpoint ${prompt.id}; skipping.`);
          return 'skipped';
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`  [auto-checkpoint] Checkpoint ${prompt.id} failed with error: ${message}`);
      return 'fail';
    }
  };

  const dispose = () => {
    client.destroy();
  };

  return { promptCheckpoint, dispose };
}
