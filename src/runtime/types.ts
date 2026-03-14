export const RUNTIME_FAILURE_ENVELOPE = 'runtime_failure' as const;
export const RUNTIME_FAILURE_VERSION = 'v1' as const;

export type PipelineFailureCode =
  | 'E_TOOL_UNAVAILABLE'
  | 'E_POLICY_BLOCKED'
  | 'E_RETRY_EXHAUSTED'
  | 'E_IDEMPOTENCY_CONFLICT'
  | 'E_RUN_NOT_FOUND';

export type GlobalSupervisorFailureKind =
  | 'transient_error'
  | 'hard_error'
  | 'runtime_error'
  | 'aborted'
  | 'missing_done'
  | 'exception'
  | 'event_limit';

export type GlobalSupervisorBailReason =
  | 'non_retryable_failure'
  | 'deterministic_retry_blocked'
  | 'max_cycles_exceeded'
  | 'max_retries_exceeded'
  | 'max_wall_time_exceeded'
  | 'max_events_exceeded';

export type GlobalSupervisorLimits = {
  maxCycles: number;
  maxRetries: number;
  maxEscalationLevel: number;
  maxTotalEvents: number;
  maxWallTimeMs: number;
};

export type RuntimeFailureSource = 'runtime' | 'pipeline_tool' | 'global_supervisor';

export type RuntimeFailureCode =
  | PipelineFailureCode
  | 'RUNTIME_TIMEOUT'
  | 'DISCORD_MISSING_PERMISSIONS'
  | 'CLAUDE_CLI_NOT_FOUND'
  | 'GEMINI_CLI_NOT_FOUND'
  | 'GEMINI_AUTH_MISSING'
  | 'CLAUDE_AUTH_MISSING'
  | 'CODEX_MODEL_UNSUPPORTED'
  | 'CODEX_APP_SERVER_DISCONNECTED'
  | 'STREAM_STALL'
  | 'PROGRESS_STALL'
  | 'CHANNEL_CONTEXT_MISSING'
  | 'CONTEXT_LIMIT_EXCEEDED'
  | 'MCP_TOOL_NAME_TOO_LONG'
  | 'GLOBAL_SUPERVISOR_BAIL'
  | 'UNKNOWN';

export type RuntimeFailureMetadata = {
  operation?: string;
  ok?: false;
  failureCodeVersion?: string | null;
  failureCode?: PipelineFailureCode | null;
  details?: Record<string, unknown>;
  reason?: GlobalSupervisorBailReason;
  cycle?: number;
  retriesUsed?: number;
  escalationLevel?: number;
  failureKind?: GlobalSupervisorFailureKind;
  signature?: string;
  lastError?: string | null;
  limits?: GlobalSupervisorLimits;
};

export type RuntimeFailure = {
  envelope: typeof RUNTIME_FAILURE_ENVELOPE;
  envelopeVersion: typeof RUNTIME_FAILURE_VERSION;
  source: RuntimeFailureSource;
  code: RuntimeFailureCode;
  message: string;
  rawMessage: string;
  userMessage: string;
  retryable: boolean | null;
  metadata: RuntimeFailureMetadata;
};

export type RuntimeErrorEvent = {
  type: 'error';
  message: string;
  /** Optional normalized failure envelope; when present, consumers should prefer this over `message`. */
  failure?: RuntimeFailure;
};

export type RuntimeFailureEvent = {
  type: 'runtime_failure';
  failure: RuntimeFailure;
};

export type RuntimeFailureInputEvent = RuntimeErrorEvent | RuntimeFailureEvent;

export type ImageData = {
  base64: string;
  mediaType: string; // 'image/png', 'image/jpeg', 'image/webp', 'image/gif'
};

/** Max images per invocation to prevent runaway accumulation. */
export const MAX_IMAGES_PER_INVOCATION = 10;

export type EngineEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'text_final'; text: string }
  | { type: 'image_data'; image: ImageData }
  | { type: 'log_line'; stream: 'stdout' | 'stderr'; line: string }
  | { type: 'thinking_delta'; text: string }
  | {
      type: 'preview_debug';
      source: 'codex' | 'claude';
      phase: 'started' | 'completed';
      itemType: string;
      itemId?: string;
      status?: string;
      label?: string;
    }
  | { type: 'tool_start'; name: string; input?: unknown }
  | { type: 'tool_end'; name: string; output?: unknown; ok: boolean }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; totalTokens?: number; costUsd?: number }
  | RuntimeErrorEvent
  | RuntimeFailureEvent
  | { type: 'done' };

