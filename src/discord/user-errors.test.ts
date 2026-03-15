import { describe, expect, it } from 'vitest';
import { mapRuntimeErrorToUserMessage, normalizeRuntimeError } from './user-errors.js';

describe('mapRuntimeErrorToUserMessage', () => {
  it('maps Claude binary missing errors to install guidance', () => {
    const msg = mapRuntimeErrorToUserMessage('spawn claude ENOENT');
    expect(msg).toContain('Claude CLI was not found');
  });

  it('does not misclassify generic ENOENT errors as Claude CLI missing', () => {
    const msg = mapRuntimeErrorToUserMessage('ENOENT: no such file or directory, open /tmp/missing.json');
    expect(msg).toContain('Runtime error:');
    expect(msg).not.toContain('Claude CLI was not found');
  });

  it('maps Gemini binary missing errors to Gemini install guidance', () => {
    const msg = mapRuntimeErrorToUserMessage('spawn gemini ENOENT');
    expect(msg).toContain('Gemini CLI was not found');
  });

  it('maps Gemini auth errors to Gemini-specific guidance', () => {
    const msg = mapRuntimeErrorToUserMessage('gemini: authentication failed');
    expect(msg).toContain('Gemini CLI authentication');
    expect(msg).not.toContain('Claude CLI');
  });

  it('does not misclassify generic auth errors as Gemini when gemini is not mentioned', () => {
    const msg = mapRuntimeErrorToUserMessage('unauthorized');
    expect(msg).toContain('Claude CLI authentication');
  });

  it('maps stream stall errors to stall-specific user message with duration', () => {
    const msg = mapRuntimeErrorToUserMessage('stream stall: no output for 120000ms');
    expect(msg).toContain('stream stalled');
    expect(msg).toContain('120000ms');
    expect(msg).toContain('2 min');
    expect(msg).toContain('DISCOCLAW_STREAM_STALL_TIMEOUT_MS');
  });

  it('maps malformed stall errors to generic stall message without duration', () => {
    const msg = mapRuntimeErrorToUserMessage('stream stall: timeout');
    expect(msg).toContain('stream stalled');
    expect(msg).toContain('DISCOCLAW_STREAM_STALL_TIMEOUT_MS');
    expect(msg).not.toContain('ms /');
  });

  it('maps progress stall errors to progress-specific user guidance', () => {
    const msg = mapRuntimeErrorToUserMessage('progress stall: no runtime progress for 45000ms');
    expect(msg).toContain('stopped making visible progress');
    expect(msg).toContain('45000ms');
    expect(msg).toContain('45 sec');
  });

  it('maps "Prompt is too long" to context overflow user message', () => {
    const msg = mapRuntimeErrorToUserMessage('Prompt is too long');
    expect(msg).toBe('The conversation context exceeded the model\'s limit. Try a shorter message or start a new conversation.');
  });

  it('maps "context_length_exceeded" to context overflow user message', () => {
    const msg = mapRuntimeErrorToUserMessage('context_length_exceeded');
    expect(msg).toBe('The conversation context exceeded the model\'s limit. Try a shorter message or start a new conversation.');
  });

  it('maps Anthropic tool_use.name 200-char error to MCP server name guidance', () => {
    const msg = mapRuntimeErrorToUserMessage(
      'messages.0.content.0.tool_use.name: String should have at most 200 characters'
    );
    expect(msg).toContain('tool name exceeded the Anthropic API 200-character limit');
    expect(msg).toContain('.mcp.json');
  });

  it('does not false-match unrelated strings mentioning 200 characters', () => {
    const msg = mapRuntimeErrorToUserMessage('response must be at most 200 characters');
    expect(msg).toContain('Runtime error:');
    expect(msg).not.toContain('tool name exceeded');
  });
});

describe('normalizeRuntimeError', () => {
  it('normalizes structured runtime_failure events without dropping metadata', () => {
    const failure = normalizeRuntimeError({
      type: 'runtime_failure',
      failure: {
        envelope: 'runtime_failure',
        envelopeVersion: 'v1',
        source: 'pipeline_tool',
        code: 'E_RUN_NOT_FOUND',
        message: 'run not found',
        rawMessage: 'run not found',
        userMessage: 'The requested pipeline run was not found.',
        retryable: false,
        metadata: {
          operation: 'pipeline.resume',
          ok: false,
          failureCodeVersion: 'v1',
          failureCode: 'E_RUN_NOT_FOUND',
        },
      },
    });

    expect(failure.source).toBe('pipeline_tool');
    expect(failure.code).toBe('E_RUN_NOT_FOUND');
    expect(failure.metadata.operation).toBe('pipeline.resume');
    expect(failure.userMessage).toBe('The requested pipeline run was not found.');
  });

  it('normalizes legacy error events through the shared classifier', () => {
    const failure = normalizeRuntimeError({
      type: 'error',
      message: 'stream stall: no output for 120000ms',
    });

    expect(failure.source).toBe('runtime');
    expect(failure.code).toBe('STREAM_STALL');
    expect(failure.retryable).toBe(true);
    expect(failure.userMessage).toContain('2 min');
  });

  it('normalizes progress stall error events through the shared classifier', () => {
    const failure = normalizeRuntimeError({
      type: 'error',
      message: 'progress stall: no runtime progress for 45000ms',
    });

    expect(failure.source).toBe('runtime');
    expect(failure.code).toBe('PROGRESS_STALL');
    expect(failure.retryable).toBe(true);
    expect(failure.userMessage).toContain('45 sec');
  });
});
