import { describe, expect, it, vi } from 'vitest';
import { ActivityType } from 'discord.js';
import { executeBotProfileAction } from './actions-bot-profile.js';
import type { ActionContext } from './actions.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<any> = {}): ActionContext {
  const setStatus = vi.fn();
  const setActivity = vi.fn();
  const setNickname = vi.fn();

  const me = {
    nickname: overrides.meNickname ?? null,
    user: { username: 'TestBot' },
    setNickname,
  };

  return {
    client: {
      user: { setStatus, setActivity },
    } as any,
    guild: {
      id: 'guild-1',
      members: {
        me: overrides.meNull ? null : me,
        fetchMe: vi.fn(async () => me),
      },
    } as any,
    channelId: 'ch-1',
    messageId: 'msg-1',
  };
}

// ---------------------------------------------------------------------------
// botSetStatus
// ---------------------------------------------------------------------------

describe('executeBotProfileAction — botSetStatus', () => {
  it.each(['online', 'idle', 'dnd', 'invisible'] as const)('sets status to %s', async (status) => {
    const ctx = makeCtx();
    const result = await executeBotProfileAction({ type: 'botSetStatus', status }, ctx);
    expect(result).toEqual({ ok: true, summary: `Status set to ${status}` });
    expect(ctx.client.user!.setStatus).toHaveBeenCalledWith(status);
  });

  it('rejects invalid status', async () => {
    const ctx = makeCtx();
    const result = await executeBotProfileAction({ type: 'botSetStatus', status: 'away' as any }, ctx);
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('Invalid status');
  });
});

// ---------------------------------------------------------------------------
// botSetActivity
// ---------------------------------------------------------------------------

describe('executeBotProfileAction — botSetActivity', () => {
  it('defaults to Playing type', async () => {
    const ctx = makeCtx();
    const result = await executeBotProfileAction({ type: 'botSetActivity', name: 'with beads' }, ctx);
    expect(result).toEqual({ ok: true, summary: 'Activity set to Playing: with beads' });
    expect(ctx.client.user!.setActivity).toHaveBeenCalledWith({ name: 'with beads', type: ActivityType.Playing });
  });

  it('sets explicit Listening type', async () => {
    const ctx = makeCtx();
    const result = await executeBotProfileAction({ type: 'botSetActivity', name: 'music', activityType: 'Listening' }, ctx);
    expect(result).toEqual({ ok: true, summary: 'Activity set to Listening: music' });
    expect(ctx.client.user!.setActivity).toHaveBeenCalledWith({ name: 'music', type: ActivityType.Listening });
  });

  it('Custom type uses state field', async () => {
    const ctx = makeCtx();
    const result = await executeBotProfileAction({ type: 'botSetActivity', name: 'Thinking hard', activityType: 'Custom' }, ctx);
    expect(result).toEqual({ ok: true, summary: 'Activity set to Custom: Thinking hard' });
    expect(ctx.client.user!.setActivity).toHaveBeenCalledWith({
      name: 'Custom Status',
      type: ActivityType.Custom,
      state: 'Thinking hard',
    });
  });

  it('rejects invalid activityType', async () => {
    const ctx = makeCtx();
    const result = await executeBotProfileAction({ type: 'botSetActivity', name: 'test', activityType: 'Streaming' as any }, ctx);
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('Invalid activityType');
  });

  it('rejects missing name', async () => {
    const ctx = makeCtx();
    const result = await executeBotProfileAction({ type: 'botSetActivity', name: '' }, ctx);
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('non-empty "name"');
  });
});

// ---------------------------------------------------------------------------
// botSetNickname
// ---------------------------------------------------------------------------

describe('executeBotProfileAction — botSetNickname', () => {
  it('sets nickname in current guild', async () => {
    const ctx = makeCtx();
    const result = await executeBotProfileAction({ type: 'botSetNickname', nickname: 'Weston' }, ctx);
    expect(result).toEqual({ ok: true, summary: 'Nickname set to "Weston"' });
    expect(ctx.guild.members.me!.setNickname).toHaveBeenCalledWith('Weston', 'Runtime nickname change via bot profile action');
  });

  it('rejects missing nickname', async () => {
    const ctx = makeCtx();
    const result = await executeBotProfileAction({ type: 'botSetNickname', nickname: '' }, ctx);
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('non-empty "nickname"');
  });

  it('fetches me when members.me is null', async () => {
    const ctx = makeCtx({ meNull: true });
    const result = await executeBotProfileAction({ type: 'botSetNickname', nickname: 'Weston' }, ctx);
    expect(result).toEqual({ ok: true, summary: 'Nickname set to "Weston"' });
    expect(ctx.guild.members.fetchMe).toHaveBeenCalled();
  });

  it('skips API call when nickname already matches', async () => {
    const ctx = makeCtx({ meNickname: 'Weston' });
    const result = await executeBotProfileAction({ type: 'botSetNickname', nickname: 'Weston' }, ctx);
    expect(result).toEqual({ ok: true, summary: 'Nickname already set to "Weston"' });
    expect(ctx.guild.members.me!.setNickname).not.toHaveBeenCalled();
  });

  it('skips API call when no nickname set and username matches', async () => {
    // meNickname defaults to null; username is 'TestBot'
    const ctx = makeCtx();
    const result = await executeBotProfileAction({ type: 'botSetNickname', nickname: 'TestBot' }, ctx);
    expect(result).toEqual({ ok: true, summary: 'Nickname already set to "TestBot"' });
    expect(ctx.guild.members.me!.setNickname).not.toHaveBeenCalled();
  });

  it('handles fetchMe failure gracefully', async () => {
    const ctx = makeCtx({ meNull: true });
    (ctx.guild.members.fetchMe as any).mockRejectedValueOnce(new Error('fetch failed'));
    const result = await executeBotProfileAction({ type: 'botSetNickname', nickname: 'Weston' }, ctx);
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('Could not fetch bot member');
  });

  it('handles permission error (50013) gracefully', async () => {
    const ctx = makeCtx();
    const permErr = new Error('Missing Permissions') as any;
    permErr.code = 50013;
    (ctx.guild.members.me!.setNickname as any).mockRejectedValueOnce(permErr);

    const result = await executeBotProfileAction({ type: 'botSetNickname', nickname: 'Weston' }, ctx);
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('Missing Permissions');
  });
});
