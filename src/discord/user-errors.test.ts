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

  it('maps stream stall errors to stall-specific user message', () => {
    const msg = mapRuntimeErrorToUserMessage('stream stall: no output for 120000ms');
    expect(msg).toContain('stream stalled');
    expect(msg).toContain('DISCOCLAW_STREAM_STALL_TIMEOUT_MS');
  });
});
