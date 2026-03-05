import type { EngineEvent } from '../runtime/types.js';
import type { PlanRunEvent } from './plan-manager.js';
import { stripActionTags } from './output-utils.js';
import type { StreamingPreviewMode } from './output-utils.js';

const MAX_RUNTIME_LINE_CHARS_COMPACT = 120;
const MAX_RUNTIME_LINE_CHARS_RAW = 220;

export type RuntimeEventTextAdapterMode = StreamingPreviewMode;

export type RuntimeEventTextAdapterOpts = {
  mode?: RuntimeEventTextAdapterMode;
};

function truncatePreviewLine(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 3) return text.slice(0, Math.max(0, maxChars));
  return text.slice(0, maxChars - 3) + '...';
}

function sanitizeRuntimeLine(text: string, maxChars: number): string {
  const clean = stripActionTags(text)
    .replace(/\r\n?/g, '\n')
    .replace(/\n+/g, ' \\n ')
    .replace(/\s+/g, ' ')
    .trim();
  return truncatePreviewLine(clean, maxChars);
}

function hasMeaningfulRuntimeLine(text: string): boolean {
  return text.replace(/\\n/g, '').trim().length > 0;
}

/**
 * Detect structured JSON-like payloads embedded in runtime logs so internals
 * do not leak into user-facing Discord progress text.
 */
function hasStructuredPayloadFragment(text: string): boolean {
  return /[{[]\s*"[^"]+"\s*:/.test(text);
}

function formatRuntimeUsageLine(
  evt: Extract<EngineEvent, { type: 'usage' }>,
  mode: RuntimeEventTextAdapterMode,
): string {
  const parts: string[] = [];
  if (typeof evt.inputTokens === 'number') parts.push(`in ${evt.inputTokens}`);
  if (typeof evt.outputTokens === 'number') parts.push(`out ${evt.outputTokens}`);
  if (typeof evt.totalTokens === 'number') parts.push(`total ${evt.totalTokens}`);
  if (typeof evt.costUsd === 'number') {
    const precision = mode === 'raw' ? 6 : 4;
    parts.push(`cost $${evt.costUsd.toFixed(precision)}`);
  }
  if (parts.length === 0) return 'Usage updated.';
  return `Usage: ${parts.join(', ')}.`;
}

function humanizeItemType(itemType: string): string {
  return itemType
    .split(/[_\s-]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatPreviewDebugLine(
  evt: Extract<EngineEvent, { type: 'preview_debug' }>,
  mode: RuntimeEventTextAdapterMode,
  maxChars: number,
): string | null {
  if (evt.label) {
    const label = sanitizeRuntimeLine(evt.label, maxChars);
    return label || null;
  }

  if (evt.source !== 'codex') return null;
  if (evt.itemType === 'agent_message') return null;

  const normalizedItemType = sanitizeRuntimeLine(evt.itemType, 80);
  if (!normalizedItemType || !hasMeaningfulRuntimeLine(normalizedItemType)) return null;

  const phase = evt.phase;
  const statusSuffix = mode === 'raw' && evt.status
    ? ` (${sanitizeRuntimeLine(evt.status, 40)})`
    : '';

  if (normalizedItemType === 'reasoning') {
    return phase === 'started'
      ? `Reasoning started${statusSuffix}...`
      : `Reasoning completed${statusSuffix}.`;
  }

  const item = humanizeItemType(normalizedItemType);
  return `${item} ${phase}${statusSuffix}.`;
}

export function adaptRuntimeEventText(
  evt: EngineEvent,
  opts?: RuntimeEventTextAdapterOpts,
): string | null {
  const mode = opts?.mode ?? 'compact';
  const maxChars = mode === 'raw'
    ? MAX_RUNTIME_LINE_CHARS_RAW
    : MAX_RUNTIME_LINE_CHARS_COMPACT;

  switch (evt.type) {
    case 'tool_start':
      return `Using ${evt.name}...`;
    case 'tool_end':
      return evt.ok ? `${evt.name} finished.` : `${evt.name} failed.`;
    case 'log_line': {
      const line = sanitizeRuntimeLine(evt.line, maxChars);
      if (!line || !hasMeaningfulRuntimeLine(line)) return null;
      if (hasStructuredPayloadFragment(line)) {
        return evt.stream === 'stderr'
          ? 'Runtime warning (details omitted).'
          : 'Runtime update (details omitted).';
      }
      return evt.stream === 'stderr'
        ? `Warning: ${line}`
        : `Update: ${line}`;
    }
    case 'usage':
      return formatRuntimeUsageLine(evt, mode);
    case 'preview_debug':
      return formatPreviewDebugLine(evt, mode, maxChars);
    case 'error': {
      const message = sanitizeRuntimeLine(evt.message, maxChars);
      if (!message || !hasMeaningfulRuntimeLine(message)) return 'Runtime error.';
      return `Runtime error: ${message}`;
    }
    default:
      return null;
  }
}

export function adaptPlanRunEventText(evt: PlanRunEvent): string {
  if (evt.type === 'phase_start') {
    return `Starting phase: ${evt.phase.title}...`;
  }

  if (evt.status === 'done') {
    return `Phase complete: ${evt.phase.title}.`;
  }
  if (evt.status === 'failed') {
    return `Phase failed: ${evt.phase.title}.`;
  }
  return `Phase skipped: ${evt.phase.title}.`;
}
