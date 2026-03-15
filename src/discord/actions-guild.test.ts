import { describe, expect, it, vi } from 'vitest';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { executeGuildAction, isoToSnowflake } from './actions-guild.js';
import { REQUESTER_MEMBER_DENY_ALL } from './actions.js';
import type { ActionContext } from './actions.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockMember(overrides: Partial<any> = {}) {
  const roleList = overrides.roles ?? [];
  const roles = new Map<string, any>();
  for (const r of roleList) {
    roles.set(r.id, r);
  }
  const highestPosition = roleList.reduce((max: number, role: { position?: number }) => (
    typeof role.position === 'number' && role.position > max ? role.position : max
  ), 0);
  const granted = overrides.permissionsBitfield ?? 0n;

  return {
    id: overrides.id ?? 'user1',
    displayName: overrides.displayName ?? 'TestUser',
    user: {
      username: overrides.username ?? 'testuser',
      bot: overrides.bot ?? false,
    },
    joinedAt: overrides.joinedAt ?? new Date('2024-01-01T00:00:00Z'),
    roles: {
      highest: { position: overrides.highestRolePosition ?? highestPosition },
      cache: {
        filter: (fn: any) => {
          const filtered = [...roles.values()].filter(fn);
          return { map: (mapFn: any) => filtered.map(mapFn) };
        },
        values: () => roles.values(),
      },
      add: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    },
    permissions: {
      has: (perm: bigint) => (granted & perm) === perm,
    },
    timeout: vi.fn(async () => {}),
    kick: vi.fn(async () => {}),
    ban: vi.fn(async () => {}),
  };
}

