import type { EngineEvent } from '../runtime/types.js';
import { ToolAwareQueue } from './tool-aware-queue.js';
import { selectStreamingOutput } from './output-utils.js';
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

/** The faster edit interval used for streaming preview edits (matches normal message handler). */
const STREAMING_EDIT_INTERVAL_MS = 1250;

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
): StreamingProgressController {
  // Streaming state driven by the ToolAwareQueue
  let activityLabel = '';
  let deltaText = '';
  let finalText = '';
  let statusTick = 0;
  let lastStreamEditAt = 0;
  let progressMessageGone = false;
  const startedAt = Date.now();

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
        deltaText = '';
      } else if (action.type === 'stream_text') {
        deltaText += action.text;
      } else if (action.type === 'set_final') {
        finalText = action.text;
        deltaText = '';
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
    const content = selectStreamingOutput({
      deltaText,
      activityLabel,
      finalText,
      statusTick: statusTick++,
      elapsedMs: now - startedAt,
    });
    try {
      await progressReply.edit({ content, allowedMentions: NO_MENTIONS });
    } catch {
      // ignore Discord edit errors during streaming
    }
  }

  const onEvent: StreamingProgressController['onEvent'] = (evt) => {
    queue.handleEvent(evt);
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
    queue = createQueue();

    try {
      await progressReply.edit({ content: msg, allowedMentions: NO_MENTIONS });
    } catch (editErr: any) {
      if (editErr?.code === 10008) progressMessageGone = true;
    }
  };

  const dispose: StreamingProgressController['dispose'] = () => {
    clearInterval(interval);
    queue.dispose();
  };

  return { onEvent, onProgress, dispose };
}
