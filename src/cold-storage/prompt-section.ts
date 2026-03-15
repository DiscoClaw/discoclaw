// ── Cold-storage prompt section builder ──────────────────────────────────
// Formats search results into a text section for prompt injection.
// Standalone module — no runtime side effects.

import type { SearchResult } from './types.js';

// ── Types ──────────────────────────────────────────────────────────────

export interface PromptSectionOptions {
  /** Max characters for the rendered section (default 1500). */
  maxChars?: number;
}

// ── Constants ──────────────────────────────────────────────────────────

const DEFAULT_MAX_CHARS = 1500;

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Build a prompt section from cold-storage search results.
 *
 * Renders each result as a compact line with score and optional jump URL.
 * Accumulates results until the character budget is exhausted.
 * Returns an empty string when results are empty.
 */
export function buildColdStorageSection(
  results: SearchResult[],
  options: PromptSectionOptions = {},
): string {
  if (results.length === 0) return '';

  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const header = 'Relevant context from conversation history:\n';

  let body = '';
  let truncated = false;

  for (const result of results) {
    const line = formatResultLine(result);
    const lineWithNewline = line + '\n';

    if (header.length + body.length + lineWithNewline.length > maxChars) {
      truncated = true;
      break;
    }

    body += lineWithNewline;
  }

  if (!body) return '';

  if (truncated) {
    body += '(more results available)\n';
  }

  return header + body;
}

// ── Formatting ─────────────────────────────────────────────────────────

/**
 * Format a single search result as a compact line.
 *
 * Format: `[score] content (source)`
 * The content is trimmed and newlines collapsed for readability.
 */
export function formatResultLine(result: SearchResult): string {
  const score = result.score.toFixed(3);
  const content = collapseWhitespace(result.chunk.content);
  const source = formatSource(result);

  return `[${score}] ${content}${source}`;
}

function formatSource(result: SearchResult): string {
  const parts: string[] = [];

  if (result.chunk.chunk_type !== 'message') {
    parts.push(result.chunk.chunk_type);
  }

  if (result.jump_url) {
    parts.push(result.jump_url);
  }

  if (parts.length === 0) return '';
  return ` (${parts.join(', ')})`;
}

function collapseWhitespace(text: string): string {
  return text.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}
