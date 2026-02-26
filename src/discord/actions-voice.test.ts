import { describe, expect, it, vi } from 'vitest';
import { ChannelType } from 'discord.js';
import { executeVoiceAction, resolveVoiceChannel } from './actions-voice.js';
import type { VoiceContext } from './actions-voice.js';
import type { ActionContext } from './actions.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockGuild(
  channels: Array<{ id: string; name: string; type: ChannelType }>,
  guildId = 'g1',
) {
  const cache = new Map<string, any>();
  for (const ch of channels) {
    cache.set(ch.id, { id: ch.id, name: ch.name, type: ch.type });
  }

  return {
    id: guildId,
    voiceAdapterCreator: (() => {}) as any,
    channels: {
      cache: {
        get: (id: string) => cache.get(id),
        find: (fn: (ch: any) => boolean) => {
          for (const ch of cache.values()) {
            if (fn(ch)) return ch;
          }
          return undefined;
        },
      },
    },
  } as any;
}

function makeCtx(guild: any): ActionContext {
  return {
    guild,
    client: {} as any,
    channelId: 'test-channel',
    messageId: 'test-message',
  };
}

function makeMockConnection(channelId = 'vc1') {
  return {
    joinConfig: { channelId, guildId: 'g1', selfMute: false, selfDeaf: false },
    rejoin: vi.fn(),
  };
}

function makeVoiceCtx(overrides: {
  getState?: (guildId: string) => string | undefined;
  getConnection?: (guildId: string) => any;
  join?: (...args: any[]) => any;
  leave?: (...args: any[]) => void;
} = {}): VoiceContext {
  return {
    voiceManager: {
      join: overrides.join ?? vi.fn(),
      leave: overrides.leave ?? vi.fn(),
      getState: overrides.getState ?? (() => undefined),
      getConnection: overrides.getConnection ?? (() => undefined),
    } as any,
  };
}

// ---------------------------------------------------------------------------
// resolveVoiceChannel
// ---------------------------------------------------------------------------

describe('resolveVoiceChannel', () => {
  it('resolves a voice channel by ID', () => {
    const guild = makeMockGuild([
      { id: 'vc1', name: 'voice-chat', type: ChannelType.GuildVoice },
    ]);
    const ch = resolveVoiceChannel(guild, 'vc1');
    expect(ch).toBeDefined();
    expect(ch!.id).toBe('vc1');
  });

  it('resolves a voice channel by name', () => {
    const guild = makeMockGuild([
      { id: 'vc1', name: 'voice-chat', type: ChannelType.GuildVoice },
    ]);
    const ch = resolveVoiceChannel(guild, 'voice-chat');
    expect(ch).toBeDefined();
    expect(ch!.name).toBe('voice-chat');
  });

  it('resolves a stage channel', () => {
    const guild = makeMockGuild([
      { id: 'sc1', name: 'stage-room', type: ChannelType.GuildStageVoice },
    ]);
    const ch = resolveVoiceChannel(guild, 'stage-room');
    expect(ch).toBeDefined();
    expect(ch!.id).toBe('sc1');
  });

  it('returns undefined for a text channel ID', () => {
    const guild = makeMockGuild([
      { id: 'tc1', name: 'general', type: ChannelType.GuildText },
    ]);
    expect(resolveVoiceChannel(guild, 'tc1')).toBeUndefined();
  });

  it('returns undefined for nonexistent channel', () => {
    const guild = makeMockGuild([]);
    expect(resolveVoiceChannel(guild, 'nope')).toBeUndefined();
  });

  it('strips leading # from ref', () => {
    const guild = makeMockGuild([
      { id: 'vc1', name: 'voice-chat', type: ChannelType.GuildVoice },
    ]);
    const ch = resolveVoiceChannel(guild, '#voice-chat');
    expect(ch).toBeDefined();
    expect(ch!.name).toBe('voice-chat');
  });
});

// ---------------------------------------------------------------------------
// voiceJoin
// ---------------------------------------------------------------------------

