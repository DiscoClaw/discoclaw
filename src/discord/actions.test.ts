import { describe, expect, it, vi } from 'vitest';
import { ChannelType } from 'discord.js';
import { parseDiscordActions, executeDiscordActions, buildDisplayResultLines, buildAllResultLines } from './actions.js';
import type { ActionCategoryFlags, DiscordActionResult } from './actions.js';

const ALL_FLAGS: ActionCategoryFlags = {
  channels: true,
  messaging: false,
  guild: false,
  moderation: false,
  polls: false,
  beads: false,
  crons: false,
  botProfile: false,
  forge: false,
  plan: false,
  memory: false,
};

// ---------------------------------------------------------------------------
// parseDiscordActions
// ---------------------------------------------------------------------------

describe('parseDiscordActions', () => {
  it('extracts a single action and strips it from text', () => {
    const input = 'Here is the list:\n<discord-action>{"type":"channelList"}</discord-action>\nDone.';
    const { cleanText, actions } = parseDiscordActions(input, ALL_FLAGS);
    expect(actions).toEqual([{ type: 'channelList' }]);
    expect(cleanText).toBe('Here is the list:\n\nDone.');
  });

  it('extracts multiple actions', () => {
    const input =
      '<discord-action>{"type":"channelCreate","name":"status","parent":"Dev"}</discord-action>' +
      '<discord-action>{"type":"channelList"}</discord-action>';
    const { actions } = parseDiscordActions(input, ALL_FLAGS);
    expect(actions).toHaveLength(2);
    expect(actions[0]).toEqual({ type: 'channelCreate', name: 'status', parent: 'Dev' });
    expect(actions[1]).toEqual({ type: 'channelList' });
  });

  it('skips malformed JSON gracefully', () => {
    const input = '<discord-action>{bad json}</discord-action>Some text';
    const { cleanText, actions } = parseDiscordActions(input, ALL_FLAGS);
    expect(actions).toHaveLength(0);
    expect(cleanText).toBe('Some text');
  });

  it('skips unknown action types', () => {
    const input = '<discord-action>{"type":"somethingWeird","id":"123"}</discord-action>';
    const { actions } = parseDiscordActions(input, ALL_FLAGS);
    expect(actions).toHaveLength(0);
  });

  it('skips disabled category action types', () => {
    const input = '<discord-action>{"type":"channelCreate","name":"test"}</discord-action>';
    const { actions } = parseDiscordActions(input, { ...ALL_FLAGS, channels: false });
    expect(actions).toHaveLength(0);
  });

  it('returns original text when no actions present', () => {
    const input = 'Just a normal message.';
    const { cleanText, actions } = parseDiscordActions(input, ALL_FLAGS);
    expect(actions).toHaveLength(0);
    expect(cleanText).toBe(input);
  });

  it('collapses blank lines left by multiple stripped action blocks', () => {
    const block = '<discord-action>{"type":"channelList"}</discord-action>';
    const input = `Here is the list:\n${block}\n${block}\n${block}\n${block}\n${block}\nDone.`;
    const { cleanText, actions } = parseDiscordActions(input, ALL_FLAGS);
    expect(actions).toHaveLength(5);
    expect(cleanText).not.toMatch(/\n{3,}/);
    expect(cleanText).toBe('Here is the list:\n\nDone.');
  });

  it('strips malformed action blocks with wrong closing tags', () => {
    const input = 'Here is the bead:\n<discord-action>{"type":"channelList"}</parameter>\n</invoke>';
    const { cleanText, actions } = parseDiscordActions(input, ALL_FLAGS);
    expect(actions).toEqual([{ type: 'channelList' }]);
    expect(cleanText).toBe('Here is the bead:');
  });

  it('strips malformed action blocks with no closing tag', () => {
    const input = 'Done.\n<discord-action>{"type":"channelList"}';
    const { cleanText, actions } = parseDiscordActions(input, ALL_FLAGS);
    expect(actions).toEqual([{ type: 'channelList' }]);
    expect(cleanText).toBe('Done.');
  });

  it('strips malformed action blocks with complex JSON payloads', () => {
    const json = '{"type":"channelCreate","name":"test","parent":"Dev","topic":"A topic"}';
    const input = `Creating channel.\n<discord-action>${json}</parameter>\n</invoke>\nExtra text.`;
    const { cleanText, actions } = parseDiscordActions(input, ALL_FLAGS);
    expect(actions).toEqual([{ type: 'channelCreate', name: 'test', parent: 'Dev', topic: 'A topic' }]);
    expect(cleanText).toBe('Creating channel.\n\nExtra text.');
  });

  it('handles nested braces in JSON string values', () => {
    const json = '{"type":"channelCreate","name":"test","topic":"Fix {braces} in output"}';
    const input = `Text.\n<discord-action>${json}</parameter>\n</invoke>`;
    const { cleanText, actions } = parseDiscordActions(input, ALL_FLAGS);
    expect(actions).toEqual([{ type: 'channelCreate', name: 'test', topic: 'Fix {braces} in output' }]);
    expect(cleanText).toBe('Text.');
  });

  it('handles two malformed action blocks in one response', () => {
    const input =
      'First.\n<discord-action>{"type":"channelList"}</parameter>\n</invoke>\n' +
      'Second.\n<discord-action>{"type":"channelCreate","name":"x"}</parameter>';
    const { cleanText, actions } = parseDiscordActions(input, ALL_FLAGS);
    expect(actions).toHaveLength(2);
    expect(actions[0]).toEqual({ type: 'channelList' });
    expect(actions[1]).toEqual({ type: 'channelCreate', name: 'x' });
    expect(cleanText).toBe('First.\n\nSecond.');
  });

  it('preserves text after an unterminated malformed action block', () => {
    const input = 'Before\n<discord-action>{"type":"channelList","x":"oops\nAfter text';
    const { cleanText, actions } = parseDiscordActions(input, ALL_FLAGS);
    expect(actions).toHaveLength(0);
    expect(cleanText).toBe('Before\n\nAfter text');
  });

  it('strips trailing XML tags after an unterminated malformed action block', () => {
    const input = 'Before\n<discord-action>{"type":"channelList","x":"oops\n</parameter>\n</invoke>\nAfter';
    const { cleanText, actions } = parseDiscordActions(input, ALL_FLAGS);
    expect(actions).toHaveLength(0);
    expect(cleanText).toBe('Before\n\nAfter');
  });
});

