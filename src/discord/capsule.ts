export type ContinuationCapsule = {
  currentTask: string;
  nextStep: string;
  blockers: string[];
};

export type Capsule = ContinuationCapsule;

export type CapsuleRange = {
  start: number;
  end: number;
};

export type ParsedContinuationCapsuleBlock = {
  capsule: ContinuationCapsule;
  raw: string;
  range: CapsuleRange;
};

export type ContinuationCapsuleParseResult = {
  capsule: ContinuationCapsule | null;
  cleanText: string;
  blocks: ParsedContinuationCapsuleBlock[];
};

export type CapsuleParseResult = ContinuationCapsuleParseResult;

type TextRange = {
  start: number;
  end: number;
};

const CAPSULE_OPEN = '<continuation-capsule>';
const CAPSULE_CLOSE = '</continuation-capsule>';

function normalizeTextValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeBlockers(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    const blockers = value
      .map(item => normalizeTextValue(item))
      .filter((item): item is string => item !== null);
    return blockers;
  }

  const single = normalizeTextValue(value);
  if (single === null) return [];

  if (single === '[]' || /^\((?:none|n\/a)\)$/i.test(single) || /^none$/i.test(single)) {
    return [];
  }

  return [single];
}

function getObjectString(
  record: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = normalizeTextValue(record[key]);
    if (value !== null) return value;
  }
  return null;
}

function normalizeCapsuleObject(value: unknown): ContinuationCapsule | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  const currentTask = getObjectString(record, ['currentTask', 'current_task', 'task', 'current']);
  const nextStep = getObjectString(record, ['nextStep', 'next_step', 'next']);
  const blockers = normalizeBlockers(record.blockers ?? record.blocker ?? []);

  if (currentTask === null || nextStep === null || blockers === null) return null;

  return { currentTask, nextStep, blockers };
}

function parseLineBasedCapsule(body: string): ContinuationCapsule | null {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  let currentTask: string | null = null;
  let nextStep: string | null = null;
  const blockers: string[] = [];
  let inBlockers = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const currentMatch = line.match(/^(?:currentTask|current_task|task|current)\s*:\s*(.+)$/i);
    if (currentMatch) {
      currentTask = normalizeTextValue(currentMatch[1]);
      inBlockers = false;
      continue;
    }

    const nextMatch = line.match(/^(?:nextStep|next_step|next)\s*:\s*(.+)$/i);
    if (nextMatch) {
      nextStep = normalizeTextValue(nextMatch[1]);
      inBlockers = false;
      continue;
    }

    const blockersMatch = line.match(/^(?:blockers?)\s*:\s*(.*)$/i);
    if (blockersMatch) {
      const inlineValue = normalizeTextValue(blockersMatch[1]);
      if (inlineValue !== null && inlineValue !== '[]' && !/^none$/i.test(inlineValue) && !/^\((?:none|n\/a)\)$/i.test(inlineValue)) {
        blockers.push(inlineValue);
      }
      inBlockers = true;
      continue;
    }

    if (!inBlockers) continue;

    const bulletMatch = rawLine.match(/^\s*[-*]\s+(.+)$/);
    if (!bulletMatch) {
      inBlockers = false;
      continue;
    }

    const blocker = normalizeTextValue(bulletMatch[1]);
    if (blocker !== null) blockers.push(blocker);
  }

  if (currentTask === null || nextStep === null) return null;
  return { currentTask, nextStep, blockers };
}

function parseCapsuleBody(body: string): ContinuationCapsule | null {
  const trimmed = body.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('{')) {
    try {
      return normalizeCapsuleObject(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }

  return parseLineBasedCapsule(trimmed);
}

function mergeRanges(ranges: TextRange[]): TextRange[] {
  if (ranges.length <= 1) return [...ranges];
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: TextRange[] = [sorted[0]!];

  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1]!;
    const current = sorted[i]!;
    if (current.start <= prev.end) {
      prev.end = Math.max(prev.end, current.end);
      continue;
    }
    merged.push({ start: current.start, end: current.end });
  }

  return merged;
}

function collectIndentedCodeRanges(text: string, start: number, end: number, out: TextRange[]): void {
  let lineStart = start;
  let blockStart = -1;
  let blockEnd = -1;

  while (lineStart <= end) {
    const nl = text.indexOf('\n', lineStart);
    const hasNl = nl !== -1 && nl < end;
    const lineEnd = hasNl ? nl : end;
    const lineEndWithNl = hasNl ? nl + 1 : end;
    const line = text.slice(lineStart, lineEnd);
    const isBlank = /^[ \t]*$/.test(line);
    const isIndented = /^(?: {4,}|\t)/.test(line);

    if (blockStart === -1) {
      if (isIndented && !isBlank) {
        blockStart = lineStart;
        blockEnd = lineEndWithNl;
      }
    } else if (isIndented || isBlank) {
      if (isIndented) blockEnd = lineEndWithNl;
    } else {
      out.push({ start: blockStart, end: blockEnd });
      blockStart = -1;
      blockEnd = -1;
    }

    if (!hasNl) break;
    lineStart = lineEndWithNl;
  }

  if (blockStart !== -1) {
    out.push({ start: blockStart, end: blockEnd });
  }
}

