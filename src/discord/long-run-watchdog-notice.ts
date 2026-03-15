import { NO_MENTIONS } from './allowed-mentions.js';
import { sanitizeErrorMessage } from './status-channel.js';

type WatchdogNoticeMessage = {
  author?: { id?: string | null } | null;
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

export function buildLongRunFinalNotice(args: {
  completion: 'succeeded' | 'failed' | 'interrupted' | null;
  completionDetail?: string | null;
  source: 'complete' | 'startup-sweep';
}): string {
  const base = args.completion === 'succeeded'
    ? 'Run complete.'
    : args.completion === 'failed'
      ? 'Run ended with errors.'
      : 'Run interrupted by restart/shutdown.';
  const recoveredSuffix = args.source === 'startup-sweep' ? ' (Recovered after restart.)' : '';
  const rawDetail = typeof args.completionDetail === 'string' ? args.completionDetail.trim() : '';
  if (!rawDetail || args.completion !== 'failed') return `${base}${recoveredSuffix}`;
  const detail = sanitizeErrorMessage(rawDetail);
  return `${base}${recoveredSuffix}\nReason: ${detail}`.slice(0, 2000);
}

export async function postLongRunWatchdogNoticeToChannel(
  channel: WatchdogNoticeChannel,
  args: {
    messageId: string;
    content: string;
    botUserId?: string;
  },
): Promise<'edited' | 'replied' | 'sent'> {
  const fetchMessage = channel.messages?.fetch;
  if (typeof fetchMessage === 'function') {
    const source = asWatchdogNoticeMessage(
      await fetchMessage.call(channel.messages, args.messageId).catch(() => null),
    );
    if (canEditSourceMessage(source, args.botUserId)) {
      await source!.edit!({ content: args.content, allowedMentions: NO_MENTIONS });
      return 'edited';
    }
    if (source && typeof source.reply === 'function') {
      await source.reply({ content: args.content, allowedMentions: NO_MENTIONS });
      return 'replied';
    }
  }

  await channel.send({ content: args.content, allowedMentions: NO_MENTIONS });
  return 'sent';
}
