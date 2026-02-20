import { describe, expect, it, vi } from 'vitest';
import { createStatusPoster, sanitizeErrorMessage, sanitizePhaseError } from './status-channel.js';

function mockChannel() {
  return { send: vi.fn().mockResolvedValue(undefined) } as any;
}

function mockLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function sentContent(ch: ReturnType<typeof mockChannel>, callIndex = 0): string {
  const arg = ch.send.mock.calls[callIndex][0] as { content: string; allowedMentions: unknown };
  return arg.content;
}

describe('createStatusPoster', () => {
  it('online() sends a plain text Bot Online message', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.online();
    expect(ch.send).toHaveBeenCalledOnce();
    const msg = sentContent(ch);
    expect(msg).toContain('**Bot Online**');
    expect(msg).toContain('connected and ready');
  });

  it('online() suppresses mentions via NO_MENTIONS', async () => {
    const ch = mockChannel();
    await createStatusPoster(ch).online();
    const arg = ch.send.mock.calls[0][0] as { allowedMentions: unknown };
    expect(arg.allowedMentions).toEqual({ parse: [] });
  });

  it('offline() sends a plain text Bot Offline message', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.offline();
    expect(ch.send).toHaveBeenCalledOnce();
    const msg = sentContent(ch);
    expect(msg).toContain('**Bot Offline**');
    expect(msg).toContain('shutting down');
  });

  it('runtimeError() sends plain text with session and channel context', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.runtimeError({ sessionKey: 'dm:123', channelName: 'general' }, 'timeout');
    expect(ch.send).toHaveBeenCalledOnce();
    const msg = sentContent(ch);
    expect(msg).toContain('**Runtime Error**');
    expect(msg).toContain('dm:123');
    expect(msg).toContain('general');
    expect(msg).toContain('timeout');
  });

  it('handlerError() sends plain text with error content', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.handlerError({ sessionKey: 'g:1:c:2' }, new Error('boom'));
    expect(ch.send).toHaveBeenCalledOnce();
    const msg = sentContent(ch);
    expect(msg).toContain('**Handler Failure**');
    expect(msg).toContain('boom');
  });

  it('handlerError() sanitizes messages containing prompt content', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    const leakyErr = new Error('Command was killed with SIGKILL (Forced termination): claude -p "You are a helpful assistant..."');
    await poster.handlerError({ sessionKey: 'g:1:c:2' }, leakyErr);
    const msg = sentContent(ch);
    expect(msg).not.toContain('claude -p');
    expect(msg).toContain('SIGKILL');
  });

  it('actionFailed() sends plain text with action type and error', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.actionFailed('channelCreate', 'Missing perms');
    expect(ch.send).toHaveBeenCalledOnce();
    const msg = sentContent(ch);
    expect(msg).toContain('**Action Failed**');
    expect(msg).toContain('channelCreate');
    expect(msg).toContain('Missing perms');
  });

  it('taskSyncComplete() sends plain text with non-zero fields only', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.taskSyncComplete({
      threadsCreated: 1, emojisUpdated: 0, starterMessagesUpdated: 2, threadsArchived: 3, statusesUpdated: 0, tagsUpdated: 0, warnings: 0,
    });
    expect(ch.send).toHaveBeenCalledOnce();
    const msg = sentContent(ch);
    expect(msg).toContain('**Task Sync Complete**');
    expect(msg).toContain('Created: 1');
    expect(msg).toContain('Starters Updated: 2');
    expect(msg).toContain('Archived: 3');
    expect(msg).not.toContain('Names Updated');
    expect(msg).not.toContain('Statuses Fixed');
    expect(msg).not.toContain('Warnings');
  });

  it('taskSyncComplete() includes warnings when > 0', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.taskSyncComplete({
      threadsCreated: 0, emojisUpdated: 0, starterMessagesUpdated: 0, threadsArchived: 0, statusesUpdated: 0, tagsUpdated: 0, warnings: 2,
    });
    expect(ch.send).toHaveBeenCalledOnce();
    const msg = sentContent(ch);
    expect(msg).toContain('**Task Sync Complete**');
    expect(msg).toContain('Warnings: 2');
  });

  it('taskSyncComplete() includes all non-zero counters and warnings together', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.taskSyncComplete({
      threadsCreated: 2, emojisUpdated: 0, starterMessagesUpdated: 0, threadsArchived: 1, statusesUpdated: 0, tagsUpdated: 0, warnings: 1,
    });
    expect(ch.send).toHaveBeenCalledOnce();
    const msg = sentContent(ch);
    expect(msg).toContain('Created: 2');
    expect(msg).toContain('Archived: 1');
    expect(msg).toContain('Warnings: 1');
  });

  it('taskSyncComplete() is silent when all counters and warnings are zero', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.taskSyncComplete({
      threadsCreated: 0, emojisUpdated: 0, starterMessagesUpdated: 0, threadsArchived: 0, statusesUpdated: 0, tagsUpdated: 0, warnings: 0,
    });
    expect(ch.send).not.toHaveBeenCalled();
  });

  it('runtimeError() sanitizes messages containing prompt content', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    const leakyMsg = 'Command was killed with SIGKILL (Forced termination): claude -p "You are a helpful assistant called Weston..."';
    await poster.runtimeError({ sessionKey: 'dm:123' }, leakyMsg);
    const msg = sentContent(ch);
    expect(msg).toContain('Command was killed with SIGKILL (Forced termination)');
    expect(msg).not.toContain('claude -p');
  });

  it('does not throw when channel.send fails', async () => {
    const ch = { send: vi.fn().mockRejectedValue(new Error('network')) } as any;
    const log = mockLog();
    const poster = createStatusPoster(ch, { log });
    await expect(poster.online()).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledOnce();
  });
});

