import type { EngineEvent } from '../runtime/types.js';
import { toolActivityLabel } from '../runtime/tool-labels.js';

export type DisplayAction =
  | { type: 'show_activity'; label: string }
  | { type: 'preview_text'; text: string }
  | { type: 'stream_text'; text: string }
  | { type: 'set_final'; text: string };

type State = 'idle' | 'buffering_text' | 'tool_active' | 'streaming_final';

export type ToolAwareQueueOpts = {
  flushDelayMs?: number;
  postToolDelayMs?: number;
  toolActivePreviewIntervalMs?: number;
};

export class ToolAwareQueue {
  private state: State = 'idle';
  private buffer = '';
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private toolActivePreviewTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private readonly emit: (action: DisplayAction) => void;
  private readonly flushDelayMs: number;
  private readonly postToolDelayMs: number;
  private readonly toolActivePreviewIntervalMs: number;

  constructor(emit: (action: DisplayAction) => void, opts?: ToolAwareQueueOpts) {
    this.emit = emit;
    this.flushDelayMs = opts?.flushDelayMs ?? 800;
    this.postToolDelayMs = opts?.postToolDelayMs ?? 500;
    this.toolActivePreviewIntervalMs = opts?.toolActivePreviewIntervalMs ?? 1250;
  }

  handleEvent(evt: EngineEvent): void {
    if (this.disposed) return;
    switch (evt.type) {
      case 'text_delta':
        this.onTextDelta(evt.text);
        break;
      case 'text_final':
        this.onTextFinal(evt.text);
        break;
      case 'tool_start':
        this.onToolStart(evt.name, evt.input);
        break;
      case 'tool_end':
        this.onToolEnd();
        break;
      case 'error':
      case 'done':
        this.stopAllTimers();
        break;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stopAllTimers();
  }

  private onTextDelta(text: string): void {
    switch (this.state) {
      case 'idle':
        this.state = 'buffering_text';
        this.buffer = text;
        this.startFlushTimer(this.flushDelayMs);
        break;
      case 'buffering_text':
        this.buffer += text;
        break;
      case 'tool_active':
        // Buffer text during tool execution; discard on next tool or flush after tool ends.
        this.buffer += text;
        this.startToolActivePreviewTimer();
        break;
      case 'streaming_final':
        this.emit({ type: 'stream_text', text });
        break;
    }
  }

  private onTextFinal(text: string): void {
    this.stopAllTimers();
    this.state = 'streaming_final';
    this.emit({ type: 'set_final', text });
  }

  private onToolStart(name: string, input?: unknown): void {
    this.cancelFlushTimer();
    const label = toolActivityLabel(name, input);

    switch (this.state) {
      case 'idle':
      case 'buffering_text':
        // Discard buffered narration text.
        this.buffer = '';
        this.state = 'tool_active';
        this.emit({ type: 'show_activity', label });
        break;
      case 'tool_active':
        // New tool replaces the current activity label.
        this.emit({ type: 'show_activity', label });
        break;
      case 'streaming_final':
        // Rare: tool starts after we began streaming. Switch to tool_active.
        this.state = 'tool_active';
        this.emit({ type: 'show_activity', label });
        break;
    }
  }

  private onToolEnd(): void {
    if (this.state !== 'tool_active') return;

    this.stopToolActivePreviewTimer();
    this.state = 'buffering_text';
    this.buffer = '';
    this.startFlushTimer(this.postToolDelayMs);
  }

  private startFlushTimer(delayMs: number): void {
    this.cancelFlushTimer();
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, delayMs);
  }

  private startToolActivePreviewTimer(): void {
    if (this.toolActivePreviewIntervalMs <= 0) return;
    if (this.toolActivePreviewTimer) return;
    this.toolActivePreviewTimer = setInterval(() => {
      if (this.disposed || this.state !== 'tool_active' || !this.buffer) return;
      this.emit({ type: 'preview_text', text: this.buffer });
    }, this.toolActivePreviewIntervalMs);
  }

  private flush(): void {
    if (this.disposed || this.state !== 'buffering_text') return;
    this.state = 'streaming_final';
    if (this.buffer) {
      this.emit({ type: 'stream_text', text: this.buffer });
      this.buffer = '';
    }
  }

  private cancelFlushTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private stopToolActivePreviewTimer(): void {
    if (this.toolActivePreviewTimer) {
      clearInterval(this.toolActivePreviewTimer);
      this.toolActivePreviewTimer = null;
    }
  }

  private stopAllTimers(): void {
    this.cancelFlushTimer();
    this.stopToolActivePreviewTimer();
  }
}