export type RuntimeCapability =
  | 'streaming_text'
  | 'sessions'
  | 'workspace_instructions'
  | 'tools_exec'
  | 'tools_fs'
  | 'tools_web'
  | 'mcp'
  | 'multi_turn'
  | 'mid_turn_steering';

export type RuntimeId = 'claude_code' | 'openai' | 'openrouter' | 'codex' | 'gemini' | 'other';

export type RuntimeSupervisorLimitsOverride = {
  maxCycles?: number;
  maxRetries?: number;
  maxEscalationLevel?: number;
  maxTotalEvents?: number;
  maxWallTimeMs?: number;
};

export type RuntimeTelemetryEvent =
  | {
      type: 'first_byte';
      stream: 'stdout' | 'stderr';
      atMs: number;
    };

export type RuntimeSupervisorPolicy = {
  /**
   * Optional per-invocation policy profile used by runtime wrappers.
   * `plan_phase` is intended for forge/plan worker invocations.
   */
  profile?: 'default' | 'plan_phase';
  /**
   * Optional per-invocation gate override.
   * When false, wrappers should pass through directly for this invocation.
   */
  enabled?: boolean;
  /**
   * Optional override for treating aborted errors as retryable.
   * Wrapper implementations should still bail immediately when caller signal
   * is already aborted.
   */
  treatAbortedAsRetryable?: boolean;
  /**
   * Maximum repeated failures with the same normalized signature before
   * deterministic retry blocking bails. Minimum effective value is 1.
   */
  maxSignatureRepeats?: number;
  /**
   * Optional per-invocation supervisor limit overrides.
   */
  limits?: RuntimeSupervisorLimitsOverride;
};

export type ForgeTurnPhase =
  | 'draft_research'
  | 'draft_artifact'
  | 'audit'
  | 'revision_research'
  | 'revision_artifact';

export type ForgeTurnKind = 'research' | 'final';

export type ForgeTurnRoute = 'native' | 'hybrid' | 'cli';

export type ForgeCandidateBoundPolicy = {
  /**
   * Final/bounded turns should use `allowlist`.
   * `unbounded` is reserved for deliberate research/discovery re-entry.
   */
  scope: 'allowlist' | 'unbounded';
  candidatePaths: readonly string[];
  allowlistPaths: readonly string[];
};

export type ForgeFallbackMode = 're_research' | 'reject';

export type ForgeFallbackPolicy = {
  /**
   * Applied when a fallback would leave the current bounded scope, including
   * route widening away from the phase-selected transport contract.
   */
  onOutOfBounds: ForgeFallbackMode;
  reResearchPhase: ForgeTurnPhase | null;
  /** Final/bounded phases should keep this true so salvage cannot widen scope. */
  noWidening: boolean;
};

export type ForgePhaseStateFlag = {
  /** Final/bounded turns must not dispatch until research is explicitly complete. */
  researchComplete: boolean;
};

export type ForgePhaseGuardrails = {
  phase: ForgeTurnPhase;
  turnKind: ForgeTurnKind;
  candidateBoundPolicy: ForgeCandidateBoundPolicy;
  fallbackPolicy: ForgeFallbackPolicy;
  phaseState: ForgePhaseStateFlag;
};

export type RuntimeInvokeParams = {
  prompt: string;
  systemPrompt?: string;
  model: string;
  cwd: string;
  sessionId?: string | null;
  sessionKey?: string | null;
  tools?: string[];
  addDirs?: string[];
  timeoutMs?: number;
  streamStallTimeoutMs?: number;
  progressStallTimeoutMs?: number;
  disableNativeAppServer?: boolean;
  maxTokens?: number;
  images?: ImageData[];
  reasoningEffort?: string;
  signal?: AbortSignal;
  rawEventTap?: (evt: EngineEvent) => void;
  onTelemetry?: (evt: RuntimeTelemetryEvent) => void;
  supervisor?: RuntimeSupervisorPolicy;
  /** Optional forge phase contract for bounded draft/audit/revision dispatch. */
  forgePhase?: ForgePhaseGuardrails;
};

export interface RuntimeAdapter {
  id: RuntimeId;
  capabilities: ReadonlySet<RuntimeCapability>;
  /** The model used when params.model is empty (adapter-default sentinel). */
  defaultModel?: string;
  invoke(params: RuntimeInvokeParams): AsyncIterable<EngineEvent>;
  steer?(sessionKey: string, message: string): Promise<boolean>;
  interrupt?(sessionKey: string): Promise<boolean>;
}
