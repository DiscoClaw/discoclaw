import { describe, expect, it, vi } from 'vitest';
import { createStatusPoster } from './status-channel.js';

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

  it('does not throw when channel.send fails', async () => {
    const ch = { send: vi.fn().mockRejectedValue(new Error('network')) } as any;
    const log = mockLog();
    const poster = createStatusPoster(ch, log);
    await expect(poster.online()).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledOnce();
  });
});
