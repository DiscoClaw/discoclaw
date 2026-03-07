export const RUNTIME_FAILURE_PREFIX = 'RUNTIME_FAILURE';
export const RUNTIME_FAILURE_ENVELOPE = 'runtime_failure';
export const RUNTIME_FAILURE_VERSION = 'v1' as const;
export const GLOBAL_SUPERVISOR_BAIL_PREFIX = 'GLOBAL_SUPERVISOR_BAIL';

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

export type RuntimeFailureCode =
  | PipelineFailureCode
  | 'RUNTIME_TIMEOUT'
  | 'DISCORD_MISSING_PERMISSIONS'
  | 'CLAUDE_CLI_NOT_FOUND'
  | 'GEMINI_CLI_NOT_FOUND'
  | 'GEMINI_AUTH_MISSING'
  | 'CLAUDE_AUTH_MISSING'
  | 'STREAM_STALL'
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
  source: 'runtime' | 'pipeline_tool' | 'global_supervisor';
  code: RuntimeFailureCode;
  message: string;
  rawMessage: string;
  userMessage: string;
  retryable: boolean | null;
  metadata: RuntimeFailureMetadata;
};

export type RuntimeFailureEvent = {
  type: 'runtime_failure';
  failure: RuntimeFailure;
};

export type RuntimeFailureInputEvent =
  | RuntimeFailureEvent
  | {
      type: 'error';
      message: string;
      failure?: RuntimeFailure;
    };

type LegacyPipelineFailurePayload = {
  ok: false;
  operation: string;
  failure_code_version?: string | null;
  failure_code?: PipelineFailureCode | null;
  message: string;
  [key: string]: unknown;
};

type LegacyGlobalSupervisorBailPayload = {
  source: 'global_supervisor';
  reason: GlobalSupervisorBailReason;
  cycle: number;
  retriesUsed: number;
  escalationLevel: number;
  failureKind: GlobalSupervisorFailureKind;
  retryable: boolean;
  signature: string;
  lastError: string | null;
  limits: GlobalSupervisorLimits;
};

type RuntimeFailureInit = Omit<RuntimeFailure, 'envelope' | 'envelopeVersion' | 'metadata'> & {
  metadata?: RuntimeFailureMetadata;
};

type PipelineToolRuntimeFailureInit = {
  operation: string;
  code: PipelineFailureCode | 'UNKNOWN';
  message: string;
  rawMessage?: string;
  userMessage?: string;
  retryable?: boolean | null;
  failureCodeVersion?: string | null;
  failureCode?: PipelineFailureCode | null;
  details?: Record<string, unknown>;
};

