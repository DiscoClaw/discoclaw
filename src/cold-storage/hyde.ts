/**
 * Hypothetical Document Embedding (HyDE) — generates a hypothetical answer
 * to a query so the embedding captures the *answer* vocabulary rather than
 * the *question* vocabulary, bridging the semantic gap for vector search.
 *
 * Fail-open by contract: any failure returns null and the caller falls back
 * to embedding the raw query.
 */
import type { LoggerLike } from '../logging/logger-like.js';

export interface HydeOpts {
  apiKey: string;
  baseUrl: string;
  model: string;
  query: string;
  log?: LoggerLike;
}

const HYDE_SYSTEM_PROMPT =
  'You are a retrieval assistant. Given a query, write a short hypothetical passage ' +
  'that directly answers it as if the passage were already stored in a knowledge base. ' +
  'Do not include preamble or meta-commentary — output only the passage.';

const TIMEOUT_MS = 15_000;

/**
 * Generate a hypothetical answer to `query` via an OpenAI-compatible chat
 * completions endpoint. Returns the generated text, or `null` on any failure.
 */
export async function generateHypotheticalAnswer(opts: HydeOpts): Promise<string | null> {
  const { apiKey, baseUrl, model, query, log } = opts;
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: HYDE_SYSTEM_PROMPT },
          { role: 'user', content: query },
        ],
        max_tokens: 256,
        temperature: 0.7,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      log?.warn(
        { status: response.status, detail },
        'hyde: chat completions API error, falling back to raw query',
      );
      return null;
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const text = json.choices?.[0]?.message?.content?.trim() ?? '';
    if (text.length === 0) {
      log?.warn({}, 'hyde: empty response from model, falling back to raw query');
      return null;
    }

    return text;
  } catch (err) {
    log?.warn({ err }, 'hyde: generation failed, falling back to raw query');
    return null;
  }
}
