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

  it('maps stream stall errors to stall-specific user message', () => {
    const msg = mapRuntimeErrorToUserMessage('stream stall: no output for 120000ms');
    expect(msg).toContain('stream stalled');
    expect(msg).toContain('DISCOCLAW_STREAM_STALL_TIMEOUT_MS');
  });
});
