import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import type { LoggerLike } from '../logging/logger-like.js';

// ── Types ──────────────────────────────────────────────────────────────

export type ChunkType = 'message' | 'file' | 'summary' | 'note';

export interface ChunkMetadata {
  guild_id: string;
  channel_id: string;
  thread_id?: string | null;
  message_id?: string | null;
  user_id?: string | null;
  parent_message_id?: string | null;
  chunk_type: ChunkType;
}

export interface InsertChunkInput {
  content: string;
  embedding: Float32Array;
  token_count: number;
  metadata: ChunkMetadata;
}

export interface StoredChunk {
  id: number;
  content: string;
  guild_id: string;
  channel_id: string;
  thread_id: string | null;
  message_id: string | null;
  user_id: string | null;
  parent_message_id: string | null;
  created_at: string;
  chunk_type: ChunkType;
  token_count: number;
}

export interface SearchResult {
  chunk: StoredChunk;
  score: number;
}

export interface SearchFilters {
  guild_id?: string;
  channel_id?: string;
  user_id?: string;
  chunk_type?: ChunkType;
  after?: string;   // ISO 8601
  before?: string;  // ISO 8601
}

export interface SearchOptions {
  embedding?: Float32Array;
  query?: string;
  filters?: SearchFilters;
  limit?: number;
}

// ── Constants ──────────────────────────────────────────────────────────

const DEFAULT_SEARCH_LIMIT = 20;
const RRF_K = 60; // Reciprocal Rank Fusion constant

// ── Schema DDL ─────────────────────────────────────────────────────────

const CREATE_CHUNKS_TABLE = `
  CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    thread_id TEXT,
    message_id TEXT,
    user_id TEXT,
    parent_message_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    chunk_type TEXT NOT NULL,
    token_count INTEGER NOT NULL
  )
`;

const CREATE_FTS_TABLE = `
  CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    content,
    content_rowid='id'
  )
`;

// ── Store ──────────────────────────────────────────────────────────────

export class ColdStorageStore {
  readonly db: Database.Database;
  private readonly log: LoggerLike;
  private readonly dimensions: number;

  constructor(dbPath: string, dimensions: number, log: LoggerLike) {
    this.log = log;
    this.dimensions = dimensions;

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');

    // Load sqlite-vec — throws on failure (caller decides fallback)
    sqliteVec.load(this.db);

    this.initSchema();
  }

  // ── Public API ─────────────────────────────────────────────────────

  insertChunk(input: InsertChunkInput): StoredChunk {
    const { content, embedding, token_count, metadata } = input;

    const insertChunkStmt = this.db.prepare(`
      INSERT INTO chunks (content, guild_id, channel_id, thread_id, message_id, user_id, parent_message_id, chunk_type, token_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertFtsStmt = this.db.prepare(`
      INSERT INTO chunks_fts (rowid, content) VALUES (?, ?)
    `);

    const insertVecStmt = this.db.prepare(`
      INSERT INTO chunks_vec (rowid, embedding) VALUES (?, ?)
    `);

    const txn = this.db.transaction(() => {
      const result = insertChunkStmt.run(
        content,
        metadata.guild_id,
        metadata.channel_id,
        metadata.thread_id ?? null,
        metadata.message_id ?? null,
        metadata.user_id ?? null,
        metadata.parent_message_id ?? null,
        metadata.chunk_type,
        token_count,
      );
      const rowid = result.lastInsertRowid;

      insertFtsStmt.run(rowid, content);
      // sqlite-vec requires BigInt for rowid bindings
      insertVecStmt.run(BigInt(rowid), embeddingToBuffer(embedding));

      return rowid;
    });

    const rowid = txn();
    return this.getById(Number(rowid))!;
  }

  search(options: SearchOptions): SearchResult[] {
    const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;

    try {
      const vectorResults = options.embedding
        ? this.vectorSearch(options.embedding, options.filters, limit)
        : [];

      const ftsResults = options.query
        ? this.ftsSearch(options.query, options.filters, limit)
        : [];

      if (vectorResults.length === 0 && ftsResults.length === 0) {
        return [];
      }

      // If only one source, return directly
      if (vectorResults.length === 0) return ftsResults.slice(0, limit);
      if (ftsResults.length === 0) return vectorResults.slice(0, limit);

      // Merge via Reciprocal Rank Fusion
      return this.rrfMerge(vectorResults, ftsResults, limit);
    } catch (err) {
      this.log.warn({ err }, 'cold-storage search failed, returning empty results');
      return [];
    }
  }

  getById(id: number): StoredChunk | null {
    const row = this.db.prepare('SELECT * FROM chunks WHERE id = ?').get(id) as StoredChunkRow | undefined;
    return row ? rowToChunk(row) : null;
  }

  deleteByMessageId(messageId: string): number {
    const rows = this.db.prepare('SELECT id FROM chunks WHERE message_id = ?').all(messageId) as { id: number }[];
    if (rows.length === 0) return 0;

    const txn = this.db.transaction(() => {
      for (const row of rows) {
        this.db.prepare('DELETE FROM chunks_fts WHERE rowid = ?').run(row.id);
        this.db.prepare('DELETE FROM chunks_vec WHERE rowid = ?').run(row.id);
      }
      const result = this.db.prepare('DELETE FROM chunks WHERE message_id = ?').run(messageId);
      return result.changes;
    });

    return txn();
  }

  close(): void {
    this.db.close();
  }

  // ── Private ────────────────────────────────────────────────────────

  private initSchema(): void {
    this.db.exec(CREATE_CHUNKS_TABLE);
    this.db.exec(CREATE_FTS_TABLE);

    // sqlite-vec virtual table
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
        rowid INTEGER PRIMARY KEY,
        embedding float[${this.dimensions}]
      )
    `);
  }

