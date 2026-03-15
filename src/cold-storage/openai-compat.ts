/**
 * OpenAI-compatible embedding provider for third-party endpoints
 * (Ollama, vLLM, LM Studio, Together, etc.).
 *
 * Maintainers: consult `docs/official-docs.md` before changing provider
 * compatibility assumptions, request shape, or model normalization here.
 *
 * Key differences from OpenAIEmbeddingProvider:
 * - Does not send `dimensions` in the request body (many compat providers reject it)
 * - Strips provider namespace prefixes from model names (e.g., "openai/model" → "model")
 * - baseUrl and model are required (no OpenAI-specific defaults)
 */
import type { EmbeddingProvider } from './embeddings.js';
import type { LoggerLike } from '../logging/logger-like.js';

export interface OpenAICompatEmbeddingOpts {
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions: number;
  log?: LoggerLike;
}

const MAX_BATCH_SIZE = 100;

export class OpenAICompatEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly log?: LoggerLike;

  constructor(opts: OpenAICompatEmbeddingOpts) {
    this.apiKey = opts.apiKey;
    this.model = stripModelPrefix(opts.model);
    this.dimensions = opts.dimensions;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.log = opts.log;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    try {
      const results: Float32Array[] = [];

      for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
        const batch = texts.slice(i, i + MAX_BATCH_SIZE);
        const batchResults = await this.embedBatch(batch);
        results.push(...batchResults);
      }

      return results;
    } catch (err) {
      this.log?.warn({ err }, 'openai-compat embedding request failed, returning empty results');
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
        // Intentionally omit `dimensions` — many compat providers reject it.
        // The caller-specified `dimensions` is used only to configure the vector
        // store column width; the provider determines its own output dimensionality.
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `OpenAI-compat embeddings API error: ${response.status} ${response.statusText} ${detail}`.trim(),
      );
    }

    const json = (await response.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
    };

    // Sort by index to preserve input order
    const sorted = json.data.sort((a, b) => a.index - b.index);
    return sorted.map((item) => new Float32Array(item.embedding));
  }
}

/** Strip provider namespace prefix from model name (e.g., "openai/model" → "model"). */
function stripModelPrefix(model: string): string {
  const idx = model.lastIndexOf('/');
  return idx >= 0 ? model.slice(idx + 1) : model;
}
