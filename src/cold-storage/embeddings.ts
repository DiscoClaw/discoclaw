import type { LoggerLike } from '../logging/logger-like.js';

// ── Interface ──────────────────────────────────────────────────────────

export interface EmbeddingProvider {
  readonly dimensions: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

// ── OpenAI Implementation ──────────────────────────────────────────────

const DEFAULT_MODEL = 'text-embedding-3-small';
const DEFAULT_DIMENSIONS = 1536;
const MAX_BATCH_SIZE = 100;

/**
 * Maintainers: consult `docs/official-docs.md` before changing the OpenAI
 * embeddings endpoint, default model, request body, or dimensions handling.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly log?: LoggerLike;

  constructor(opts: {
    apiKey: string;
    model?: string;
    dimensions?: number;
    baseUrl?: string;
    log?: LoggerLike;
  }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.dimensions = opts.dimensions ?? DEFAULT_DIMENSIONS;
    this.baseUrl = opts.baseUrl ?? 'https://api.openai.com/v1';
    this.log = opts.log;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    try {
      // Split into batches of MAX_BATCH_SIZE
      const results: Float32Array[] = [];

      for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
        const batch = texts.slice(i, i + MAX_BATCH_SIZE);
        const batchResults = await this.embedBatch(batch);
        results.push(...batchResults);
      }

      return results;
    } catch (err) {
      this.log?.warn({ err }, 'embedding request failed, returning empty results');
      return [];
    }
  }

  private async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const url = `${this.baseUrl}/embeddings`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        dimensions: this.dimensions,
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`OpenAI embeddings API error: ${response.status} ${response.statusText} ${detail}`.trim());
    }

    const json = await response.json() as {
      data: Array<{ embedding: number[]; index: number }>;
    };

    // Sort by index to preserve input order
    const sorted = json.data.sort((a, b) => a.index - b.index);
    return sorted.map((item) => new Float32Array(item.embedding));
  }
}