  private vectorSearch(embedding: Float32Array, filters: SearchFilters | undefined, limit: number): SearchResult[] {
    // sqlite-vec KNN query — fetch more candidates than limit to allow for filtering
    const fetchCount = filters ? limit * 3 : limit;
    const rows = this.db.prepare(`
      SELECT rowid, distance
      FROM chunks_vec
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `).all(embeddingToBuffer(embedding), fetchCount) as { rowid: number; distance: number }[];

    const results: SearchResult[] = [];
    for (const row of rows) {
      const chunk = this.getById(row.rowid);
      if (!chunk) continue;
      if (filters && !matchesFilters(chunk, filters)) continue;
      // Convert distance to similarity score (lower distance = higher score)
      results.push({ chunk, score: 1 / (1 + row.distance) });
      if (results.length >= limit) break;
    }

    return results;
  }

  private ftsSearch(query: string, filters: SearchFilters | undefined, limit: number): SearchResult[] {
    const sanitized = sanitizeFtsQuery(query);
    if (!sanitized) return [];

    const fetchCount = filters ? limit * 3 : limit;
    const rows = this.db.prepare(`
      SELECT rowid, rank
      FROM chunks_fts
      WHERE chunks_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(sanitized, fetchCount) as { rowid: number; rank: number }[];

    const results: SearchResult[] = [];
    for (const row of rows) {
      const chunk = this.getById(row.rowid);
      if (!chunk) continue;
      if (filters && !matchesFilters(chunk, filters)) continue;
      // FTS5 rank is negative (more negative = more relevant), normalize
      results.push({ chunk, score: 1 / (1 + Math.abs(row.rank)) });
      if (results.length >= limit) break;
    }

    return results;
  }

  private rrfMerge(vectorResults: SearchResult[], ftsResults: SearchResult[], limit: number): SearchResult[] {
    const scores = new Map<number, { chunk: StoredChunk; score: number }>();

    for (let i = 0; i < vectorResults.length; i++) {
      const { chunk } = vectorResults[i];
      const rrfScore = 1 / (RRF_K + i + 1);
      scores.set(chunk.id, { chunk, score: rrfScore });
    }

    for (let i = 0; i < ftsResults.length; i++) {
      const { chunk } = ftsResults[i];
      const rrfScore = 1 / (RRF_K + i + 1);
      const existing = scores.get(chunk.id);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scores.set(chunk.id, { chunk, score: rrfScore });
      }
    }

    return [...scores.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ chunk, score }) => ({ chunk, score }));
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

interface StoredChunkRow {
  id: number;
  content: string;
  guild_id: string;
  channel_id: string;
  thread_id: string | null;
  message_id: string | null;
  user_id: string | null;
  parent_message_id: string | null;
  created_at: string;
  chunk_type: string;
  token_count: number;
}

function rowToChunk(row: StoredChunkRow): StoredChunk {
  return {
    id: row.id,
    content: row.content,
    guild_id: row.guild_id,
    channel_id: row.channel_id,
    thread_id: row.thread_id,
    message_id: row.message_id,
    user_id: row.user_id,
    parent_message_id: row.parent_message_id,
    created_at: row.created_at,
    chunk_type: row.chunk_type as ChunkType,
    token_count: row.token_count,
  };
}

function embeddingToBuffer(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

function matchesFilters(chunk: StoredChunk, filters: SearchFilters): boolean {
  if (filters.guild_id && chunk.guild_id !== filters.guild_id) return false;
  if (filters.channel_id && chunk.channel_id !== filters.channel_id) return false;
  if (filters.user_id && chunk.user_id !== filters.user_id) return false;
  if (filters.chunk_type && chunk.chunk_type !== filters.chunk_type) return false;
  if (filters.after && chunk.created_at < filters.after) return false;
  if (filters.before && chunk.created_at > filters.before) return false;
  return true;
}

function sanitizeFtsQuery(query: string): string {
  // Strip FTS5 special characters, keep only words
  return query
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}
