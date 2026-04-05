/**
 * Types for the Gemini Multimodal Live API provider.
 *
 * Extracted so that both GeminiLiveProvider (Phase 1.1) and the future
 * GeminiLiveResponder (Phase 1.2) can share them without circular deps.
 */

import type WebSocket from 'ws';
import type { LoggerLike } from '../../logging/logger-like.js';
import type { GeminiToolsConfig } from './gemini-tool-mapper.js';
import type { TokenBudget } from './gemini-live-token-estimator.js';

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

export type GeminiLiveState = 'idle' | 'connecting' | 'setup' | 'open' | 'stopped';

// ---------------------------------------------------------------------------
// Events emitted by the provider
// ---------------------------------------------------------------------------

/** A single function call from the Gemini server. */
export type GeminiFunctionCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

export type GeminiLiveEvent =
  | { type: 'audio'; data: Buffer }
  | { type: 'text'; text: string }
  | { type: 'turn_complete' }
  | { type: 'interrupted' }
  | { type: 'setup_complete' }
  | { type: 'error'; error: string }
  | { type: 'tool_call'; functionCalls: GeminiFunctionCall[] }
  | { type: 'reconnecting'; attempt: number; maxRetries: number; hasResumeHandle: boolean }
  | { type: 'reconnected'; attempt: number }
  | { type: 'reconnect_failed'; attempts: number }
  | { type: 'session_rotating'; sessionAgeMs: number }
  | { type: 'token_warning'; estimatedTokens: number; threshold: 'warn' | 'compress' }
  | { type: 'fallback_recommended'; reason: string };

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
  /** Gemini tools config (function declarations). Included in the setup message when provided. */
  tools?: GeminiToolsConfig;
  /** Session rotation threshold in ms. Defaults to 780000 (13 min). Set to 0 to disable. */
  sessionRotationMs?: number;
  /** Token budget overrides for compression safety warnings. */
  tokenBudget?: Partial<TokenBudget>;
};
