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
  | { type: 'error'; message: string }
  | { type: 'done' };

export type RuntimeCapability =
  | 'streaming_text'
  | 'sessions'
  | 'workspace_instructions'
  | 'tools_exec'
  | 'tools_fs'
  | 'tools_web'
  | 'mcp'
  | 'multi_turn';

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
  maxTokens?: number;
  images?: ImageData[];
  reasoningEffort?: string;
  signal?: AbortSignal;
  onTelemetry?: (evt: RuntimeTelemetryEvent) => void;
  supervisor?: RuntimeSupervisorPolicy;
};

export interface RuntimeAdapter {
  id: RuntimeId;
  capabilities: ReadonlySet<RuntimeCapability>;
  /** The model used when params.model is empty (adapter-default sentinel). */
  defaultModel?: string;
  invoke(params: RuntimeInvokeParams): AsyncIterable<EngineEvent>;
}
