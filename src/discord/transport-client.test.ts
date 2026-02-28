import { describe, expect, it, vi } from 'vitest';
import { DiscordTransportClient } from './transport-client.js';

// ---------------------------------------------------------------------------
// Minimal mock helpers
// ---------------------------------------------------------------------------

function makeMockGuild(overrides: Record<string, unknown> = {}) {
  return {
    id: 'guild-1',
    channels: {
      cache: {
        get: vi.fn(),
        find: vi.fn(),
        values: vi.fn((): IterableIterator<any> => [][Symbol.iterator]()),
      },
      create: vi.fn(),
    },
    members: {
      me: overrides.me ?? null,
      fetch: vi.fn(),
      fetchMe: vi.fn(),
    },
    roles: {
      cache: {
        get: vi.fn(),
        find: vi.fn(),
        values: vi.fn((): IterableIterator<any> => [][Symbol.iterator]()),
      },
    },
    scheduledEvents: {
      fetch: vi.fn(),
      create: vi.fn(),
      edit: vi.fn(),
      delete: vi.fn(),
    },
    voiceAdapterCreator: vi.fn(),
  };
}

function makeMockClient() {
  return {
    user: {
      id: 'bot-user-1',
      setStatus: vi.fn(),
      setActivity: vi.fn(),
    },
    channels: {
      cache: {
        get: vi.fn(),
      },
      fetch: vi.fn(),
    },
  };
}

function makeTransport(
  guildOverrides: Record<string, unknown> = {},
) {
  const guild = makeMockGuild(guildOverrides);
  const client = makeMockClient();
  const transport = new DiscordTransportClient(guild as any, client as any);
  return { transport, guild, client };
}

// ---------------------------------------------------------------------------
// Guild identity
// ---------------------------------------------------------------------------

describe('DiscordTransportClient — guildId', () => {
  it('returns the guild id', () => {
    const { transport } = makeTransport();
    expect(transport.guildId).toBe('guild-1');
  });
});

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

