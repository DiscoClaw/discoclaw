import fs from 'node:fs/promises';
import type { LoggerLike } from '../logging/logger-like.js';
import { NO_MENTIONS } from './allowed-mentions.js';

type DiscordMessage = {
  edit(opts: { content: string; allowedMentions?: { parse: readonly never[] } }): Promise<unknown>;
};

type InFlightEntry = {
  reply: DiscordMessage;
  channelId: string;
  messageId: string;
  label: string;
};

type OrphanEntry = {
  channelId: string;
  messageId: string;
};

type FetchableMessage = {
  edit(opts: { content: string; allowedMentions?: { parse: readonly never[] } }): Promise<unknown>;
};

type MessageFetchableChannel = {
  messages: {
    fetch(id: string): Promise<FetchableMessage>;
  };
};

type StartupClient = {
  channels: {
    fetch(id: string): Promise<unknown>;
  };
};

function asOrphanEntry(value: unknown): OrphanEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as { channelId?: unknown; messageId?: unknown };
  if (typeof candidate.channelId !== 'string' || typeof candidate.messageId !== 'string') {
    return null;
  }
  return { channelId: candidate.channelId, messageId: candidate.messageId };
}

function hasMessageFetch(channel: unknown): channel is MessageFetchableChannel {
  if (!channel || typeof channel !== 'object' || !('messages' in channel)) return false;
  const messages = (channel as { messages?: unknown }).messages;
  return !!messages && typeof messages === 'object' && 'fetch' in messages &&
    typeof (messages as { fetch?: unknown }).fetch === 'function';
}

const INTERRUPTED_GRACEFUL = '*(Interrupted \u2014 bot is restarting.)*';
const INTERRUPTED_COLD = '*(Interrupted \u2014 bot was restarted.)*';

// --- Module state ---
const registry = new Map<string, InFlightEntry>();
let shuttingDown = false;
let dataFilePath: string | null = null;

// --- Public API ---

/**
 * Configure the path for the persistent inflight.json file.
 * Call once at startup after dataDir is resolved.
 */
export function setDataFilePath(filePath: string): void {
  dataFilePath = filePath;
}

/**
 * Register an in-progress Discord reply. Returns a disposer function
 * that unregisters the entry. Use in try/finally to guarantee cleanup.
 */
export function registerInFlightReply(
  reply: DiscordMessage,
  channelId: string,
  messageId: string,
  label: string,
): () => void {
  if (shuttingDown) {
    // Drain already happened — immediately edit and discard.
    reply.edit({ content: INTERRUPTED_GRACEFUL, allowedMentions: NO_MENTIONS }).catch(() => {});
    return () => {};
  }

  const key = `${channelId}:${messageId}`;
  registry.set(key, { reply, channelId, messageId, label });

  // Best-effort persist for cold-start recovery.
  persistAdd({ channelId, messageId }).catch(() => {});

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    registry.delete(key);
    persistRemove({ channelId, messageId }).catch(() => {});
  };
}

/**
 * Number of currently tracked in-flight replies.
 */
export function inFlightReplyCount(): number {
  return registry.size;
}

/**
 * Returns true if there is at least one in-flight reply for the given channelId.
 */
export function hasInFlightForChannel(channelId: string): boolean {
  for (const entry of registry.values()) {
    if (entry.channelId === channelId) return true;
  }
  return false;
}

/**
 * Returns true once drainInFlightReplies has been called.
 * Streaming loops should check this and no-op if true,
 * preventing the "Interrupted" text from being overwritten.
 */
export function isShuttingDown(): boolean {
  return shuttingDown;
}

/**
 * Atomically snapshot and clear the registry, set the shutdown flag,
 * then edit all tracked replies in parallel with a timeout.
 */
export async function drainInFlightReplies(opts?: {
  timeoutMs?: number;
  log?: LoggerLike;
}): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 3000;
  const log = opts?.log;

  // Atomic snapshot + clear + flag.
  const entries = Array.from(registry.values());
  registry.clear();
  shuttingDown = true;

  if (entries.length === 0) {
    // Clear persistent file even if registry was empty (belt-and-suspenders).
    await persistClear().catch(() => {});
    return;
  }

  log?.info({ count: entries.length }, 'inflight:drain editing in-flight replies');

  const editPromises = entries.map((entry) =>
    entry.reply
      .edit({ content: INTERRUPTED_GRACEFUL, allowedMentions: NO_MENTIONS })
      .then(() => {
        log?.info({ channelId: entry.channelId, messageId: entry.messageId, label: entry.label }, 'inflight:drain edited');
      })
      .catch((err) => {
        log?.warn({ err, channelId: entry.channelId, messageId: entry.messageId }, 'inflight:drain edit failed');
      }),
  );

  await Promise.race([
    Promise.allSettled(editPromises),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);

  await persistClear().catch(() => {});
}

