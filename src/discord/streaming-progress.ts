import type { EngineEvent } from '../runtime/types.js';
import { ToolAwareQueue } from './tool-aware-queue.js';
import { selectStreamingOutput, stripActionTags } from './output-utils.js';
import type { StreamingPreviewMode } from './output-utils.js';
import { NO_MENTIONS } from './allowed-mentions.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StreamingProgressController = {
  /**
   * Forward a runtime event into the streaming queue.
   * Call this for every event emitted by the runtime during a phase/forge run.
   */
  onEvent: (evt: EngineEvent) => void;
  /**
   * Emit a static progress message — throttled at `forgeProgressThrottleMs`.
   * Also resets the streaming queue so stale tool/text state is cleared
   * at each invocation boundary.
   */
  onProgress: (msg: string, opts?: { force?: boolean }) => Promise<void>;
  /** Stop the streaming edit interval and dispose the internal queue. */
  dispose: () => void;
};

export type StreamingProgressPreviewMode = 'always' | 'delayed';

export type StreamingProgressOpts = {
  previewMode?: StreamingProgressPreviewMode;
  previewDelayMs?: number;
  streamPreviewMode?: StreamingPreviewMode;
};

/** The faster edit interval used for streaming preview edits (matches normal message handler). */
const STREAMING_EDIT_INTERVAL_MS = 1250;
const DEFAULT_PREVIEW_DELAY_MS = 7000;
const MAX_RUNTIME_LINE_CHARS_COMPACT = 120;
const MAX_RUNTIME_LINE_CHARS_RAW = 220;

function errorCode(err: unknown): number | null {
  if (typeof err !== 'object' || err === null || !('code' in err)) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'number' ? code : null;
}

function truncatePreviewLine(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - 1)) + '\u2026';
}

function sanitizeRuntimeLine(text: string, maxChars: number): string {
  const clean = stripActionTags(text)
    .replace(/\r\n?/g, '\n')
    .replace(/\n+/g, ' \\n ')
    .replace(/\s+/g, ' ')
    .trim();
  return truncatePreviewLine(clean, maxChars);
}

/**
 * Detect structured JSON-like payloads embedded in runtime logs so we can keep
 * those internals out of Discord streaming previews.
 */
