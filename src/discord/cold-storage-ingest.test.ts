import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ingestMessage, deleteMessageChunks, type IngestableMessage } from './cold-storage-ingest.js';
import { createColdStorage, type ColdStorageSubsystem } from '../cold-storage/index.js';
import type { LoggerLike } from '../logging/logger-like.js';

// ── Test helpers ────────────────────────────────────────────────────────

function createLogger(): LoggerLike {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeMessage(overrides: Partial<IngestableMessage> = {}): IngestableMessage {
  return {
    id: '400000000000000001',
    content: 'Hello, this is a test message for cold storage.',
    authorId: '100000000000000001',
    channelId: '200000000000000001',
    guildId: '300000000000000001',
    ...overrides,
  };
}

/** Deterministic fake embedding provider. */
function makeFakeEmbeddings(dimensions: number) {
  return {
    dimensions,
    embed: vi.fn(async (texts: string[]) =>
      texts.map((_, i) => {
        const arr = new Float32Array(dimensions);
        arr[i % dimensions] = 1;
        return arr;
      }),
    ),
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('ingestMessage', () => {
  const DIMS = 4;
  let subsystem: ColdStorageSubsystem;
  let log: LoggerLike;

  beforeEach(() => {
    log = createLogger();
    subsystem = createColdStorage({
      dbPath: ':memory:',
      provider: 'openai',
      apiKey: 'test-key',
      dimensions: DIMS,
      log: createLogger(),
    })!;
    // Replace embedding provider with a deterministic fake
    (subsystem as { embeddings: unknown }).embeddings = makeFakeEmbeddings(DIMS);
  });

  afterEach(() => {
    subsystem.close();
  });

  // ── Happy path ──────────────────────────────────────────────────────

  it('ingests a simple message and returns inserted chunks', async () => {
    const msg = makeMessage();
    const result = await ingestMessage(subsystem, msg, log);

    expect(result.chunksInserted).toBe(1);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].content).toBe(msg.content);
    expect(result.chunks[0].guild_id).toBe(msg.guildId);
    expect(result.chunks[0].channel_id).toBe(msg.channelId);
    expect(result.chunks[0].message_id).toBe(msg.id);
    expect(result.chunks[0].user_id).toBe(msg.authorId);
    expect(result.chunks[0].chunk_type).toBe('message');
    expect(log.info).toHaveBeenCalled();
  });

  it('stores thread_id when provided', async () => {
    const msg = makeMessage({ threadId: '500000000000000001' });
    const result = await ingestMessage(subsystem, msg, log);

    expect(result.chunks[0].thread_id).toBe('500000000000000001');
  });

  it('stores parent_message_id from options', async () => {
    const msg = makeMessage();
    const result = await ingestMessage(subsystem, msg, log, {
      parentMessageId: '600000000000000001',
    });

    expect(result.chunks[0].parent_message_id).toBe('600000000000000001');
  });

  it('uses custom chunkType from options', async () => {
    const msg = makeMessage();
    const result = await ingestMessage(subsystem, msg, log, { chunkType: 'note' });

    expect(result.chunks[0].chunk_type).toBe('note');
  });

  // ── Chunking ────────────────────────────────────────────────────────

  it('chunks long messages into multiple records', async () => {
    const longContent = 'word '.repeat(500).trim(); // ~2500 chars
    const msg = makeMessage({ content: longContent });
    const result = await ingestMessage(subsystem, msg, log, { maxChunkSize: 200 });

    expect(result.chunksInserted).toBeGreaterThan(1);
    expect(result.chunks.length).toBe(result.chunksInserted);
    // All chunks should share the same message_id
    for (const chunk of result.chunks) {
      expect(chunk.message_id).toBe(msg.id);
    }
  });

  // ── Skip conditions ─────────────────────────────────────────────────

  it('skips empty content', async () => {
    const msg = makeMessage({ content: '' });
    const result = await ingestMessage(subsystem, msg, log);

    expect(result.chunksInserted).toBe(0);
    expect(result.chunks).toHaveLength(0);
  });

  it('skips whitespace-only content', async () => {
    const msg = makeMessage({ content: '   \n\t  ' });
    const result = await ingestMessage(subsystem, msg, log);

    expect(result.chunksInserted).toBe(0);
    expect(result.chunks).toHaveLength(0);
  });

  it('skips messages without guildId (DMs)', async () => {
    const msg = makeMessage({ guildId: undefined });
    const result = await ingestMessage(subsystem, msg, log);

    expect(result.chunksInserted).toBe(0);
    expect(result.chunks).toHaveLength(0);
  });

  it('skips messages when channelFilter is set and channel is not in the list', async () => {
    const msg = makeMessage({ channelId: '200000000000000001' });
    const result = await ingestMessage(subsystem, msg, log, {
      channelFilter: ['999999999999999999'],
    });

    expect(result.chunksInserted).toBe(0);
    expect(result.chunks).toHaveLength(0);
  });

  it('ingests messages when channelFilter includes the channel', async () => {
    const msg = makeMessage({ channelId: '200000000000000001' });
    const result = await ingestMessage(subsystem, msg, log, {
      channelFilter: ['200000000000000001'],
    });

    expect(result.chunksInserted).toBe(1);
  });

  it('ingests messages when channelFilter is empty (no filtering)', async () => {
    const msg = makeMessage();
    const result = await ingestMessage(subsystem, msg, log, {
      channelFilter: [],
    });

    expect(result.chunksInserted).toBe(1);
  });

  // ── Embedding failure ───────────────────────────────────────────────

  it('returns empty when embedding provider returns no results', async () => {
    (subsystem as { embeddings: unknown }).embeddings = {
      dimensions: DIMS,
      embed: vi.fn(async () => []),
    };

    const msg = makeMessage();
    const result = await ingestMessage(subsystem, msg, log);

    expect(result.chunksInserted).toBe(0);
    expect(log.warn).toHaveBeenCalled();
  });

  it('catches embedding errors and returns empty', async () => {
    (subsystem as { embeddings: unknown }).embeddings = {
      dimensions: DIMS,
      embed: vi.fn(async () => { throw new Error('API down'); }),
    };

    const msg = makeMessage();
    const result = await ingestMessage(subsystem, msg, log);

    expect(result.chunksInserted).toBe(0);
    expect(log.warn).toHaveBeenCalled();
  });

  // ── Token count ─────────────────────────────────────────────────────

  it('estimates token count for each chunk', async () => {
    const msg = makeMessage({ content: 'twelve chars' }); // 12 chars → ceil(12/4) = 3
    const result = await ingestMessage(subsystem, msg, log);

    expect(result.chunks[0].token_count).toBe(Math.ceil('twelve chars'.length / 4));
  });
});

describe('deleteMessageChunks', () => {
  const DIMS = 4;
  let subsystem: ColdStorageSubsystem;
  let log: LoggerLike;

  beforeEach(() => {
    log = createLogger();
    subsystem = createColdStorage({
      dbPath: ':memory:',
      provider: 'openai',
      apiKey: 'test-key',
      dimensions: DIMS,
      log: createLogger(),
    })!;
    (subsystem as { embeddings: unknown }).embeddings = makeFakeEmbeddings(DIMS);
  });

  afterEach(() => {
    subsystem.close();
  });

  it('deletes ingested chunks by message ID', async () => {
    const msg = makeMessage();
    await ingestMessage(subsystem, msg, log);

    const result = deleteMessageChunks(subsystem, msg.id, log);

    expect(result.chunksDeleted).toBe(1);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: msg.id, chunksDeleted: 1 }),
      expect.any(String),
    );
  });

  it('returns 0 when no chunks match', () => {
    const result = deleteMessageChunks(subsystem, 'nonexistent', log);
    expect(result.chunksDeleted).toBe(0);
  });

  it('deletes multiple chunks for same message ID', async () => {
    const longContent = 'word '.repeat(500).trim();
    const msg = makeMessage({ content: longContent });
    const ingested = await ingestMessage(subsystem, msg, log, { maxChunkSize: 200 });

    expect(ingested.chunksInserted).toBeGreaterThan(1);

    const result = deleteMessageChunks(subsystem, msg.id, log);
    expect(result.chunksDeleted).toBe(ingested.chunksInserted);
  });

  it('does not delete chunks from other messages', async () => {
    const msg1 = makeMessage({ id: '111111111111111111', content: 'first message' });
    const msg2 = makeMessage({ id: '222222222222222222', content: 'second message' });
    await ingestMessage(subsystem, msg1, log);
    await ingestMessage(subsystem, msg2, log);

    deleteMessageChunks(subsystem, msg1.id, log);

    // msg2 chunks should still be searchable
    const results = subsystem.store.search({ query: 'second' });
    expect(results.length).toBe(1);
    expect(results[0].chunk.message_id).toBe(msg2.id);
  });

  it('catches store errors and returns 0', () => {
    // Close the store to force an error
    subsystem.close();

    const result = deleteMessageChunks(
      subsystem,
      '400000000000000001',
      log,
    );

    expect(result.chunksDeleted).toBe(0);
    expect(log.warn).toHaveBeenCalled();
  });
});
