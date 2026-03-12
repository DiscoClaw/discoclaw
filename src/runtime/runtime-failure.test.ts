import { describe, expect, it } from 'vitest';

import {
  classifyRuntimeFailureForGlobalSupervisor,
  createRuntimeErrorEvent,
  GLOBAL_SUPERVISOR_BAIL_PREFIX,
  RUNTIME_FAILURE_PREFIX,
  mapRuntimeFailureToUserMessage,
  normalizeRuntimeFailure,
  normalizeRuntimeFailureEvent,
  projectPipelineFailure,
  serializeRuntimeFailure,
  type RuntimeFailure,
} from './runtime-failure.js';

describe('normalizeRuntimeFailure', () => {
  it('normalizes legacy pipeline failure payloads', () => {
    const failure = normalizeRuntimeFailure(JSON.stringify({
      ok: false,
      operation: 'pipeline.start',
      failure_code_version: 'v1',
      failure_code: 'E_IDEMPOTENCY_CONFLICT',
      message: 'run already exists',
      run_id: 'run-123',
    }));

    expect(failure.source).toBe('pipeline_tool');
    expect(failure.code).toBe('E_IDEMPOTENCY_CONFLICT');
    expect(failure.message).toBe('run already exists');
    expect(failure.userMessage).toContain('matching pipeline run already exists');
    expect(failure.metadata.operation).toBe('pipeline.start');
    expect(failure.metadata.failureCodeVersion).toBe('v1');
    expect(failure.metadata.failureCode).toBe('E_IDEMPOTENCY_CONFLICT');
    expect(failure.metadata.details).toEqual({ run_id: 'run-123' });
  });

  it('normalizes legacy global supervisor bail messages', () => {
    const failure = normalizeRuntimeFailure(
      `${GLOBAL_SUPERVISOR_BAIL_PREFIX} ${JSON.stringify({
        source: 'global_supervisor',
        reason: 'deterministic_retry_blocked',
        cycle: 2,
        retriesUsed: 1,
        escalationLevel: 1,
        failureKind: 'transient_error',
        retryable: true,
        signature: 'transient_error:rate limit',
        lastError: 'OpenAI API error: 429 rate limit',
        limits: {
          maxCycles: 5,
          maxRetries: 4,
          maxEscalationLevel: 2,
          maxTotalEvents: 5000,
          maxWallTimeMs: 0,
        },
      })}`,
    );

    expect(failure.source).toBe('global_supervisor');
    expect(failure.code).toBe('GLOBAL_SUPERVISOR_BAIL');
    expect(failure.userMessage).toContain('same failure repeated');
    expect(failure.metadata.reason).toBe('deterministic_retry_blocked');
    expect(failure.metadata.failureKind).toBe('transient_error');
    expect(failure.retryable).toBe(true);
    expect(failure.metadata.lastError).toBe('OpenAI API error: 429 rate limit');
    expect(failure.metadata.cycle).toBe(2);
    expect(failure.metadata.retriesUsed).toBe(1);
    expect(failure.metadata.limits?.maxCycles).toBe(5);
  });

  it('classifies raw runtime strings with preserved user guidance', () => {
    const failure = normalizeRuntimeFailure('stream stall: no output for 120000ms');

    expect(failure.source).toBe('runtime');
    expect(failure.code).toBe('STREAM_STALL');
    expect(failure.userMessage).toContain('120000ms');
    expect(failure.userMessage).toContain('2 min');
    expect(failure.retryable).toBe(true);
  });

  it('classifies progress stall runtime strings with preserved user guidance', () => {
    const failure = normalizeRuntimeFailure('progress stall: no runtime progress for 45000ms');

    expect(failure.source).toBe('runtime');
    expect(failure.code).toBe('PROGRESS_STALL');
    expect(failure.userMessage).toContain('45000ms');
    expect(failure.userMessage).toContain('45 sec');
    expect(failure.retryable).toBe(true);
  });

  it('distinguishes gemini auth from generic auth', () => {
    const geminiFailure = normalizeRuntimeFailure('gemini: authentication failed');
    const genericFailure = normalizeRuntimeFailure('unauthorized');

    expect(geminiFailure.code).toBe('GEMINI_AUTH_MISSING');
    expect(geminiFailure.userMessage).toContain('Gemini CLI authentication');
    expect(genericFailure.code).toBe('CLAUDE_AUTH_MISSING');
    expect(genericFailure.userMessage).toContain('Claude CLI authentication');
  });

  it.each([
    ['worker timed out after 30000ms', 'RUNTIME_TIMEOUT', true],
    ['Discord missing permissions for channel send', 'DISCORD_MISSING_PERMISSIONS', false],
    ['spawn claude ENOENT', 'CLAUDE_CLI_NOT_FOUND', false],
    ['spawn gemini ENOENT', 'GEMINI_CLI_NOT_FOUND', false],
    [
      'ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5-mini\' model is not supported when using Codex with a ChatGPT account."}}',
      'CODEX_MODEL_UNSUPPORTED',
      false,
    ],
    ['codex app-server websocket closed', 'CODEX_APP_SERVER_DISCONNECTED', false],
    ['progress stall: no runtime progress for 45000ms', 'PROGRESS_STALL', true],
    ['configuration error: missing required channel context for #ops', 'CHANNEL_CONTEXT_MISSING', false],
    ['context_length_exceeded', 'CONTEXT_LIMIT_EXCEEDED', false],
    ['tool_use.name must be at most 200 characters', 'MCP_TOOL_NAME_TOO_LONG', false],
  ] as const)('classifies raw runtime branch %s', (input, code, retryable) => {
    const failure = normalizeRuntimeFailure(input);

    expect(failure.source).toBe('runtime');
    expect(failure.code).toBe(code);
    expect(failure.retryable).toBe(retryable);
  });

  it('treats unsupported Codex models as hard errors for the global supervisor', () => {
    const classification = classifyRuntimeFailureForGlobalSupervisor(
      'ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5-mini\' model is not supported when using Codex with a ChatGPT account."}}',
      { treatAbortedAsRetryable: false, signalAborted: false },
    );

    expect(classification).toEqual({
      kind: 'hard_error',
      retryable: false,
    });
  });

  it('treats native Codex app-server disconnects as hard errors for the global supervisor', () => {
    const classification = classifyRuntimeFailureForGlobalSupervisor(
      'codex app-server websocket closed',
      { treatAbortedAsRetryable: true, signalAborted: false },
    );

    expect(classification).toEqual({
      kind: 'hard_error',
      retryable: false,
    });
  });
  it('falls back to unknown runtime failures without dropping the message', () => {
    const failure = normalizeRuntimeFailure('some new runtime error');

    expect(failure.source).toBe('runtime');
    expect(failure.code).toBe('UNKNOWN');
    expect(failure.userMessage).toBe('Runtime error: some new runtime error');
    expect(failure.retryable).toBeNull();
  });

  it('preserves the pipeline envelope for unknown pipeline failure codes', () => {
    const failure = normalizeRuntimeFailure(JSON.stringify({
      ok: false,
      operation: 'pipeline.start',
      failure_code_version: 'v1',
      failure_code: 'E_NOT_REAL',
      message: 'some future pipeline failure',
    }));

    expect(failure.source).toBe('pipeline_tool');
    expect(failure.code).toBe('UNKNOWN');
    expect(failure.metadata.operation).toBe('pipeline.start');
    expect(failure.metadata.failureCodeVersion).toBe('v1');
    expect(failure.message).toBe('some future pipeline failure');
    expect(failure.userMessage).toBe('Runtime error: some future pipeline failure');
  });

  it('preserves legacy pipeline payloads when the failure code version is unknown', () => {
    const failure = normalizeRuntimeFailure(JSON.stringify({
      ok: false,
      operation: 'pipeline.resume',
      failure_code_version: 'v999',
      failure_code: 'E_RUN_NOT_FOUND',
      message: 'run not found',
    }));

    expect(failure.source).toBe('pipeline_tool');
    expect(failure.code).toBe('E_RUN_NOT_FOUND');
    expect(failure.metadata.failureCodeVersion).toBe('v999');
    expect(failure.metadata.operation).toBe('pipeline.resume');
  });

  it('round-trips serialized runtime failures', () => {
    const original = normalizeRuntimeFailure('spawn claude ENOENT');
    const encoded = serializeRuntimeFailure(original);
    const decoded = normalizeRuntimeFailure(encoded);

    expect(encoded.startsWith(`${RUNTIME_FAILURE_PREFIX} `)).toBe(true);
    expect(decoded).toEqual(original);
  });

  it('normalizes runtime_failure events', () => {
    const failure = normalizeRuntimeFailure('Prompt is too long');
    const eventFailure = normalizeRuntimeFailureEvent({
      type: 'runtime_failure',
      failure,
    });

    expect(eventFailure).toEqual(failure);
  });

  it('normalizes legacy error events', () => {
    const failure = normalizeRuntimeFailureEvent({
      type: 'error',
      message: 'spawn gemini ENOENT',
    });

    expect(failure.code).toBe('GEMINI_CLI_NOT_FOUND');
    expect(failure.userMessage).toContain('Gemini CLI was not found');
  });

  it('creates emitter-side error events with attached runtime failure envelopes', () => {
    const event = createRuntimeErrorEvent('stream stall: no output for 120000ms');

    expect(event.type).toBe('error');
    expect(event.message).toBe('stream stall: no output for 120000ms');
    expect(event.failure?.code).toBe('STREAM_STALL');
    expect(event.failure?.userMessage).toContain('2 min');
  });

  it('creates progress-stall error events with attached runtime failure envelopes', () => {
    const event = createRuntimeErrorEvent('progress stall: no runtime progress for 45000ms');

    expect(event.type).toBe('error');
    expect(event.message).toBe('progress stall: no runtime progress for 45000ms');
    expect(event.failure?.code).toBe('PROGRESS_STALL');
    expect(event.failure?.userMessage).toContain('45 sec');
  });

  it('prefers event.failure over event.message when both are present', () => {
    const failure = normalizeRuntimeFailure('spawn gemini ENOENT');
    const normalized = normalizeRuntimeFailureEvent({
      type: 'error',
      message: 'unauthorized',
      failure,
    });

    expect(normalized.code).toBe('GEMINI_CLI_NOT_FOUND');
    expect(normalized.message).toBe('spawn gemini ENOENT');
  });

  it('projects structured pipeline failures without reclassifying from strings', () => {
    const projected = projectPipelineFailure({
      envelope: 'runtime_failure',
      envelopeVersion: 'v1',
      source: 'pipeline_tool',
      code: 'E_RETRY_EXHAUSTED',
      message: 'wrapped step failed',
      rawMessage: 'executor failed in a way that does not mention retries',
      userMessage: 'The pipeline exhausted its retry budget before finishing.',
      retryable: true,
      metadata: {
        operation: 'step.run',
        ok: false,
        failureCodeVersion: 'v1',
        failureCode: 'E_RETRY_EXHAUSTED',
      },
    });

    expect(projected.code).toBe('E_RETRY_EXHAUSTED');
    expect(projected.failureCode).toBe('E_RETRY_EXHAUSTED');
    expect(projected.failureCodeVersion).toBe('v1');
    expect(projected.retryable).toBe(true);
    expect(projected.userMessage).toBe('The pipeline exhausted its retry budget before finishing.');
  });

  it('projects raw pipeline wrapper failures through centralized heuristics', () => {
    const projected = projectPipelineFailure('Tool not allowlisted for this invocation: write_file');

    expect(projected.code).toBe('E_POLICY_BLOCKED');
    expect(projected.failureCode).toBe('E_POLICY_BLOCKED');
    expect(projected.userMessage).toBe('The requested pipeline action was blocked by runtime policy.');
    expect(projected.retryable).toBe(false);
  });

  it('projects raw tool validation failures without collapsing them into unavailable', () => {
    const projected = projectPipelineFailure('file_path is required');

    expect(projected.code).toBe('E_POLICY_BLOCKED');
    expect(projected.failureCode).toBe('E_POLICY_BLOCKED');
    expect(projected.userMessage).toBe(
      'The pipeline step failed because its tool input, path, or content constraints were not satisfied.',
    );
    expect(projected.retryable).toBe(false);
  });
});

describe('mapRuntimeFailureToUserMessage', () => {
  it('reuses the normalized envelope instead of re-pattern-matching at the call site', () => {
    const failure = normalizeRuntimeFailure(JSON.stringify({
      ok: false,
      operation: 'pipeline.resume',
      failure_code_version: 'v1',
      failure_code: 'E_RUN_NOT_FOUND',
      message: 'run not found',
    })) as RuntimeFailure;

    expect(mapRuntimeFailureToUserMessage(failure)).toBe('The requested pipeline run was not found.');
  });

  it('handles blank runtime errors', () => {
    expect(mapRuntimeFailureToUserMessage('')).toBe('An unexpected runtime error occurred with no additional detail.');
  });
});