function collectInlineCodeRanges(text: string, start: number, end: number, out: TextRange[]): void {
  let i = start;
  let inInline = false;
  let inlineTicks = 0;
  let inlineStart = -1;

  while (i < end) {
    if (text[i] !== '`') {
      i++;
      continue;
    }

    let ticks = 1;
    while (i + ticks < end && text[i + ticks] === '`') ticks++;

    if (!inInline) {
      inInline = true;
      inlineTicks = ticks;
      inlineStart = i;
    } else if (ticks === inlineTicks) {
      out.push({ start: inlineStart, end: i + ticks });
      inInline = false;
      inlineTicks = 0;
      inlineStart = -1;
    }

    i += ticks;
  }
}

function computeMarkdownCodeRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];

  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  let fenceStart = 0;
  let lineStart = 0;

  while (lineStart <= text.length) {
    const nl = text.indexOf('\n', lineStart);
    const hasNl = nl !== -1;
    const lineEnd = hasNl ? nl : text.length;
    const lineEndWithNl = hasNl ? nl + 1 : text.length;
    const line = text.slice(lineStart, lineEnd);

    if (!inFence) {
      const open = line.match(/^[ \t]*(`{3,}|~{3,})/);
      if (open) {
        inFence = true;
        fenceChar = open[1]![0]!;
        fenceLen = open[1]!.length;
        fenceStart = lineStart;
      }
    } else {
      const closeRe = new RegExp(`^[ \\t]*\\${fenceChar}{${fenceLen},}[ \\t]*$`);
      if (closeRe.test(line)) {
        ranges.push({ start: fenceStart, end: lineEndWithNl });
        inFence = false;
        fenceChar = '';
        fenceLen = 0;
      }
    }

    if (!hasNl) break;
    lineStart = lineEndWithNl;
  }

  if (inFence) {
    ranges.push({ start: fenceStart, end: text.length });
  }

  const mergedFenceRanges = mergeRanges(ranges);
  let segmentStart = 0;
  for (const range of mergedFenceRanges) {
    if (segmentStart < range.start) {
      collectIndentedCodeRanges(text, segmentStart, range.start, ranges);
    }
    segmentStart = range.end;
  }
  if (segmentStart < text.length) {
    collectIndentedCodeRanges(text, segmentStart, text.length, ranges);
  }

  const mergedBlockRanges = mergeRanges(ranges);
  segmentStart = 0;
  for (const range of mergedBlockRanges) {
    if (segmentStart < range.start) {
      collectInlineCodeRanges(text, segmentStart, range.start, ranges);
    }
    segmentStart = range.end;
  }
  if (segmentStart < text.length) {
    collectInlineCodeRanges(text, segmentStart, text.length, ranges);
  }

  return mergeRanges(ranges);
}

function isIndexInRanges(index: number, ranges: TextRange[]): boolean {
  for (const range of ranges) {
    if (index < range.start) return false;
    if (index < range.end) return true;
  }
  return false;
}

function collapseCapsuleWhitespace(text: string): string {
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

function stripRanges(text: string, ranges: TextRange[]): string {
  if (ranges.length === 0) return text;

  const mergedRanges = mergeRanges(ranges);
  let cursor = 0;
  let out = '';

  for (const range of mergedRanges) {
    out += text.slice(cursor, range.start);
    cursor = range.end;
  }
  out += text.slice(cursor);

  return collapseCapsuleWhitespace(out);
}

export function extractContinuationCapsuleBlocks(text: string): ParsedContinuationCapsuleBlock[] {
  const codeRanges = computeMarkdownCodeRanges(text);
  const blocks: ParsedContinuationCapsuleBlock[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const open = text.indexOf(CAPSULE_OPEN, cursor);
    if (open === -1) break;

    cursor = open + CAPSULE_OPEN.length;
    if (isIndexInRanges(open, codeRanges)) continue;

    const close = text.indexOf(CAPSULE_CLOSE, cursor);
    if (close === -1) break;

    const end = close + CAPSULE_CLOSE.length;
    const raw = text.slice(open, end);
    const capsule = parseCapsuleBody(text.slice(cursor, close));
    if (capsule !== null) {
      blocks.push({
        capsule,
        raw,
        range: { start: open, end },
      });
    }

    cursor = end;
  }

  return blocks;
}

export const extractCapsuleBlocks = extractContinuationCapsuleBlocks;

export function parseContinuationCapsule(text: string): ContinuationCapsuleParseResult {
  const blocks = extractContinuationCapsuleBlocks(text);
  const cleanText = stripRanges(text, blocks.map(block => block.range));
  return {
    capsule: blocks.length > 0 ? blocks[blocks.length - 1]!.capsule : null,
    cleanText,
    blocks,
  };
}

export const parseCapsule = parseContinuationCapsule;

export function renderContinuationCapsule(capsule: ContinuationCapsule): string {
  const normalized = normalizeCapsuleObject(capsule);
  if (normalized === null) {
    throw new Error('Invalid continuation capsule');
  }

  return `${CAPSULE_OPEN}\n${JSON.stringify(normalized)}\n${CAPSULE_CLOSE}`;
}

export const renderCapsule = renderContinuationCapsule;
