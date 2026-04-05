/**
 * Types for the Gemini Multimodal Live API provider.
 *
 * Extracted so that both GeminiLiveProvider (Phase 1.1) and the future
 * GeminiLiveResponder (Phase 1.2) can share them without circular deps.
 */

import type WebSocket from 'ws';
import type { LoggerLike } from '../../logging/logger-like.js';

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

export type GeminiLiveState = 'idle' | 'connecting' | 'setup' | 'open' | 'stopped';

// ---------------------------------------------------------------------------
// Events emitted by the provider
// ---------------------------------------------------------------------------

export type GeminiLiveEvent =
  | { type: 'audio'; data: Buffer }
  | { type: 'text'; text: string }
  | { type: 'turn_complete' }
  | { type: 'interrupted' }
  | { type: 'setup_complete' }
  | { type: 'error'; error: string };

// ---------------------------------------------------------------------------
// Constructor options
// ---------------------------------------------------------------------------

export type GeminiLiveOpts = {
  apiKey: string;
  log: LoggerLike;
  /** Model ID. Defaults to 'gemini-2.0-flash-live-001'. */
  model?: string;
  /** System instruction text. */
  systemInstruction?: string;
  /** Response modalities. Defaults to ['AUDIO']. */
  responseModalities?: Array<'AUDIO' | 'TEXT'>;
  /** Speech config voice name. */
  voiceName?: string;
  /** Override WebSocket constructor for testing. */
  wsFactory?: (url: string) => WebSocket;
};