function hasStructuredPayloadFragment(text: string): boolean {
  return /[{[]\s*"[^"]+"\s*:/.test(text);
}

function formatRuntimeUsageLine(evt: Extract<EngineEvent, { type: 'usage' }>, mode: StreamingPreviewMode): string {
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

function formatRuntimeSignal(evt: EngineEvent, streamPreviewMode: StreamingPreviewMode): string | null {
  const maxChars = streamPreviewMode === 'raw'
    ? MAX_RUNTIME_LINE_CHARS_RAW
    : MAX_RUNTIME_LINE_CHARS_COMPACT;
  switch (evt.type) {
    case 'tool_start':
      return `Using ${evt.name}...`;
    case 'tool_end':
      return evt.ok ? `${evt.name} finished.` : `${evt.name} failed.`;
    case 'log_line': {
      const line = sanitizeRuntimeLine(evt.line, maxChars);
      if (!line) return null;
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
      return formatRuntimeUsageLine(evt, streamPreviewMode);
    case 'error': {
      const message = sanitizeRuntimeLine(evt.message, maxChars);
      if (!message) return 'Runtime error.';
      return `Runtime error: ${message}`;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a streaming progress controller for a Discord message.
 *
 * The controller wraps a `ToolAwareQueue` to track live tool activity and
 * streaming text, driving periodic Discord message edits via
 * `selectStreamingOutput`. Static progress text (phase transitions, etc.)
 * is forwarded through `onProgress`, which also resets the queue so
 * streaming state from the previous phase does not bleed into the next.
 *
 * @param progressReply  The Discord message to edit in place.
 * @param progressThrottleMs  Minimum ms between static progress edits (forgeProgressThrottleMs).
 */
export function createStreamingProgress(
  progressReply: { edit: (opts: { content: string; allowedMentions?: unknown }) => Promise<unknown> },
  progressThrottleMs: number,
  opts?: StreamingProgressOpts,
): StreamingProgressController {
  // Streaming state driven by the ToolAwareQueue
  let activityLabel = '';
  let deltaText = '';
  let finalText = '';
  let toolPreviewSnapshot = '';
  let statusTick = 0;
  let lastStreamEditAt = 0;
  let progressMessageGone = false;
  const startedAt = Date.now();
  const previewMode = opts?.previewMode ?? 'always';
  const previewDelayMs = Math.max(0, opts?.previewDelayMs ?? DEFAULT_PREVIEW_DELAY_MS);
  const streamPreviewMode = opts?.streamPreviewMode ?? 'compact';

  // Static-progress throttle state (mirrors the existing onProgress pattern)
  let lastStaticEditAt = 0;

  // Current queue instance — replaced on each onProgress call
  let queue = createQueue();

  // Interval that drives streaming preview edits
  const interval = setInterval(() => {
    void maybeStreamEdit(false);
  }, STREAMING_EDIT_INTERVAL_MS);

  function createQueue(): ToolAwareQueue {
    return new ToolAwareQueue((action) => {
      if (action.type === 'show_activity') {
        activityLabel = action.label;
      } else if (action.type === 'preview_text') {
        if (action.text.startsWith(toolPreviewSnapshot)) {
          deltaText += action.text.slice(toolPreviewSnapshot.length);
        } else {
          deltaText += action.text;
        }
        toolPreviewSnapshot = action.text;
      } else if (action.type === 'stream_text') {
        deltaText += action.text;
        toolPreviewSnapshot = '';
      } else if (action.type === 'set_final') {
        finalText = action.text;
        deltaText = '';
        toolPreviewSnapshot = '';
        activityLabel = '';
      }
    });
  }

  async function maybeStreamEdit(force: boolean): Promise<void> {
    if (progressMessageGone) return;
    const now = Date.now();
    if (!force && now - lastStreamEditAt < STREAMING_EDIT_INTERVAL_MS) return;
    // Only render when there is something streaming to show
    if (!activityLabel && !deltaText && !finalText) return;
    lastStreamEditAt = now;
    const elapsedMs = now - startedAt;
    const showPreview = previewMode === 'always' || elapsedMs >= previewDelayMs;
    const content = selectStreamingOutput({
      deltaText,
      activityLabel,
      finalText,
      statusTick: statusTick++,
      previewMode: streamPreviewMode,
      showPreview,
      elapsedMs,
    });
    try {
      await progressReply.edit({ content, allowedMentions: NO_MENTIONS });
    } catch {
      // ignore Discord edit errors during streaming
    }
  }

  function appendSignalLine(line: string): void {
    deltaText += (deltaText && !deltaText.endsWith('\n') ? '\n' : '') + line + '\n';
  }

  const onEvent: StreamingProgressController['onEvent'] = (evt) => {
    const signalLine = formatRuntimeSignal(evt, streamPreviewMode);
    if (signalLine) appendSignalLine(signalLine);
    queue.handleEvent(evt);
    void maybeStreamEdit(false);
  };

  const onProgress: StreamingProgressController['onProgress'] = async (msg, opts) => {
    if (progressMessageGone) return;
    const now = Date.now();
    if (!opts?.force && now - lastStaticEditAt < progressThrottleMs) return;
    lastStaticEditAt = now;

    // Reset streaming state for the new phase boundary
    queue.dispose();
    activityLabel = '';
    deltaText = '';
    finalText = '';
    toolPreviewSnapshot = '';
    queue = createQueue();

    try {
      await progressReply.edit({ content: msg, allowedMentions: NO_MENTIONS });
    } catch (editErr) {
      if (errorCode(editErr) === 10008) progressMessageGone = true;
    }
  };

  const dispose: StreamingProgressController['dispose'] = () => {
    clearInterval(interval);
    queue.dispose();
  };

  return { onEvent, onProgress, dispose };
}
