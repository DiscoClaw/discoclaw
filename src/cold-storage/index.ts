// ── Cold-storage barrel ─────────────────────────────────────────────────
// Re-exports + factory function for assembling the cold-storage subsystem.

import type { LoggerLike } from '../logging/logger-like.js';
import { ColdStorageStore } from './store.js';
import { type EmbeddingProvider, OpenAIEmbeddingProvider } from './embeddings.js';
import { OpenAICompatEmbeddingProvider } from './openai-compat.js';

// ── Re-exports ──────────────────────────────────────────────────────────

export type {
  ChunkType,
  ChunkMetadata,
  ChunkInput,
  ChunkOutput,
  Chunk,
  SearchFilters,
  SearchQuery,
  SearchResult,
} from './types.js';
export { deriveJumpUrl } from './types.js';

export { ColdStorageStore } from './store.js';
export type { InsertChunkInput, SearchOptions } from './store.js';

export type { EmbeddingProvider } from './embeddings.js';
export { OpenAIEmbeddingProvider } from './embeddings.js';

export { OpenAICompatEmbeddingProvider } from './openai-compat.js';
export type { OpenAICompatEmbeddingOpts } from './openai-compat.js';

export { chunkThread, splitLongText } from './chunker.js';
export type { ThreadMessage, ChunkerOptions } from './chunker.js';

export { buildColdStorageSection, formatResultLine } from './prompt-section.js';
export type { PromptSectionOptions } from './prompt-section.js';

// ── Factory types ───────────────────────────────────────────────────────

export interface ColdStorageConfig {
  /** Path to the SQLite database file. */
  dbPath: string;
  /** Which embedding provider to use. */
  provider: 'openai' | 'openai-compat';
  /** API key for the embedding provider. */
  apiKey: string;
  /** Embedding model name (required for openai-compat, optional for openai). */
  model?: string;
  /** Embedding dimensions (required for openai-compat, optional for openai). */
  dimensions?: number;
  /** Base URL for the embedding API (required for openai-compat, optional for openai). */
  baseUrl?: string;
  /** Logger instance. */
  log: LoggerLike;
}

export interface ColdStorageSubsystem {
  store: ColdStorageStore;
  embeddings: EmbeddingProvider;
  close(): void;
}

// ── Factory ─────────────────────────────────────────────────────────────

export function createColdStorage(config: ColdStorageConfig): ColdStorageSubsystem {
  const embeddings = createEmbeddingProvider(config);
  const store = new ColdStorageStore(config.dbPath, embeddings.dimensions, config.log);

  return {
    store,
    embeddings,
    close() {
      store.close();
    },
  };
}

function createEmbeddingProvider(config: ColdStorageConfig): EmbeddingProvider {
  if (config.provider === 'openai-compat') {
    if (!config.baseUrl) {
      throw new Error('cold-storage: openai-compat provider requires baseUrl');
    }
    if (!config.model) {
      throw new Error('cold-storage: openai-compat provider requires model');
    }
    if (!config.dimensions) {
      throw new Error('cold-storage: openai-compat provider requires dimensions');
    }

    return new OpenAICompatEmbeddingProvider({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      dimensions: config.dimensions,
      log: config.log,
    });
  }

  // Default: OpenAI provider
  return new OpenAIEmbeddingProvider({
    apiKey: config.apiKey,
    model: config.model,
    dimensions: config.dimensions,
    baseUrl: config.baseUrl,
    log: config.log,
  });
}
