import type {
  TaskDiscordClient,
  TaskDiscordThreadChannel,
} from './discord-types.js';

export async function fetchThreadChannel(
  client: TaskDiscordClient,
  threadId: string,
): Promise<TaskDiscordThreadChannel | null> {
  const cached = client.channels.cache.get(threadId);
  if (cached && cached.isThread()) return cached as TaskDiscordThreadChannel;
  try {
    const fetched = await client.channels.fetch(threadId);
    if (fetched && fetched.isThread()) return fetched as TaskDiscordThreadChannel;
    return null;
  } catch {
    return null;
  }
}

/** Order-insensitive comparison of two tag ID arrays. */
export function tagsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sorted = (arr: string[]) => [...arr].sort();
  return sorted(a).every((v, i) => v === sorted(b)[i]);
}
