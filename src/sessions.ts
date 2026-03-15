import crypto from 'node:crypto';

/**
 * Generates a fresh session UUID for each invocation.
 *
 * Claude CLI >= 2.1.38 rejects `--session-id` if a JSONL transcript file
 * already exists for that UUID ("Session ID already in use").  Since `-p`
 * mode does not load previous conversation history from the JSONL anyway,
 * reusing UUIDs provides no benefit.  Discoclaw maintains conversation
 * continuity through its own rolling-summary and durable-memory systems.
 */
export class SessionManager {
  constructor(_storePath?: string) {
    // storePath kept for backwards-compatible constructor signature.
  }

  async getOrCreate(_sessionKey: string): Promise<string> {
    return crypto.randomUUID();
  }
}
