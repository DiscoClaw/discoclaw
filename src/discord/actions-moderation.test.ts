import { describe, expect, it, vi } from 'vitest';
import { executeModerationAction } from './actions-moderation.js';
import type { ActionContext } from './actions.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockMember(overrides: Partial<any> = {}) {
  return {
    id: overrides.id ?? 'user1',
    displayName: overrides.displayName ?? 'TestUser',
    user: { username: overrides.username ?? 'testuser' },
    timeout: vi.fn(async () => {}),
    kick: vi.fn(async () => {}),
    ban: vi.fn(async () => {}),
  };
}

function makeCtx(members: any[]): ActionContext {
  const memberMap = new Map<string, any>();
  for (const m of members) memberMap.set(m.id, m);

  return {
    guild: {
      members: {
        fetch: vi.fn(async (id: string) => {
          const m = memberMap.get(id);
          if (!m) throw new Error('not found');
          return m;
        }),
      },
    } as any,
    client: {} as any,
    channelId: 'ch1',
    messageId: 'msg1',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('timeout', () => {
  it('times out a member with default duration', async () => {
    const member = makeMockMember({ id: 'u1', displayName: 'Alice' });
    const ctx = makeCtx([member]);

    const result = await executeModerationAction(
      { type: 'timeout', userId: 'u1' },
      ctx,
    );

    expect(result).toEqual({ ok: true, summary: 'Timed out Alice for 5 minutes' });
    expect(member.timeout).toHaveBeenCalledWith(5 * 60 * 1000, undefined);
  });

  it('times out with custom duration and reason', async () => {
    const member = makeMockMember({ id: 'u1', displayName: 'Bob' });
    const ctx = makeCtx([member]);

    const result = await executeModerationAction(
      { type: 'timeout', userId: 'u1', durationMinutes: 30, reason: 'Spamming' },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect((result as any).summary).toContain('30 minutes');
    expect((result as any).summary).toContain('Spamming');
    expect(member.timeout).toHaveBeenCalledWith(30 * 60 * 1000, 'Spamming');
  });

  it('fails when member not found', async () => {
    const ctx = makeCtx([]);
    const result = await executeModerationAction(
      { type: 'timeout', userId: 'nope' },
      ctx,
    );
    expect(result).toEqual({ ok: false, error: 'Member "nope" not found' });
  });
});

describe('kick', () => {
  it('kicks a member', async () => {
    const member = makeMockMember({ id: 'u1', displayName: 'Spammer' });
    const ctx = makeCtx([member]);

    const result = await executeModerationAction(
      { type: 'kick', userId: 'u1', reason: 'Rule violation' },
      ctx,
    );

    expect(result).toEqual({ ok: true, summary: 'Kicked Spammer: Rule violation' });
    expect(member.kick).toHaveBeenCalledWith('Rule violation');
  });
});

describe('ban', () => {
  it('bans a member with message deletion', async () => {
    const member = makeMockMember({ id: 'u1', displayName: 'BadActor' });
    const ctx = makeCtx([member]);

    const result = await executeModerationAction(
      { type: 'ban', userId: 'u1', reason: 'Repeated violations', deleteMessageDays: 7 },
      ctx,
    );

    expect(result).toEqual({ ok: true, summary: 'Banned BadActor: Repeated violations' });
    expect(member.ban).toHaveBeenCalledWith({
      reason: 'Repeated violations',
      deleteMessageSeconds: 7 * 86400,
    });
  });

  it('bans without reason', async () => {
    const member = makeMockMember({ id: 'u1', displayName: 'User' });
    const ctx = makeCtx([member]);

    const result = await executeModerationAction(
      { type: 'ban', userId: 'u1' },
      ctx,
    );

    expect(result).toEqual({ ok: true, summary: 'Banned User' });
  });
});
