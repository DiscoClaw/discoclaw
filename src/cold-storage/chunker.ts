// ── Types ──────────────────────────────────────────────────────────────

export interface ThreadMessage {
  content: string;
  user_id?: string;
  message_id?: string;
}

export interface ChunkerOptions {
  /** Maximum characters per chunk (default 1500). */
  maxChunkSize?: number;
  /** Number of trailing messages to repeat in the next chunk for context overlap (default 2). */
  overlapMessages?: number;
}

// ── Constants ──────────────────────────────────────────────────────────

const DEFAULT_MAX_CHUNK_SIZE = 1500;
const DEFAULT_OVERLAP_MESSAGES = 2;

// Matches fenced code blocks: ```...```
const CODE_BLOCK_RE = /```[\s\S]*?```/g;

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Groups thread messages into coherent text chunks with sliding-window overlap.
 * Preserves code blocks (never splits mid-block). Splits long messages at
 * paragraph/sentence boundaries outside code fences.
 */
export function chunkThread(
  messages: ThreadMessage[],
  options: ChunkerOptions = {},
): string[] {
  const maxSize = options.maxChunkSize ?? DEFAULT_MAX_CHUNK_SIZE;
  const overlapCount = options.overlapMessages ?? DEFAULT_OVERLAP_MESSAGES;

  if (messages.length === 0) return [];

  // Pre-split any individual message that exceeds maxSize
  const expanded: ThreadMessage[] = [];
  for (const msg of messages) {
    if (msg.content.length <= maxSize) {
      expanded.push(msg);
    } else {
      const parts = splitLongText(msg.content, maxSize);
      for (const part of parts) {
        expanded.push({ ...msg, content: part });
      }
    }
  }

  // Group messages into chunks using a greedy approach
  const chunks: string[] = [];
  let i = 0;

  while (i < expanded.length) {
    const chunkStart = i;
    const group: string[] = [];
    let size = 0;

    while (i < expanded.length) {
      const text = expanded[i].content;
      const added = size === 0 ? text.length : text.length + 1; // +1 for newline separator
      if (size > 0 && size + added > maxSize) break;
      group.push(text);
      size += added;
      i++;
    }

    chunks.push(group.join('\n'));

    // Slide back for overlap, but guarantee at least 1 message of forward progress
    if (i < expanded.length && overlapCount > 0) {
      const slideBack = Math.min(overlapCount, i - chunkStart - 1);
      if (slideBack > 0) i -= slideBack;
    }
  }

  return chunks;
}

// ── Internals (exported for testing) ───────────────────────────────────

/**
 * Split text that exceeds maxSize at paragraph or sentence boundaries,
 * never breaking inside a fenced code block.
 */
export function splitLongText(text: string, maxSize: number): string[] {
  if (text.length <= maxSize) return [text];

  // Identify code block regions as protected spans
  const protected_spans = findCodeBlockSpans(text);

  // Build a list of split candidates (paragraph breaks, then sentence ends)
  const candidates = findSplitCandidates(text, protected_spans);

  const parts: string[] = [];
  let start = 0;

  while (start < text.length) {
    if (text.length - start <= maxSize) {
      parts.push(text.slice(start).trim());
      break;
    }

    const end = start + maxSize;
    // Find the best split point: latest candidate at or before `end`
    let splitAt = -1;
    for (const c of candidates) {
      if (c <= start) continue;
      if (c > end) break;
      splitAt = c;
    }

    if (splitAt <= start) {
      // No good candidate — split at maxSize as a last resort
      // But avoid splitting inside a code block
      const codeSpan = protected_spans.find(s => s.start < end && s.end > end);
      if (codeSpan) {
        // Include the entire code block
        splitAt = codeSpan.end;
      } else {
        splitAt = end;
      }
    }

    parts.push(text.slice(start, splitAt).trim());
    start = splitAt;
    // Skip leading whitespace for the next part
    while (start < text.length && text[start] === '\n') start++;
  }

  return parts.filter(p => p.length > 0);
}

interface Span {
  start: number;
  end: number;
}

function findCodeBlockSpans(text: string): Span[] {
  const spans: Span[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(CODE_BLOCK_RE.source, 'g');
  while ((match = re.exec(text)) !== null) {
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return spans;
}

function isInsideCodeBlock(pos: number, spans: Span[]): boolean {
  return spans.some(s => pos > s.start && pos < s.end);
}

/**
 * Returns sorted character offsets where splitting is acceptable.
 * Prefers paragraph boundaries (\n\n), then sentence-ending punctuation followed by space.
 */
function findSplitCandidates(text: string, protectedSpans: Span[]): number[] {
  const candidates: number[] = [];

  // Paragraph breaks (split after the double newline)
  for (let i = 0; i < text.length - 1; i++) {
    if (text[i] === '\n' && text[i + 1] === '\n' && !isInsideCodeBlock(i, protectedSpans)) {
      candidates.push(i + 2);
    }
  }

  // Sentence ends: `. `, `! `, `? ` (split after the space)
  for (let i = 0; i < text.length - 1; i++) {
    if (
      (text[i] === '.' || text[i] === '!' || text[i] === '?') &&
      (text[i + 1] === ' ' || text[i + 1] === '\n') &&
      !isInsideCodeBlock(i, protectedSpans)
    ) {
      candidates.push(i + 1);
    }
  }

  // Deduplicate and sort
  return [...new Set(candidates)].sort((a, b) => a - b);
}
