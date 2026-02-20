import type { MessageMentionOptions } from 'discord.js';
import type { LoggerLike } from './action-types.js';
import type { TaskSyncResult } from '../tasks/types.js';
import type { StartupContext } from './shutdown-context.js';
import { NO_MENTIONS } from './allowed-mentions.js';

type Sendable = { send(content: string | { content: string; allowedMentions?: MessageMentionOptions }): Promise<unknown> };

/**
 * Strip CLI args and prompt content from error messages so internals
 * (SOUL.md, IDENTITY.md, full prompts) don't leak into status channel messages.
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
 * Detects timeout patterns and emits "Phase **X** timed out after Y minutes".
 * Non-timeout errors emit "Phase **X** failed: <sanitized error>".
 * Output is always truncated to 500 chars.
 */
export function sanitizePhaseError(phaseId: string, raw: string, timeoutMs?: number): string {
  // Detect execa/AbortSignal timeout patterns: "timed out after Nms"
  const timeoutMatch = raw.match(/timed out after (\d+)ms/i);
  if (timeoutMatch) {
    const ms = timeoutMs ?? parseInt(timeoutMatch[1], 10);
    const minutes = Math.round(ms / 60000);
    const humanTime = ms >= 60000 ? `${minutes} minute${minutes !== 1 ? 's' : ''}` : `${Math.round(ms / 1000)} seconds`;
    return `Phase **${phaseId}** timed out after ${humanTime}`.slice(0, 500);
  }

  return `Phase **${phaseId}** failed: ${sanitizeErrorMessage(raw)}`.slice(0, 500);
}

export type BootReportData = {
  startupType: StartupContext['type'];
  // Shutdown context fields (present on intentional/graceful-unknown)
  shutdownReason?: string;
  shutdownMessage?: string;
  shutdownRequestedBy?: string;
  activeForge?: string;
  // Tasks subsystem
  tasksEnabled: boolean;
  tasksDbVersion?: string;
  forumResolved: boolean;
  // Crons subsystem
  cronsEnabled: boolean;
  cronJobCount?: number;
  // Memory layers
  memoryEpisodicOn: boolean;
  memorySemanticOn: boolean;
  memoryWorkingOn: boolean;
  // Action categories
  actionCategoriesEnabled: string[];
  // Config / permissions
  configWarnings?: number;
  permissionsTier?: string;
  // Runtime
  runtimeModel?: string;
  bootDurationMs?: number;
  buildVersion?: string;
};

export type StatusPoster = {
  online(): Promise<void>;
  offline(): Promise<void>;
  runtimeError(context: { sessionKey: string; channelName?: string }, message: string): Promise<void>;
  handlerError(context: { sessionKey: string }, err: unknown): Promise<void>;
  actionFailed(actionType: string, error: string): Promise<void>;
  taskSyncComplete(result: TaskSyncResult): Promise<void>;
  bootReport?(data: BootReportData): Promise<void>;
};

export type StatusPosterOpts = {
  botDisplayName?: string;
  log?: LoggerLike;
};