// --- Cold-start recovery ---

/**
 * Load orphaned reply entries from the persistent file (for cold-start recovery).
 */
export function loadOrphanedReplies(filePath: string): Promise<OrphanEntry[]> {
  return fs.readFile(filePath, 'utf-8')
    .then((raw) => {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((entry) => asOrphanEntry(entry))
        .filter((entry): entry is OrphanEntry => entry !== null);
    })
    .catch(() => []);
}

/**
 * On startup, detect and clean up any orphaned messages left by a previous unclean exit.
 */
export async function cleanupOrphanedReplies(opts: {
  client: StartupClient;
  dataFilePath: string;
  log?: LoggerLike;
  timeoutMs?: number;
}): Promise<void> {
  const { client, dataFilePath: filePath, log, timeoutMs = 5000 } = opts;

  const orphans = await loadOrphanedReplies(filePath);
  if (orphans.length === 0) return;

  log?.info({ count: orphans.length }, 'inflight:cold-start cleaning up orphaned replies');

  const editPromises = orphans.map(async (orphan) => {
    try {
      const channel = await client.channels.fetch(orphan.channelId);
      if (!hasMessageFetch(channel)) {
        log?.warn({ channelId: orphan.channelId }, 'inflight:cold-start channel not fetchable');
        return;
      }
      const message = await channel.messages.fetch(orphan.messageId);
      await message.edit({ content: INTERRUPTED_COLD, allowedMentions: NO_MENTIONS });
      log?.info({ channelId: orphan.channelId, messageId: orphan.messageId }, 'inflight:cold-start edited orphan');
    } catch (err) {
      log?.warn({ err, channelId: orphan.channelId, messageId: orphan.messageId }, 'inflight:cold-start orphan cleanup failed');
    }
  });

  await Promise.race([
    Promise.allSettled(editPromises),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);

  // Clear the file after processing.
  try {
    await fs.unlink(filePath);
  } catch {
    // Already gone or inaccessible.
  }
}

// --- Persistence helpers (serial queue + atomic write-tmp-rename) ---

// Serial promise queue prevents read-modify-write races when multiple
// handlers register/dispose concurrently (maxConcurrentInvocations > 1).
let persistQueue: Promise<void> = Promise.resolve();

function enqueuePersist(fn: () => Promise<void>): Promise<void> {
  const next = persistQueue.then(fn, fn);
  persistQueue = next.then(() => {}, () => {});
  return next;
}

async function readPersistedEntries(): Promise<OrphanEntry[]> {
  if (!dataFilePath) return [];
  try {
    const raw = await fs.readFile(dataFilePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

async function writePersistedEntries(entries: OrphanEntry[]): Promise<void> {
  if (!dataFilePath) return;
  const tmpPath = `${dataFilePath}.tmp.${process.pid}`;
  await fs.writeFile(tmpPath, JSON.stringify(entries) + '\n', 'utf-8');
  await fs.rename(tmpPath, dataFilePath);
}

function persistAdd(entry: OrphanEntry): Promise<void> {
  return enqueuePersist(async () => {
    if (!dataFilePath) return;
    const entries = await readPersistedEntries();
    const key = `${entry.channelId}:${entry.messageId}`;
    // Avoid duplicates.
    if (!entries.some((e) => `${e.channelId}:${e.messageId}` === key)) {
      entries.push(entry);
    }
    await writePersistedEntries(entries);
  });
}

function persistRemove(entry: OrphanEntry): Promise<void> {
  return enqueuePersist(async () => {
    if (!dataFilePath) return;
    const entries = await readPersistedEntries();
    const key = `${entry.channelId}:${entry.messageId}`;
    const filtered = entries.filter((e) => `${e.channelId}:${e.messageId}` !== key);
    await writePersistedEntries(filtered);
  });
}

function persistClear(): Promise<void> {
  return enqueuePersist(async () => {
    if (!dataFilePath) return;
    try {
      await fs.unlink(dataFilePath);
    } catch {
      // File doesn't exist or inaccessible — fine.
    }
  });
}

// --- Test helpers ---

/**
 * Wait for all queued persistence operations to complete.
 * Only for use in tests — avoids flaky setTimeout-based waits.
 */
export function _waitForPendingPersists(): Promise<void> {
  return persistQueue;
}

/**
 * Reset module state. Only for use in tests.
 */
export function _resetForTest(): void {
  registry.clear();
  shuttingDown = false;
  dataFilePath = null;
  persistQueue = Promise.resolve();
}