// ---------------------------------------------------------------------------
// executeDiscordActions — mocked guild
// ---------------------------------------------------------------------------

function makeMockGuild(channels: Array<{ id: string; name: string; type: ChannelType; parentName?: string }>) {
  const cache = new Map<string, any>();
  for (const ch of channels) {
    cache.set(ch.id, {
      id: ch.id,
      name: ch.name,
      type: ch.type,
      parent: ch.parentName ? { name: ch.parentName } : null,
    });
  }

  return {
    channels: {
      cache: {
        find: (fn: (ch: any) => boolean) => {
          for (const ch of cache.values()) {
            if (fn(ch)) return ch;
          }
          return undefined;
        },
        values: () => cache.values(),
        get size() { return cache.size; },
      },
      create: vi.fn(async (opts: any) => ({
        name: opts.name,
        id: 'new-id',
      })),
    },
  } as any;
}

function makeCtx(guild: any) {
  return {
    guild,
    client: {} as any,
    channelId: 'test-channel',
    messageId: 'test-message',
  };
}

describe('executeDiscordActions', () => {
  it('channelCreate succeeds with parent category', async () => {
    const guild = makeMockGuild([
      { id: 'cat1', name: 'Dev', type: ChannelType.GuildCategory },
    ]);

    const results = await executeDiscordActions(
      [{ type: 'channelCreate', name: 'status', parent: 'Dev', topic: 'Status updates' }],
      makeCtx(guild),
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ ok: true, summary: 'Created #status under Dev' });
    expect(guild.channels.create).toHaveBeenCalledWith({
      name: 'status',
      type: ChannelType.GuildText,
      parent: 'cat1',
      topic: 'Status updates',
    });
  });

  it('channelCreate fails when parent category not found', async () => {
    const guild = makeMockGuild([]);

    const results = await executeDiscordActions(
      [{ type: 'channelCreate', name: 'status', parent: 'NonExistent' }],
      makeCtx(guild),
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ ok: false, error: 'Category "NonExistent" not found' });
  });

  it('channelCreate without parent', async () => {
    const guild = makeMockGuild([]);

    const results = await executeDiscordActions(
      [{ type: 'channelCreate', name: 'general' }],
      makeCtx(guild),
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ ok: true, summary: 'Created #general' });
    expect(guild.channels.create).toHaveBeenCalledWith({
      name: 'general',
      type: ChannelType.GuildText,
      parent: undefined,
      topic: undefined,
    });
  });

  it('channelList groups by category', async () => {
    const guild = makeMockGuild([
      { id: 'cat1', name: 'Dev', type: ChannelType.GuildCategory },
      { id: 'ch1', name: 'general', type: ChannelType.GuildText, parentName: 'Dev' },
      { id: 'ch2', name: 'random', type: ChannelType.GuildText },
    ]);

    const results = await executeDiscordActions([{ type: 'channelList' }], makeCtx(guild));

    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    const summary = (results[0] as { ok: true; summary: string }).summary;
    expect(summary).toContain('#random (id:ch2)');
    expect(summary).toContain('Dev: #general (id:ch1)');
  });

  it('handles API errors gracefully', async () => {
    const guild = makeMockGuild([]);
    guild.channels.create = vi.fn(async () => {
      throw new Error('Missing Permissions');
    });

    const results = await executeDiscordActions(
      [{ type: 'channelCreate', name: 'test' }],
      makeCtx(guild),
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ ok: false, error: 'Missing Permissions' });
  });

  it('one failure does not block subsequent actions', async () => {
    const guild = makeMockGuild([
      { id: 'ch1', name: 'general', type: ChannelType.GuildText },
    ]);
    guild.channels.create = vi.fn(async () => {
      throw new Error('Missing Permissions');
    });

    const results = await executeDiscordActions(
      [
        { type: 'channelCreate', name: 'test' },
        { type: 'channelList' },
      ],
      makeCtx(guild),
    );

    expect(results).toHaveLength(2);
    expect(results[0].ok).toBe(false);
    expect(results[1].ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildDisplayResultLines / buildAllResultLines
// ---------------------------------------------------------------------------

describe('buildDisplayResultLines', () => {
  it('filters successful sendMessage results', () => {
    const actions = [{ type: 'sendMessage' }, { type: 'channelCreate' }];
    const results: DiscordActionResult[] = [
      { ok: true, summary: 'Sent message to #general' },
      { ok: true, summary: 'Created #status' },
    ];
    const lines = buildDisplayResultLines(actions, results);
    expect(lines).toEqual(['Done: Created #status']);
  });

  it('keeps failed sendMessage results', () => {
    const actions = [{ type: 'sendMessage' }];
    const results: DiscordActionResult[] = [
      { ok: false, error: 'Missing Permissions' },
    ];
    const lines = buildDisplayResultLines(actions, results);
    expect(lines).toEqual(['Failed: Missing Permissions']);
  });

  it('keeps non-sendMessage successes', () => {
    const actions = [{ type: 'channelCreate' }, { type: 'react' }, { type: 'channelList' }];
    const results: DiscordActionResult[] = [
      { ok: true, summary: 'Created #foo' },
      { ok: true, summary: 'Reacted with ✅' },
      { ok: true, summary: 'Listed 3 channels' },
    ];
    const lines = buildDisplayResultLines(actions, results);
    expect(lines).toEqual([
      'Done: Created #foo',
      'Done: Reacted with ✅',
      'Done: Listed 3 channels',
    ]);
  });

  it('returns empty array when all actions are successful sendMessage', () => {
    const actions = [{ type: 'sendMessage' }, { type: 'sendMessage' }];
    const results: DiscordActionResult[] = [
      { ok: true, summary: 'Sent message to #general' },
      { ok: true, summary: 'Sent message to #random' },
    ];
    const lines = buildDisplayResultLines(actions, results);
    expect(lines).toEqual([]);
  });

  it('handles mixed actions correctly', () => {
    const actions = [{ type: 'sendMessage' }, { type: 'channelCreate' }, { type: 'sendMessage' }];
    const results: DiscordActionResult[] = [
      { ok: true, summary: 'Sent message to #general' },
      { ok: true, summary: 'Created #status' },
      { ok: false, error: 'Channel not found' },
    ];
    const lines = buildDisplayResultLines(actions, results);
    expect(lines).toEqual([
      'Done: Created #status',
      'Failed: Channel not found',
    ]);
  });
});

describe('buildAllResultLines', () => {
  it('returns all result lines without filtering', () => {
    const results: DiscordActionResult[] = [
      { ok: true, summary: 'Sent message to #general' },
      { ok: true, summary: 'Created #status' },
      { ok: false, error: 'Missing Permissions' },
    ];
    const lines = buildAllResultLines(results);
    expect(lines).toEqual([
      'Done: Sent message to #general',
      'Done: Created #status',
      'Failed: Missing Permissions',
    ]);
  });
});
