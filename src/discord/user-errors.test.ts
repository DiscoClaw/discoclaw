import { describe, expect, it } from 'vitest';
import { mapRuntimeErrorToUserMessage } from './user-errors.js';

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

  it('maps "Prompt is too long" to context overflow user message', () => {
    const msg = mapRuntimeErrorToUserMessage('Prompt is too long');
    expect(msg).toBe('The conversation context exceeded the model\'s limit. Try a shorter message or start a new conversation.');
  });

  it('maps "context_length_exceeded" to context overflow user message', () => {
    const msg = mapRuntimeErrorToUserMessage('context_length_exceeded');
    expect(msg).toBe('The conversation context exceeded the model\'s limit. Try a shorter message or start a new conversation.');
  });
});
