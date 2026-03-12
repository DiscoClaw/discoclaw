import { NO_MENTIONS } from './allowed-mentions.js';

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
