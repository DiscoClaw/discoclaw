import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LoggerLike } from '../logging/logger-like.js';

vi.mock('@discordjs/voice', () => ({
  VoiceConnectionStatus: {
    Signalling: 'signalling',
    Connecting: 'connecting',
    Ready: 'ready',
    Disconnected: 'disconnected',
    Destroyed: 'destroyed',
  },
  joinVoiceChannel: vi.fn(),
}));

import { joinVoiceChannel, VoiceConnectionStatus } from '@discordjs/voice';
import { VoiceConnectionManager } from './connection-manager.js';

type StatusLike = { status: string };
type StateChangeListener = (oldState: StatusLike, newState: StatusLike) => void;

function createMockConnection(
  initialStatus = VoiceConnectionStatus.Signalling,
  joinConfigOverrides: Partial<{ channelId: string; guildId: string; selfMute: boolean; selfDeaf: boolean }> = {},
) {
  const stateListeners: StateChangeListener[] = [];
  const conn = {
    rejoinAttempts: 0,
    state: { status: initialStatus } as StatusLike,
    joinConfig: {
      channelId: joinConfigOverrides.channelId ?? 'ch1',
      guildId: joinConfigOverrides.guildId ?? 'g1',
      selfMute: joinConfigOverrides.selfMute ?? false,
      selfDeaf: joinConfigOverrides.selfDeaf ?? false,
    },
    on: vi.fn((event: string, listener: StateChangeListener) => {
      if (event === 'stateChange') stateListeners.push(listener);
      return conn;
    }),
    destroy: vi.fn(() => {
      const old = { ...conn.state };
      conn.state = { status: VoiceConnectionStatus.Destroyed };
      for (const l of stateListeners) l(old, conn.state);
    }),
    rejoin: vi.fn((opts?: { selfMute?: boolean; selfDeaf?: boolean; channelId?: string }) => {
      conn.rejoinAttempts++;
      if (opts?.selfMute !== undefined) conn.joinConfig.selfMute = opts.selfMute;
      if (opts?.selfDeaf !== undefined) conn.joinConfig.selfDeaf = opts.selfDeaf;
      if (opts?.channelId !== undefined) conn.joinConfig.channelId = opts.channelId;
      return true;
    }),
    /** Simulate a state transition in tests. */
    _transition(status: string) {
      const old = { ...conn.state };
      conn.state = { status };
      for (const l of stateListeners) l(old, conn.state);
    },
  };
  return conn;
}

