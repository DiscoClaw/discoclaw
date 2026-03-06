// ── Cold-storage ingestion & deletion helpers for Discord messages ───────
// Standalone module — no runtime side effects. Wired in by Plan 2b.

import type { LoggerLike } from '../logging/logger-like.js';
import type { ColdStorageSubsystem } from '../cold-storage/index.js';
import type { ChunkMetadata, Chunk } from '../cold-storage/types.js';
import { chunkThread, type ThreadMessage } from '../cold-storage/chunker.js';

// ── Types ──────────────────────────────────────────────────────────────

/** Minimal message shape needed for ingestion (subset of PlatformMessage). */
export interface IngestableMessage {
  id: string;
  content: string;
  authorId: string;
  channelId: string;
  guildId?: string;
  threadId?: string;
}

export interface IngestResult {
  /** Number of chunks inserted. */
  chunksInserted: number;
  /** The stored Chunk records. */
  chunks: Chunk[];
}

export interface DeleteResult {
  /** Number of chunks removed. */
  chunksDeleted: number;
}

export interface IngestOptions {
  /** Parent message ID for reply chains. */
  parentMessageId?: string;
  /** Override chunk type (default: 'message'). */
  chunkType?: ChunkMetadata['chunk_type'];
  /** Max characters per chunk (passed to chunker). */
  maxChunkSize?: number;
}

// ── Ingestion ──────────────────────────────────────────────────────────

/**
 * Ingest a Discord message into cold storage.
 *
 * Chunks the content, generates embeddings, and inserts into the store.
 * Returns the number of chunks inserted and the stored records.
 *
 * Skips silently (returns 0 chunks) when:
 * - content is empty/whitespace
 * - guildId is missing (DMs are not stored)
 *
 * Never throws — errors are caught and logged.
 */
export async function ingestMessage(
  subsystem: ColdStorageSubsystem,
  message: IngestableMessage,
  log: LoggerLike,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const empty: IngestResult = { chunksInserted: 0, chunks: [] };

  const content = message.content.trim();
  if (!content) return empty;
  if (!message.guildId) return empty;

  try {
    // 1. Chunk the message content
    const threadMsg: ThreadMessage = { content, user_id: message.authorId, message_id: message.id };
    const chunkTexts = chunkThread([threadMsg], { maxChunkSize: options.maxChunkSize });

    if (chunkTexts.length === 0) return empty;

    // 2. Generate embeddings for all chunks in a single batch
    const embeddings = await subsystem.embeddings.embed(chunkTexts);

    if (embeddings.length === 0) {
      log.warn({ messageId: message.id }, 'cold-storage-ingest: embedding returned empty, skipping');
      return empty;
    }

    // 3. Build metadata (shared across all chunks of this message)
    const metadata: ChunkMetadata = {
      guild_id: message.guildId,
      channel_id: message.channelId,
      thread_id: message.threadId ?? null,
      message_id: message.id,
      user_id: message.authorId,
      parent_message_id: options.parentMessageId ?? null,
      chunk_type: options.chunkType ?? 'message',
    };

    // 4. Insert each chunk with its embedding
    const inserted: Chunk[] = [];
    for (let i = 0; i < chunkTexts.length; i++) {
      const chunk = subsystem.store.insertChunk({
        content: chunkTexts[i],
        embedding: embeddings[i],
        token_count: estimateTokenCount(chunkTexts[i]),
        metadata,
      });
      inserted.push(chunk);
    }

    log.info(
      { messageId: message.id, chunks: inserted.length },
      'cold-storage-ingest: ingested message',
    );

    return { chunksInserted: inserted.length, chunks: inserted };
  } catch (err) {
    log.warn({ err, messageId: message.id }, 'cold-storage-ingest: failed to ingest message');
    return empty;
  }
}

// ── Deletion ───────────────────────────────────────────────────────────

/**
 * Delete all cold-storage chunks associated with a Discord message ID.
 *
 * Never throws — errors are caught and logged.
 */
export function deleteMessageChunks(
  subsystem: ColdStorageSubsystem,
  messageId: string,
  log: LoggerLike,
): DeleteResult {
  try {
    const deleted = subsystem.store.deleteByMessageId(messageId);

    if (deleted > 0) {
      log.info({ messageId, chunksDeleted: deleted }, 'cold-storage-ingest: deleted message chunks');
    }

    return { chunksDeleted: deleted };
  } catch (err) {
    log.warn({ err, messageId }, 'cold-storage-ingest: failed to delete message chunks');
    return { chunksDeleted: 0 };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Rough token estimate: ~4 chars per token (good enough for budgeting). */
function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}