export function createStatusPoster(channel: Sendable, opts?: StatusPosterOpts): StatusPoster {
  const name = opts?.botDisplayName ?? 'Discoclaw';
  const log = opts?.log;
  const send = async (content: string) => {
    try {
      await channel.send({ content, allowedMentions: NO_MENTIONS });
    } catch (err) {
      log?.warn({ err }, 'status-channel: failed to post status message');
    }
  };
  const sendTaskSyncComplete = async (result: TaskSyncResult) => {
    const { threadsCreated, emojisUpdated, starterMessagesUpdated, threadsArchived, statusesUpdated, tagsUpdated, threadsReconciled, orphanThreadsFound, warnings } = result;
    const allZero = threadsCreated === 0 && emojisUpdated === 0 && starterMessagesUpdated === 0 && threadsArchived === 0 && statusesUpdated === 0 && tagsUpdated === 0 && (threadsReconciled ?? 0) === 0 && (orphanThreadsFound ?? 0) === 0;
    if (allZero && warnings === 0) return;

    const parts: string[] = ['**Task Sync Complete**'];
    if (threadsCreated > 0) parts.push(`Created: ${threadsCreated}`);
    if (emojisUpdated > 0) parts.push(`Names Updated: ${emojisUpdated}`);
    if (starterMessagesUpdated > 0) parts.push(`Starters Updated: ${starterMessagesUpdated}`);
    if (threadsArchived > 0) parts.push(`Archived: ${threadsArchived}`);
    if (statusesUpdated > 0) parts.push(`Statuses Fixed: ${statusesUpdated}`);
    if (tagsUpdated > 0) parts.push(`Tags Updated: ${tagsUpdated}`);
    if (threadsReconciled && threadsReconciled > 0) parts.push(`Reconciled: ${threadsReconciled}`);
    if (orphanThreadsFound && orphanThreadsFound > 0) parts.push(`Orphans Found: ${orphanThreadsFound}`);
    if (warnings > 0) parts.push(`Warnings: ${warnings}`);

    await send(parts.join(' · '));
  };

  return {
    async online() {
      await send(`**Bot Online** — ${name} is connected and ready.`);
    },

    async offline() {
      await send(`**Bot Offline** — ${name} is shutting down.`);
    },

    async runtimeError(context, message) {
      const ctx = [context.sessionKey, context.channelName].filter(Boolean).join(' · ');
      await send(`**Runtime Error** [${ctx}]\n${sanitizeErrorMessage(message).slice(0, 500)}`);
    },

    async handlerError(context, err) {
      await send(`**Handler Failure** [${context.sessionKey}]\n${sanitizeErrorMessage(String(err) || '(unknown error)').slice(0, 500)}`);
    },

    async actionFailed(actionType, error) {
      await send(`**Action Failed** [${actionType || '(unknown)'}]\n${(error || '(unknown)').slice(0, 500)}`);
    },

    async taskSyncComplete(result) {
      await sendTaskSyncComplete(result);
    },

    async bootReport(data) {
      const typeLabel: Record<StartupContext['type'], string> = {
        crash: 'Crash',
        intentional: 'Intentional',
        'graceful-unknown': 'Graceful (unknown)',
        'first-boot': 'First Boot',
      };

      const lines: string[] = ['**Boot Report**'];
      lines.push(`Startup · ${typeLabel[data.startupType]}`);
      if (data.bootDurationMs !== undefined) lines.push(`Boot Time · ${data.bootDurationMs}ms`);
      lines.push(`Model · ${data.runtimeModel || '(default)'}`);
      lines.push(`Permissions · ${data.permissionsTier || '(unset)'}`);

      if (data.shutdownReason) {
        const reasonParts = [data.shutdownReason];
        if (data.shutdownRequestedBy) reasonParts.push(`by <@${data.shutdownRequestedBy}>`);
        if (data.shutdownMessage) reasonParts.push(`— ${data.shutdownMessage}`);
        lines.push(`Last Shutdown · ${reasonParts.join(' ')}`);
      }

      if (data.activeForge) {
        lines.push(`Forge at Shutdown · ${data.activeForge.slice(0, 200)}`);
      }

      const tasksEnabled = data.tasksEnabled;
      const tasksDbVersion = data.tasksDbVersion;
      const tasksStatus = tasksEnabled
        ? `on${tasksDbVersion ? ` · v${tasksDbVersion}` : ''}${data.forumResolved ? ' · forum ok' : ' · forum unresolved'}`
        : 'off';
      lines.push(`Tasks · ${tasksStatus}`);

      const cronsStatus = data.cronsEnabled
        ? `on${data.cronJobCount !== undefined ? ` · ${data.cronJobCount} job${data.cronJobCount !== 1 ? 's' : ''}` : ''}`
        : 'off';
      lines.push(`Crons · ${cronsStatus}`);

      const memoryParts: string[] = [];
      if (data.memoryEpisodicOn) memoryParts.push('episodic');
      if (data.memorySemanticOn) memoryParts.push('semantic');
      if (data.memoryWorkingOn) memoryParts.push('working');
      lines.push(`Memory · ${memoryParts.length > 0 ? memoryParts.join(', ') : 'off'}`);

      lines.push(`Actions · ${data.actionCategoriesEnabled.length > 0 ? data.actionCategoriesEnabled.join(', ') : '(none)'}`);
      lines.push(`Version · DiscoClaw ${data.buildVersion ?? '(unknown)'}`);

      if (data.configWarnings && data.configWarnings > 0) {
        lines.push(`Config Warnings · ${data.configWarnings}`);
      }

      await send(lines.join('\n'));
    },
  };
}