describe('DiscordTransportClient — channels', () => {
  it('getChannel delegates to guild.channels.cache.get', () => {
    const { transport, guild } = makeTransport();
    const ch = { id: 'ch-1', name: 'general' };
    guild.channels.cache.get.mockReturnValue(ch);

    expect(transport.getChannel('ch-1')).toBe(ch);
    expect(guild.channels.cache.get).toHaveBeenCalledWith('ch-1');
  });

  it('findChannel delegates to guild.channels.cache.find', () => {
    const { transport, guild } = makeTransport();
    const ch = { id: 'ch-2', name: 'random' };
    guild.channels.cache.find.mockReturnValue(ch);

    const pred = (c: any) => c.name === 'random';
    expect(transport.findChannel(pred)).toBe(ch);
    expect(guild.channels.cache.find).toHaveBeenCalledWith(pred);
  });

  it('listChannels delegates to guild.channels.cache.values', () => {
    const { transport, guild } = makeTransport();
    const channels = [{ id: 'ch-1' }, { id: 'ch-2' }] as any[];
    guild.channels.cache.values.mockReturnValue(channels[Symbol.iterator]());

    expect([...transport.listChannels()]).toEqual(channels);
    expect(guild.channels.cache.values).toHaveBeenCalled();
  });

  it('createChannel delegates to guild.channels.create', async () => {
    const { transport, guild } = makeTransport();
    const created = { id: 'ch-new', name: 'new-channel' };
    guild.channels.create.mockResolvedValue(created);

    const opts = { name: 'new-channel' } as any;
    const result = await transport.createChannel(opts);
    expect(result).toBe(created);
    expect(guild.channels.create).toHaveBeenCalledWith(opts);
  });

  it('fetchClientChannel delegates to client.channels.fetch', async () => {
    const { transport, client } = makeTransport();
    const ch = { id: 'ch-remote' };
    client.channels.fetch.mockResolvedValue(ch);

    const result = await transport.fetchClientChannel('ch-remote');
    expect(result).toBe(ch);
    expect(client.channels.fetch).toHaveBeenCalledWith('ch-remote');
  });

  it('fetchClientChannel returns null when fetch resolves to null', async () => {
    const { transport, client } = makeTransport();
    client.channels.fetch.mockResolvedValue(null);

    expect(await transport.fetchClientChannel('missing')).toBeNull();
  });

  it('getClientChannel delegates to client.channels.cache.get', () => {
    const { transport, client } = makeTransport();
    const ch = { id: 'ch-cached' };
    client.channels.cache.get.mockReturnValue(ch);

    expect(transport.getClientChannel('ch-cached')).toBe(ch);
    expect(client.channels.cache.get).toHaveBeenCalledWith('ch-cached');
  });

  it('getClientChannel returns null when not cached', () => {
    const { transport, client } = makeTransport();
    client.channels.cache.get.mockReturnValue(undefined);

    expect(transport.getClientChannel('missing')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

describe('DiscordTransportClient — members', () => {
  it('fetchMember delegates to guild.members.fetch', async () => {
    const { transport, guild } = makeTransport();
    const member = { id: 'user-1', displayName: 'Alice' };
    guild.members.fetch.mockResolvedValue(member);

    expect(await transport.fetchMember('user-1')).toBe(member);
    expect(guild.members.fetch).toHaveBeenCalledWith('user-1');
  });

  it('fetchMember returns null on error', async () => {
    const { transport, guild } = makeTransport();
    guild.members.fetch.mockRejectedValue(new Error('not found'));

    expect(await transport.fetchMember('missing')).toBeNull();
  });

  it('getBotMember returns guild.members.me', () => {
    const me = { id: 'bot-1', displayName: 'Bot' };
    const { transport } = makeTransport({ me });

    expect(transport.getBotMember()).toBe(me);
  });

  it('getBotMember returns null when me is null', () => {
    const { transport } = makeTransport({ me: null });

    expect(transport.getBotMember()).toBeNull();
  });

  it('fetchBotMember delegates to guild.members.fetchMe', async () => {
    const { transport, guild } = makeTransport();
    const me = { id: 'bot-1' };
    guild.members.fetchMe.mockResolvedValue(me);

    expect(await transport.fetchBotMember()).toBe(me);
    expect(guild.members.fetchMe).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Bot user
// ---------------------------------------------------------------------------

describe('DiscordTransportClient — bot user', () => {
  it('botUserId returns client.user.id', () => {
    const { transport } = makeTransport();
    expect(transport.botUserId).toBe('bot-user-1');
  });

  it('setPresenceStatus delegates to client.user.setStatus', () => {
    const { transport, client } = makeTransport();
    transport.setPresenceStatus('idle');
    expect(client.user.setStatus).toHaveBeenCalledWith('idle');
  });

  it('setPresenceActivity delegates to client.user.setActivity', () => {
    const { transport, client } = makeTransport();
    const activity = { name: 'testing', type: 0 } as any;
    transport.setPresenceActivity(activity);
    expect(client.user.setActivity).toHaveBeenCalledWith(activity);
  });
});

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

describe('DiscordTransportClient — roles', () => {
  it('getRole delegates to guild.roles.cache.get', () => {
    const { transport, guild } = makeTransport();
    const role = { id: 'role-1', name: 'Moderator' };
    guild.roles.cache.get.mockReturnValue(role);

    expect(transport.getRole('role-1')).toBe(role);
    expect(guild.roles.cache.get).toHaveBeenCalledWith('role-1');
  });

  it('findRole delegates to guild.roles.cache.find', () => {
    const { transport, guild } = makeTransport();
    const role = { id: 'role-2', name: 'Admin' };
    guild.roles.cache.find.mockReturnValue(role);

    const pred = (r: any) => r.name === 'Admin';
    expect(transport.findRole(pred)).toBe(role);
    expect(guild.roles.cache.find).toHaveBeenCalledWith(pred);
  });

  it('listRoles delegates to guild.roles.cache.values', () => {
    const { transport, guild } = makeTransport();
    const roles = [{ id: 'r1' }, { id: 'r2' }] as any[];
    guild.roles.cache.values.mockReturnValue(roles[Symbol.iterator]());

    expect([...transport.listRoles()]).toEqual(roles);
    expect(guild.roles.cache.values).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Scheduled events
// ---------------------------------------------------------------------------

describe('DiscordTransportClient — scheduled events', () => {
  it('fetchScheduledEvents delegates and returns a Map', async () => {
    const { transport, guild } = makeTransport();
    const event1 = { id: 'ev-1', name: 'Event 1' };
    const event2 = { id: 'ev-2', name: 'Event 2' };
    const collection = {
      map: vi.fn((fn: any) => [event1, event2].map(fn)),
    };
    guild.scheduledEvents.fetch.mockResolvedValue(collection);

    const result = await transport.fetchScheduledEvents();
    expect(result).toBeInstanceOf(Map);
    expect(result.get('ev-1')).toBe(event1);
    expect(result.get('ev-2')).toBe(event2);
    expect(guild.scheduledEvents.fetch).toHaveBeenCalled();
  });

  it('createScheduledEvent delegates to guild.scheduledEvents.create', async () => {
    const { transport, guild } = makeTransport();
    const event = { id: 'ev-new', name: 'New Event' };
    guild.scheduledEvents.create.mockResolvedValue(event);

    const opts = { name: 'New Event' };
    const result = await transport.createScheduledEvent(opts);
    expect(result).toBe(event);
    expect(guild.scheduledEvents.create).toHaveBeenCalledWith(opts);
  });

  it('editScheduledEvent delegates to guild.scheduledEvents.edit', async () => {
    const { transport, guild } = makeTransport();
    const event = { id: 'ev-1', name: 'Updated' };
    guild.scheduledEvents.edit.mockResolvedValue(event);

    const opts = { name: 'Updated' };
    const result = await transport.editScheduledEvent('ev-1', opts);
    expect(result).toBe(event);
    expect(guild.scheduledEvents.edit).toHaveBeenCalledWith('ev-1', opts);
  });

  it('deleteScheduledEvent delegates to guild.scheduledEvents.delete', async () => {
    const { transport, guild } = makeTransport();
    guild.scheduledEvents.delete.mockResolvedValue(undefined);

    await transport.deleteScheduledEvent('ev-1');
    expect(guild.scheduledEvents.delete).toHaveBeenCalledWith('ev-1');
  });

  it('fetchScheduledEvent delegates and returns the event', async () => {
    const { transport, guild } = makeTransport();
    const event = { id: 'ev-1', name: 'Event' };
    guild.scheduledEvents.fetch.mockResolvedValue(event);

    const result = await transport.fetchScheduledEvent('ev-1');
    expect(result).toBe(event);
    expect(guild.scheduledEvents.fetch).toHaveBeenCalledWith('ev-1');
  });

  it('fetchScheduledEvent returns null on error', async () => {
    const { transport, guild } = makeTransport();
    guild.scheduledEvents.fetch.mockRejectedValue(new Error('not found'));

    expect(await transport.fetchScheduledEvent('missing')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------

describe('DiscordTransportClient — voice', () => {
  it('voiceAdapterCreator returns guild.voiceAdapterCreator', () => {
    const { transport, guild } = makeTransport();
    expect(transport.voiceAdapterCreator).toBe(guild.voiceAdapterCreator);
  });
});
