// Strategy interface for the universal CLI runtime adapter.
// Each CLI-based model provides a thin strategy object (~40-80 lines)
// that plugs into the shared infrastructure via createCliRuntime().
//
// Mostly types, plus small forge phase-routing helpers used by adapters.

import type {
  EngineEvent,
  ForgePhaseGuardrails,
  ForgeTurnKind,
  ForgeTurnPhase,
  ForgeTurnRoute,
  ImageData,
  RuntimeCapability,
  RuntimeId,
  RuntimeInvokeParams,
} from './types.js';

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
  /** Temp file paths for images written by prepareImages(). Strategies use these in buildArgs. */
  tempImagePaths?: string[];
  /** Explicit signal that the strategy intentionally reset session context for this invocation. */
  sessionResetReason?: string;
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
// Forge phase routing — phase-first routing with bounded fallback guards
// ---------------------------------------------------------------------------
export type ForgeCliRouteDecision = {
  status: 'allow' | 're_research' | 'reject';
  requestedPhase: ForgeTurnPhase;
  nextPhase: ForgeTurnPhase;
  turnKind: ForgeTurnKind;
  route: ForgeTurnRoute;
  fallbackRoute: ForgeTurnRoute | null;
  reason?: string;
};

function defaultForgeFallbackRoute(route: ForgeTurnRoute): ForgeTurnRoute | null {
  return route === 'hybrid' ? 'cli' : null;
}

function buildForgeScopeViolationDecision(
  guardrails: ForgePhaseGuardrails,
  reason: string,
  attemptedRoute: ForgeTurnRoute,
  attemptedFallbackRoute: ForgeTurnRoute | null,
): ForgeCliRouteDecision {
  const reResearchPhase = guardrails.fallbackPolicy.onOutOfBounds === 're_research'
    ? guardrails.fallbackPolicy.reResearchPhase
    : null;

  if (reResearchPhase) {
    const nextRoute = resolveForgeTurnRoute(reResearchPhase);
    return {
      status: 're_research',
      requestedPhase: guardrails.phase,
      nextPhase: reResearchPhase,
      turnKind: resolveForgeTurnKind(reResearchPhase),
      route: nextRoute,
      fallbackRoute: defaultForgeFallbackRoute(nextRoute),
      reason: `${reason} Re-enter ${reResearchPhase} before continuing.`,
    };
  }

  return {
    status: 'reject',
    requestedPhase: guardrails.phase,
    nextPhase: guardrails.phase,
    turnKind: guardrails.turnKind,
    route: attemptedRoute,
    fallbackRoute: attemptedFallbackRoute,
    reason,
  };
}

export function resolveForgeTurnKind(phase: ForgeTurnPhase): ForgeTurnKind {
  return phase === 'draft_research' || phase === 'revision_research'
    ? 'research'
    : 'final';
}

export function resolveForgeTurnRoute(phase: ForgeTurnPhase): ForgeTurnRoute {
  if (phase === 'draft_research' || phase === 'revision_research') return 'native';
  if (phase === 'audit') return 'hybrid';
  return 'cli';
}

export function resolveForgeCliRoute(
  guardrails: ForgePhaseGuardrails,
  opts: {
    requestedRoute?: ForgeTurnRoute;
    fallbackRoute?: ForgeTurnRoute | null;
  } = {},
): ForgeCliRouteDecision {
  const expectedTurnKind = resolveForgeTurnKind(guardrails.phase);
  const phaseRoute = resolveForgeTurnRoute(guardrails.phase);
  const requestedRoute = opts.requestedRoute ?? phaseRoute;
  const fallbackRoute = opts.fallbackRoute === undefined
    ? defaultForgeFallbackRoute(requestedRoute)
    : opts.fallbackRoute;

  if (guardrails.turnKind !== expectedTurnKind) {
    return buildForgeScopeViolationDecision(
      guardrails,
      `Forge phase ${guardrails.phase} declared turn kind ${guardrails.turnKind}, expected ${expectedTurnKind}.`,
      requestedRoute,
      fallbackRoute,
    );
  }

  if (guardrails.turnKind === 'final' && !guardrails.phaseState.researchComplete) {
    return {
      status: 'reject',
      requestedPhase: guardrails.phase,
      nextPhase: guardrails.phase,
      turnKind: guardrails.turnKind,
      route: phaseRoute,
      fallbackRoute: defaultForgeFallbackRoute(phaseRoute),
      reason: 'Research/discovery must complete before dispatching a bounded final forge turn.',
    };
  }

  if (guardrails.turnKind === 'final' && guardrails.candidateBoundPolicy.scope !== 'allowlist') {
    return buildForgeScopeViolationDecision(
      guardrails,
      `Final forge phase ${guardrails.phase} requires allowlist-bounded candidate access.`,
      requestedRoute,
      fallbackRoute,
    );
  }

  if (
    guardrails.turnKind === 'final'
    && guardrails.candidateBoundPolicy.allowlistPaths.length === 0
  ) {
    return buildForgeScopeViolationDecision(
      guardrails,
      `Final forge phase ${guardrails.phase} is missing a grounded candidate allowlist.`,
      requestedRoute,
      fallbackRoute,
    );
  }

  if (requestedRoute !== phaseRoute && guardrails.fallbackPolicy.noWidening) {
    return buildForgeScopeViolationDecision(
      guardrails,
      `Route override ${requestedRoute} widens forge phase ${guardrails.phase} beyond its bounded phase contract.`,
      requestedRoute,
      fallbackRoute,
    );
  }

  const expectedFallbackRoute = defaultForgeFallbackRoute(requestedRoute);
  if (fallbackRoute !== expectedFallbackRoute && guardrails.fallbackPolicy.noWidening) {
    return buildForgeScopeViolationDecision(
      guardrails,
      expectedFallbackRoute
        ? `Forge phase ${guardrails.phase} requires ${requestedRoute} routing with ${expectedFallbackRoute} fallback.`
        : `Forge phase ${guardrails.phase} does not allow fallback routing from ${requestedRoute}.`,
      requestedRoute,
      fallbackRoute,
    );
  }

  return {
    status: 'allow',
    requestedPhase: guardrails.phase,
    nextPhase: guardrails.phase,
    turnKind: guardrails.turnKind,
    route: requestedRoute,
    fallbackRoute,
  };
}

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
   * Prepare images for file-based delivery (e.g. Codex `--image` flags).
   * Writes base64 image data to temp files and returns paths + cleanup function.
   */
  prepareImages?(images: ImageData[], log?: CliAdapterLogger): Promise<{ paths: string[]; cleanup: () => Promise<void> }>;

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

  /** Build subprocess env var overrides for this invocation. */
  buildEnv?(ctx: CliInvokeContext, opts: UniversalCliOpts): Record<string, string | undefined> | undefined;

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
