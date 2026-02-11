import { describe, expect, it, vi } from 'vitest';
import { setBotNickname } from '../discord.js';

function mockGuild(overrides?: Record<string, any>) {
  const me = {
    nickname: null as string | null,
    user: { username: 'Discoclaw' },
    setNickname: vi.fn().mockResolvedValue(undefined),
    ...overrides?.me,
  };
  return {
    id: 'guild-1',
    members: {
      me,
      fetchMe: vi.fn().mockResolvedValue(me),
    },
    ...overrides,
  };
}

function mockLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('setBotNickname', () => {
  it('sets nickname when different from current', async () => {
    const guild = mockGuild();
    const log = mockLog();
    await setBotNickname(guild, 'Weston', log);
    expect(guild.members.me.setNickname).toHaveBeenCalledWith('Weston', 'Automatic nickname from bot identity');
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ guildId: 'guild-1', nickname: 'Weston' }),
      'discord:nickname set',
    );
  });

  it('skips when nickname already matches', async () => {
    const me = { nickname: 'Weston', user: { username: 'Discoclaw' }, setNickname: vi.fn() };
    const guild = { id: 'guild-1', members: { me, fetchMe: vi.fn() } };
    const log = mockLog();
    await setBotNickname(guild, 'Weston', log);
    expect(me.setNickname).not.toHaveBeenCalled();
  });

  it('skips when username matches and no nickname set', async () => {
    const me = { nickname: null, user: { username: 'Weston' }, setNickname: vi.fn() };
    const guild = { id: 'guild-1', members: { me, fetchMe: vi.fn() } };
    const log = mockLog();
    await setBotNickname(guild, 'Weston', log);
    expect(me.setNickname).not.toHaveBeenCalled();
  });

  it('handles missing permissions gracefully (error code 50013)', async () => {
    const err = Object.assign(new Error('Missing Permissions'), { code: 50013 });
    const guild = mockGuild();
    guild.members.me.setNickname = vi.fn().mockRejectedValue(err);
    const log = mockLog();
    await setBotNickname(guild, 'Weston', log);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ guildId: 'guild-1' }),
      'discord:nickname Missing Permissions — cannot set nickname',
    );
  });

  it('handles null guild.members.me by calling fetchMe()', async () => {
    const me = {
      nickname: null as string | null,
      user: { username: 'Discoclaw' },
      setNickname: vi.fn().mockResolvedValue(undefined),
    };
    const guild = {
      id: 'guild-1',
      members: {
        me: null,
        fetchMe: vi.fn().mockResolvedValue(me),
      },
    };
    const log = mockLog();
    await setBotNickname(guild, 'Weston', log);
    expect(guild.members.fetchMe).toHaveBeenCalledOnce();
    expect(me.setNickname).toHaveBeenCalledWith('Weston', 'Automatic nickname from bot identity');
  });

  it('handles other errors gracefully', async () => {
    const err = new Error('Unknown error');
    const guild = mockGuild();
    guild.members.me.setNickname = vi.fn().mockRejectedValue(err);
    const log = mockLog();
    await setBotNickname(guild, 'Weston', log);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err, guildId: 'guild-1' }),
      'discord:nickname failed to set',
    );
  });
});
