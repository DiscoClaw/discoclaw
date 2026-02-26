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

function createMockConnection(initialStatus = VoiceConnectionStatus.Signalling) {
  const stateListeners: StateChangeListener[] = [];
  const conn = {
    rejoinAttempts: 0,
    state: { status: initialStatus } as StatusLike,
    on: vi.fn((event: string, listener: StateChangeListener) => {
      if (event === 'stateChange') stateListeners.push(listener);
      return conn;
    }),
    destroy: vi.fn(() => {
      const old = { ...conn.state };
      conn.state = { status: VoiceConnectionStatus.Destroyed };
      for (const l of stateListeners) l(old, conn.state);
    }),
    rejoin: vi.fn(() => {
      conn.rejoinAttempts++;
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
});