describe('voiceJoin', () => {
  it('joins a voice channel resolved by name', async () => {
    const guild = makeMockGuild([
      { id: 'vc1', name: 'voice-chat', type: ChannelType.GuildVoice },
    ]);
    const ctx = makeCtx(guild);
    const joinFn = vi.fn();
    const voiceCtx = makeVoiceCtx({ join: joinFn });

    const result = await executeVoiceAction(
      { type: 'voiceJoin', channel: 'voice-chat' },
      ctx,
      voiceCtx,
    );

    expect(result).toEqual({ ok: true, summary: 'Joined voice channel #voice-chat' });
    expect(joinFn).toHaveBeenCalledWith({
      channelId: 'vc1',
      guildId: 'g1',
      adapterCreator: guild.voiceAdapterCreator,
    });
  });

  it('joins a voice channel resolved by ID', async () => {
    const guild = makeMockGuild([
      { id: 'vc1', name: 'voice-chat', type: ChannelType.GuildVoice },
    ]);
    const ctx = makeCtx(guild);
    const joinFn = vi.fn();
    const voiceCtx = makeVoiceCtx({ join: joinFn });

    const result = await executeVoiceAction(
      { type: 'voiceJoin', channel: 'vc1' },
      ctx,
      voiceCtx,
    );

    expect(result).toEqual({ ok: true, summary: 'Joined voice channel #voice-chat' });
    expect(joinFn).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'vc1' }),
    );
  });

  it('fails when channel is a text channel', async () => {
    const guild = makeMockGuild([
      { id: 'tc1', name: 'general', type: ChannelType.GuildText },
    ]);
    const ctx = makeCtx(guild);
    const voiceCtx = makeVoiceCtx();

    const result = await executeVoiceAction(
      { type: 'voiceJoin', channel: 'general' },
      ctx,
      voiceCtx,
    );

    expect(result).toEqual({ ok: false, error: 'Voice channel "general" not found' });
  });

  it('fails when channel does not exist', async () => {
    const guild = makeMockGuild([]);
    const ctx = makeCtx(guild);
    const voiceCtx = makeVoiceCtx();

    const result = await executeVoiceAction(
      { type: 'voiceJoin', channel: 'nonexistent' },
      ctx,
      voiceCtx,
    );

    expect(result).toEqual({ ok: false, error: 'Voice channel "nonexistent" not found' });
  });
});

// ---------------------------------------------------------------------------
// voiceLeave
// ---------------------------------------------------------------------------

describe('voiceLeave', () => {
  it('leaves an active voice connection', async () => {
    const guild = makeMockGuild([], 'g1');
    const ctx = makeCtx(guild);
    const leaveFn = vi.fn();
    const voiceCtx = makeVoiceCtx({
      getState: (guildId) => (guildId === 'g1' ? 'ready' : undefined),
      leave: leaveFn,
    });

    const result = await executeVoiceAction(
      { type: 'voiceLeave' },
      ctx,
      voiceCtx,
    );

    expect(result).toEqual({ ok: true, summary: 'Left voice channel in guild g1' });
    expect(leaveFn).toHaveBeenCalledWith('g1');
  });

  it('is a graceful no-op when no active connection', async () => {
    const guild = makeMockGuild([], 'g1');
    const ctx = makeCtx(guild);
    const leaveFn = vi.fn();
    const voiceCtx = makeVoiceCtx({ leave: leaveFn });

    const result = await executeVoiceAction(
      { type: 'voiceLeave' },
      ctx,
      voiceCtx,
    );

    expect(result).toEqual({ ok: true, summary: 'No active voice connection to leave' });
    expect(leaveFn).not.toHaveBeenCalled();
  });

  it('uses explicit guildId when provided', async () => {
    const guild = makeMockGuild([], 'g1');
    const ctx = makeCtx(guild);
    const leaveFn = vi.fn();
    const voiceCtx = makeVoiceCtx({
      getState: (guildId) => (guildId === 'g2' ? 'ready' : undefined),
      leave: leaveFn,
    });

    const result = await executeVoiceAction(
      { type: 'voiceLeave', guildId: 'g2' },
      ctx,
      voiceCtx,
    );

    expect(result).toEqual({ ok: true, summary: 'Left voice channel in guild g2' });
    expect(leaveFn).toHaveBeenCalledWith('g2');
  });
});

// ---------------------------------------------------------------------------
// voiceMute
// ---------------------------------------------------------------------------

