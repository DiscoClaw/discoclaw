import { describe, expect, it } from 'vitest';
import { LaunchStore } from './launch-store.js';

describe('LaunchStore', () => {
  it('supports pending launch resolution and bound-session replay', () => {
    let now = Date.parse('2026-03-18T12:00:00Z');
    const store = new LaunchStore({
      pendingTtlMs: 120_000,
      boundSessionTtlMs: 600_000,
      now: () => now,
    });
    const ctx = { userId: 'user-1', channelId: 'channel-1', guildId: 'guild-1' };

    store.registerPending(ctx, 'artifact-1');
    const initial = store.resolveCurrent(ctx);
    expect(initial?.target).toEqual({ type: 'artifact', artifactId: 'artifact-1' });
    expect(initial?.source).toBe('pending');
    expect(store.hasPending(ctx)).toBe(false);

    now += 10_000;
    const replay = store.resolveCurrent(ctx, initial?.boundSessionToken);
    expect(replay?.target).toEqual({ type: 'artifact', artifactId: 'artifact-1' });
    expect(replay?.source).toBe('bound-session');
    expect(replay?.boundSessionToken).not.toBe(initial?.boundSessionToken);
  });

  it('applies latest-click-wins for the same user and channel context', () => {
    const store = new LaunchStore({
      pendingTtlMs: 120_000,
      boundSessionTtlMs: 600_000,
    });
    const ctx = { userId: 'user-1', channelId: 'channel-1', guildId: 'guild-1' };

    store.registerPending(ctx, 'artifact-1');
    store.registerPending(ctx, 'artifact-2');
    const resolution = store.resolveCurrent(ctx);

    expect(resolution?.target).toEqual({ type: 'artifact', artifactId: 'artifact-2' });
  });

  it('expires pending launches after the configured TTL', () => {
    let now = Date.parse('2026-03-18T12:00:00Z');
    const store = new LaunchStore({
      pendingTtlMs: 1_000,
      boundSessionTtlMs: 600_000,
      now: () => now,
    });
    const ctx = { userId: 'user-1', channelId: 'channel-1', guildId: 'guild-1' };

    store.registerPending(ctx, 'artifact-1');
    now += 1_500;

    expect(store.resolveCurrent(ctx)).toBeNull();
  });

  it('supports built-in app launches', () => {
    const store = new LaunchStore({
      pendingTtlMs: 120_000,
      boundSessionTtlMs: 600_000,
    });
    const ctx = { userId: 'user-1', channelId: 'channel-1', guildId: 'guild-1' };

    const ref = store.createAppLaunchRef('dashboard');
    expect(store.parseLaunchRef(ref)).toEqual({ type: 'app', appName: 'dashboard' });

    store.registerPending(ctx, { type: 'app', appName: 'dashboard' });
    const resolution = store.resolveCurrent(ctx);

    expect(resolution?.target).toEqual({ type: 'app', appName: 'dashboard' });
    expect(store.verifyBoundSession(String(resolution?.boundSessionToken), ctx)?.target).toEqual({
      type: 'app',
      appName: 'dashboard',
    });
  });

  it('keeps launch refs valid across restarts when the signer secret is stable', () => {
    const first = new LaunchStore({
      pendingTtlMs: 120_000,
      boundSessionTtlMs: 600_000,
      launchRefSecret: 'stable-canvas-secret',
    });
    const second = new LaunchStore({
      pendingTtlMs: 120_000,
      boundSessionTtlMs: 600_000,
      launchRefSecret: 'stable-canvas-secret',
    });

    const artifactRef = first.createArtifactLaunchRef('artifact-1');
    const appRef = first.createAppLaunchRef('dashboard');

    expect(second.parseLaunchRef(artifactRef)).toEqual({ type: 'artifact', artifactId: 'artifact-1' });
    expect(second.parseLaunchRef(appRef)).toEqual({ type: 'app', appName: 'dashboard' });
  });

  it('peeks at pending entries by activity context without consuming them', () => {
    const store = new LaunchStore({
      pendingTtlMs: 120_000,
      boundSessionTtlMs: 600_000,
    });
    const ctx = { userId: 'user-1', channelId: 'channel-1', guildId: 'guild-1' };

    expect(store.peekByActivity('channel-1', 'guild-1')).toBeNull();

    store.registerPending(ctx, 'artifact-1');
    const peeked = store.peekByActivity('channel-1', 'guild-1');
    expect(peeked).toEqual({ userId: 'user-1' });

    // Peek does not consume — hasPending and resolveCurrent still work
    expect(store.hasPending(ctx)).toBe(true);
    const resolved = store.resolveCurrent(ctx);
    expect(resolved?.target).toEqual({ type: 'artifact', artifactId: 'artifact-1' });
  });

  it('prefers a fresh pending launch over an older bound session in the same context', () => {
    const store = new LaunchStore({
      pendingTtlMs: 120_000,
      boundSessionTtlMs: 600_000,
    });
    const ctx = { userId: 'user-1', channelId: 'channel-1', guildId: 'guild-1' };

    store.registerPending(ctx, 'artifact-1');
    const first = store.resolveCurrent(ctx);
    expect(first?.target).toEqual({ type: 'artifact', artifactId: 'artifact-1' });

    store.registerPending(ctx, { type: 'app', appName: 'dashboard' });
    const next = store.resolveCurrent(ctx, first?.boundSessionToken);

    expect(next?.source).toBe('pending');
    expect(next?.target).toEqual({ type: 'app', appName: 'dashboard' });
  });
});
