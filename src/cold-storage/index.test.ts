import { describe, it, expect, afterEach, vi } from 'vitest';
import { createColdStorage, type ColdStorageConfig, type ColdStorageSubsystem } from './index.js';
import type { LoggerLike } from '../logging/logger-like.js';
import { OpenAIEmbeddingProvider } from './embeddings.js';
import { OpenAICompatEmbeddingProvider } from './openai-compat.js';

function createLogger(): LoggerLike {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function defaultConfig(overrides: Partial<ColdStorageConfig> = {}): ColdStorageConfig {
  return {
    dbPath: ':memory:',
    provider: 'openai',
    apiKey: 'test-key',
    log: createLogger(),
    ...overrides,
  };
}

describe('createColdStorage', () => {
  let subsystem: ColdStorageSubsystem | undefined;

  afterEach(() => {
    subsystem?.close();
    subsystem = undefined;
  });

  // ── OpenAI provider ─────────────────────────────────────────────────

  it('creates subsystem with OpenAI provider by default', () => {
    subsystem = createColdStorage(defaultConfig());

    expect(subsystem.store).toBeDefined();
    expect(subsystem.embeddings).toBeInstanceOf(OpenAIEmbeddingProvider);
    expect(subsystem.embeddings.dimensions).toBe(1536); // OpenAI default
  });

  it('passes custom model and dimensions to OpenAI provider', () => {
    subsystem = createColdStorage(defaultConfig({
      model: 'text-embedding-3-large',
      dimensions: 3072,
    }));

    expect(subsystem.embeddings).toBeInstanceOf(OpenAIEmbeddingProvider);
    expect(subsystem.embeddings.dimensions).toBe(3072);
  });

  it('passes custom baseUrl to OpenAI provider', () => {
    subsystem = createColdStorage(defaultConfig({
      baseUrl: 'https://custom.openai.com/v1',
    }));

    expect(subsystem.embeddings).toBeInstanceOf(OpenAIEmbeddingProvider);
  });

  // ── OpenAI-compat provider ──────────────────────────────────────────

  it('creates subsystem with OpenAI-compat provider', () => {
    subsystem = createColdStorage(defaultConfig({
      provider: 'openai-compat',
      baseUrl: 'http://localhost:11434/v1',
      model: 'nomic-embed-text',
      dimensions: 768,
    }));

    expect(subsystem.store).toBeDefined();
    expect(subsystem.embeddings).toBeInstanceOf(OpenAICompatEmbeddingProvider);
    expect(subsystem.embeddings.dimensions).toBe(768);
  });

  it('throws when openai-compat is missing baseUrl', () => {
    expect(() => createColdStorage(defaultConfig({
      provider: 'openai-compat',
      model: 'nomic-embed-text',
      dimensions: 768,
    }))).toThrow('openai-compat provider requires baseUrl');
  });

  it('throws when openai-compat is missing model', () => {
    expect(() => createColdStorage(defaultConfig({
      provider: 'openai-compat',
      baseUrl: 'http://localhost:11434/v1',
      dimensions: 768,
    }))).toThrow('openai-compat provider requires model');
  });

  it('throws when openai-compat is missing dimensions', () => {
    expect(() => createColdStorage(defaultConfig({
      provider: 'openai-compat',
      baseUrl: 'http://localhost:11434/v1',
      model: 'nomic-embed-text',
    }))).toThrow('openai-compat provider requires dimensions');
  });

  // ── Store initialization ────────────────────────────────────────────

  it('initializes store with provider dimensions', () => {
    subsystem = createColdStorage(defaultConfig({ dimensions: 384 }));

    // Verify store is functional by checking schema was created
    const tables = subsystem.store.db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual table') ORDER BY name")
      .pluck()
      .all() as string[];

    expect(tables).toContain('chunks');
    expect(tables).toContain('chunks_fts');
    expect(tables).toContain('chunks_vec');
  });

  // ── close() ─────────────────────────────────────────────────────────

  it('close() closes the underlying store', () => {
    subsystem = createColdStorage(defaultConfig());

    subsystem.close();
    // After close, accessing db should throw
    expect(() => subsystem!.store.db.prepare('SELECT 1')).toThrow();
    subsystem = undefined; // prevent double-close in afterEach
  });
});
