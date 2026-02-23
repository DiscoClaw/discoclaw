// Strategy interface for the universal CLI runtime adapter.
// Each CLI-based model provides a thin strategy object (~40-80 lines)
// that plugs into the shared infrastructure via createCliRuntime().
//
// Types only — no runtime code.

import type { EngineEvent, ImageData, RuntimeCapability, RuntimeId, RuntimeInvokeParams } from './types.js';

// ---------------------------------------------------------------------------
// ParsedLineResult — what a strategy's parseLine() returns
// ---------------------------------------------------------------------------
export type ParsedLineResult = {
  /** Text delta extracted from this line (null = no text). */
  text?: string | null;
  /** Image extracted from this line (null = no image). */
  image?: ImageData | null;
  /** Final result text (only for "result" events). */
  resultText?: string | null;
  /** Images from result content block arrays. */
  resultImages?: ImageData[];
  /** If true, this event signals end-of-turn (for multi-turn mode). */
  endOfTurn?: boolean;
  /** Any extra events to emit (e.g. session-mapping for Codex). */
  extraEvents?: EngineEvent[];
  /** Whether this line is inside a tool-use block (suppress streaming). */
  inToolUse?: boolean;
  /**
   * If true, this event represents meaningful non-text activity (e.g. tool
   * input generation) that should reset the progress stall timer even though
   * no text_delta was produced. Intentionally NOT set for thinking_delta —
   * those are exactly what the spiral detector is meant to catch.
   */
  activity?: boolean;
};

// ---------------------------------------------------------------------------
// CliInvokeContext — per-invocation context passed to strategy hooks
// ---------------------------------------------------------------------------
export type CliInvokeContext = {
  params: RuntimeInvokeParams;
  useStdin: boolean;
  hasImages: boolean;
  /** Session-resume map (sessionKey → external thread/session ID). Available for session-resume strategies. */
  sessionMap?: Map<string, string>;
};

// ---------------------------------------------------------------------------
// CliAdapterLogger — minimal logger interface
// ---------------------------------------------------------------------------
export type CliAdapterLogger = {
  debug(...args: unknown[]): void;
  info?(...args: unknown[]): void;
};

// ---------------------------------------------------------------------------
// UniversalCliOpts — shared options for createCliRuntime()
// ---------------------------------------------------------------------------
export type UniversalCliOpts = {
  binary?: string;
  dangerouslySkipPermissions?: boolean;
  disableSessions?: boolean;
  multiTurn?: boolean;
  multiTurnHangTimeoutMs?: number;
  multiTurnIdleTimeoutMs?: number;
  multiTurnMaxProcesses?: number;
  streamStallTimeoutMs?: number;
  progressStallTimeoutMs?: number;
  sessionScanning?: boolean;
  echoStdio?: boolean;
  verbose?: boolean;
  debugFile?: string | null;
  log?: CliAdapterLogger;
  strictMcpConfig?: boolean;
  fallbackModel?: string;
  maxBudgetUsd?: number;
  appendSystemPrompt?: string;
  outputFormat?: 'text' | 'stream-json';
};

// ---------------------------------------------------------------------------
// CliAdapterStrategy — model-specific logic
// ---------------------------------------------------------------------------
export interface CliAdapterStrategy {
  /** Runtime identifier. */
  id: RuntimeId;
  /** Default binary name (e.g. 'claude', 'codex'). */
  binaryDefault: string;
  /** Default model to use when params.model is empty. */
  defaultModel: string;
  /** Capabilities that this runtime supports. */
  capabilities: readonly RuntimeCapability[];

  // --- One-shot invocation ---

  /** Build CLI args for one-shot invocation. */
  buildArgs(ctx: CliInvokeContext, opts: UniversalCliOpts): string[];

  /** Build stdin payload for one-shot invocation (null = no stdin). */
  buildStdinPayload?(ctx: CliInvokeContext): string | null;

  /**
   * Determine the output mode for this invocation.
   * A function (not static) because Codex switches between text/JSONL
   * based on session state.
   */
  getOutputMode(ctx: CliInvokeContext, opts: UniversalCliOpts): 'text' | 'jsonl';

  /**
   * Parse a single stdout line in JSONL mode.
   * Called for each non-empty line. Return parsed information or null to skip.
   */
  parseLine?(evt: unknown, ctx: CliInvokeContext): ParsedLineResult | null;

  /** Sanitize/truncate error messages before exposing to users. */
  sanitizeError?(raw: string, binary: string): string;

  // --- Multi-turn (process pool or session resume) ---

  /** Multi-turn mode: 'process-pool' (Claude), 'session-resume' (Codex), or 'none'. */
  multiTurnMode?: 'process-pool' | 'session-resume' | 'none';

  /** Build args for the long-running process (process-pool mode). */
  buildLongRunningArgs?(opts: UniversalCliOpts, model: string): string[];

  /** Build stdin message for a turn in multi-turn mode. */
  buildTurnStdin?(prompt: string, images?: ImageData[]): string;

  /** Parse a stdout line from a long-running process. */
  parseLongRunningLine?(evt: unknown): ParsedLineResult | null;

  // --- Error handling ---

  /**
   * Handle spawn errors (ENOENT, EACCES, etc.).
   * Return a user-facing error message, or null to use default handling.
   */
  handleSpawnError?(err: unknown, binary: string): string | null;

  /**
   * Handle process exit with non-zero code.
   * Return a user-facing error message, or null to use default handling.
   */
  handleExitError?(exitCode: number, stderr: string, stdout: string): string | null;
}
