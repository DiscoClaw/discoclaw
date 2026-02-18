import { describe, expect, it, vi } from 'vitest';
import { createStatusPoster, sanitizeErrorMessage, sanitizePhaseError } from './status-channel.js';

function mockChannel() {
  return { send: vi.fn().mockResolvedValue(undefined) } as any;
}

function mockLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('createStatusPoster', () => {
  it('online() sends a green embed', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.online();
    expect(ch.send).toHaveBeenCalledOnce();
    const embed = ch.send.mock.calls[0][0].embeds[0];
    expect(embed.data.color).toBe(0x57f287);
    expect(embed.data.title).toBe('Bot Online');
  });

  it('offline() sends a gray embed', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.offline();
    expect(ch.send).toHaveBeenCalledOnce();
    const embed = ch.send.mock.calls[0][0].embeds[0];
    expect(embed.data.color).toBe(0x95a5a6);
    expect(embed.data.title).toBe('Bot Offline');
  });

  it('runtimeError() sends a red embed with context', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.runtimeError({ sessionKey: 'dm:123', channelName: 'general' }, 'timeout');
    expect(ch.send).toHaveBeenCalledOnce();
    const embed = ch.send.mock.calls[0][0].embeds[0];
    expect(embed.data.color).toBe(0xed4245);
    expect(embed.data.title).toBe('Runtime Error');
    expect(embed.data.description).toBe('timeout');
    expect(embed.data.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Session', value: 'dm:123' }),
        expect.objectContaining({ name: 'Channel', value: 'general' }),
      ]),
    );
  });

  it('handlerError() sends a red embed', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.handlerError({ sessionKey: 'g:1:c:2' }, new Error('boom'));
    expect(ch.send).toHaveBeenCalledOnce();
    const embed = ch.send.mock.calls[0][0].embeds[0];
    expect(embed.data.color).toBe(0xed4245);
    expect(embed.data.title).toBe('Handler Failure');
    expect(embed.data.description).toContain('boom');
  });

  it('handlerError() sanitizes messages containing prompt content', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    const leakyErr = new Error('Command was killed with SIGKILL (Forced termination): claude -p "You are a helpful assistant..."');
    await poster.handlerError({ sessionKey: 'g:1:c:2' }, leakyErr);
    const embed = ch.send.mock.calls[0][0].embeds[0];
    expect(embed.data.description).not.toContain('claude -p');
    expect(embed.data.description).toContain('SIGKILL');
  });

  it('actionFailed() sends an orange embed', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.actionFailed('channelCreate', 'Missing perms');
    expect(ch.send).toHaveBeenCalledOnce();
    const embed = ch.send.mock.calls[0][0].embeds[0];
    expect(embed.data.color).toBe(0xfee75c);
    expect(embed.data.title).toBe('Action Failed');
    expect(embed.data.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Action', value: 'channelCreate' }),
        expect.objectContaining({ name: 'Error', value: 'Missing perms' }),
      ]),
    );
  });

  it('beadSyncComplete() sends green embed with non-zero fields', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.beadSyncComplete({
      threadsCreated: 1, emojisUpdated: 0, starterMessagesUpdated: 2, threadsArchived: 3, statusesUpdated: 0, tagsUpdated: 0, warnings: 0,
    });
    expect(ch.send).toHaveBeenCalledOnce();
    const embed = ch.send.mock.calls[0][0].embeds[0];
    expect(embed.data.color).toBe(0x57f287);
    expect(embed.data.title).toBe('Bead Sync Complete');
    const fieldNames = embed.data.fields.map((f: any) => f.name);
    expect(fieldNames).toContain('Created');
    expect(fieldNames).toContain('Starters Updated');
    expect(fieldNames).toContain('Archived');
    expect(fieldNames).not.toContain('Names Updated');
    expect(fieldNames).not.toContain('Statuses Fixed');
    expect(fieldNames).not.toContain('Warnings');
  });

  it('beadSyncComplete() sends orange embed when warnings > 0', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.beadSyncComplete({
      threadsCreated: 0, emojisUpdated: 0, starterMessagesUpdated: 0, threadsArchived: 0, statusesUpdated: 0, tagsUpdated: 0, warnings: 2,
    });
    expect(ch.send).toHaveBeenCalledOnce();
    const embed = ch.send.mock.calls[0][0].embeds[0];
    expect(embed.data.color).toBe(0xfee75c);
    expect(embed.data.title).toBe('Bead Sync Complete');
    const fieldNames = embed.data.fields.map((f: any) => f.name);
    expect(fieldNames).toContain('Warnings');
  });

  it('beadSyncComplete() sends orange embed when warnings > 0 even with non-zero counters', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.beadSyncComplete({
      threadsCreated: 2, emojisUpdated: 0, starterMessagesUpdated: 0, threadsArchived: 1, statusesUpdated: 0, tagsUpdated: 0, warnings: 1,
    });
    expect(ch.send).toHaveBeenCalledOnce();
    const embed = ch.send.mock.calls[0][0].embeds[0];
    expect(embed.data.color).toBe(0xfee75c);
    const fieldNames = embed.data.fields.map((f: any) => f.name);
    expect(fieldNames).toContain('Created');
    expect(fieldNames).toContain('Archived');
    expect(fieldNames).toContain('Warnings');
  });

  it('beadSyncComplete() is silent when all counters and warnings are zero', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    await poster.beadSyncComplete({
      threadsCreated: 0, emojisUpdated: 0, starterMessagesUpdated: 0, threadsArchived: 0, statusesUpdated: 0, tagsUpdated: 0, warnings: 0,
    });
    expect(ch.send).not.toHaveBeenCalled();
  });

  it('runtimeError() sanitizes messages containing prompt content', async () => {
    const ch = mockChannel();
    const poster = createStatusPoster(ch);
    const leakyMsg = 'Command was killed with SIGKILL (Forced termination): claude -p "You are a helpful assistant called Weston..."';
    await poster.runtimeError({ sessionKey: 'dm:123' }, leakyMsg);
    const embed = ch.send.mock.calls[0][0].embeds[0];
    expect(embed.data.description).toBe('Command was killed with SIGKILL (Forced termination)');
    expect(embed.data.description).not.toContain('claude -p');
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
    expect(sanitizePhaseError('3', raw)).toBe('Phase 3 timed out after 2 minutes');
  });

  it('uses provided timeoutMs over value in error string', () => {
    const raw = 'Process timed out after 60000ms';
    expect(sanitizePhaseError('2', raw, 300000)).toBe('Phase 2 timed out after 5 minutes');
  });

  it('uses singular "minute" when timeout is exactly 1 minute', () => {
    const raw = 'timed out after 60000ms';
    expect(sanitizePhaseError('1', raw)).toBe('Phase 1 timed out after 1 minute');
  });

  it('falls back to seconds when timeout is under 1 minute', () => {
    const raw = 'timed out after 30000ms';
    expect(sanitizePhaseError('1', raw)).toBe('Phase 1 timed out after 30s');
  });

  it('delegates non-timeout errors to sanitizeErrorMessage', () => {
    const raw = 'Command was killed with SIGKILL (Forced termination): claude -p "You are..."';
    const result = sanitizePhaseError('4', raw);
    expect(result).not.toContain('claude -p');
    expect(result).toContain('SIGKILL');
  });

  it('truncates output to 500 chars', () => {
    const raw = 'x'.repeat(1000);
    expect(sanitizePhaseError('1', raw).length).toBe(500);
  });

  it('handles case-insensitive timeout pattern', () => {
    const raw = 'Timed Out After 90000ms';
    expect(sanitizePhaseError('5', raw)).toBe('Phase 5 timed out after 2 minutes');
  });
});
