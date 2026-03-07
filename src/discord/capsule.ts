import { computeMarkdownCodeRanges } from './markdown-code-ranges.js';

export type ContinuationCapsule = {
  activeTaskId?: string;
  currentFocus: string;
  nextStep: string;
  blockedOn?: string;
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
const CAPSULE_FIELD_MAX_CHARS = 200;

function normalizeTextValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\r\n?/g, '\n').trim().slice(0, CAPSULE_FIELD_MAX_CHARS);
  return normalized.length > 0 ? normalized : null;
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

function isNoBlockedOnValue(value: string): boolean {
  return value === '[]' || /^\((?:none|n\/a)\)$/i.test(value) || /^none$/i.test(value);
}

function normalizeBlockedOnValue(value: unknown): string | null {
  if (Array.isArray(value)) {
    const blockers = value
      .map(item => normalizeTextValue(item))
      .filter((item): item is string => item !== null && !isNoBlockedOnValue(item));
    if (blockers.length === 0) return null;
    return normalizeTextValue(blockers.join('; '));
  }

  const normalized = normalizeTextValue(value);
  if (normalized === null || isNoBlockedOnValue(normalized)) return null;
  return normalized;
}

export function normalizeContinuationCapsule(value: unknown): ContinuationCapsule | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  const activeTaskId = getObjectString(record, ['activeTaskId', 'active_task_id', 'taskId', 'task_id']) ?? undefined;
  const currentFocus = getObjectString(record, [
    'currentFocus',
    'current_focus',
    'focus',
    'currentTask',
    'current_task',
    'task',
    'current',
  ]);
  const nextStep = getObjectString(record, ['nextStep', 'next_step', 'next']);
  const blockedOn = normalizeBlockedOnValue(
    record.blockedOn ?? record.blocked_on ?? record.blockers ?? record.blocker,
  ) ?? undefined;

  if (currentFocus === null || nextStep === null) return null;

  return {
    ...(activeTaskId ? { activeTaskId } : {}),
    currentFocus,
    nextStep,
    ...(blockedOn ? { blockedOn } : {}),
  };
}

function parseLineBasedCapsule(body: string): ContinuationCapsule | null {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  let activeTaskId: string | null = null;
  let currentFocus: string | null = null;
  let nextStep: string | null = null;
  let blockedOn: string | null = null;
  const blockers: string[] = [];
  let inLegacyBlockers = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const taskIdMatch = line.match(/^(?:activeTaskId|active_task_id|taskId|task_id)\s*:\s*(.+)$/i);
    if (taskIdMatch) {
      activeTaskId = normalizeTextValue(taskIdMatch[1]);
      inLegacyBlockers = false;
      continue;
    }

    const currentMatch = line.match(/^(?:currentFocus|current_focus|focus|currentTask|current_task|task|current)\s*:\s*(.+)$/i);
    if (currentMatch) {
      currentFocus = normalizeTextValue(currentMatch[1]);
      inLegacyBlockers = false;
      continue;
    }

    const nextMatch = line.match(/^(?:nextStep|next_step|next)\s*:\s*(.+)$/i);
    if (nextMatch) {
      nextStep = normalizeTextValue(nextMatch[1]);
      inLegacyBlockers = false;
      continue;
    }

    const blockedOnMatch = line.match(/^(?:blockedOn|blocked_on|blocked)\s*:\s*(.*)$/i);
    if (blockedOnMatch) {
      blockedOn = normalizeBlockedOnValue(blockedOnMatch[1]);
      inLegacyBlockers = false;
      continue;
    }

    const blockersMatch = line.match(/^(?:blockers?)\s*:\s*(.*)$/i);
    if (blockersMatch) {
      const inlineValue = normalizeBlockedOnValue(blockersMatch[1]);
      if (inlineValue !== null) blockers.push(inlineValue);
      inLegacyBlockers = true;
      continue;
    }

    if (!inLegacyBlockers) continue;

    const bulletMatch = rawLine.match(/^\s*[-*]\s+(.+)$/);
    if (!bulletMatch) {
      inLegacyBlockers = false;
      continue;
    }

    const blocker = normalizeTextValue(bulletMatch[1]);
    if (blocker !== null && !isNoBlockedOnValue(blocker)) blockers.push(blocker);
  }

  const normalizedBlockedOn = blockedOn ?? normalizeBlockedOnValue(blockers);
  if (currentFocus === null || nextStep === null) return null;

  return {
    ...(activeTaskId ? { activeTaskId } : {}),
    currentFocus,
    nextStep,
    ...(normalizedBlockedOn ? { blockedOn: normalizedBlockedOn } : {}),
  };
}

function parseCapsuleBody(body: string): ContinuationCapsule | null {
  const trimmed = body.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('{')) {
    try {
      return normalizeContinuationCapsule(JSON.parse(trimmed));
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

type ScannedContinuationCapsuleBlock = {
  capsule: ContinuationCapsule | null;
  raw: string;
  range: CapsuleRange;
};

function scanContinuationCapsuleBlocks(text: string): ScannedContinuationCapsuleBlock[] {
  const codeRanges = computeMarkdownCodeRanges(text);
  const blocks: ScannedContinuationCapsuleBlock[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const open = text.indexOf(CAPSULE_OPEN, cursor);
    if (open === -1) break;

    cursor = open + CAPSULE_OPEN.length;
    if (isIndexInRanges(open, codeRanges)) continue;

    const close = text.indexOf(CAPSULE_CLOSE, cursor);
    if (close === -1) {
      blocks.push({
        capsule: null,
        raw: text.slice(open),
        range: { start: open, end: text.length },
      });
      break;
    }

    const end = close + CAPSULE_CLOSE.length;
    const raw = text.slice(open, end);
    const capsule = parseCapsuleBody(text.slice(cursor, close));
    blocks.push({
      capsule,
      raw,
      range: { start: open, end },
    });

    cursor = end;
  }

  return blocks;
}

export function extractContinuationCapsuleBlocks(text: string): ParsedContinuationCapsuleBlock[] {
  return scanContinuationCapsuleBlocks(text).filter(
    (block): block is ParsedContinuationCapsuleBlock => block.capsule !== null,
  );
}

export const extractCapsuleBlocks = extractContinuationCapsuleBlocks;

export function parseContinuationCapsule(text: string): ContinuationCapsuleParseResult {
  const scannedBlocks = scanContinuationCapsuleBlocks(text);
  const blocks = scannedBlocks.filter(
    (block): block is ParsedContinuationCapsuleBlock => block.capsule !== null,
  );
  const cleanText = stripRanges(text, scannedBlocks.map(block => block.range));
  return {
    capsule: blocks.length > 0 ? blocks[blocks.length - 1]!.capsule : null,
    cleanText,
    blocks,
  };
}

export const parseCapsule = parseContinuationCapsule;
export const parseCapsuleBlock = parseContinuationCapsule;

export function renderContinuationCapsule(capsule: ContinuationCapsule): string {
  const normalized = normalizeContinuationCapsule(capsule);
  if (normalized === null) {
    throw new Error('Invalid continuation capsule');
  }

  return `${CAPSULE_OPEN}\n${JSON.stringify(normalized)}\n${CAPSULE_CLOSE}`;
}

export const renderCapsule = renderContinuationCapsule;
