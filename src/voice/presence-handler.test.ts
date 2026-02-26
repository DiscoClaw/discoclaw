import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Collection } from 'discord.js';
import type { GuildMember, VoiceBasedChannel, VoiceState } from 'discord.js';
import type { LoggerLike } from '../logging/logger-like.js';
import { VoicePresenceHandler } from './presence-handler.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createLogger(): LoggerLike {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function createMember(id: string, bot = false): GuildMember {
  return { id, user: { bot, id } } as unknown as GuildMember;
}

function createChannel(
  id: string,
  members: GuildMember[] = [],
): VoiceBasedChannel {
  const col = new Collection<string, GuildMember>();
  for (const m of members) col.set(m.id, m);
  return { id, name: `channel-${id}`, members: col } as unknown as VoiceBasedChannel;
}

const fakeAdapter = (() => ({
  destroy() {},
  sendPayload: () => true,
})) as never;

function createVoiceManager() {
  return {
    join: vi.fn(),
    leave: vi.fn(),
    getConnection: vi.fn().mockReturnValue(undefined),
  };
}

type MockVoiceManager = ReturnType<typeof createVoiceManager>;

function createVoiceState(opts: {
  guildId: string;
  channelId: string | null;
  channel: VoiceBasedChannel | null;
  member: GuildMember | null;
}): VoiceState {
  return {
    guild: {
      id: opts.guildId,
      voiceAdapterCreator: fakeAdapter,
    },
    channelId: opts.channelId,
    channel: opts.channel,
    member: opts.member,
  } as unknown as VoiceState;
}

