import { NO_MENTIONS } from './allowed-mentions.js';
import { appendOutsideFence } from './output-utils.js';
import { sanitizeErrorMessage } from './status-channel.js';

type WatchdogNoticeMessage = {
  author?: { id?: string | null } | null;
  content?: string | null;
  editable?: boolean;
  edit?: (opts: { content: string; allowedMentions?: unknown }) => Promise<unknown>;
  reply?: (opts: { content: string; allowedMentions?: unknown }) => Promise<unknown>;
};

type WatchdogNoticeChannel = {
  send: (opts: { content: string; allowedMentions?: unknown }) => Promise<unknown>;
  messages?: {
    fetch?: (id: string) => Promise<unknown>;
  };
};

type WatchdogNoticeDelivery = 'edited' | 'replied' | 'sent';

const TRANSIENT_CHAT_COMPLETION_PLACEHOLDERS = new Set<string>([
  '*(Interrupted — bot is restarting.)*',
  '*(Interrupted — bot was restarted.)*',
  '*(Response aborted.)*',
]);

function asWatchdogNoticeMessage(value: unknown): WatchdogNoticeMessage | null {
  return typeof value === 'object' && value !== null
    ? value as WatchdogNoticeMessage
    : null;
}

function canEditSourceMessage(message: WatchdogNoticeMessage | null, botUserId?: string): boolean {
  if (!message || typeof message.edit !== 'function') return false;
  if (typeof message.editable === 'boolean') return message.editable;
  const authorId = message.author?.id;
  return typeof authorId === 'string' && authorId.length > 0 && authorId === botUserId;
}

function isTransientChatCompletionPlaceholder(content: string | null | undefined): boolean {
  const normalized = normalizeWatchdogNoticeText(content);
  return normalized != null && TRANSIENT_CHAT_COMPLETION_PLACEHOLDERS.has(normalized);
}

function canReplaceTransientChatCompletionPlaceholder(
  message: WatchdogNoticeMessage | null,
  botUserId?: string,
): boolean {
  if (!message || !canEditSourceMessage(message, botUserId)) return false;
  if (!isTransientChatCompletionPlaceholder(message.content)) return false;
  if (typeof botUserId !== 'string' || botUserId.length === 0) return true;
  return message.author?.id === botUserId;
}

async function fetchWatchdogNoticeSource(
  channel: WatchdogNoticeChannel,
  messageId: string,
): Promise<WatchdogNoticeMessage | null> {
  const fetchMessage = channel.messages?.fetch;
  if (typeof fetchMessage !== 'function') return null;
  return asWatchdogNoticeMessage(
    await fetchMessage.call(channel.messages, messageId).catch(() => null),
  );
}

export function buildLongRunFinalNotice(args: {
  completion: 'succeeded' | 'failed' | 'interrupted' | null;
  completionDetail?: string | null;
  recoveryText?: string | null;
  source: 'complete' | 'startup-sweep';
}): string {
  const recoveryText = normalizeWatchdogNoticeText(args.recoveryText);
  if (recoveryText) {
    return buildRecoveredWatchdogNotice(recoveryText, args.source);
  }

  const base = args.completion === 'succeeded'
    ? 'Run complete.'
    : args.completion === 'failed'
      ? 'Run ended with errors.'
      : 'Run interrupted by restart/shutdown.';
  const recoveredSuffix = args.source === 'startup-sweep' ? ' (Recovered after restart.)' : '';
  const rawDetail = typeof args.completionDetail === 'string' ? args.completionDetail.trim() : '';
  if (!rawDetail || args.completion !== 'failed') return `${base}${recoveredSuffix}`;
  const detail = sanitizeErrorMessage(rawDetail);
  return `${base}${recoveredSuffix}\nReason: ${detail}`;
}

export function buildLongRunStagingFailureNotice(prefix?: string | null): string {
  const base = 'Final delivery safeguard failed before I could post the terminal reply. Leaving this message visible instead of deleting it.';
  const normalizedPrefix = normalizeWatchdogNoticeText(prefix);
  if (!normalizedPrefix) return base;
  return appendOutsideFence(normalizedPrefix, base);
}

function normalizeWatchdogNoticeText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  return normalized || null;
}

function buildRecoveredWatchdogNotice(
  recoveryText: string,
  source: 'complete' | 'startup-sweep',
): string {
  if (source !== 'startup-sweep') return recoveryText;
  return appendOutsideFence(recoveryText, 'Recovered after restart.');
}

export async function postLongRunWatchdogNoticeToChannel(
  channel: WatchdogNoticeChannel,
  args: {
    messageId: string;
    content: string;
    botUserId?: string;
  },
): Promise<WatchdogNoticeDelivery> {
  const source = await fetchWatchdogNoticeSource(channel, args.messageId);
  if (canEditSourceMessage(source, args.botUserId)) {
    await source!.edit!({ content: args.content, allowedMentions: NO_MENTIONS });
    return 'edited';
  }
  if (source && typeof source.reply === 'function') {
    await source.reply({ content: args.content, allowedMentions: NO_MENTIONS });
    return 'replied';
  }

  await channel.send({ content: args.content, allowedMentions: NO_MENTIONS });
  return 'sent';
}

export async function postLongRunChatCompletionToChannel(
  channel: WatchdogNoticeChannel,
  args: {
    messageId: string;
    content: string;
    botUserId?: string;
  },
): Promise<WatchdogNoticeDelivery> {
  const source = await fetchWatchdogNoticeSource(channel, args.messageId);
  if (canReplaceTransientChatCompletionPlaceholder(source, args.botUserId)) {
    await source!.edit!({ content: args.content, allowedMentions: NO_MENTIONS });
    return 'edited';
  }
  if (source && typeof source.reply === 'function') {
    await source.reply({ content: args.content, allowedMentions: NO_MENTIONS });
    return 'replied';
  }

  await channel.send({ content: args.content, allowedMentions: NO_MENTIONS });
  return 'sent';
}
