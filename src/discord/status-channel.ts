import { EmbedBuilder } from 'discord.js';
import type { LoggerLike } from './action-types.js';
import type { BeadSyncResult } from '../beads/types.js';

type Sendable = { send(opts: { embeds: EmbedBuilder[] }): Promise<unknown> };

/**
 * Strip CLI args and prompt content from error messages so internals
 * (SOUL.md, IDENTITY.md, full prompts) don't leak into status channel embeds.
 */
export function sanitizeErrorMessage(raw: string): string {
  if (!raw) return '(no message)';

  // execa kill messages look like:
  //   "Command was killed with SIGKILL (Forced termination): claude -p \"You are...\""
  //   "Command was killed with SIGKILL (Forced termination): /usr/local/bin/claude ... -- \"You are...\""
  // Match ": " followed by a path or bare name containing "claude" (the binary invocation).
  const cliBinMatch = raw.match(/:\s+(?:\/\S*\/)?claude\s/);
  if (cliBinMatch) {
    return raw.slice(0, cliBinMatch.index!).slice(0, 500);
  }

  // Positional prompt separator: " -- " followed by a quoted string (prompt content).
  // execa formats args with single quotes in shortMessage, so check both quote styles.
  const positionalMatch = raw.match(/ -- ["']/);
  if (positionalMatch) {
    return raw.slice(0, positionalMatch.index!).slice(0, 500);
  }

  // Generic: if the message contains "claude -p" anywhere, truncate before it
  const dashPIdx = raw.indexOf('claude -p');
  if (dashPIdx !== -1) {
    const prefix = raw.slice(0, dashPIdx).trimEnd();
    return (prefix || 'Command failed').slice(0, 500);
  }

  // Safety-net truncation for any other long message
  return raw.slice(0, 500);
}

/**
 * Format a phase failure error for human-readable Discord display.
 * Detects timeout patterns and emits "Phase X timed out after Y minutes".
 * Non-timeout errors are delegated to sanitizeErrorMessage.
 * Output is always truncated to 500 chars.
 */
export function sanitizePhaseError(phaseId: string, raw: string, timeoutMs?: number): string {
  // Detect execa/AbortSignal timeout patterns: "timed out after Nms"
  const timeoutMatch = raw.match(/timed out after (\d+)ms/i);
  if (timeoutMatch) {
    const ms = timeoutMs ?? parseInt(timeoutMatch[1], 10);
    const minutes = Math.round(ms / 60000);
    const humanTime = ms >= 60000 ? `${minutes} minute${minutes !== 1 ? 's' : ''}` : `${Math.round(ms / 1000)}s`;
    return `Phase ${phaseId} timed out after ${humanTime}`.slice(0, 500);
  }

  return sanitizeErrorMessage(raw).slice(0, 500);
}

export type StatusPoster = {
  online(): Promise<void>;
  offline(): Promise<void>;
  runtimeError(context: { sessionKey: string; channelName?: string }, message: string): Promise<void>;
  handlerError(context: { sessionKey: string }, err: unknown): Promise<void>;
  actionFailed(actionType: string, error: string): Promise<void>;
  beadSyncComplete(result: BeadSyncResult): Promise<void>;
};

const Colors = {
  green: 0x57f287,
  gray: 0x95a5a6,
  red: 0xed4245,
  orange: 0xfee75c,
} as const;

export type StatusPosterOpts = {
  botDisplayName?: string;
  log?: LoggerLike;
};

export function createStatusPoster(channel: Sendable, opts?: StatusPosterOpts): StatusPoster {
  const name = opts?.botDisplayName ?? 'Discoclaw';
  const log = opts?.log;
  const send = async (embed: EmbedBuilder) => {
    try {
      await channel.send({ embeds: [embed] });
    } catch (err) {
      log?.warn({ err }, 'status-channel: failed to post status embed');
    }
  };

  return {
    async online() {
      await send(
        new EmbedBuilder()
          .setColor(Colors.green)
          .setTitle('Bot Online')
          .setDescription(`${name} is connected and ready.`)
          .setTimestamp(),
      );
    },

    async offline() {
      await send(
        new EmbedBuilder()
          .setColor(Colors.gray)
          .setTitle('Bot Offline')
          .setDescription(`${name} is shutting down.`)
          .setTimestamp(),
      );
    },

    async runtimeError(context, message) {
      const embed = new EmbedBuilder()
        .setColor(Colors.red)
        .setTitle('Runtime Error')
        .setDescription(sanitizeErrorMessage(message).slice(0, 4096))
        .setTimestamp();
      if (context.sessionKey) embed.addFields({ name: 'Session', value: context.sessionKey, inline: true });
      if (context.channelName) embed.addFields({ name: 'Channel', value: context.channelName, inline: true });
      await send(embed);
    },

    async handlerError(context, err) {
      const embed = new EmbedBuilder()
        .setColor(Colors.red)
        .setTitle('Handler Failure')
        .setDescription(sanitizeErrorMessage(String(err) || '(unknown error)').slice(0, 4096))
        .setTimestamp();
      if (context.sessionKey) embed.addFields({ name: 'Session', value: context.sessionKey, inline: true });
      await send(embed);
    },

    async actionFailed(actionType, error) {
      await send(
        new EmbedBuilder()
          .setColor(Colors.orange)
          .setTitle('Action Failed')
          .addFields(
            { name: 'Action', value: actionType || '(unknown)', inline: true },
            { name: 'Error', value: (error || '(unknown)').slice(0, 1024) },
          )
          .setTimestamp(),
      );
    },

    async beadSyncComplete(result) {
      const { threadsCreated, emojisUpdated, starterMessagesUpdated, threadsArchived, statusesUpdated, tagsUpdated, threadsReconciled, orphanThreadsFound, warnings } = result;
      const allZero = threadsCreated === 0 && emojisUpdated === 0 && starterMessagesUpdated === 0 && threadsArchived === 0 && statusesUpdated === 0 && tagsUpdated === 0 && (threadsReconciled ?? 0) === 0 && (orphanThreadsFound ?? 0) === 0;
      if (allZero && warnings === 0) return;

      const color = warnings > 0 ? Colors.orange : Colors.green;
      const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle('Bead Sync Complete')
        .setTimestamp();

      if (threadsCreated > 0) embed.addFields({ name: 'Created', value: String(threadsCreated), inline: true });
      if (emojisUpdated > 0) embed.addFields({ name: 'Names Updated', value: String(emojisUpdated), inline: true });
      if (starterMessagesUpdated > 0) embed.addFields({ name: 'Starters Updated', value: String(starterMessagesUpdated), inline: true });
      if (threadsArchived > 0) embed.addFields({ name: 'Archived', value: String(threadsArchived), inline: true });
      if (statusesUpdated > 0) embed.addFields({ name: 'Statuses Fixed', value: String(statusesUpdated), inline: true });
      if (tagsUpdated > 0) embed.addFields({ name: 'Tags Updated', value: String(tagsUpdated), inline: true });
      if (threadsReconciled && threadsReconciled > 0) embed.addFields({ name: 'Reconciled', value: String(threadsReconciled), inline: true });
      if (orphanThreadsFound && orphanThreadsFound > 0) embed.addFields({ name: 'Orphans Found', value: String(orphanThreadsFound), inline: true });
      if (warnings > 0) embed.addFields({ name: 'Warnings', value: String(warnings), inline: true });

      await send(embed);
    },
  };
}
