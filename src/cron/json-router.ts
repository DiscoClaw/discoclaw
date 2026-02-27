// ---------------------------------------------------------------------------
// JSON routing response parser and multi-channel sender
// ---------------------------------------------------------------------------
// When a cron job uses routingMode: 'json', the AI returns a JSON array of
// { channel, content } objects. This module parses that output, resolves the
// target channels, and sends messages — falling back to the default channel
// if parsing fails or all entries fail to send.
// ---------------------------------------------------------------------------

import { sendChunks } from '../discord/output-common.js';
import type { LoggerLike } from '../logging/logger-like.js';

export type JsonRouteEntry = {
  channel: string;
  content: string;
};

export type JsonRouteResult = {
  /** Number of entries successfully sent. */
  routedCount: number;
  /** Whether the fallback path (raw output to default channel) was used. */
  usedFallback: boolean;
};

type SendableChannel = {
  send: (opts: { content: string; allowedMentions: unknown }) => Promise<unknown>;
};

/**
 * Parse a JSON route payload from AI output.
 * Handles optional code-fence wrapping (```json ... ``` or ``` ... ```).
 *
 * Returns null if:
 *   - The stripped text is empty
 *   - JSON parsing fails
 *   - The parsed value is not an array
 *
 * Returns an array (possibly empty) on success. Entries missing a string
 * `channel` or string `content` field are skipped silently.
 */
export function parseJsonRouteEntries(output: string): JsonRouteEntry[] | null {
  let text = output.trim();

  // Strip optional code fences (```json ... ``` or ``` ... ```)
  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/);
  if (fenceMatch) {
    text = (fenceMatch[1] ?? '').trim();
  }

  if (!text) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) return null;

  const entries: JsonRouteEntry[] = [];
  for (const item of parsed) {
    if (
      item !== null &&
      typeof item === 'object' &&
      typeof (item as Record<string, unknown>).channel === 'string' &&
      typeof (item as Record<string, unknown>).content === 'string'
    ) {
      const entry = item as Record<string, unknown>;
      entries.push({
        channel: entry.channel as string,
        content: entry.content as string,
      });
    }
  }

  return entries;
}

/**
 * Full pipeline: parse AI output → resolve channels → send messages.
 *
 * Falls back to posting the raw output on the default channel when:
 *   - JSON parsing fails (invalid JSON, not an array)
 *   - All route entries fail to send (channel not found or send error)
 *
 * An empty array (`[]`) is treated as a successful no-op — no fallback.
 */
export async function handleJsonRouteOutput(
  output: string,
  resolveChannel: (ref: string) => SendableChannel | undefined,
  defaultChannel: SendableChannel,
  options?: { log?: LoggerLike; jobId?: string },
): Promise<JsonRouteResult> {
  const { log, jobId } = options ?? {};

  const entries = parseJsonRouteEntries(output);

  if (entries === null) {
    log?.warn({ jobId }, 'cron:json-router parse failed — falling back to default channel');
    await sendChunks(defaultChannel, output);
    return { routedCount: 0, usedFallback: true };
  }

  if (entries.length === 0) {
    log?.info({ jobId }, 'cron:json-router empty route array — no messages sent');
    return { routedCount: 0, usedFallback: false };
  }

  let routedCount = 0;
  let failedCount = 0;

  for (const entry of entries) {
    const channel = resolveChannel(entry.channel);
    if (!channel) {
      log?.warn({ jobId, channelRef: entry.channel }, 'cron:json-router channel not found — skipping entry');
      failedCount++;
      continue;
    }
    try {
      await sendChunks(channel, entry.content);
      routedCount++;
    } catch (err) {
      log?.warn({ jobId, channelRef: entry.channel, err }, 'cron:json-router send failed — skipping entry');
      failedCount++;
    }
  }

  // If all entries failed, fall back to posting raw output to the default channel.
  if (routedCount === 0 && failedCount > 0) {
    log?.warn({ jobId, failedCount }, 'cron:json-router all entries failed — falling back to default channel');
    await sendChunks(defaultChannel, output);
    return { routedCount: 0, usedFallback: true };
  }

  return { routedCount, usedFallback: false };
}
