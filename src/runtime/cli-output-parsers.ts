// Output parsing functions for Claude CLI stream-json format.
// Extracted from claude-code-cli.ts for reuse by strategies and LongRunningProcess
// without circular imports.

import type { EngineEvent, ImageData } from './types.js';

/** Max base64 string length (~25 MB encoded, ~18.75 MB decoded). */
const MAX_IMAGE_BASE64_LEN = 25 * 1024 * 1024;

/** Extract a text string from a Claude CLI stream-json event. */
export function extractTextFromUnknownEvent(evt: unknown): string | null {
  if (!evt || typeof evt !== 'object') return null;
  const anyEvt = evt as Record<string, unknown>;

  // Claude CLI stream-json emits nested structures; check common shapes.
  const candidates: unknown[] = [
    anyEvt.text,
    anyEvt.delta,
    anyEvt.content,
    // Sometimes nested under .data.
    (anyEvt.data && typeof anyEvt.data === 'object') ? (anyEvt.data as any).text : undefined,
    // Claude CLI stream-json: event.delta.text (content_block_delta events)
    (anyEvt.event && typeof anyEvt.event === 'object' &&
     (anyEvt.event as any).delta && typeof (anyEvt.event as any).delta === 'object')
      ? (anyEvt.event as any).delta.text
      : undefined,
  ];

  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return null;
}

/** Extract the final result text from a Claude CLI stream-json "result" event. */
export function extractResultText(evt: unknown): string | null {
  if (!evt || typeof evt !== 'object') return null;
  const anyEvt = evt as Record<string, unknown>;
  if (anyEvt.type === 'result' && typeof anyEvt.result === 'string' && anyEvt.result.length > 0) {
    return anyEvt.result;
  }
  return null;
}

/** Extract an image content block from a Claude CLI stream-json event. */
export function extractImageFromUnknownEvent(evt: unknown): ImageData | null {
  if (!evt || typeof evt !== 'object') return null;
  const anyEvt = evt as Record<string, unknown>;

  // Direct image content block: { type: 'image', source: { type: 'base64', media_type, data } }
  if (anyEvt.type === 'image' && anyEvt.source && typeof anyEvt.source === 'object') {
    const src = anyEvt.source as Record<string, unknown>;
    if (src.type === 'base64' && typeof src.media_type === 'string' && typeof src.data === 'string') {
      if (src.data.length > MAX_IMAGE_BASE64_LEN) return null;
      return { base64: src.data, mediaType: src.media_type };
    }
  }

  // Wrapped in content_block_start: { content_block: { type: 'image', source: { ... } } }
  if (anyEvt.content_block && typeof anyEvt.content_block === 'object') {
    return extractImageFromUnknownEvent(anyEvt.content_block);
  }

  return null;
}

/** Extract text and images from a result event with content block arrays. */
export function extractResultContentBlocks(evt: unknown): { text: string; images: ImageData[] } | null {
  if (!evt || typeof evt !== 'object') return null;
  const anyEvt = evt as Record<string, unknown>;
  if (anyEvt.type !== 'result' || !Array.isArray(anyEvt.result)) return null;

  let text = '';
  const images: ImageData[] = [];

  for (const block of anyEvt.result) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string') {
      text += b.text;
    } else if (b.type === 'image') {
      const img = extractImageFromUnknownEvent(b);
      if (img) images.push(img);
    }
  }

  return { text, images };
}

/** Create a dedupe key for an image using a prefix + length to avoid storing full base64 in memory. */
export function imageDedupeKey(img: ImageData): string {
  return img.mediaType + ':' + img.base64.length + ':' + img.base64.slice(0, 64);
}

/**
 * Strip tool-call XML blocks and keep only the final answer.
 * When tool blocks are present, the text before/between them is narration
 * ("Let me read the files...") — we only want the text *after* the last block.
 */
export function stripToolUseBlocks(text: string): string {
  const toolPattern = /<tool_use>[\s\S]*?<\/tool_use>|<tool_calls>[\s\S]*?<\/tool_calls>|<tool_results>[\s\S]*?<\/tool_results>|<tool_call>[\s\S]*?<\/tool_call>|<tool_result>[\s\S]*?<\/tool_result>/g;
  const segments = text.split(toolPattern);
  // If tool blocks exist, keep only the last segment (the final answer).
  const result = segments.length > 1
    ? segments[segments.length - 1] ?? ''
    : text;
  return result.replace(/\n{3,}/g, '\n\n').trim();
}

/** Yield a text_final + done event pair from a text string. */
export function* textAsChunks(text: string): Generator<EngineEvent> {
  if (!text) return;
  yield { type: 'text_final', text };
  yield { type: 'done' };
}
