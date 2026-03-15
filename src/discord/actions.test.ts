import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { buildUnavailableActionTypesNotice } from './output-common.js';
import {
  parseDiscordActions,
  executeDiscordActions,
  discordActionsPromptSection,
  buildTieredDiscordActionsPromptSection,
  buildDisplayResultLines,
  buildAllResultLines,
  withoutRequesterGatedActionFlags,
} from './actions.js';
import type { ActionCategoryFlags, DiscordActionResult } from './actions.js';
import { TaskStore } from '../tasks/store.js';
import { _resetDestructiveConfirmationForTest } from './destructive-confirmation.js';
import { shouldTriggerFollowUp } from './action-categories.js';

const ALL_FLAGS: ActionCategoryFlags = {
  channels: true,
  messaging: false,
  guild: false,
  moderation: false,
  polls: false,
  tasks: false,
  crons: false,
  botProfile: false,
  forge: false,
  plan: false,
  memory: false,
  config: false,
  defer: true,
};

// ---------------------------------------------------------------------------
// parseDiscordActions
// ---------------------------------------------------------------------------

describe('parseDiscordActions', () => {
  beforeEach(() => {
    _resetDestructiveConfirmationForTest();
  });

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

  it('extracts a continuation capsule and strips it from cleaned text', () => {
    const input = [
      'Working on it.',
      '<continuation-capsule>',
      '{"activeTaskId":"ws-1170","currentFocus":"Keep the session focused","nextStep":"Patch actions.ts","blockedOn":"Need prompt wiring"}',
      '</continuation-capsule>',
      '<discord-action>{"type":"channelList"}</discord-action>',
      'Done.',
    ].join('\n');

    const { cleanText, actions, continuationCapsule } = parseDiscordActions(input, ALL_FLAGS);
    expect(actions).toEqual([{ type: 'channelList' }]);
    expect(continuationCapsule).toEqual({
      activeTaskId: 'ws-1170',
      currentFocus: 'Keep the session focused',
      nextStep: 'Patch actions.ts',
      blockedOn: 'Need prompt wiring',
    });
    expect(cleanText).toBe('Working on it.\n\nDone.');
  });

  it('extracts defer actions when defer flag enabled', () => {
    const input = '<discord-action>{"type":"defer","channel":"general","delaySeconds":300,"prompt":"check the forge"}</discord-action>';
    const { actions } = parseDiscordActions(input, ALL_FLAGS);
    expect(actions).toEqual([{ type: 'defer', channel: 'general', delaySeconds: 300, prompt: 'check the forge' }]);
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

  it('skips defer actions when defer flag disabled', () => {
    const input = '<discord-action>{"type":"defer","channel":"general","delaySeconds":60}</discord-action>';
    const { actions } = parseDiscordActions(input, { ...ALL_FLAGS, defer: false });
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

  it('returns empty strippedUnrecognizedTypes when all action types are recognized', () => {
    const input = '<discord-action>{"type":"channelList"}</discord-action>';
    const { strippedUnrecognizedTypes } = parseDiscordActions(input, ALL_FLAGS);
    expect(strippedUnrecognizedTypes).toEqual([]);
  });

  it('collects unrecognized type names in strippedUnrecognizedTypes (first pass)', () => {
    const input = '<discord-action>{"type":"somethingWeird","id":"123"}</discord-action>';
    const { actions, strippedUnrecognizedTypes } = parseDiscordActions(input, ALL_FLAGS);
    expect(actions).toHaveLength(0);
    expect(strippedUnrecognizedTypes).toEqual(['somethingWeird']);
  });

  it('collects flag-disabled type names in strippedUnrecognizedTypes (first pass)', () => {
    const input = '<discord-action>{"type":"channelCreate","name":"test"}</discord-action>';
    const { actions, strippedUnrecognizedTypes } = parseDiscordActions(input, { ...ALL_FLAGS, channels: false });
    expect(actions).toHaveLength(0);
    expect(strippedUnrecognizedTypes).toEqual(['channelCreate']);
  });

  it('collects unrecognized type names in strippedUnrecognizedTypes (second pass / malformed block)', () => {
    const input = '<discord-action>{"type":"unknownType","foo":"bar"}</parameter>\n</invoke>';
    const { actions, strippedUnrecognizedTypes } = parseDiscordActions(input, ALL_FLAGS);
    expect(actions).toHaveLength(0);
    expect(strippedUnrecognizedTypes).toEqual(['unknownType']);
  });

  it('collects multiple unrecognized types across both passes', () => {
    const input =
      '<discord-action>{"type":"typeA"}</discord-action>' +
      '<discord-action>{"type":"channelList"}</discord-action>' +
      '<discord-action>{"type":"typeB"}</parameter>';
    const { actions, strippedUnrecognizedTypes } = parseDiscordActions(input, ALL_FLAGS);
    expect(actions).toEqual([{ type: 'channelList' }]);
    expect(strippedUnrecognizedTypes).toEqual(['typeA', 'typeB']);
  });

  it('accepts task action types when tasks flag is enabled', () => {
    const input = '<discord-action>{"type":"taskList"}</discord-action>';
    const { actions } = parseDiscordActions(input, { ...ALL_FLAGS, tasks: true });
    expect(actions).toEqual([{ type: 'taskList' }]);
  });

  it('rewrites planClose to taskClose when plan actions are disabled and tasks are enabled', () => {
    const input = '<discord-action>{"type":"planClose","planId":"dev-uqy"}</discord-action>';
    const { actions, strippedUnrecognizedTypes } = parseDiscordActions(input, { ...ALL_FLAGS, tasks: true, plan: false });
    expect(actions).toEqual([{ type: 'taskClose', taskId: 'dev-uqy' }]);
    expect(strippedUnrecognizedTypes).toEqual([]);
  });

  it('does not rewrite planClose when planId looks like a plan identifier', () => {
    const input = '<discord-action>{"type":"planClose","planId":"plan-042"}</discord-action>';
    const { actions, strippedUnrecognizedTypes } = parseDiscordActions(input, { ...ALL_FLAGS, tasks: true, plan: false });
    expect(actions).toEqual([]);
    expect(strippedUnrecognizedTypes).toEqual(['planClose']);
  });

  it('does not rewrite planClose when plan actions are enabled', () => {
    const input = '<discord-action>{"type":"planClose","planId":"dev-uqy"}</discord-action>';
    const { actions } = parseDiscordActions(input, { ...ALL_FLAGS, tasks: true, plan: true });
    expect(actions).toEqual([{ type: 'planClose', planId: 'dev-uqy' }]);
  });

  it('ignores action tags inside fenced code blocks', () => {
    const input =
      'Example only:\n```json\n<discord-action>{"type":"channelDelete","channelId":"ch1"}</discord-action>\n```\nNo action.';
    const { actions, cleanText } = parseDiscordActions(input, ALL_FLAGS);
    expect(actions).toEqual([]);
    expect(cleanText).toContain('<discord-action>');
  });

  it('ignores action tags inside inline code spans', () => {
    const input = 'Do not run `<discord-action>{"type":"channelDelete","channelId":"ch1"}</discord-action>` please.';
    const { actions, cleanText } = parseDiscordActions(input, ALL_FLAGS);
    expect(actions).toEqual([]);
    expect(cleanText).toContain('<discord-action>');
  });

  it('ignores action tags inside indented code blocks', () => {
    const input =
      'Example only:\n' +
      '    <discord-action>{"type":"channelDelete","channelId":"ch1"}</discord-action>\n' +
      'No action.';
    const { actions, cleanText } = parseDiscordActions(input, ALL_FLAGS);
    expect(actions).toEqual([]);
    expect(cleanText).toContain('<discord-action>');
  });

  it('parses forgeStatus when forge flag is enabled', () => {
    const input = '<discord-action>{"type":"forgeStatus","forgeId":"forge-abc"}</discord-action>';
    const { actions, strippedUnrecognizedTypes } = parseDiscordActions(input, { ...ALL_FLAGS, forge: true });
    expect(actions).toEqual([{ type: 'forgeStatus', forgeId: 'forge-abc' }]);
    expect(strippedUnrecognizedTypes).toEqual([]);
  });

  it('strips forgeStatus when forge flag is disabled', () => {
    const input = '<discord-action>{"type":"forgeStatus","forgeId":"forge-abc"}</discord-action>';
    const { actions, strippedUnrecognizedTypes } = parseDiscordActions(input, { ...ALL_FLAGS, forge: false });
    expect(actions).toHaveLength(0);
    expect(strippedUnrecognizedTypes).toEqual(['forgeStatus']);
  });

  it('parses two same-type taskCreate actions and extracts both', () => {
    const input =
      '<discord-action>{"type":"taskCreate","title":"First task"}</discord-action>' +
      '<discord-action>{"type":"taskCreate","title":"Second task"}</discord-action>';
    const { actions, parseFailures } = parseDiscordActions(input, { ...ALL_FLAGS, tasks: true });
    expect(actions).toHaveLength(2);
    expect(actions[0]).toEqual({ type: 'taskCreate', title: 'First task' });
    expect(actions[1]).toEqual({ type: 'taskCreate', title: 'Second task' });
    expect(parseFailures).toBe(0);
  });

  it('returns parseFailures: 1 and only the valid action when second block has malformed JSON', () => {
    const input =
      '<discord-action>{"type":"taskCreate","title":"Valid task"}</discord-action>' +
      '<discord-action>{bad json}</discord-action>';
    const { actions, parseFailures } = parseDiscordActions(input, { ...ALL_FLAGS, tasks: true });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({ type: 'taskCreate', title: 'Valid task' });
    expect(parseFailures).toBe(1);
  });

  it('returns parseFailures: 0 for well-formed input', () => {
    const input = '<discord-action>{"type":"channelList"}</discord-action>';
    const { parseFailures } = parseDiscordActions(input, ALL_FLAGS);
    expect(parseFailures).toBe(0);
  });

  it('includes generateImage in valid types when imagegen flag is true', () => {
    const input = '<discord-action>{"type":"generateImage","prompt":"sunset","channel":"art"}</discord-action>';
    const { actions, strippedUnrecognizedTypes } = parseDiscordActions(input, { ...ALL_FLAGS, imagegen: true });
    expect(actions).toEqual([{ type: 'generateImage', prompt: 'sunset', channel: 'art' }]);
    expect(strippedUnrecognizedTypes).toEqual([]);
  });

  it('excludes generateImage from valid types when imagegen flag is false', () => {
    const input = '<discord-action>{"type":"generateImage","prompt":"sunset","channel":"art"}</discord-action>';
    const { actions, strippedUnrecognizedTypes } = parseDiscordActions(input, { ...ALL_FLAGS, imagegen: false });
    expect(actions).toHaveLength(0);
    expect(strippedUnrecognizedTypes).toEqual(['generateImage']);
  });

  it('excludes generateImage from valid types when imagegen flag is omitted', () => {
    const input = '<discord-action>{"type":"generateImage","prompt":"sunset","channel":"art"}</discord-action>';
    const { actions, strippedUnrecognizedTypes } = parseDiscordActions(input, ALL_FLAGS);
    expect(actions).toHaveLength(0);
    expect(strippedUnrecognizedTypes).toEqual(['generateImage']);
  });

  it('includes voice action types when voice flag is true', () => {
    const input = '<discord-action>{"type":"voiceJoin","channel":"voice-chat"}</discord-action>';
    const { actions, strippedUnrecognizedTypes } = parseDiscordActions(input, { ...ALL_FLAGS, voice: true });
    expect(actions).toEqual([{ type: 'voiceJoin', channel: 'voice-chat' }]);
    expect(strippedUnrecognizedTypes).toEqual([]);
  });

  it('excludes voice action types when voice flag is false', () => {
    const input = '<discord-action>{"type":"voiceJoin","channel":"voice-chat"}</discord-action>';
    const { actions, strippedUnrecognizedTypes } = parseDiscordActions(input, { ...ALL_FLAGS, voice: false });
    expect(actions).toHaveLength(0);
    expect(strippedUnrecognizedTypes).toEqual(['voiceJoin']);
  });

  it('excludes voice action types when voice flag is omitted', () => {
    const input = '<discord-action>{"type":"voiceLeave"}</discord-action>';
    const { actions, strippedUnrecognizedTypes } = parseDiscordActions(input, ALL_FLAGS);
    expect(actions).toHaveLength(0);
    expect(strippedUnrecognizedTypes).toEqual(['voiceLeave']);
  });

  it('keeps allowlisted action types when allowedActionTypes is provided', () => {
    const input = '<discord-action>{"type":"channelList"}</discord-action>';
    const { actions, strippedUnrecognizedTypes } = parseDiscordActions(input, ALL_FLAGS, ['channelList']);
    expect(actions).toEqual([{ type: 'channelList' }]);
    expect(strippedUnrecognizedTypes).toEqual([]);
  });

  it('strips category-enabled action types that are not in allowedActionTypes', () => {
    const input =
      '<discord-action>{"type":"channelList"}</discord-action>' +
      '<discord-action>{"type":"channelCreate","name":"ops"}</discord-action>';
    const { actions, strippedUnrecognizedTypes } = parseDiscordActions(input, ALL_FLAGS, ['channelList']);
    expect(actions).toEqual([{ type: 'channelList' }]);
    expect(strippedUnrecognizedTypes).toEqual(['channelCreate']);
  });

  it('reports allowlist-blocked action names through stripped-type notices', () => {
    const input =
      '<discord-action>{"type":"channelCreate","name":"ops"}</discord-action>' +
      '<discord-action>{"type":"channelDelete","channelId":"123"}</discord-action>';
    const { strippedUnrecognizedTypes } = parseDiscordActions(input, ALL_FLAGS, ['channelList']);
    const notice = buildUnavailableActionTypesNotice(strippedUnrecognizedTypes);
    expect(strippedUnrecognizedTypes).toEqual(['channelCreate', 'channelDelete']);
    expect(notice).toContain('channelCreate');
    expect(notice).toContain('channelDelete');
  });

  it('prompt Rules section confirms multiple same-type actions are supported', () => {
    const prompt = discordActionsPromptSection(ALL_FLAGS, 'ClawBot');
    expect(prompt).toContain('Multiple same-type actions are supported');
  });
});

describe('buildTieredDiscordActionsPromptSection', () => {
  it('tells the model not to promise work without emitting an action block', () => {
    const prompt = buildTieredDiscordActionsPromptSection(ALL_FLAGS, 'Weston').prompt;

    expect(prompt).toContain('include the concrete `<discord-action>` block(s) that actually begin that work');
    expect(prompt).toContain('If you are not emitting an action block, say that you have not started yet');
  });
});

describe('withoutRequesterGatedActionFlags', () => {
  it('disables requester-gated Discord categories and preserves internal ones', () => {
    expect(withoutRequesterGatedActionFlags({
      channels: true,
      messaging: true,
      guild: true,
      moderation: true,
      polls: true,
      tasks: true,
      crons: true,
      botProfile: true,
      forge: true,
      plan: true,
      memory: true,
      config: true,
      defer: true,
      loop: true,
      imagegen: true,
      voice: true,
      spawn: true,
    })).toEqual({
      channels: false,
      messaging: false,
      guild: false,
      moderation: false,
      polls: false,
      tasks: true,
      crons: true,
      botProfile: true,
      forge: true,
      plan: true,
      memory: true,
      config: true,
      defer: true,
      loop: true,
      imagegen: true,
      voice: true,
      spawn: true,
    });
  });
});

// ---------------------------------------------------------------------------
// executeDiscordActions — mocked guild
// ---------------------------------------------------------------------------

function makeMockGuild(channels: Array<{ id: string; name: string; type: ChannelType; parentName?: string }>) {
  const requester = {
    id: 'user-1',
    permissions: {
      has: vi.fn(() => true),
    },
  };
  const cache = new Map<string, any>();
  for (const ch of channels) {
    cache.set(ch.id, {
      id: ch.id,
      name: ch.name,
      type: ch.type,
      parent: ch.parentName ? { name: ch.parentName } : null,
      permissionsFor: vi.fn(() => ({
        has: vi.fn(() => true),
      })),
    });
  }

  return {
    channels: {
      cache: {
        get: (id: string) => cache.get(id),
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
    members: {
      fetch: vi.fn(async () => requester),
    },
  } as any;
}

function makeCtx(guild: any) {
  return {
    guild,
    client: {} as any,
    channelId: 'test-channel',
    messageId: 'test-message',
    requesterId: 'user-1',
  };
}

describe('executeDiscordActions', () => {
  beforeEach(() => {
    _resetDestructiveConfirmationForTest();
  });

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
    expect(results[0]).toEqual({ ok: false, error: 'Failed (channelCreate): Missing Permissions' });
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

  it('executes task actions when taskCtx is provided', async () => {
    const store = new TaskStore({ prefix: 'ws' });
    store.create({ title: 'test task', priority: 2 });
    const results = await executeDiscordActions(
      [{ type: 'taskList', limit: 10 } as any],
      makeCtx(makeMockGuild([])),
      undefined,
      {
        taskCtx: {
          tasksCwd: '/tmp',
          forumId: 'forum-1',
          tagMap: {},
          store,
          runtime: {} as any,
          autoTag: false,
          autoTagModel: 'fast',
        },
      },
    );
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
  });

  it('blocks destructive actions without explicit confirmation bypass', async () => {
    const guild = makeMockGuild([]);
    const results = await executeDiscordActions(
      [{ type: 'channelDelete', channelId: 'ch1' } as any],
      {
        ...makeCtx(guild),
        confirmation: {
          mode: 'interactive',
          sessionKey: 'discord:channel:chan',
          userId: '123',
        },
      },
    );
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    if (results[0].ok) throw new Error('unexpected ok result');
    expect(results[0].error).toContain('requires confirmation');
    expect(results[0].error).toContain('!confirm');
  });

  it('executes two same-type channelCreate actions and returns two results', async () => {
    const guild = makeMockGuild([]);

    const results = await executeDiscordActions(
      [
        { type: 'channelCreate', name: 'alpha' },
        { type: 'channelCreate', name: 'beta' },
      ],
      makeCtx(guild),
    );

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ ok: true, summary: 'Created #alpha' });
    expect(results[1]).toEqual({ ok: true, summary: 'Created #beta' });
  });

  it('returns imagegen setup stub for interactive manual/follow-up calls when imagegenCtx is absent', async () => {
    const guild = makeMockGuild([]);
    const results = await executeDiscordActions(
      [{ type: 'generateImage', prompt: 'sunset', channel: 'art' } as any],
      {
        ...makeCtx(guild),
        confirmation: {
          mode: 'interactive',
          sessionKey: 'discord:channel:test-channel',
          userId: 'user-1',
        },
      },
    );
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    if (results[0].ok) throw new Error('unexpected ok result');
    expect(results[0].error).toContain('Setup walkthrough');
    expect(results[0].error).toContain('DISCOCLAW_DISCORD_ACTIONS_IMAGEGEN=1');
    expect(results[0].error).toContain('!models help');
  });

  it('keeps the raw imagegen not-configured error for automated callers when imagegenCtx is absent', async () => {
    const guild = makeMockGuild([]);
    const results = await executeDiscordActions(
      [{ type: 'generateImage', prompt: 'sunset', channel: 'art' } as any],
      {
        ...makeCtx(guild),
        confirmation: {
          mode: 'automated',
        },
      },
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ ok: false, error: 'Imagegen subsystem not configured' });
  });

  it('reaches imagegen executor when imagegenCtx is provided', async () => {
    const guild = makeMockGuild([]);
    // Add cache.get so resolveChannel/findChannelRaw can proceed
    guild.channels.cache.get = (_id: string) => undefined;
    const results = await executeDiscordActions(
      [{ type: 'generateImage', prompt: 'sunset', channel: 'nonexistent-channel' } as any],
      makeCtx(guild),
      undefined,
      { imagegenCtx: { apiKey: 'test-key' } },
    );
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    if (results[0].ok) throw new Error('unexpected ok result');
    // Executor was reached — error comes from channel resolution, not the "not configured" guard
    expect(results[0].error).not.toContain('not configured');
    expect(results[0].error).toContain('Channel');
  });

  it('returns voice not-configured error when voiceCtx is absent', async () => {
    const results = await executeDiscordActions(
      [{ type: 'voiceJoin', channel: 'voice-chat' } as any],
      makeCtx(makeMockGuild([])),
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ ok: false, error: 'Voice subsystem not configured' });
  });

  it('allows destructive actions with bypassDestructive confirmation context', async () => {
    const ban = vi.fn(async () => {});
    const requester = {
      id: '123',
      permissions: {
        has: vi.fn((perm: bigint) => perm === PermissionFlagsBits.BanMembers),
      },
      roles: {
        highest: { position: 100 },
      },
    };
    const target = {
      id: '42',
      displayName: 'User42',
      roles: {
        highest: { position: 1 },
      },
      ban,
    };
    const guild = {
      members: {
        fetch: vi.fn(async (userId: string) => (userId === '123' ? requester : target)),
      },
    } as any;
    const results = await executeDiscordActions(
      [{ type: 'ban', userId: '42' } as any],
      {
        guild,
        client: {} as any,
        channelId: 'chan',
        messageId: 'msg',
        requesterId: '123',
        confirmation: {
          mode: 'interactive',
          sessionKey: 'discord:channel:chan',
          userId: '123',
          bypassDestructive: true,
        },
      },
    );
    expect(results).toEqual([{ ok: true, summary: 'Banned User42' }]);
    expect(guild.members.fetch).toHaveBeenCalledWith('42');
    expect(ban).toHaveBeenCalledOnce();
  });

  it('parses three same-type channelCreate actions and executes all three', async () => {
    const input =
      '<discord-action>{"type":"channelCreate","name":"alpha"}</discord-action>' +
      '<discord-action>{"type":"channelCreate","name":"beta"}</discord-action>' +
      '<discord-action>{"type":"channelCreate","name":"gamma"}</discord-action>';
    const { actions } = parseDiscordActions(input, ALL_FLAGS);
    expect(actions).toHaveLength(3);

    const guild = makeMockGuild([]);
    const results = await executeDiscordActions(actions, makeCtx(guild));
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ ok: true, summary: 'Created #alpha' });
    expect(results[1]).toEqual({ ok: true, summary: 'Created #beta' });
    expect(results[2]).toEqual({ ok: true, summary: 'Created #gamma' });
  });

  it('fetches requester member once per batch for gated actions', async () => {
    const channel = {
      id: 'ch1',
      name: 'general',
      type: ChannelType.GuildText,
      permissionsFor: vi.fn(() => ({
        has: (perm: bigint) => (
          (PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory) & perm
        ) === perm,
      })),
      messages: {
        fetch: vi.fn(async () => new Map()),
      },
    };
    const requester = { id: 'user-1' };
    const guild = {
      channels: {
        cache: {
          get: (id: string) => (id === 'ch1' ? channel : undefined),
          find: (fn: (ch: any) => boolean) => (fn(channel) ? channel : undefined),
          values: () => [channel].values(),
        },
      },
      members: {
        fetch: vi.fn(async () => requester),
      },
    } as any;

    const results = await executeDiscordActions(
      [
        { type: 'searchMessages', query: 'needle', channel: 'general' } as any,
        { type: 'searchMessages', query: 'needle', channel: 'general' } as any,
      ],
      { ...makeCtx(guild), requesterId: 'user-1' },
    );

    expect(guild.members.fetch).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.ok)).toBe(true);
  });

  it('fails closed for gated actions when requester member cannot be resolved', async () => {
    const channel = {
      id: 'ch1',
      name: 'general',
      type: ChannelType.GuildText,
      permissionsFor: vi.fn(() => ({
        has: vi.fn(() => true),
      })),
      messages: {
        fetch: vi.fn(async () => new Map()),
      },
    };
    const guild = {
      channels: {
        cache: {
          get: (id: string) => (id === 'ch1' ? channel : undefined),
          find: (fn: (ch: any) => boolean) => (fn(channel) ? channel : undefined),
          values: () => [channel].values(),
        },
      },
      members: {
        fetch: vi.fn(async () => {
          throw new Error('missing');
        }),
      },
    } as any;

    const results = await executeDiscordActions(
      [{ type: 'searchMessages', query: 'needle', channel: 'general' } as any],
      { ...makeCtx(guild), requesterId: 'user-1' },
    );

    expect(guild.members.fetch).toHaveBeenCalledWith('user-1');
    expect(results).toEqual([{ ok: false, error: 'Permission denied for searchMessages' }]);
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

  it('filters successful sendFile results', () => {
    const actions = [{ type: 'sendFile' }, { type: 'react' }];
    const results: DiscordActionResult[] = [
      { ok: true, summary: 'Sent file "screenshot.png" to #general' },
      { ok: true, summary: 'Reacted with 👍' },
    ];
    const lines = buildDisplayResultLines(actions, results);
    expect(lines).toEqual(['Done: Reacted with 👍']);
  });

  it('keeps failed sendFile results', () => {
    const actions = [{ type: 'sendFile' }];
    const results: DiscordActionResult[] = [
      { ok: false, error: 'File not found: /tmp/missing.png' },
    ];
    const lines = buildDisplayResultLines(actions, results);
    expect(lines).toEqual(['Failed: File not found: /tmp/missing.png']);
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

describe('discordActionsPromptSection', () => {
  it('always includes the standard guidance when actions are enabled', () => {
    const flags: ActionCategoryFlags = {
      channels: false,
      messaging: false,
      guild: false,
      moderation: false,
      polls: false,
      tasks: false,
      crons: false,
      botProfile: false,
      forge: false,
      plan: false,
      memory: false,
      config: false,
      defer: false,
    };

    const prompt = discordActionsPromptSection(flags, 'ClawBot');
    expect(prompt).toContain('Perform Discord server actions by including');
    expect(prompt).toContain('### Rules');
    expect(prompt).toContain('Keep the continuation capsule current');
    expect(prompt).toContain('<continuation-capsule>{"activeTaskId":"...","currentFocus":"...","nextStep":"...","blockedOn":"..."}</continuation-capsule>');
  });

  it('documents deferred self-invocation when defer actions are enabled', () => {
    const flags: ActionCategoryFlags = {
      channels: false,
      messaging: false,
      guild: false,
      moderation: false,
      polls: false,
      tasks: false,
      crons: false,
      botProfile: false,
      forge: false,
      plan: false,
      memory: false,
      config: false,
      defer: true,
    };

    const prompt = discordActionsPromptSection(flags);
    expect(prompt).toContain('### Deferred self-invocation');
    expect(prompt).toContain('{"type":"defer","channel":"general","delaySeconds":600,"prompt":"Check on the forge run"}');
    expect(prompt).toContain('without another user prompt');
    expect(prompt).toContain('DISCOCLAW_DISCORD_ACTIONS_DEFER_MAX_DELAY_SECONDS');
    expect(prompt).toContain('DISCOCLAW_DISCORD_ACTIONS_DEFER_MAX_CONCURRENT');
    expect(prompt).toContain('DISCOCLAW_DISCORD_ACTIONS_DEFER_MAX_DEPTH');
    expect(prompt).toContain('no conversation history');
  });

  it('includes imagegen guidance whenever the caller advertises imagegen', () => {
    const flags: ActionCategoryFlags = {
      channels: false,
      messaging: false,
      guild: false,
      moderation: false,
      polls: false,
      tasks: false,
      crons: false,
      botProfile: false,
      forge: false,
      plan: false,
      memory: false,
      config: false,
      defer: false,
      imagegen: true,
    };

    const prompt = discordActionsPromptSection(flags, 'ClawBot');
    expect(prompt).toContain('### Image Generation');
    expect(prompt).toContain('"type":"generateImage"');
  });
});

describe('buildTieredDiscordActionsPromptSection', () => {
  const TIER_FLAGS: ActionCategoryFlags = {
    channels: true,
    messaging: true,
    guild: true,
    moderation: true,
    polls: true,
    tasks: true,
    crons: true,
    botProfile: true,
    forge: true,
    plan: true,
    memory: true,
    config: true,
    defer: true,
    imagegen: true,
    voice: true,
    spawn: true,
  };

  it('includes only core categories for a plain turn', () => {
    const selection = buildTieredDiscordActionsPromptSection(TIER_FLAGS, 'ClawBot', {
      channelName: 'general',
      channelContextPath: null,
      isThread: false,
      userText: 'hello',
    });

    expect(selection.includedCategories).toEqual(['messaging', 'channels']);
    expect(selection.tierBuckets.core).toEqual(['messaging', 'channels']);
    expect(selection.tierBuckets.channelContextual).toEqual([]);
    expect(selection.tierBuckets.keywordTriggered).toEqual([]);
    expect(selection.prompt).toContain('### Messaging');
    expect(selection.prompt).toContain('### Channel Management');
    expect(selection.prompt).not.toContain('### Task Tracking');
    expect(selection.prompt).not.toContain('### Memory (Durable User Memory)');
  });

  it('adds task schemas for task-thread contextual turns without unrelated categories', () => {
    const selection = buildTieredDiscordActionsPromptSection(TIER_FLAGS, 'ClawBot', {
      channelName: 'task-ws-204',
      channelContextPath: '/tmp/context/tasks/task-ws-204.md',
      isThread: true,
      userText: 'status update',
    });

    expect(selection.includedCategories).toEqual(['messaging', 'channels', 'tasks']);
    expect(selection.tierBuckets.channelContextual).toEqual(['tasks']);
    expect(selection.prompt).toContain('### Task Tracking');
    expect(selection.prompt).not.toContain('### Cron Scheduled Tasks');
    expect(selection.prompt).not.toContain('### Memory (Durable User Memory)');
    expect(selection.prompt).not.toContain('### Plan Management');
  });

  it('adds keyword-triggered schemas and deduplicates overlap', () => {
    const selection = buildTieredDiscordActionsPromptSection(TIER_FLAGS, 'ClawBot', {
      channelName: 'general',
      channelContextPath: null,
      isThread: false,
      userText: 'Remember this, draft a plan with forge, and schedule a cron reminder. Also make a task.',
    });

    expect(selection.keywordHits).toEqual(['memory', 'task', 'plan', 'forge', 'cron']);
    expect(selection.tierBuckets.keywordTriggered).toEqual(['memory', 'tasks', 'plan', 'forge', 'crons', 'defer']);
    expect(new Set(selection.tierBuckets.keywordTriggered).size).toBe(selection.tierBuckets.keywordTriggered.length);
    expect(selection.prompt).toContain('### Memory (Durable User Memory)');
    expect(selection.prompt).toContain('### Task Tracking');
    expect(selection.prompt).toContain('### Plan Management');
    expect(selection.prompt).toContain('### Forge (Plan Drafting + Audit)');
    expect(selection.prompt).toContain('### Cron Scheduled Tasks');
    expect(selection.prompt).toContain('### Deferred self-invocation');
  });

  it('routes natural-language image requests into the imagegen category', () => {
    const phrases = [
      'generate a mockup',
      'create a picture',
      'make me an icon',
      'render a scene',
      'make me a tiny app icon',
      'craft a profile picture',
    ];

    for (const userText of phrases) {
      const selection = buildTieredDiscordActionsPromptSection(TIER_FLAGS, 'ClawBot', {
        channelName: 'general',
        channelContextPath: null,
        isThread: false,
        userText,
      });

      expect(selection.keywordHits).toContain('imagegen');
      expect(selection.tierBuckets.keywordTriggered).toContain('imagegen');
      expect(selection.includedCategories).toContain('imagegen');
      expect(selection.prompt).toContain('### Image Generation');
    }
  });

  it('does not route ambiguous non-image creation requests into imagegen', () => {
    const phrases = [
      'make a plan',
      'design the architecture',
      'create a task',
    ];

    for (const userText of phrases) {
      const selection = buildTieredDiscordActionsPromptSection(TIER_FLAGS, 'ClawBot', {
        channelName: 'general',
        channelContextPath: null,
        isThread: false,
        userText,
      });

      expect(selection.keywordHits).not.toContain('imagegen');
      expect(selection.tierBuckets.keywordTriggered).not.toContain('imagegen');
      expect(selection.includedCategories).not.toContain('imagegen');
      expect(selection.prompt).not.toContain('### Image Generation');
    }
  });

  it('hard-blocks disabled categories even when keywords/context hit', () => {
    const selection = buildTieredDiscordActionsPromptSection(
      { ...TIER_FLAGS, memory: false, plan: false, forge: false, crons: false, defer: false },
      'ClawBot',
      {
        channelName: 'cron-and-planning',
        channelContextPath: '/tmp/context/tasks/thread.md',
        isThread: true,
        userText: 'remember this and make a plan in forge with cron reminder',
      },
    );

    expect(selection.keywordHits).toEqual(['memory', 'plan', 'forge', 'cron']);
    expect(selection.includedCategories).toEqual(['messaging', 'channels', 'tasks']);
    expect(selection.prompt).not.toContain('### Memory (Durable User Memory)');
    expect(selection.prompt).not.toContain('### Plan Management');
    expect(selection.prompt).not.toContain('### Forge (Plan Drafting + Audit)');
    expect(selection.prompt).not.toContain('### Cron Scheduled Tasks');
    expect(selection.prompt).not.toContain('### Deferred self-invocation');
  });

  it('routes workspace and doctor warning language into the config category', () => {
    const selection = buildTieredDiscordActionsPromptSection(TIER_FLAGS, 'ClawBot', {
      channelName: 'general',
      channelContextPath: null,
      isThread: false,
      userText: 'Can you check whether that workspace bootstrap warning is still current with doctor?',
    });

    expect(selection.keywordHits).toContain('config');
    expect(selection.includedCategories).toContain('config');
    expect(selection.prompt).toContain('workspaceWarnings');
  });
});

// ---------------------------------------------------------------------------
// shouldTriggerFollowUp — voice query actions
// ---------------------------------------------------------------------------

describe('shouldTriggerFollowUp (voice)', () => {
  it('returns true when voiceStatus succeeds', () => {
    const result = shouldTriggerFollowUp(
      [{ type: 'voiceStatus' }],
      [{ ok: true }],
    );
    expect(result).toBe(true);
  });

  it('returns true when workspaceWarnings succeeds', () => {
    const result = shouldTriggerFollowUp(
      [{ type: 'workspaceWarnings' }],
      [{ ok: true }],
    );
    expect(result).toBe(true);
  });
});