type GlobalSupervisorRuntimeFailureInit = {
  reason: GlobalSupervisorBailReason;
  cycle: number;
  retriesUsed: number;
  escalationLevel: number;
  failureKind: GlobalSupervisorFailureKind;
  retryable: boolean;
  signature: string;
  lastError: string | null;
  limits: GlobalSupervisorLimits;
  rawMessage?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseJsonRecord(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeFiniteNumber(value: unknown, fallback = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return value;
}

function sanitizeRawMessage(raw: string): string {
  return raw.trim();
}

function defaultUnknownMessage(raw: string): string {
  return raw ? `Runtime error: ${raw}` : 'An unexpected runtime error occurred with no additional detail.';
}

function normalizeMetadata(metadata: RuntimeFailureMetadata | undefined): RuntimeFailureMetadata {
  const out: RuntimeFailureMetadata = {};
  if (!metadata) return out;

  if (typeof metadata.operation === 'string' && metadata.operation.trim() !== '') {
    out.operation = metadata.operation;
  }
  if (metadata.ok === false) {
    out.ok = false;
  }
  if (metadata.failureCodeVersion === null || typeof metadata.failureCodeVersion === 'string') {
    out.failureCodeVersion = metadata.failureCodeVersion;
  }
  if (metadata.failureCode === null || isPipelineFailureCode(metadata.failureCode)) {
    out.failureCode = metadata.failureCode;
  }
  if (isRecord(metadata.details)) {
    out.details = metadata.details;
  }
  if (isGlobalSupervisorBailReason(metadata.reason)) {
    out.reason = metadata.reason;
  }
  if (typeof metadata.cycle === 'number' && Number.isFinite(metadata.cycle)) {
    out.cycle = metadata.cycle;
  }
  if (typeof metadata.retriesUsed === 'number' && Number.isFinite(metadata.retriesUsed)) {
    out.retriesUsed = metadata.retriesUsed;
  }
  if (typeof metadata.escalationLevel === 'number' && Number.isFinite(metadata.escalationLevel)) {
    out.escalationLevel = metadata.escalationLevel;
  }
  if (isGlobalSupervisorFailureKind(metadata.failureKind)) {
    out.failureKind = metadata.failureKind;
  }
  if (typeof metadata.signature === 'string' && metadata.signature.trim() !== '') {
    out.signature = metadata.signature;
  }
  if (metadata.lastError === null || typeof metadata.lastError === 'string') {
    out.lastError = metadata.lastError;
  }
  if (isGlobalSupervisorLimits(metadata.limits)) {
    out.limits = {
      maxCycles: normalizeFiniteNumber(metadata.limits.maxCycles),
      maxRetries: normalizeFiniteNumber(metadata.limits.maxRetries),
      maxEscalationLevel: normalizeFiniteNumber(metadata.limits.maxEscalationLevel),
      maxTotalEvents: normalizeFiniteNumber(metadata.limits.maxTotalEvents),
      maxWallTimeMs: normalizeFiniteNumber(metadata.limits.maxWallTimeMs),
    };
  }

  return out;
}

function getLegacyFailureMetadata(value: Record<string, unknown>): RuntimeFailureMetadata {
  const metadata: RuntimeFailureMetadata = isRecord(value['metadata'])
    ? normalizeMetadata(value['metadata'] as RuntimeFailureMetadata)
    : {};

  if (metadata.operation === undefined && typeof value['operation'] === 'string') {
    metadata.operation = value['operation'];
  }
  if (metadata.ok === undefined && value['ok'] === false) {
    metadata.ok = false;
  }
  if (
    metadata.failureCodeVersion === undefined
    && (value['failureCodeVersion'] === null || typeof value['failureCodeVersion'] === 'string')
  ) {
    metadata.failureCodeVersion = value['failureCodeVersion'] as string | null;
  }
  if (
    metadata.failureCode === undefined
    && (value['failureCode'] === null || isPipelineFailureCode(value['failureCode']))
  ) {
    metadata.failureCode = value['failureCode'] as PipelineFailureCode | null;
  }
  if (metadata.details === undefined && isRecord(value['details'])) {
    metadata.details = value['details'] as Record<string, unknown>;
  }

  if (metadata.reason === undefined && isGlobalSupervisorBailReason(value['reason'])) {
    metadata.reason = value['reason'];
  }
  if (metadata.cycle === undefined && typeof value['cycle'] === 'number') {
    metadata.cycle = value['cycle'];
  }
  if (metadata.retriesUsed === undefined && typeof value['retriesUsed'] === 'number') {
    metadata.retriesUsed = value['retriesUsed'];
  }
  if (metadata.escalationLevel === undefined && typeof value['escalationLevel'] === 'number') {
    metadata.escalationLevel = value['escalationLevel'];
  }
  if (metadata.failureKind === undefined && isGlobalSupervisorFailureKind(value['failureKind'])) {
    metadata.failureKind = value['failureKind'];
  }
  if (metadata.signature === undefined && typeof value['signature'] === 'string') {
    metadata.signature = value['signature'];
  }
  if (metadata.lastError === undefined && (value['lastError'] === null || typeof value['lastError'] === 'string')) {
    metadata.lastError = value['lastError'] as string | null;
  }
  if (metadata.limits === undefined && isGlobalSupervisorLimits(value['limits'])) {
    metadata.limits = {
      maxCycles: normalizeFiniteNumber(value['limits']['maxCycles']),
      maxRetries: normalizeFiniteNumber(value['limits']['maxRetries']),
      maxEscalationLevel: normalizeFiniteNumber(value['limits']['maxEscalationLevel']),
      maxTotalEvents: normalizeFiniteNumber(value['limits']['maxTotalEvents']),
      maxWallTimeMs: normalizeFiniteNumber(value['limits']['maxWallTimeMs']),
    };
  }

  return metadata;
}

export function createRuntimeFailure(partial: RuntimeFailureInit): RuntimeFailure {
  return {
    envelope: RUNTIME_FAILURE_ENVELOPE,
    envelopeVersion: RUNTIME_FAILURE_VERSION,
    source: partial.source,
    code: partial.code,
    message: partial.message,
    rawMessage: partial.rawMessage,
    userMessage: partial.userMessage,
    retryable: partial.retryable,
    metadata: normalizeMetadata(partial.metadata),
  };
}

export function createPipelineToolRuntimeFailure(
  partial: PipelineToolRuntimeFailureInit,
): RuntimeFailure {
  const message = String(partial.message ?? '').trim() || 'Pipeline tool failed.';
  const rawMessage = partial.rawMessage ?? message;
  return createRuntimeFailure({
    source: 'pipeline_tool',
    code: partial.code,
    message,
    rawMessage,
    userMessage: partial.userMessage ?? defaultUnknownMessage(message),
    retryable: partial.retryable ?? null,
    metadata: {
      operation: partial.operation,
      ok: false,
      failureCodeVersion: partial.failureCodeVersion ?? null,
      failureCode: partial.failureCode ?? (partial.code === 'UNKNOWN' ? null : partial.code),
      details: partial.details,
    },
  });
}

function buildGlobalSupervisorUserMessage(payload: {
  reason: GlobalSupervisorBailReason;
  failureKind: GlobalSupervisorFailureKind;
}): string {
  switch (payload.reason) {
    case 'deterministic_retry_blocked':
      return 'The global runtime supervisor stopped after the same failure repeated. Try a different strategy before retrying.';
    case 'max_cycles_exceeded':
      return 'The global runtime supervisor stopped after reaching its maximum recovery cycles.';
    case 'max_retries_exceeded':
      return 'The global runtime supervisor exhausted its retry budget before the runtime recovered.';
    case 'max_wall_time_exceeded':
      return 'The global runtime supervisor stopped after exceeding its wall-time limit.';
    case 'max_events_exceeded':
      return 'The global runtime supervisor stopped after the runtime emitted too many events.';
    case 'non_retryable_failure':
      if (payload.failureKind === 'aborted') {
        return 'The runtime was aborted before it could finish.';
      }
      return 'The global runtime supervisor stopped because the failure was not retryable.';
  }
}

export function createGlobalSupervisorRuntimeFailure(
  partial: GlobalSupervisorRuntimeFailureInit,
): RuntimeFailure {
  const message = partial.lastError ?? `Global supervisor bailout: ${partial.reason}`;
  return createRuntimeFailure({
    source: 'global_supervisor',
    code: 'GLOBAL_SUPERVISOR_BAIL',
    message,
    rawMessage: partial.rawMessage ?? message,
    userMessage: buildGlobalSupervisorUserMessage(partial),
    retryable: partial.retryable,
    metadata: {
      reason: partial.reason,
      cycle: partial.cycle,
      retriesUsed: partial.retriesUsed,
      escalationLevel: partial.escalationLevel,
      failureKind: partial.failureKind,
      signature: partial.signature,
      lastError: partial.lastError,
      limits: partial.limits,
    },
  });
}

function classifyPipelineFailure(
  payload: LegacyPipelineFailurePayload,
  rawMessage: string,
): RuntimeFailure {
  const code = payload.failure_code ?? null;
  const message = String(payload.message ?? '').trim() || 'Pipeline tool failed.';
  const {
    ok: _ok,
    operation: _operation,
    failure_code_version: _failureCodeVersion,
    failure_code: _failureCode,
    message: _message,
    ...details
  } = payload;

  let userMessage = defaultUnknownMessage(message);
  let retryable: boolean | null = null;

  switch (code) {
    case 'E_TOOL_UNAVAILABLE':
      userMessage = 'The requested pipeline tool is unavailable in this runtime configuration.';
      retryable = false;
      break;
    case 'E_POLICY_BLOCKED':
      userMessage = 'The requested pipeline action was blocked by runtime policy.';
      retryable = false;
      break;
    case 'E_RETRY_EXHAUSTED':
      userMessage = 'The pipeline exhausted its retry budget before finishing.';
      retryable = true;
      break;
    case 'E_IDEMPOTENCY_CONFLICT':
      userMessage = 'A matching pipeline run already exists. Check the existing run instead of starting a duplicate.';
      retryable = true;
      break;
    case 'E_RUN_NOT_FOUND':
      userMessage = 'The requested pipeline run was not found.';
      retryable = false;
      break;
    default:
      break;
  }

  return createPipelineToolRuntimeFailure({
    operation: payload.operation,
    code: code ?? 'UNKNOWN',
    message,
    rawMessage,
    userMessage,
    retryable,
    failureCodeVersion: payload.failure_code_version ?? null,
    failureCode: code,
    details,
  });
}

function isPipelineFailureCode(value: unknown): value is PipelineFailureCode {
  return value === 'E_TOOL_UNAVAILABLE'
    || value === 'E_POLICY_BLOCKED'
    || value === 'E_RETRY_EXHAUSTED'
    || value === 'E_IDEMPOTENCY_CONFLICT'
    || value === 'E_RUN_NOT_FOUND';
}

function isLegacyPipelineFailurePayload(value: unknown): value is LegacyPipelineFailurePayload {
  if (!isRecord(value)) return false;
  if (value['ok'] !== false) return false;
  if (typeof value['operation'] !== 'string' || typeof value['message'] !== 'string') return false;
  const code = value['failure_code'];
  return code === undefined || code === null || isPipelineFailureCode(code);
}

function isGlobalSupervisorFailureKind(value: unknown): value is GlobalSupervisorFailureKind {
  return value === 'transient_error'
    || value === 'hard_error'
    || value === 'runtime_error'
    || value === 'aborted'
    || value === 'missing_done'
    || value === 'exception'
    || value === 'event_limit';
}

function isGlobalSupervisorBailReason(value: unknown): value is GlobalSupervisorBailReason {
  return value === 'non_retryable_failure'
    || value === 'deterministic_retry_blocked'
    || value === 'max_cycles_exceeded'
    || value === 'max_retries_exceeded'
    || value === 'max_wall_time_exceeded'
    || value === 'max_events_exceeded';
}

function isGlobalSupervisorLimits(value: unknown): value is GlobalSupervisorLimits {
  if (!isRecord(value)) return false;
  return typeof value['maxCycles'] === 'number'
    && typeof value['maxRetries'] === 'number'
    && typeof value['maxEscalationLevel'] === 'number'
    && typeof value['maxTotalEvents'] === 'number'
    && typeof value['maxWallTimeMs'] === 'number';
}

function isLegacyGlobalSupervisorBailPayload(value: unknown): value is LegacyGlobalSupervisorBailPayload {
  if (!isRecord(value)) return false;
  return value['source'] === 'global_supervisor'
    && isGlobalSupervisorBailReason(value['reason'])
    && typeof value['cycle'] === 'number'
    && typeof value['retriesUsed'] === 'number'
    && typeof value['escalationLevel'] === 'number'
    && isGlobalSupervisorFailureKind(value['failureKind'])
    && typeof value['retryable'] === 'boolean'
    && typeof value['signature'] === 'string'
    && (value['lastError'] === null || typeof value['lastError'] === 'string')
    && isGlobalSupervisorLimits(value['limits']);
}

function classifyGlobalSupervisorFailure(
  payload: LegacyGlobalSupervisorBailPayload,
  rawMessage: string,
): RuntimeFailure {
  return createGlobalSupervisorRuntimeFailure({
    reason: payload.reason,
    cycle: payload.cycle,
    retriesUsed: payload.retriesUsed,
    escalationLevel: payload.escalationLevel,
    failureKind: payload.failureKind,
    retryable: payload.retryable,
    signature: payload.signature,
    lastError: payload.lastError,
    limits: payload.limits,
    rawMessage,
  });
}

function classifyRawRuntimeFailure(rawMessage: string): RuntimeFailure {
  const message = sanitizeRawMessage(rawMessage);
  const lc = message.toLowerCase();
  const mentionsClaude = lc.includes('claude');
  const mentionsGemini = lc.includes('gemini');

  if (lc.includes('timed out')) {
    return createRuntimeFailure({
      source: 'runtime',
      code: 'RUNTIME_TIMEOUT',
      message,
      rawMessage,
      userMessage: 'The runtime timed out before finishing. Try a smaller request or increase RUNTIME_TIMEOUT_MS.',
      retryable: true,
    });
  }

  if (lc.includes('missing permissions') || lc.includes('missing access')) {
    return createRuntimeFailure({
      source: 'runtime',
      code: 'DISCORD_MISSING_PERMISSIONS',
      message,
      rawMessage,
      userMessage:
        'Discord denied this action due to missing permissions/access. Update the bot role permissions in Server Settings -> Roles, then retry.',
      retryable: false,
    });
  }

  if (mentionsClaude && (lc.includes('not found') || lc.includes('enoent') || lc.includes('spawn'))) {
    return createRuntimeFailure({
      source: 'runtime',
      code: 'CLAUDE_CLI_NOT_FOUND',
      message,
      rawMessage,
      userMessage: 'Claude CLI was not found. Install it and set CLAUDE_BIN (or fix PATH), then restart.',
      retryable: false,
    });
  }

  if (mentionsGemini && (lc.includes('not found') || lc.includes('enoent') || lc.includes('spawn'))) {
    return createRuntimeFailure({
      source: 'runtime',
      code: 'GEMINI_CLI_NOT_FOUND',
      message,
      rawMessage,
      userMessage: 'Gemini CLI was not found. Install it and set GEMINI_BIN (or fix PATH), then restart.',
      retryable: false,
    });
  }

  if (mentionsGemini && (lc.includes('unauthorized') || lc.includes('authentication') || lc.includes('not logged in'))) {
    return createRuntimeFailure({
      source: 'runtime',
      code: 'GEMINI_AUTH_MISSING',
      message,
      rawMessage,
      userMessage: 'Gemini CLI authentication is missing or expired. Re-authenticate Gemini CLI and retry.',
      retryable: false,
    });
  }

  if (lc.includes('unauthorized') || lc.includes('authentication') || lc.includes('not logged in')) {
    return createRuntimeFailure({
      source: 'runtime',
      code: 'CLAUDE_AUTH_MISSING',
      message,
      rawMessage,
      userMessage: 'Claude CLI authentication is missing or expired. Re-authenticate Claude CLI and retry.',
      retryable: false,
    });
  }

  if (lc.includes('stream stall')) {
    const msMatch = message.match(/no output for (\d+)ms/i);
    const userMessage = msMatch
      ? (() => {
          const ms = parseInt(msMatch[1]!, 10);
          const humanDuration = ms >= 60000
            ? `${Math.round(ms / 60000)} min`
            : `${Math.round(ms / 1000)} sec`;
          return (
            `The runtime stream stalled (no output for ${ms}ms / ${humanDuration}). ` +
            'This may indicate a long-running tool or API hang. ' +
            'Ask the bot to increase DISCOCLAW_STREAM_STALL_TIMEOUT_MS to allow more time.'
          );
        })()
      : 'The runtime stream stalled (no output received). This may indicate a network issue or API hang. Try again or increase DISCOCLAW_STREAM_STALL_TIMEOUT_MS.';

    return createRuntimeFailure({
      source: 'runtime',
      code: 'STREAM_STALL',
      message,
      rawMessage,
      userMessage,
      retryable: true,
    });
  }

  if (lc.includes('configuration error: missing required channel context')) {
    return createRuntimeFailure({
      source: 'runtime',
      code: 'CHANNEL_CONTEXT_MISSING',
      message,
      rawMessage,
      userMessage:
        'This channel is missing required context. Create/index the channel context file under content/discord/channels or disable DISCORD_REQUIRE_CHANNEL_CONTEXT.',
      retryable: false,
    });
  }

  if (lc.includes('prompt is too long') || lc.includes('context length exceeded') || lc.includes('context_length_exceeded')) {
    return createRuntimeFailure({
      source: 'runtime',
      code: 'CONTEXT_LIMIT_EXCEEDED',
      message,
      rawMessage,
      userMessage: 'The conversation context exceeded the model\'s limit. Try a shorter message or start a new conversation.',
      retryable: false,
    });
  }

  if (lc.includes('tool_use.name') && lc.includes('at most 200 characters')) {
    return createRuntimeFailure({
      source: 'runtime',
      code: 'MCP_TOOL_NAME_TOO_LONG',
      message,
      rawMessage,
      userMessage:
        'A tool name exceeded the Anthropic API 200-character limit. MCP tool names are composed as `mcp__<server_name>__<tool_name>` - shorten the server name in `.mcp.json` and restart.',
      retryable: false,
    });
  }

  return createRuntimeFailure({
    source: 'runtime',
    code: 'UNKNOWN',
    message,
    rawMessage,
    userMessage: defaultUnknownMessage(message),
    retryable: null,
  });
}

function isRuntimeFailure(value: unknown): value is RuntimeFailure {
  if (!isRecord(value)) return false;
  return value['envelope'] === RUNTIME_FAILURE_ENVELOPE
    && value['envelopeVersion'] === RUNTIME_FAILURE_VERSION
    && (value['source'] === 'runtime' || value['source'] === 'pipeline_tool' || value['source'] === 'global_supervisor')
    && typeof value['message'] === 'string'
    && typeof value['rawMessage'] === 'string'
    && typeof value['userMessage'] === 'string';
}

function normalizeExistingRuntimeFailure(value: RuntimeFailure): RuntimeFailure {
  const source = value.source;
  const metadata = getLegacyFailureMetadata(value as unknown as Record<string, unknown>);
  return createRuntimeFailure({
    source,
    code: value.code,
    message: value.message,
    rawMessage: value.rawMessage,
    userMessage: value.userMessage,
    retryable: value.retryable,
    metadata,
  });
}

function normalizeObjectFailure(value: Record<string, unknown>): RuntimeFailure | null {
  if (isRuntimeFailure(value)) {
    return normalizeExistingRuntimeFailure(value);
  }

  if (isLegacyPipelineFailurePayload(value)) {
    return classifyPipelineFailure(value, JSON.stringify(value));
  }

  if (isLegacyGlobalSupervisorBailPayload(value)) {
    return classifyGlobalSupervisorFailure(value, `${GLOBAL_SUPERVISOR_BAIL_PREFIX} ${JSON.stringify(value)}`);
  }

  if (typeof value['message'] === 'string') {
    return classifyRawRuntimeFailure(value['message']);
  }

  return null;
}

export function normalizeRuntimeFailure(input: unknown): RuntimeFailure {
  if (typeof input === 'string') {
    const raw = input;
    const trimmed = sanitizeRawMessage(raw);

    if (trimmed.startsWith(`${RUNTIME_FAILURE_PREFIX} `)) {
      const payload = parseJsonRecord(trimmed.slice(RUNTIME_FAILURE_PREFIX.length + 1));
      const parsed = payload ? normalizeObjectFailure(payload) : null;
      if (parsed) return parsed;
    }

    if (trimmed.startsWith(`${GLOBAL_SUPERVISOR_BAIL_PREFIX} `)) {
      const payload = parseJsonRecord(trimmed.slice(GLOBAL_SUPERVISOR_BAIL_PREFIX.length + 1));
      if (payload && isLegacyGlobalSupervisorBailPayload(payload)) {
        return classifyGlobalSupervisorFailure(payload, trimmed);
      }
    }

    const payload = parseJsonRecord(trimmed);
    if (payload) {
      const parsed = normalizeObjectFailure(payload);
      if (parsed) return parsed;
    }

    return classifyRawRuntimeFailure(trimmed);
  }

  if (input instanceof Error) {
    return normalizeRuntimeFailure(input.message);
  }

  if (isRecord(input)) {
    const parsed = normalizeObjectFailure(input);
    if (parsed) return parsed;
  }

  return classifyRawRuntimeFailure(String(input ?? ''));
}

export function normalizeRuntimeFailureEvent(event: RuntimeFailureInputEvent): RuntimeFailure {
  if (event.type === 'runtime_failure') {
    return normalizeRuntimeFailure(event.failure);
  }
  if (event.failure) {
    return normalizeRuntimeFailure(event.failure);
  }
  return normalizeRuntimeFailure(event.message);
}

export function serializeRuntimeFailure(input: RuntimeFailure): string {
  return `${RUNTIME_FAILURE_PREFIX} ${JSON.stringify(normalizeRuntimeFailure(input))}`;
}

export function mapRuntimeFailureToUserMessage(input: RuntimeFailure | RuntimeFailureInputEvent | string | Error): string {
  if (typeof input === 'string' || input instanceof Error) {
    return normalizeRuntimeFailure(input).userMessage;
  }

  if (isRecord(input) && 'type' in input && (input['type'] === 'error' || input['type'] === 'runtime_failure')) {
    return normalizeRuntimeFailureEvent(input as RuntimeFailureInputEvent).userMessage;
  }

  return normalizeRuntimeFailure(input).userMessage;
}