function createLogger(): LoggerLike {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const mockJoin = vi.mocked(joinVoiceChannel);
const fakeAdapter = (() => ({ destroy() {}, sendPayload: () => true })) as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('VoiceConnectionManager', () => {
  it('join returns a connection and tracks state as Ready', () => {
    const conn = createMockConnection();
    mockJoin.mockReturnValue(conn as never);

    const mgr = new VoiceConnectionManager(createLogger());
    const result = mgr.join({ channelId: 'ch1', guildId: 'g1', adapterCreator: fakeAdapter });

    expect(result).toBe(conn);
    conn._transition(VoiceConnectionStatus.Ready);
    expect(mgr.getState('g1')).toBe('ready');
  });

  it('leave destroys the connection and removes it from the map', () => {
    const conn = createMockConnection();
    mockJoin.mockReturnValue(conn as never);

    const mgr = new VoiceConnectionManager(createLogger());
    mgr.join({ channelId: 'ch1', guildId: 'g1', adapterCreator: fakeAdapter });

    mgr.leave('g1');

    expect(conn.destroy).toHaveBeenCalled();
    expect(mgr.getState('g1')).toBeUndefined();
  });

  it('leave is a no-op for unknown guild', () => {
    const mgr = new VoiceConnectionManager(createLogger());
    // Should not throw
    mgr.leave('unknown');
  });

  it('leaveAll destroys all tracked connections', () => {
    const conn1 = createMockConnection();
    const conn2 = createMockConnection();
    mockJoin.mockReturnValueOnce(conn1 as never).mockReturnValueOnce(conn2 as never);

    const mgr = new VoiceConnectionManager(createLogger());
    mgr.join({ channelId: 'ch1', guildId: 'g1', adapterCreator: fakeAdapter });
    mgr.join({ channelId: 'ch2', guildId: 'g2', adapterCreator: fakeAdapter });

    mgr.leaveAll();

    expect(conn1.destroy).toHaveBeenCalled();
    expect(conn2.destroy).toHaveBeenCalled();
    expect(mgr.getState('g1')).toBeUndefined();
    expect(mgr.getState('g2')).toBeUndefined();
  });

  it('reconnect fires on disconnect and succeeds within retry limit', () => {
    const conn = createMockConnection();
    mockJoin.mockReturnValue(conn as never);
    const log = createLogger();

    const mgr = new VoiceConnectionManager(log, { reconnectRetryLimit: 3 });
    mgr.join({ channelId: 'ch1', guildId: 'g1', adapterCreator: fakeAdapter });

    // Simulate disconnect
    conn._transition(VoiceConnectionStatus.Disconnected);

    expect(conn.rejoin).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalled();

    // Simulate successful reconnect
    conn._transition(VoiceConnectionStatus.Ready);
    expect(mgr.getState('g1')).toBe('ready');
  });

  it('reconnect exhausts retries and destroys the connection', () => {
    const conn = createMockConnection();
    mockJoin.mockReturnValue(conn as never);
    const log = createLogger();

    const mgr = new VoiceConnectionManager(log, { reconnectRetryLimit: 2 });
    mgr.join({ channelId: 'ch1', guildId: 'g1', adapterCreator: fakeAdapter });

    // First disconnect — rejoin attempt 1
    conn._transition(VoiceConnectionStatus.Disconnected);
    expect(conn.rejoin).toHaveBeenCalledTimes(1);
    expect(conn.rejoinAttempts).toBe(1);

    // Second disconnect — rejoin attempt 2
    conn._transition(VoiceConnectionStatus.Disconnected);
    expect(conn.rejoin).toHaveBeenCalledTimes(2);
    expect(conn.rejoinAttempts).toBe(2);

    // Third disconnect — limit exhausted, should destroy
    conn._transition(VoiceConnectionStatus.Disconnected);
    expect(conn.rejoin).toHaveBeenCalledTimes(2); // no additional rejoin
    expect(log.error).toHaveBeenCalled();
    expect(mgr.getState('g1')).toBeUndefined();
  });

  it('joining while already in a guild destroys the old connection first', () => {
    const conn1 = createMockConnection();
    const conn2 = createMockConnection();
    mockJoin.mockReturnValueOnce(conn1 as never).mockReturnValueOnce(conn2 as never);
    const log = createLogger();

    const mgr = new VoiceConnectionManager(log);
    mgr.join({ channelId: 'ch1', guildId: 'g1', adapterCreator: fakeAdapter });
    mgr.join({ channelId: 'ch2', guildId: 'g1', adapterCreator: fakeAdapter });

    expect(conn1.destroy).toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      { guildId: 'g1' },
      'destroying existing connection before rejoin',
    );
    // New connection is tracked
    conn2._transition(VoiceConnectionStatus.Ready);
    expect(mgr.getState('g1')).toBe('ready');
  });

  it('destroy cleans up all connections', () => {
    const conn = createMockConnection();
    mockJoin.mockReturnValue(conn as never);

    const mgr = new VoiceConnectionManager(createLogger());
    mgr.join({ channelId: 'ch1', guildId: 'g1', adapterCreator: fakeAdapter });

    mgr.destroy();

    expect(conn.destroy).toHaveBeenCalled();
    expect(mgr.getState('g1')).toBeUndefined();
  });

  it('getState returns undefined for unknown guild', () => {
    const mgr = new VoiceConnectionManager(createLogger());
    expect(mgr.getState('nonexistent')).toBeUndefined();
  });

  it('Destroyed state change removes connection from the map', () => {
    const conn = createMockConnection();
    mockJoin.mockReturnValue(conn as never);

    const mgr = new VoiceConnectionManager(createLogger());
    mgr.join({ channelId: 'ch1', guildId: 'g1', adapterCreator: fakeAdapter });

    // External destroy (e.g. adapter disconnect)
    conn._transition(VoiceConnectionStatus.Destroyed);
    expect(mgr.getState('g1')).toBeUndefined();
  });

  it('mute updates selfMute via rejoin', () => {
    const conn = createMockConnection();
    mockJoin.mockReturnValue(conn as never);

    const mgr = new VoiceConnectionManager(createLogger());
    mgr.join({ channelId: 'ch1', guildId: 'g1', adapterCreator: fakeAdapter });

    mgr.mute('g1', true);
    expect(conn.rejoin).toHaveBeenCalledWith({ channelId: 'ch1', selfMute: true, selfDeaf: false });
    expect(conn.joinConfig.selfMute).toBe(true);

    mgr.mute('g1', false);
    expect(conn.rejoin).toHaveBeenCalledWith({ channelId: 'ch1', selfMute: false, selfDeaf: false });
    expect(conn.joinConfig.selfMute).toBe(false);
  });

  it('mute is a no-op for unknown guild', () => {
    const mgr = new VoiceConnectionManager(createLogger());
    mgr.mute('unknown', true); // should not throw
  });

  it('deafen updates selfDeaf via rejoin', () => {
    const conn = createMockConnection();
    mockJoin.mockReturnValue(conn as never);

    const mgr = new VoiceConnectionManager(createLogger());
    mgr.join({ channelId: 'ch1', guildId: 'g1', adapterCreator: fakeAdapter });

    mgr.deafen('g1', true);
    expect(conn.rejoin).toHaveBeenCalledWith({ channelId: 'ch1', selfMute: false, selfDeaf: true });
    expect(conn.joinConfig.selfDeaf).toBe(true);

    mgr.deafen('g1', false);
    expect(conn.rejoin).toHaveBeenCalledWith({ channelId: 'ch1', selfMute: false, selfDeaf: false });
    expect(conn.joinConfig.selfDeaf).toBe(false);
  });

  it('deafen is a no-op for unknown guild', () => {
    const mgr = new VoiceConnectionManager(createLogger());
    mgr.deafen('unknown', true); // should not throw
  });

  it('getStatus returns connection metadata', () => {
    const conn = createMockConnection(VoiceConnectionStatus.Signalling, {
      channelId: 'ch1',
      guildId: 'g1',
    });
    mockJoin.mockReturnValue(conn as never);

    const mgr = new VoiceConnectionManager(createLogger());
    mgr.join({ channelId: 'ch1', guildId: 'g1', adapterCreator: fakeAdapter });
    conn._transition(VoiceConnectionStatus.Ready);

    const status = mgr.getStatus('g1');
    expect(status).toEqual({
      channelId: 'ch1',
      state: 'ready',
      selfMute: false,
      selfDeaf: false,
    });
  });

  it('getStatus reflects mute/deafen changes', () => {
    const conn = createMockConnection();
    mockJoin.mockReturnValue(conn as never);

    const mgr = new VoiceConnectionManager(createLogger());
    mgr.join({ channelId: 'ch1', guildId: 'g1', adapterCreator: fakeAdapter });
    conn._transition(VoiceConnectionStatus.Ready);

    mgr.mute('g1', true);
    mgr.deafen('g1', true);

    const status = mgr.getStatus('g1');
    expect(status).toEqual({
      channelId: 'ch1',
      state: 'ready',
      selfMute: true,
      selfDeaf: true,
    });
  });

  it('getStatus returns undefined for unknown guild', () => {
    const mgr = new VoiceConnectionManager(createLogger());
    expect(mgr.getStatus('nonexistent')).toBeUndefined();
  });

  it('listConnections returns all active connections with status', () => {
    const conn1 = createMockConnection(VoiceConnectionStatus.Signalling, {
      channelId: 'ch1',
      guildId: 'g1',
    });
    const conn2 = createMockConnection(VoiceConnectionStatus.Signalling, {
      channelId: 'ch2',
      guildId: 'g2',
    });
    mockJoin.mockReturnValueOnce(conn1 as never).mockReturnValueOnce(conn2 as never);

    const mgr = new VoiceConnectionManager(createLogger());
    mgr.join({ channelId: 'ch1', guildId: 'g1', adapterCreator: fakeAdapter });
    mgr.join({ channelId: 'ch2', guildId: 'g2', adapterCreator: fakeAdapter });

    conn1._transition(VoiceConnectionStatus.Ready);
    conn2._transition(VoiceConnectionStatus.Ready);

    const all = mgr.listConnections();
    expect(all.size).toBe(2);
    expect(all.get('g1')).toEqual({
      channelId: 'ch1',
      state: 'ready',
      selfMute: false,
      selfDeaf: false,
    });
    expect(all.get('g2')).toEqual({
      channelId: 'ch2',
      state: 'ready',
      selfMute: false,
      selfDeaf: false,
    });
  });

  it('listConnections returns empty map when no connections exist', () => {
    const mgr = new VoiceConnectionManager(createLogger());
    const all = mgr.listConnections();
    expect(all.size).toBe(0);
  });
});
