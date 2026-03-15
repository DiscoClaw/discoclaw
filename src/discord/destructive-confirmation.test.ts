import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetDestructiveConfirmationForTest as resetState,
  requestDestructiveConfirmation,
  consumeDestructiveConfirmation,
  describeDestructiveConfirmationRequirement,
} from './destructive-confirmation.js';

describe('destructive confirmation state', () => {
  beforeEach(() => {
    resetState();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reuses token for the same action/session/user while pending', () => {
    const action = { type: 'channelDelete', channelId: '123' };
    const first = requestDestructiveConfirmation(action, 'discord:channel:1', 'u1');
    const second = requestDestructiveConfirmation(action, 'discord:channel:1', 'u1');
    expect(first.token).toBe(second.token);
  });

  it('consumes token only for matching session and user', () => {
    const action = { type: 'channelDelete', channelId: '123' };
    const pending = requestDestructiveConfirmation(action, 'discord:channel:1', 'u1');
    expect(consumeDestructiveConfirmation(pending.token, 'discord:channel:2', 'u1')).toBeNull();
    expect(consumeDestructiveConfirmation(pending.token, 'discord:channel:1', 'u2')).toBeNull();
    const consumed = consumeDestructiveConfirmation(pending.token, 'discord:channel:1', 'u1');
    expect(consumed?.actionType).toBe('channelDelete');
    expect(consumeDestructiveConfirmation(pending.token, 'discord:channel:1', 'u1')).toBeNull();
  });

  it('blocks destructive actions in automated mode', () => {
    const decision = describeDestructiveConfirmationRequirement(
      { type: 'ban', userId: '42' },
      { mode: 'automated' },
    );
    expect(decision.allow).toBe(false);
    if (decision.allow) throw new Error('expected block');
    expect(decision.error).toContain('disabled in automated flows');
  });

  it('allows non-destructive actions without confirmation metadata', () => {
    const decision = describeDestructiveConfirmationRequirement(
      { type: 'channelList' },
      undefined,
    );
    expect(decision).toEqual({ allow: true });
  });

  it('generates a different token when random token collides with a pending entry', () => {
    const randomSpy = vi.spyOn(crypto, 'randomBytes');
    randomSpy
      .mockReturnValueOnce(Buffer.from('aaaaaaaa', 'hex') as any)
      .mockReturnValueOnce(Buffer.from('aaaaaaaa', 'hex') as any)
      .mockReturnValueOnce(Buffer.from('bbbbbbbb', 'hex') as any);

    const first = requestDestructiveConfirmation(
      { type: 'channelDelete', channelId: 'c1' },
      'discord:channel:1',
      'u1',
    );
    const second = requestDestructiveConfirmation(
      { type: 'ban', userId: '42' },
      'discord:channel:1',
      'u1',
    );

    expect(first.token).toBe('aaaaaaaa');
    expect(second.token).toBe('bbbbbbbb');
    expect(first.token).not.toBe(second.token);
  });
});
