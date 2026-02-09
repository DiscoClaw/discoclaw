export function discordSessionKey(msg: {
  channelId: string;
  authorId: string;
  isDm: boolean;
  threadId?: string | null;
}): string {
  if (msg.isDm) return `discord:dm:${msg.authorId}`;
  if (msg.threadId) return `discord:thread:${msg.threadId}`;
  return `discord:channel:${msg.channelId}`;
}