function makeCtx(overrides: Partial<any> = {}): ActionContext {
  const channels = new Map<string, any>();
  for (const ch of (overrides.channels ?? [])) {
    channels.set(ch.id, ch);
  }

  const roles = new Map<string, any>();
  for (const r of (overrides.roles ?? [])) {
    roles.set(r.id, r);
  }

  const members = new Map<string, any>();
  for (const m of (overrides.members ?? [])) {
    members.set(m.id, m);
  }

  return {
    guild: {
      channels: {
        cache: {
          get: (id: string) => channels.get(id),
          find: (fn: any) => {
            for (const ch of channels.values()) {
              if (fn(ch)) return ch;
            }
            return undefined;
          },
          values: () => channels.values(),
        },
      },
      members: {
        fetch: vi.fn(async (id: string) => {
          const m = members.get(id);
          if (!m) throw new Error('not found');
          return m;
        }),
      },
      roles: {
        cache: {
          get: (id: string) => roles.get(id),
          find: (fn: any) => {
            for (const r of roles.values()) {
              if (fn(r)) return r;
            }
            return undefined;
          },
          values: () => roles.values(),
        },
      },
      scheduledEvents: {
        fetch: vi.fn(async (idOrUndefined?: string) => {
          if (typeof idOrUndefined === 'string') {
            const ev = (overrides.events as Map<string, any>)?.get(idOrUndefined);
            if (!ev) throw new Error('not found');
            return ev;
          }
          return overrides.events ?? new Map();
        }),
        create: vi.fn(async (opts: any) => ({ name: opts.name })),
        edit: vi.fn(async (_id: string, opts: any) => ({ name: opts.name ?? 'Edited Event' })),
        delete: vi.fn(async () => {}),
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

describe('memberInfo', () => {
  it('returns member info', async () => {
    const member = makeMockMember({
      id: 'u1',
      username: 'alice',
      displayName: 'Alice',
      roles: [{ id: 'r1', name: 'Admin' }],
    });
    const ctx = makeCtx({ members: [member] });

    const result = await executeGuildAction(
      { type: 'memberInfo', userId: 'u1' },
      ctx,
    );

    expect(result.ok).toBe(true);
    const summary = (result as any).summary as string;
    expect(summary).toContain('Username: alice');
    expect(summary).toContain('Display: Alice');
    expect(summary).toContain('Admin');
  });

  it('fails when member not found', async () => {
    const ctx = makeCtx({});
    const result = await executeGuildAction(
      { type: 'memberInfo', userId: 'nonexistent' },
      ctx,
    );
    expect(result).toEqual({ ok: false, error: 'Member "nonexistent" not found' });
  });
});

describe('roleInfo', () => {
  it('lists roles sorted by position', async () => {
    const roles = [
      { id: 'r1', name: 'Admin', position: 2, members: { size: 3 } },
      { id: 'r2', name: 'Member', position: 1, members: { size: 10 } },
    ];
    const ctx = makeCtx({ roles });

    const result = await executeGuildAction({ type: 'roleInfo' }, ctx);

    expect(result.ok).toBe(true);
    const summary = (result as any).summary as string;
    expect(summary).toContain('Admin');
    expect(summary).toContain('Member');
    // Admin should come first (higher position).
    expect(summary.indexOf('Admin')).toBeLessThan(summary.indexOf('Member'));
  });
});

describe('roleAdd / roleRemove', () => {
  it('adds a role by name', async () => {
    const member = makeMockMember({ id: 'u1', displayName: 'Alice' });
    const role = { id: 'r1', name: 'Moderator', position: 1 };
    const ctx = makeCtx({ members: [member], roles: [role] });

    const result = await executeGuildAction(
      { type: 'roleAdd', userId: 'u1', role: 'Moderator' },
      ctx,
    );

    expect(result).toEqual({ ok: true, summary: 'Added role "Moderator" to Alice' });
    expect(member.roles.add).toHaveBeenCalledWith('r1');
  });

  it('removes a role by name', async () => {
    const member = makeMockMember({ id: 'u1', displayName: 'Alice' });
    const role = { id: 'r1', name: 'Moderator', position: 1 };
    const ctx = makeCtx({ members: [member], roles: [role] });

    const result = await executeGuildAction(
      { type: 'roleRemove', userId: 'u1', role: 'Moderator' },
      ctx,
    );

    expect(result).toEqual({ ok: true, summary: 'Removed role "Moderator" from Alice' });
    expect(member.roles.remove).toHaveBeenCalledWith('r1');
  });

  it('fails when role not found', async () => {
    const member = makeMockMember({ id: 'u1' });
    const ctx = makeCtx({ members: [member] });

    const result = await executeGuildAction(
      { type: 'roleAdd', userId: 'u1', role: 'Nonexistent' },
      ctx,
    );

    expect(result).toEqual({ ok: false, error: 'Role "Nonexistent" not found' });
  });

  it('denies gated role changes when requester resolution failed', async () => {
    const member = makeMockMember({ id: 'u1', displayName: 'Alice' });
    const role = { id: 'r1', name: 'Moderator', position: 1 };
    const ctx = makeCtx({ members: [member], roles: [role] });

    const result = await executeGuildAction(
      { type: 'roleAdd', userId: 'u1', role: 'Moderator' },
      ctx,
      REQUESTER_MEMBER_DENY_ALL,
    );

    expect(result).toEqual({ ok: false, error: 'Permission denied for roleAdd' });
    expect(member.roles.add).not.toHaveBeenCalled();
  });

  it('denies roleAdd when requester is below the target role hierarchy', async () => {
    const target = makeMockMember({
      id: 'u1',
      displayName: 'Alice',
      roles: [{ id: 'member-role', name: 'Member', position: 1 }],
    });
    const role = { id: 'r1', name: 'Moderator', position: 5 };
    const requester = makeMockMember({
      id: 'requester',
      permissionsBitfield: PermissionFlagsBits.ManageRoles,
      roles: [{ id: 'req-role', name: 'Helper', position: 4 }],
    });
    const ctx = makeCtx({ members: [target], roles: [role] });

    const result = await executeGuildAction(
      { type: 'roleAdd', userId: 'u1', role: 'Moderator' },
      ctx,
      requester as any,
    );

    expect(result).toEqual({ ok: false, error: 'Permission denied for roleAdd' });
    expect(target.roles.add).not.toHaveBeenCalled();
  });
});

describe('isoToSnowflake', () => {
  it('passes through raw snowflake IDs', () => {
    expect(isoToSnowflake('123456789012345678')).toBe('123456789012345678');
  });

  it('converts ISO date to snowflake', () => {
    const result = isoToSnowflake('2025-01-01T00:00:00Z');
    expect(result).not.toBeNull();
    // Should be a large numeric string
    expect(/^\d+$/.test(result!)).toBe(true);
  });

  it('returns null for invalid input', () => {
    expect(isoToSnowflake('not-a-date')).toBeNull();
    expect(isoToSnowflake('')).toBeNull();
  });

  it('returns null for pre-epoch dates', () => {
    expect(isoToSnowflake('2014-01-01')).toBeNull();
    expect(isoToSnowflake('1970-01-01T00:00:00Z')).toBeNull();
  });
});

describe('searchMessages', () => {
  /** Helper: create a channel with a paginated messages.fetch mock. */
  function makeChannel(pages: Array<Array<{ id: string; content: string; author: { username: string }; createdAt?: Date }>>) {
    let callIdx = 0;
    return {
      id: 'ch1',
      name: 'general',
      type: ChannelType.GuildText,
      permissionsFor: vi.fn(() => ({
        has: (perm: bigint) => (
          (PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory) & perm
        ) === perm,
      })),
      messages: {
        fetch: vi.fn(async () => {
          const page = pages[callIdx] ?? [];
          callIdx++;
          const map = new Map(page.map((m) => [m.id, m]));
          return map;
        }),
      },
    };
  }

  it('finds matching messages across pages', async () => {
    // Page 1: exactly 100 messages so pagination continues.
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: String(10200 - i),
      content: i === 5 ? 'Hello world' : 'noise',
      author: { username: i === 5 ? 'bob' : 'filler' },
    }));
    const page2 = [
      { id: '10050', content: 'Hello again', author: { username: 'carol' } },
    ];
    const ch = makeChannel([page1, page2]);
    const ctx = makeCtx({ channels: [ch] });

    const result = await executeGuildAction(
      { type: 'searchMessages', query: 'hello', channel: '#general' },
      ctx,
    );

    expect(result.ok).toBe(true);
    const summary = (result as any).summary as string;
    expect(summary).toContain('[bob]');
    expect(summary).toContain('[carol]');
    expect(summary).toContain('2 found');
  });

  it('stops scanning when channel is exhausted', async () => {
    // Single partial page (< 100 messages).
    const page1 = [
      { id: '50', content: 'Match here', author: { username: 'alice' } },
    ];
    const ch = makeChannel([page1]);
    const ctx = makeCtx({ channels: [ch] });

    const result = await executeGuildAction(
      { type: 'searchMessages', query: 'match', channel: '#general' },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(ch.messages.fetch).toHaveBeenCalledTimes(1);
  });

  it('stops scanning when after boundary is hit mid-page', async () => {
    // Use snowflake-length IDs. after boundary = message ID 15000000000000000150.
    const page1 = [
      { id: '15000000000000000200', content: 'Match A', author: { username: 'alice' } },
      { id: '15000000000000000180', content: 'Match B', author: { username: 'bob' } },
      { id: '15000000000000000160', content: 'Match C', author: { username: 'carol' } },
      { id: '15000000000000000140', content: 'Match D past boundary', author: { username: 'dave' } },
    ];
    const ch = makeChannel([page1]);
    const ctx = makeCtx({ channels: [ch] });

    const result = await executeGuildAction(
      { type: 'searchMessages', query: 'match', channel: '#general', after: '15000000000000000150' },
      ctx,
    );

    expect(result.ok).toBe(true);
    const summary = (result as any).summary as string;
    // Only A, B, C should match (IDs > boundary).
    expect(summary).toContain('3 found');
    expect(summary).not.toContain('dave');
  });

  it('respects maxPages cap', async () => {
    // 100 messages per page, maxPages = 1 → only 1 fetch call.
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      id: String(10000 - i),
      content: i === 50 ? 'target' : 'noise',
      author: { username: 'user' },
    }));
    const ch = makeChannel([fullPage, fullPage]);
    const ctx = makeCtx({ channels: [ch] });

    const result = await executeGuildAction(
      { type: 'searchMessages', query: 'target', channel: '#general', maxPages: 1 },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(ch.messages.fetch).toHaveBeenCalledTimes(1);
  });

  it('returns no-match message with scan count', async () => {
    const page1 = [
      { id: '200', content: 'nothing relevant', author: { username: 'alice' } },
    ];
    const ch = makeChannel([page1]);
    const ctx = makeCtx({ channels: [ch] });

    const result = await executeGuildAction(
      { type: 'searchMessages', query: 'zzzzz', channel: '#general' },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect((result as any).summary).toContain('No messages matching');
    expect((result as any).summary).toContain('scanned 1');
  });

  it('denies search when requester lacks channel history permissions', async () => {
    const ch = makeChannel([[{ id: '1', content: 'hello', author: { username: 'bob' } }]]);
    ch.permissionsFor = vi.fn(() => ({
      has: (perm: bigint) => (PermissionFlagsBits.ViewChannel & perm) === perm,
    }));
    const requester = makeMockMember({ id: 'requester' });
    const ctx = makeCtx({ channels: [ch] });

    const result = await executeGuildAction(
      { type: 'searchMessages', query: 'hello', channel: 'ch1' },
      ctx,
      requester as any,
    );

    expect(result).toEqual({ ok: false, error: 'Permission denied for searchMessages' });
    expect(ch.messages.fetch).not.toHaveBeenCalled();
  });
});

describe('searchMessages — empty channel', () => {
  function makeChannel(pages: Array<Array<{ id: string; content: string; author: { username: string } }>>) {
    let callIdx = 0;
    return {
      id: 'ch1',
      name: 'general',
      type: ChannelType.GuildText,
      messages: {
        fetch: vi.fn(async () => {
          const page = pages[callIdx] ?? [];
          callIdx++;
          return new Map(page.map((m) => [m.id, m]));
        }),
      },
    };
  }

  it('returns no-match when channel has zero messages', async () => {
    const ch = makeChannel([[]]);
    const ctx = makeCtx({ channels: [ch] });

    const result = await executeGuildAction(
      { type: 'searchMessages', query: 'anything', channel: '#general' },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect((result as any).summary).toContain('No messages matching');
    expect(ch.messages.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('eventList', () => {
  it('lists events', async () => {
    const events = new Map([
      ['e1', { id: 'e1', name: 'Team Meeting', scheduledStartAt: new Date('2025-02-01T15:00:00Z'), description: 'Weekly sync' }],
    ]);
    const ctx = makeCtx({ events });

    const result = await executeGuildAction({ type: 'eventList' }, ctx);

    expect(result.ok).toBe(true);
    expect((result as any).summary).toContain('Team Meeting (id:e1)');
  });

  it('filters channel-scoped events the requester cannot view', async () => {
    const visibleChannel = {
      id: 'ch-visible',
      permissionsFor: vi.fn(() => ({ has: () => true })),
    };
    const hiddenChannel = {
      id: 'ch-hidden',
      permissionsFor: vi.fn(() => ({ has: () => false })),
    };
    const events = new Map([
      ['e-visible', { id: 'e-visible', name: 'Visible Voice', channelId: 'ch-visible', scheduledStartAt: new Date('2025-02-01T15:00:00Z') }],
      ['e-hidden', { id: 'e-hidden', name: 'Hidden Voice', channelId: 'ch-hidden', scheduledStartAt: new Date('2025-02-01T16:00:00Z') }],
      ['e-external', { id: 'e-external', name: 'External Event', scheduledStartAt: new Date('2025-02-01T17:00:00Z') }],
    ]);
    const requester = makeMockMember({ id: 'requester' });
    const ctx = makeCtx({ channels: [visibleChannel, hiddenChannel], events });

    const result = await executeGuildAction({ type: 'eventList' }, ctx, requester as any);

    expect(result.ok).toBe(true);
    expect((result as any).summary).toContain('Visible Voice (id:e-visible)');
    expect((result as any).summary).toContain('External Event (id:e-external)');
    expect((result as any).summary).not.toContain('Hidden Voice (id:e-hidden)');
  });

  it('shows empty message when no events', async () => {
    const ctx = makeCtx({ events: new Map() });
    const result = await executeGuildAction({ type: 'eventList' }, ctx);
    expect(result).toEqual({ ok: true, summary: 'No scheduled events' });
  });
});

describe('eventCreate', () => {
  it('creates an external event with location', async () => {
    const ctx = makeCtx({});

    const result = await executeGuildAction(
      {
        type: 'eventCreate',
        name: 'Offsite',
        startTime: '2025-03-01T10:00:00Z',
        location: 'Conference Room A',
      },
      ctx,
    );

    expect(result).toEqual({ ok: true, summary: 'Created event "Offsite"' });
    expect((ctx.guild as any).scheduledEvents.create).toHaveBeenCalled();
  });

  it('fails with invalid startTime', async () => {
    const ctx = makeCtx({});

    const result = await executeGuildAction(
      { type: 'eventCreate', name: 'Bad', startTime: 'not-a-date' },
      ctx,
    );

    expect(result).toEqual({ ok: false, error: 'Invalid startTime: "not-a-date"' });
  });
});

describe('eventEdit', () => {
  it('edits an event name', async () => {
    const ctx = makeCtx({});

    const result = await executeGuildAction(
      { type: 'eventEdit', eventId: 'e1', name: 'New Name' },
      ctx,
    );

    expect(result).toEqual({ ok: true, summary: 'Edited event "New Name"' });
    expect((ctx.guild as any).scheduledEvents.edit).toHaveBeenCalledWith('e1', { name: 'New Name' });
  });

  it('edits multiple fields', async () => {
    const ctx = makeCtx({});

    const result = await executeGuildAction(
      { type: 'eventEdit', eventId: 'e1', name: 'Updated', description: 'New desc', startTime: '2025-06-01T10:00:00Z' },
      ctx,
    );

    expect(result.ok).toBe(true);
    const call = (ctx.guild as any).scheduledEvents.edit.mock.calls[0];
    expect(call[0]).toBe('e1');
    expect(call[1]).toMatchObject({ name: 'Updated', description: 'New desc' });
    expect(call[1].scheduledStartTime).toBeDefined();
  });

  it('fails when no fields provided', async () => {
    const ctx = makeCtx({});

    const result = await executeGuildAction(
      { type: 'eventEdit', eventId: 'e1' },
      ctx,
    );

    expect(result).toEqual({ ok: false, error: 'eventEdit requires at least one field to update' });
  });

  it('fails with invalid startTime', async () => {
    const ctx = makeCtx({});

    const result = await executeGuildAction(
      { type: 'eventEdit', eventId: 'e1', startTime: 'nope' },
      ctx,
    );

    expect(result).toEqual({ ok: false, error: 'Invalid startTime: "nope"' });
  });

  it('fails with invalid endTime', async () => {
    const ctx = makeCtx({});

    const result = await executeGuildAction(
      { type: 'eventEdit', eventId: 'e1', endTime: 'bad' },
      ctx,
    );

    expect(result).toEqual({ ok: false, error: 'Invalid endTime: "bad"' });
  });
});

describe('eventDelete', () => {
  it('deletes an event and shows its name', async () => {
    const events = new Map([
      ['e1', { id: 'e1', name: 'Team Meeting' }],
    ]);
    const ctx = makeCtx({ events });

    const result = await executeGuildAction(
      { type: 'eventDelete', eventId: 'e1' },
      ctx,
    );

    expect(result).toEqual({ ok: true, summary: 'Deleted event "Team Meeting"' });
    expect((ctx.guild as any).scheduledEvents.delete).toHaveBeenCalledWith('e1');
  });

  it('falls back to eventId when event not found for name', async () => {
    const ctx = makeCtx({});

    const result = await executeGuildAction(
      { type: 'eventDelete', eventId: 'unknown-id' },
      ctx,
    );

    expect(result).toEqual({ ok: true, summary: 'Deleted event "unknown-id"' });
    expect((ctx.guild as any).scheduledEvents.delete).toHaveBeenCalledWith('unknown-id');
  });
});
