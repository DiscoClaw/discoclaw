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

export type GeminiLiveHistoryTurn = {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
};

export const DEFAULT_GEMINI_LIVE_MODEL = 'gemini-3.1-flash-live-preview';

/**
 * Returns the caller-provided Gemini Live model when it looks like a live-capable
 * model ID. Non-live model IDs are ignored so voice mode falls back to the
 * provider default instead of sending an invalid model to the Live API.
 */
export function normalizeGeminiLiveModel(model?: string): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith('gemini-') && trimmed.includes('live') ? trimmed : undefined;
}

/**
 * Gemini 3.1 Flash Live currently supports synchronous function calling only.
 * Gemini 2.5 Flash Live supports NON_BLOCKING declarations and response scheduling.
 */
export function supportsGeminiLiveAsyncFunctionCalling(model: string): boolean {
  return /^gemini-2\.5-.*live/i.test(model.trim());
}

/**
 * Gemini 3.1 Flash Live only supports clientContent for initial history seeding.
 * Regular conversational text turns must use realtimeInput.text.
 */
export function supportsGeminiLiveIncrementalClientContent(model: string): boolean {
  return /^gemini-2\.5-.*live/i.test(model.trim());
}

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
  | { type: 'input_transcript'; text: string }
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
  /** Model ID. Defaults to DEFAULT_GEMINI_LIVE_MODEL. */
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
  /** Enables 3.1-style initial history seeding via clientContent after setup. */
  initialHistoryInClientContent?: boolean;
};
