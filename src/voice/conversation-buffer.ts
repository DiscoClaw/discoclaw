/**
 * Per-guild conversation ring buffer for voice sessions.
 *
 * Stores up to CAPACITY user/assistant turn pairs in a fixed-size circular
 * array. Oldest turns are evicted when full. Used to inject conversation
 * history into the voice prompt so the AI has context for follow-ups.
 */

/** Maximum number of turn pairs stored in the buffer. */
export const CAPACITY = 10;

/** Per-entry character cap — user and assistant text are each truncated to this length. */
const ENTRY_CHAR_CAP = 500;

export type Turn = {
  user: string;
  assistant: string;
};

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

export class ConversationBuffer {
  private readonly buffer: (Turn | undefined)[];
  private head = 0; // next write index
  private count = 0;

  constructor() {
    this.buffer = new Array<Turn | undefined>(CAPACITY);
  }

  /** Number of turns currently stored. */
  get size(): number {
    return this.count;
  }

  /** Append a user/assistant turn pair. Evicts the oldest if at capacity. */
  push(userText: string, assistantText: string): void {
    this.buffer[this.head] = {
      user: truncate(userText, ENTRY_CHAR_CAP),
      assistant: truncate(assistantText, ENTRY_CHAR_CAP),
    };
    this.head = (this.head + 1) % CAPACITY;
    if (this.count < CAPACITY) this.count++;
  }

  /**
   * Pre-populate history from persisted voice-log turns.
   * If more entries than CAPACITY are provided, only the most recent are kept.
   */
  backfill(turns: Turn[]): void {
    // Take only the tail if there are more turns than capacity.
    const source = turns.length > CAPACITY ? turns.slice(-CAPACITY) : turns;
    for (const turn of source) {
      this.push(turn.user, turn.assistant);
    }
  }

  /**
   * Format the stored turns as a conversation log string.
   * Returns empty string when the buffer is empty.
   */
  getHistory(): string {
    if (this.count === 0) return '';

    const lines: string[] = [];
    // Read from oldest to newest.
    const start = this.count < CAPACITY ? 0 : this.head;
    for (let i = 0; i < this.count; i++) {
      const idx = (start + i) % CAPACITY;
      const turn = this.buffer[idx]!;
      lines.push(`[User]: ${turn.user}`);
      lines.push(`[Assistant]: ${turn.assistant}`);
    }
    return lines.join('\n');
  }

  /** Clear all stored turns. */
  clear(): void {
    this.buffer.fill(undefined);
    this.head = 0;
    this.count = 0;
  }
}
