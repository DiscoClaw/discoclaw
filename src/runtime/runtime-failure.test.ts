import { describe, expect, it } from 'vitest';

import {
  GLOBAL_SUPERVISOR_BAIL_PREFIX,
  RUNTIME_FAILURE_PREFIX,
  mapRuntimeFailureToUserMessage,
  normalizeRuntimeFailure,
  normalizeRuntimeFailureEvent,
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

  it('distinguishes gemini auth from generic auth', () => {
    const geminiFailure = normalizeRuntimeFailure('gemini: authentication failed');
    const genericFailure = normalizeRuntimeFailure('unauthorized');

    expect(geminiFailure.code).toBe('GEMINI_AUTH_MISSING');
    expect(geminiFailure.userMessage).toContain('Gemini CLI authentication');
    expect(genericFailure.code).toBe('CLAUDE_AUTH_MISSING');
    expect(genericFailure.userMessage).toContain('Claude CLI authentication');
  });

  it('falls back to unknown runtime failures without dropping the message', () => {
    const failure = normalizeRuntimeFailure('some new runtime error');

    expect(failure.source).toBe('runtime');
    expect(failure.code).toBe('UNKNOWN');
    expect(failure.userMessage).toBe('Runtime error: some new runtime error');
    expect(failure.retryable).toBeNull();
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
