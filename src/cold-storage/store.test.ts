import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ColdStorageStore, type InsertChunkInput, type ChunkMetadata, type SearchOptions } from './store.js';
import type { LoggerLike } from '../logging/logger-like.js';

const DIMS = 4; // small dimension count for tests

function createLogger(): LoggerLike {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeEmbedding(...values: number[]): Float32Array {
  if (values.length !== DIMS) throw new Error(`expected ${DIMS} values`);
  return new Float32Array(values);
}

function defaultMetadata(overrides: Partial<ChunkMetadata> = {}): ChunkMetadata {
  return {
    guild_id: '100000000000000001',
    channel_id: '200000000000000001',
    chunk_type: 'message',
    ...overrides,
  };
}

function makeInput(overrides: Partial<Omit<InsertChunkInput, 'metadata'>> & { metadata?: Partial<ChunkMetadata> } = {}): InsertChunkInput {
  const { metadata: metaOverrides, ...rest } = overrides;
  return {
    content: 'hello world',
    embedding: makeEmbedding(1, 0, 0, 0),
    token_count: 2,
    metadata: defaultMetadata(metaOverrides),
    ...rest,
  };
}

describe('ColdStorageStore', () => {
  let store: ColdStorageStore;
  let log: LoggerLike;

  beforeEach(() => {
    log = createLogger();
    store = new ColdStorageStore(':memory:', DIMS, log);
  });

  afterEach(() => {
    store.close();
  });

  // ── Schema ───────────────────────────────────────────────────────

  describe('schema creation', () => {
    it('creates chunks, chunks_fts, and chunks_vec tables', () => {
      const tables = store.db
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual table') ORDER BY name")
        .pluck()
        .all() as string[];

      expect(tables).toContain('chunks');
      expect(tables).toContain('chunks_fts');
      expect(tables).toContain('chunks_vec');
    });
  });

  // ── Insert / Retrieve ────────────────────────────────────────────

  describe('insertChunk + getById', () => {
    it('round-trips a chunk', () => {
      const input = makeInput({
        content: 'round trip test',
        token_count: 3,
        metadata: {
          guild_id: '111111111111111111',
          channel_id: '222222222222222222',
          thread_id: '333333333333333333',
          message_id: '444444444444444444',
          user_id: '555555555555555555',
          parent_message_id: '666666666666666666',
          chunk_type: 'note',
        },
      });

      const inserted = store.insertChunk(input);

      expect(inserted.id).toBeGreaterThan(0);
      expect(inserted.content).toBe('round trip test');
      expect(inserted.guild_id).toBe('111111111111111111');
      expect(inserted.channel_id).toBe('222222222222222222');
      expect(inserted.thread_id).toBe('333333333333333333');
      expect(inserted.message_id).toBe('444444444444444444');
      expect(inserted.user_id).toBe('555555555555555555');
      expect(inserted.parent_message_id).toBe('666666666666666666');
      expect(inserted.chunk_type).toBe('note');
      expect(inserted.token_count).toBe(3);
      expect(inserted.created_at).toBeTruthy();

      const fetched = store.getById(inserted.id);
      expect(fetched).toEqual(inserted);
    });

    it('returns null for non-existent id', () => {
      expect(store.getById(999)).toBeNull();
    });

    it('stores nullable fields as null when omitted', () => {
      const input = makeInput({
        metadata: { thread_id: null, message_id: null, user_id: null, parent_message_id: null },
      });
      const inserted = store.insertChunk(input);
      expect(inserted.thread_id).toBeNull();
      expect(inserted.message_id).toBeNull();
      expect(inserted.user_id).toBeNull();
      expect(inserted.parent_message_id).toBeNull();
    });
  });

  // ── Vector Search ────────────────────────────────────────────────

  describe('vector search', () => {
    it('returns nearest neighbors by embedding similarity', () => {
      // Insert three chunks with known embeddings
      store.insertChunk(makeInput({ content: 'north', embedding: makeEmbedding(1, 0, 0, 0) }));
      store.insertChunk(makeInput({ content: 'east', embedding: makeEmbedding(0, 1, 0, 0) }));
      store.insertChunk(makeInput({ content: 'northeast', embedding: makeEmbedding(0.7, 0.7, 0, 0) }));

      // Search near "north" — should rank north first, northeast second
      const results = store.search({ embedding: makeEmbedding(1, 0, 0, 0), limit: 3 });

      expect(results.length).toBe(3);
      expect(results[0].chunk.content).toBe('north');
      expect(results[1].chunk.content).toBe('northeast');
      expect(results[2].chunk.content).toBe('east');
    });

    it('respects limit', () => {
      store.insertChunk(makeInput({ content: 'a', embedding: makeEmbedding(1, 0, 0, 0) }));
      store.insertChunk(makeInput({ content: 'b', embedding: makeEmbedding(0, 1, 0, 0) }));
      store.insertChunk(makeInput({ content: 'c', embedding: makeEmbedding(0, 0, 1, 0) }));

      const results = store.search({ embedding: makeEmbedding(1, 0, 0, 0), limit: 2 });
      expect(results.length).toBe(2);
    });
  });

  // ── FTS5 Search ──────────────────────────────────────────────────

  describe('FTS5 keyword search', () => {
    it('finds chunks by keyword', () => {
      store.insertChunk(makeInput({ content: 'the quick brown fox jumps' }));
      store.insertChunk(makeInput({ content: 'lazy dog sleeps' }));

      const results = store.search({ query: 'fox' });
      expect(results.length).toBe(1);
      expect(results[0].chunk.content).toContain('fox');
    });

    it('returns empty for no match', () => {
      store.insertChunk(makeInput({ content: 'apples and oranges' }));
      const results = store.search({ query: 'bananas' });
      expect(results.length).toBe(0);
    });

    it('handles special characters in query', () => {
      store.insertChunk(makeInput({ content: 'hello world test' }));
      // FTS5 special chars should be sanitized, not cause errors
      const results = store.search({ query: 'hello "world' });
      expect(results.length).toBe(1);
    });
  });

  // ── RRF Merge ────────────────────────────────────────────────────

  describe('RRF merge ranking', () => {
    it('ranks chunks appearing in both vector and FTS results higher', () => {
      // "alpha bravo" is close in embedding space AND matches keyword "alpha"
      store.insertChunk(makeInput({
        content: 'alpha bravo content here',
        embedding: makeEmbedding(1, 0, 0, 0),
      }));
      // Close in embedding space but no keyword match
      store.insertChunk(makeInput({
        content: 'charlie delta content here',
        embedding: makeEmbedding(0.9, 0.1, 0, 0),
      }));
      // Keyword match but far in embedding space
      store.insertChunk(makeInput({
        content: 'alpha echo content here',
        embedding: makeEmbedding(0, 0, 0, 1),
      }));

      const results = store.search({
        embedding: makeEmbedding(1, 0, 0, 0),
        query: 'alpha',
        limit: 3,
      });

      // "alpha bravo" should rank highest — it appears in both result sets
      expect(results[0].chunk.content).toContain('alpha bravo');
    });
  });

  // ── Metadata Filtering ──────────────────────────────────────────

  describe('metadata filtering', () => {
    beforeEach(() => {
      store.insertChunk(makeInput({
        content: 'guild-a channel-a',
        embedding: makeEmbedding(1, 0, 0, 0),
        metadata: {
          guild_id: 'G1',
          channel_id: 'C1',
          user_id: 'U1',
          chunk_type: 'message',
        },
      }));
      store.insertChunk(makeInput({
        content: 'guild-b channel-b',
        embedding: makeEmbedding(0.9, 0.1, 0, 0),
        metadata: {
          guild_id: 'G2',
          channel_id: 'C2',
          user_id: 'U2',
          chunk_type: 'note',
        },
      }));
    });

    it('filters by guild_id', () => {
      const results = store.search({
        embedding: makeEmbedding(1, 0, 0, 0),
        filters: { guild_id: 'G1' },
      });
      expect(results.length).toBe(1);
      expect(results[0].chunk.guild_id).toBe('G1');
    });

    it('filters by channel_id', () => {
      const results = store.search({
        embedding: makeEmbedding(1, 0, 0, 0),
        filters: { channel_id: 'C2' },
      });
      expect(results.length).toBe(1);
      expect(results[0].chunk.channel_id).toBe('C2');
    });

    it('filters by user_id', () => {
      const results = store.search({
        embedding: makeEmbedding(1, 0, 0, 0),
        filters: { user_id: 'U1' },
      });
      expect(results.length).toBe(1);
      expect(results[0].chunk.user_id).toBe('U1');
    });

    it('filters by chunk_type', () => {
      const results = store.search({
        embedding: makeEmbedding(1, 0, 0, 0),
        filters: { chunk_type: 'note' },
      });
      expect(results.length).toBe(1);
      expect(results[0].chunk.chunk_type).toBe('note');
    });

    it('filters by time range', () => {
      // All chunks created "now" — filtering with future after should exclude all
      const results = store.search({
        embedding: makeEmbedding(1, 0, 0, 0),
        filters: { after: '2099-01-01T00:00:00.000Z' },
      });
      expect(results.length).toBe(0);
    });

    it('filters by before date', () => {
      // All chunks created "now" — before far future should include all
      const results = store.search({
        embedding: makeEmbedding(1, 0, 0, 0),
        filters: { before: '2099-01-01T00:00:00.000Z' },
      });
      expect(results.length).toBe(2);
    });

    it('filters by thread_id', () => {
      store.insertChunk(makeInput({
        content: 'in thread',
        embedding: makeEmbedding(0, 0, 1, 0),
        metadata: {
          guild_id: 'G1',
          channel_id: 'C1',
          thread_id: 'T1',
          chunk_type: 'message',
        },
      }));

      const results = store.search({
        embedding: makeEmbedding(1, 0, 0, 0),
        filters: { thread_id: 'T1' },
      });
      expect(results.length).toBe(1);
      expect(results[0].chunk.thread_id).toBe('T1');
    });
  });

  // ── Deletion ─────────────────────────────────────────────────────

  describe('deleteByMessageId', () => {
    it('deletes chunks and their FTS/vec entries', () => {
      const msgId = '777777777777777777';
      store.insertChunk(makeInput({
        content: 'to be deleted',
        metadata: { message_id: msgId },
      }));
      store.insertChunk(makeInput({
        content: 'to remain',
        embedding: makeEmbedding(0, 1, 0, 0),
        metadata: { message_id: '888888888888888888' },
      }));

      const deleted = store.deleteByMessageId(msgId);
      expect(deleted).toBe(1);

      // Verify chunk is gone
      const searchResults = store.search({ query: 'deleted' });
      expect(searchResults.length).toBe(0);

      // Verify other chunk remains
      const remaining = store.search({ query: 'remain' });
      expect(remaining.length).toBe(1);
    });

    it('returns 0 when no chunks match', () => {
      expect(store.deleteByMessageId('nonexistent')).toBe(0);
    });

    it('deletes multiple chunks with the same message_id', () => {
      const msgId = '999999999999999999';
      store.insertChunk(makeInput({
        content: 'chunk one',
        embedding: makeEmbedding(1, 0, 0, 0),
        metadata: { message_id: msgId },
      }));
      store.insertChunk(makeInput({
        content: 'chunk two',
        embedding: makeEmbedding(0, 1, 0, 0),
        metadata: { message_id: msgId },
      }));

      const deleted = store.deleteByMessageId(msgId);
      expect(deleted).toBe(2);
    });
  });

  // ── Jump URL in Search Results ───────────────────────────────────

  describe('jump URL in search results', () => {
    it('includes jump_url derived from chunk metadata', () => {
      store.insertChunk(makeInput({
        content: 'jump url test',
        embedding: makeEmbedding(1, 0, 0, 0),
        metadata: {
          guild_id: '100000000000000001',
          channel_id: '200000000000000001',
          message_id: '300000000000000001',
        },
      }));

      const results = store.search({ embedding: makeEmbedding(1, 0, 0, 0), limit: 1 });
      expect(results[0].jump_url).toBe(
        'https://discord.com/channels/100000000000000001/200000000000000001/300000000000000001',
      );
    });

    it('returns null jump_url when message_id is missing', () => {
      store.insertChunk(makeInput({
        content: 'no message id',
        embedding: makeEmbedding(1, 0, 0, 0),
        metadata: {
          guild_id: '100000000000000001',
          channel_id: '200000000000000001',
          message_id: null,
        },
      }));

      const results = store.search({ embedding: makeEmbedding(1, 0, 0, 0), limit: 1 });
      expect(results[0].jump_url).toBeNull();
    });
  });

  // ── Chunk Count ─────────────────────────────────────────────────

  describe('chunkCount', () => {
    it('returns 0 on empty store', () => {
      expect(store.chunkCount()).toBe(0);
    });

    it('returns correct count after inserts', () => {
      store.insertChunk(makeInput({ content: 'one', embedding: makeEmbedding(1, 0, 0, 0) }));
      store.insertChunk(makeInput({ content: 'two', embedding: makeEmbedding(0, 1, 0, 0) }));
      store.insertChunk(makeInput({ content: 'three', embedding: makeEmbedding(0, 0, 1, 0) }));
      expect(store.chunkCount()).toBe(3);
    });

    it('returns correct count after deletes', () => {
      const msgId = '111111111111111111';
      store.insertChunk(makeInput({ content: 'keep', embedding: makeEmbedding(1, 0, 0, 0), metadata: { message_id: '222222222222222222' } }));
      store.insertChunk(makeInput({ content: 'remove', embedding: makeEmbedding(0, 1, 0, 0), metadata: { message_id: msgId } }));
      expect(store.chunkCount()).toBe(2);

      store.deleteByMessageId(msgId);
      expect(store.chunkCount()).toBe(1);
    });
  });

  // ── Fail-open ────────────────────────────────────────────────────

  describe('fail-open behavior', () => {
    it('returns empty results and logs warning when search encounters an error', () => {
      // Corrupt the FTS table to trigger an error during search
      store.db.exec('DROP TABLE chunks_fts');

      const results = store.search({ query: 'anything' });
      expect(results).toEqual([]);
      expect(log.warn).toHaveBeenCalled();
    });

    it('returns empty when both embedding and query are omitted', () => {
      store.insertChunk(makeInput());
      const results = store.search({});
      expect(results).toEqual([]);
    });
  });

  // ── Extension load failure ──────────────────────────────────────────

  describe('extension load failure', () => {
    it('propagates error when database is unusable', () => {
      // Verify the constructor fails gracefully with a bad path that prevents
      // sqlite-vec from loading (e.g., read-only filesystem path)
      expect(() => new ColdStorageStore('/dev/null/impossible.db', DIMS, createLogger()))
        .toThrow();
    });
  });
});
