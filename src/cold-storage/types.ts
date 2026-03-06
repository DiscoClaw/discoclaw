// ── Shared types for the cold-storage subsystem ────────────────────────

export type ChunkType = 'message' | 'file' | 'summary' | 'note';

/** Metadata attached to a chunk on insertion. */
export interface ChunkMetadata {
  guild_id: string;
  channel_id: string;
  thread_id?: string | null;
  message_id?: string | null;
  user_id?: string | null;
  parent_message_id?: string | null;
  chunk_type: ChunkType;
}

/** Content + metadata for inserting a new chunk (pre-embedding). */
export interface ChunkInput {
  content: string;
  metadata: ChunkMetadata;
}

/** Single result produced by the chunker. */
export interface ChunkOutput {
  content: string;
  token_count: number;
}

/** Stored record shape as persisted in the database. */
export interface Chunk {
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

/** Optional filters for search queries. */
export interface SearchFilters {
  guild_id?: string;
  channel_id?: string;
  thread_id?: string;
  user_id?: string;
  chunk_type?: ChunkType;
  after?: string;  // ISO 8601
  before?: string; // ISO 8601
}

/** Query text + optional filters for searching stored chunks. */
export interface SearchQuery {
  query: string;
  filters?: SearchFilters;
  limit?: number;
}

/** Chunk data + similarity score + derived jump URL. */
export interface SearchResult {
  chunk: Chunk;
  score: number;
  jump_url: string | null;
}

// ── Utilities ──────────────────────────────────────────────────────────

/** Constructs a Discord message URL from stored IDs, or null if message_id is missing. */
export function deriveJumpUrl(
  chunk: Pick<Chunk, 'guild_id' | 'channel_id' | 'message_id'>,
): string | null {
  if (!chunk.message_id) return null;
  return `https://discord.com/channels/${chunk.guild_id}/${chunk.channel_id}/${chunk.message_id}`;
}