describe('sanitizeErrorMessage', () => {
  it('passes through short clean messages unchanged', () => {
    expect(sanitizeErrorMessage('timeout')).toBe('timeout');
  });

  it('returns "(no message)" for empty/falsy input', () => {
    expect(sanitizeErrorMessage('')).toBe('(no message)');
  });

  it('strips prompt after "Command was killed with SIGKILL": claude -p ...', () => {
    const msg = 'Command was killed with SIGKILL (Forced termination): claude -p "You are a helpful..."';
    expect(sanitizeErrorMessage(msg)).toBe('Command was killed with SIGKILL (Forced termination)');
  });

  it('strips prompt after "Command failed with exit code 1": claude -p ...', () => {
    const msg = 'Command failed with exit code 1: claude -p "big prompt here..."';
    expect(sanitizeErrorMessage(msg)).toBe('Command failed with exit code 1');
  });

  it('strips content when "claude -p" appears mid-message without colon-space separator', () => {
    const msg = 'Something went wrong while running claude -p "giant prompt"';
    expect(sanitizeErrorMessage(msg)).toBe('Something went wrong while running');
  });

  it('strips prompt with absolute binary path and positional arg (double quotes)', () => {
    const msg = 'Command was killed with SIGKILL (Forced termination): /usr/local/bin/claude --tools bash -- "You are a helpful assistant..."';
    expect(sanitizeErrorMessage(msg)).toBe('Command was killed with SIGKILL (Forced termination)');
  });

  it('strips prompt with absolute binary path and positional arg (single quotes)', () => {
    // execa formats args with single quotes in shortMessage
    const msg = "Command was killed with SIGKILL (Forced termination): /usr/local/bin/claude --tools bash -- 'You are a helpful assistant...'";
    expect(sanitizeErrorMessage(msg)).toBe('Command was killed with SIGKILL (Forced termination)');
  });

  it('strips single-quoted positional prompt when binary name is not "claude"', () => {
    const msg = "Command was killed with SIGKILL (Forced termination): /opt/mybin --tools bash -- 'You are a helpful assistant...'";
    expect(sanitizeErrorMessage(msg)).not.toContain('You are a helpful');
  });

  it('truncates long messages to 500 chars', () => {
    const long = 'x'.repeat(1000);
    expect(sanitizeErrorMessage(long).length).toBe(500);
  });
});

describe('sanitizePhaseError', () => {
  it('formats timeout using ms from error string when no timeoutMs provided', () => {
    const raw = 'Process timed out after 120000ms';
    expect(sanitizePhaseError('3', raw)).toBe('Phase **3** timed out after 2 minutes');
  });

  it('uses provided timeoutMs over value in error string', () => {
    const raw = 'Process timed out after 60000ms';
    expect(sanitizePhaseError('2', raw, 300000)).toBe('Phase **2** timed out after 5 minutes');
  });

  it('uses singular "minute" when timeout is exactly 1 minute', () => {
    const raw = 'timed out after 60000ms';
    expect(sanitizePhaseError('1', raw)).toBe('Phase **1** timed out after 1 minute');
  });

  it('falls back to seconds when timeout is under 1 minute', () => {
    const raw = 'timed out after 30000ms';
    expect(sanitizePhaseError('1', raw)).toBe('Phase **1** timed out after 30 seconds');
  });

  it('wraps non-timeout errors with "Phase X failed:" prefix', () => {
    const raw = 'Command was killed with SIGKILL (Forced termination): claude -p "You are..."';
    const result = sanitizePhaseError('4', raw);
    expect(result).not.toContain('claude -p');
    expect(result).toContain('SIGKILL');
    expect(result).toMatch(/^Phase \*\*4\*\* failed:/);
  });

  it('truncates output to 500 chars', () => {
    const raw = 'x'.repeat(1000);
    expect(sanitizePhaseError('1', raw).length).toBe(500);
  });

  it('handles case-insensitive timeout pattern', () => {
    const raw = 'Timed Out After 90000ms';
    expect(sanitizePhaseError('5', raw)).toBe('Phase **5** timed out after 2 minutes');
  });
});