describe('voiceMute', () => {
  it('mutes via connection rejoin', async () => {
    const guild = makeMockGuild([], 'g1');
    const ctx = makeCtx(guild);
    const conn = makeMockConnection();
    const voiceCtx = makeVoiceCtx({
      getConnection: () => conn,
    });

    const result = await executeVoiceAction(
      { type: 'voiceMute', mute: true },
      ctx,
      voiceCtx,
    );

    expect(result).toEqual({ ok: true, summary: 'Muted in voice channel' });
    expect(conn.rejoin).toHaveBeenCalledWith(
      expect.objectContaining({ selfMute: true }),
    );
  });

  it('unmutes via connection rejoin', async () => {
    const guild = makeMockGuild([], 'g1');
    const ctx = makeCtx(guild);
    const conn = makeMockConnection();
    const voiceCtx = makeVoiceCtx({
      getConnection: () => conn,
    });

    const result = await executeVoiceAction(
      { type: 'voiceMute', mute: false },
      ctx,
      voiceCtx,
    );

    expect(result).toEqual({ ok: true, summary: 'Unmuted in voice channel' });
    expect(conn.rejoin).toHaveBeenCalledWith(
      expect.objectContaining({ selfMute: false }),
    );
  });

  it('returns error when no active connection', async () => {
    const guild = makeMockGuild([], 'g1');
    const ctx = makeCtx(guild);
    const voiceCtx = makeVoiceCtx();

    const result = await executeVoiceAction(
      { type: 'voiceMute', mute: true },
      ctx,
      voiceCtx,
    );

    expect(result).toEqual({
      ok: false,
      error: 'No active voice connection \u2014 join a channel first',
    });
  });
});

// ---------------------------------------------------------------------------
// voiceDeafen
// ---------------------------------------------------------------------------

describe('voiceDeafen', () => {
  it('deafens via connection rejoin', async () => {
    const guild = makeMockGuild([], 'g1');
    const ctx = makeCtx(guild);
    const conn = makeMockConnection();
    const voiceCtx = makeVoiceCtx({
      getConnection: () => conn,
    });

    const result = await executeVoiceAction(
      { type: 'voiceDeafen', deafen: true },
      ctx,
      voiceCtx,
    );

    expect(result).toEqual({ ok: true, summary: 'Deafened in voice channel' });
    expect(conn.rejoin).toHaveBeenCalledWith(
      expect.objectContaining({ selfDeaf: true }),
    );
  });

  it('undeafens via connection rejoin', async () => {
    const guild = makeMockGuild([], 'g1');
    const ctx = makeCtx(guild);
    const conn = makeMockConnection();
    const voiceCtx = makeVoiceCtx({
      getConnection: () => conn,
    });

    const result = await executeVoiceAction(
      { type: 'voiceDeafen', deafen: false },
      ctx,
      voiceCtx,
    );

    expect(result).toEqual({ ok: true, summary: 'Undeafened in voice channel' });
    expect(conn.rejoin).toHaveBeenCalledWith(
      expect.objectContaining({ selfDeaf: false }),
    );
  });

  it('returns error when no active connection', async () => {
    const guild = makeMockGuild([], 'g1');
    const ctx = makeCtx(guild);
    const voiceCtx = makeVoiceCtx();

    const result = await executeVoiceAction(
      { type: 'voiceDeafen', deafen: true },
      ctx,
      voiceCtx,
    );

    expect(result).toEqual({
      ok: false,
      error: 'No active voice connection \u2014 join a channel first',
    });
  });
});

// ---------------------------------------------------------------------------
// voiceStatus
// ---------------------------------------------------------------------------

describe('voiceStatus', () => {
  it('returns connection info when active', async () => {
    const guild = makeMockGuild([], 'g1');
    const ctx = makeCtx(guild);
    const conn = makeMockConnection('vc1');
    const voiceCtx = makeVoiceCtx({
      getState: (guildId) => (guildId === 'g1' ? 'ready' : undefined),
      getConnection: (guildId) => (guildId === 'g1' ? conn : undefined),
    });

    const result = await executeVoiceAction(
      { type: 'voiceStatus' },
      ctx,
      voiceCtx,
    );

    expect(result.ok).toBe(true);
    expect((result as any).summary).toContain('vc1');
    expect((result as any).summary).toContain('ready');
  });

  it('returns empty state when no connections', async () => {
    const guild = makeMockGuild([], 'g1');
    const ctx = makeCtx(guild);
    const voiceCtx = makeVoiceCtx();

    const result = await executeVoiceAction(
      { type: 'voiceStatus' },
      ctx,
      voiceCtx,
    );

    expect(result).toEqual({ ok: true, summary: 'No active voice connections' });
  });
});