function createHandler(voiceManager: MockVoiceManager, log?: LoggerLike) {
  return new VoicePresenceHandler({
    log: log ?? createLogger(),
    voiceManager: voiceManager as never,
    botUserId: 'bot-1',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe('VoicePresenceHandler', () => {
  describe('auto-join', () => {
    it('joins when a non-bot user enters a voice channel', () => {
      const mgr = createVoiceManager();
      const handler = createHandler(mgr);

      const user = createMember('user-1');
      const channel = createChannel('ch-1', [user]);

      const oldState = createVoiceState({
        guildId: 'g1',
        channelId: null,
        channel: null,
        member: user,
      });
      const newState = createVoiceState({
        guildId: 'g1',
        channelId: 'ch-1',
        channel,
        member: user,
      });

      handler.handleVoiceStateUpdate(oldState, newState);

      expect(mgr.join).toHaveBeenCalledWith({
        channelId: 'ch-1',
        guildId: 'g1',
        adapterCreator: fakeAdapter,
      });
    });

    it('does not join if bot is already connected to the guild', () => {
      const mgr = createVoiceManager();
      mgr.getConnection.mockReturnValue({ joinConfig: { channelId: 'ch-1' } });
      const handler = createHandler(mgr);

      const user = createMember('user-1');
      const channel = createChannel('ch-2', [user]);

      const oldState = createVoiceState({
        guildId: 'g1',
        channelId: null,
        channel: null,
        member: user,
      });
      const newState = createVoiceState({
        guildId: 'g1',
        channelId: 'ch-2',
        channel,
        member: user,
      });

      handler.handleVoiceStateUpdate(oldState, newState);

      expect(mgr.join).not.toHaveBeenCalled();
    });

    it('ignores bot users joining a channel', () => {
      const mgr = createVoiceManager();
      const handler = createHandler(mgr);

      const bot = createMember('other-bot', true);
      const channel = createChannel('ch-1', [bot]);

      const oldState = createVoiceState({
        guildId: 'g1',
        channelId: null,
        channel: null,
        member: bot,
      });
      const newState = createVoiceState({
        guildId: 'g1',
        channelId: 'ch-1',
        channel,
        member: bot,
      });

      handler.handleVoiceStateUpdate(oldState, newState);

      expect(mgr.join).not.toHaveBeenCalled();
    });

    it('ignores state changes without a member', () => {
      const mgr = createVoiceManager();
      const handler = createHandler(mgr);

      const oldState = createVoiceState({
        guildId: 'g1',
        channelId: null,
        channel: null,
        member: null,
      });
      const newState = createVoiceState({
        guildId: 'g1',
        channelId: 'ch-1',
        channel: createChannel('ch-1'),
        member: null,
      });

      handler.handleVoiceStateUpdate(oldState, newState);

      expect(mgr.join).not.toHaveBeenCalled();
    });
  });

  describe('auto-leave', () => {
    it('leaves when the last non-bot user leaves the channel', () => {
      const mgr = createVoiceManager();
      mgr.getConnection.mockReturnValue({ joinConfig: { channelId: 'ch-1' } });
      const handler = createHandler(mgr);

      const user = createMember('user-1');
      // After the user leaves, the channel has no non-bot members.
      const emptyChannel = createChannel('ch-1', []);

      const oldState = createVoiceState({
        guildId: 'g1',
        channelId: 'ch-1',
        channel: emptyChannel,
        member: user,
      });
      const newState = createVoiceState({
        guildId: 'g1',
        channelId: null,
        channel: null,
        member: user,
      });

      handler.handleVoiceStateUpdate(oldState, newState);

      expect(mgr.leave).toHaveBeenCalledWith('g1');
    });

    it('does not leave if non-bot users remain in the channel', () => {
      const mgr = createVoiceManager();
      mgr.getConnection.mockReturnValue({ joinConfig: { channelId: 'ch-1' } });
      const handler = createHandler(mgr);

      const leavingUser = createMember('user-1');
      const remainingUser = createMember('user-2');
      // The remaining user is still in the channel after the first user leaves.
      const channel = createChannel('ch-1', [remainingUser]);

      const oldState = createVoiceState({
        guildId: 'g1',
        channelId: 'ch-1',
        channel,
        member: leavingUser,
      });
      const newState = createVoiceState({
        guildId: 'g1',
        channelId: null,
        channel: null,
        member: leavingUser,
      });

      handler.handleVoiceStateUpdate(oldState, newState);

      expect(mgr.leave).not.toHaveBeenCalled();
    });

    it('does not leave if only bots remain but at least one non-bot user remains', () => {
      const mgr = createVoiceManager();
      mgr.getConnection.mockReturnValue({ joinConfig: { channelId: 'ch-1' } });
      const handler = createHandler(mgr);

      const leavingUser = createMember('user-1');
      const botMember = createMember('some-bot', true);
      const humanMember = createMember('user-2');
      const channel = createChannel('ch-1', [botMember, humanMember]);

      const oldState = createVoiceState({
        guildId: 'g1',
        channelId: 'ch-1',
        channel,
        member: leavingUser,
      });
      const newState = createVoiceState({
        guildId: 'g1',
        channelId: null,
        channel: null,
        member: leavingUser,
      });

      handler.handleVoiceStateUpdate(oldState, newState);

      expect(mgr.leave).not.toHaveBeenCalled();
    });

    it('leaves if only bots remain in the channel', () => {
      const mgr = createVoiceManager();
      mgr.getConnection.mockReturnValue({ joinConfig: { channelId: 'ch-1' } });
      const handler = createHandler(mgr);

      const user = createMember('user-1');
      const botMember = createMember('other-bot', true);
      // Only a bot remains after the user leaves.
      const channel = createChannel('ch-1', [botMember]);

      const oldState = createVoiceState({
        guildId: 'g1',
        channelId: 'ch-1',
        channel,
        member: user,
      });
      const newState = createVoiceState({
        guildId: 'g1',
        channelId: null,
        channel: null,
        member: user,
      });

      handler.handleVoiceStateUpdate(oldState, newState);

      expect(mgr.leave).toHaveBeenCalledWith('g1');
    });

    it('does not leave if bot is in a different channel', () => {
      const mgr = createVoiceManager();
      // Bot is in ch-2, user leaves ch-1.
      mgr.getConnection.mockReturnValue({ joinConfig: { channelId: 'ch-2' } });
      const handler = createHandler(mgr);

      const user = createMember('user-1');
      const channel = createChannel('ch-1', []);

      const oldState = createVoiceState({
        guildId: 'g1',
        channelId: 'ch-1',
        channel,
        member: user,
      });
      const newState = createVoiceState({
        guildId: 'g1',
        channelId: null,
        channel: null,
        member: user,
      });

      handler.handleVoiceStateUpdate(oldState, newState);

      expect(mgr.leave).not.toHaveBeenCalled();
    });

    it('does not leave if bot has no connection to the guild', () => {
      const mgr = createVoiceManager();
      // No connection.
      mgr.getConnection.mockReturnValue(undefined);
      const handler = createHandler(mgr);

      const user = createMember('user-1');
      const channel = createChannel('ch-1', []);

      const oldState = createVoiceState({
        guildId: 'g1',
        channelId: 'ch-1',
        channel,
        member: user,
      });
      const newState = createVoiceState({
        guildId: 'g1',
        channelId: null,
        channel: null,
        member: user,
      });

      handler.handleVoiceStateUpdate(oldState, newState);

      expect(mgr.leave).not.toHaveBeenCalled();
    });
  });

  describe('channel switching', () => {
    it('auto-joins new channel when user switches and bot has no connection', () => {
      const mgr = createVoiceManager();
      const handler = createHandler(mgr);

      const user = createMember('user-1');
      const oldChannel = createChannel('ch-1', []);
      const newChannel = createChannel('ch-2', [user]);

      const oldState = createVoiceState({
        guildId: 'g1',
        channelId: 'ch-1',
        channel: oldChannel,
        member: user,
      });
      const newState = createVoiceState({
        guildId: 'g1',
        channelId: 'ch-2',
        channel: newChannel,
        member: user,
      });

      handler.handleVoiceStateUpdate(oldState, newState);

      // Should join the new channel (bot has no connection).
      expect(mgr.join).toHaveBeenCalledWith({
        channelId: 'ch-2',
        guildId: 'g1',
        adapterCreator: fakeAdapter,
      });
    });

    it('auto-leaves old channel when user switches and no humans remain', () => {
      const mgr = createVoiceManager();
      // Bot is in ch-1.
      mgr.getConnection.mockReturnValue({ joinConfig: { channelId: 'ch-1' } });
      const handler = createHandler(mgr);

      const user = createMember('user-1');
      const oldChannel = createChannel('ch-1', []);
      const newChannel = createChannel('ch-2', [user]);

      const oldState = createVoiceState({
        guildId: 'g1',
        channelId: 'ch-1',
        channel: oldChannel,
        member: user,
      });
      const newState = createVoiceState({
        guildId: 'g1',
        channelId: 'ch-2',
        channel: newChannel,
        member: user,
      });

      handler.handleVoiceStateUpdate(oldState, newState);

      // Should leave old channel since no non-bot members remain.
      expect(mgr.leave).toHaveBeenCalledWith('g1');
      // Should NOT join new channel because getConnection returned a value
      // (even though leave was called, getConnection is checked before leave
      // is called for the join path).
      expect(mgr.join).not.toHaveBeenCalled();
    });
  });

  describe('same-channel state changes', () => {
    it('ignores mute/deafen changes (same channel)', () => {
      const mgr = createVoiceManager();
      const handler = createHandler(mgr);

      const user = createMember('user-1');
      const channel = createChannel('ch-1', [user]);

      const oldState = createVoiceState({
        guildId: 'g1',
        channelId: 'ch-1',
        channel,
        member: user,
      });
      const newState = createVoiceState({
        guildId: 'g1',
        channelId: 'ch-1',
        channel,
        member: user,
      });

      handler.handleVoiceStateUpdate(oldState, newState);

      expect(mgr.join).not.toHaveBeenCalled();
      expect(mgr.leave).not.toHaveBeenCalled();
    });
  });

  describe('logging', () => {
    it('logs when auto-joining', () => {
      const mgr = createVoiceManager();
      const log = createLogger();
      const handler = createHandler(mgr, log);

      const user = createMember('user-1');
      const channel = createChannel('ch-1', [user]);

      const oldState = createVoiceState({
        guildId: 'g1',
        channelId: null,
        channel: null,
        member: user,
      });
      const newState = createVoiceState({
        guildId: 'g1',
        channelId: 'ch-1',
        channel,
        member: user,
      });

      handler.handleVoiceStateUpdate(oldState, newState);

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ guildId: 'g1', channelId: 'ch-1' }),
        'voice:presence: user joined, auto-joining channel',
      );
    });

    it('logs when auto-leaving', () => {
      const mgr = createVoiceManager();
      mgr.getConnection.mockReturnValue({ joinConfig: { channelId: 'ch-1' } });
      const log = createLogger();
      const handler = createHandler(mgr, log);

      const user = createMember('user-1');
      const channel = createChannel('ch-1', []);

      const oldState = createVoiceState({
        guildId: 'g1',
        channelId: 'ch-1',
        channel,
        member: user,
      });
      const newState = createVoiceState({
        guildId: 'g1',
        channelId: null,
        channel: null,
        member: user,
      });

      handler.handleVoiceStateUpdate(oldState, newState);

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ guildId: 'g1', channelId: 'ch-1' }),
        'voice:presence: last non-bot user left, auto-leaving channel',
      );
    });
  });
});
