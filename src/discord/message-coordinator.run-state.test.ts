import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _resetMessageCoordinatorStateForTests, createMessageCreateHandler } from './message-coordinator.js';
import { _resetForTest as resetForgePlanRegistry, addRunningPlan } from './forge-plan-registry.js';

function makeQueue() {
  return {
    run: async <T>(_key: string, fn: () => Promise<T>) => fn(),
  };
}

function makeReply(id: string) {
  return {
    id,
    channelId: 'chan',
    edit: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    react: vi.fn(async () => {}),
    reactions: { resolve: () => ({ remove: async () => {} }) },
  };
}

function makeMsg(content: string, replyId: string) {
  const replyObj = makeReply(replyId);
  return {
    id: `msg-${replyId}`,
    type: 0,
    author: { id: '123', bot: false, username: 'tester', displayName: 'Tester' },
    guildId: 'guild',
    guild: { roles: { everyone: {} } },
    channelId: 'chan',
    channel: {
      send: vi.fn(async () => {}),
      isThread: () => false,
      name: 'general',
      id: 'chan',
      messages: { fetch: vi.fn(async () => makeHistoryCollection([])) },
    },
    content,
    attachments: new Map(),
    stickers: new Map(),
    embeds: [],
    mentions: { has: () => false },
    client: { user: { id: 'bot-1' }, channels: { cache: new Map() } },
    reply: vi.fn(async () => replyObj),
  };
}

function makeHistoryCollection(messages: any[]) {
  return {
    size: messages.length,
    values: function* values() {
      yield* messages;
    },
  };
}

function makeParams(runtime: any, summaryDataDir: string, overrides: Partial<any> = {}) {
  return {
    allowUserIds: new Set(['123']),
    allowBotIds: new Set<string>(),
    botMessageMemoryWriteEnabled: false,
    runtime,
    sessionManager: { getOrCreate: vi.fn(async () => 'sess') } as any,
    workspaceCwd: '/tmp',
    projectCwd: '/tmp',
    groupsDir: '/tmp',
    useGroupDirCwd: false,
    runtimeModel: 'fast',
    runtimeTools: [],
    runtimeTimeoutMs: 1000,
    requireChannelContext: false,
    autoIndexChannelContext: false,
    autoJoinThreads: false,
    useRuntimeSessions: true,
    discordActionsEnabled: false,
    discordActionsChannels: false,
    discordActionsMessaging: false,
    discordActionsGuild: false,
    discordActionsModeration: false,
    discordActionsPolls: false,
    discordActionsTasks: false,
    discordActionsBotProfile: false,
    messageHistoryBudget: 0,
    summaryEnabled: false,
    summaryModel: 'fast',
    summaryMaxChars: 2000,
    summaryEveryNTurns: 1,
    summaryDataDir,
    summaryToDurableEnabled: false,
    shortTermMemoryEnabled: false,
    shortTermDataDir: '/tmp/shortterm',
    shortTermMaxEntries: 20,
    shortTermMaxAgeMs: 21600000,
    shortTermInjectMaxChars: 1000,
    durableMemoryEnabled: false,
    durableDataDir: '/tmp/durable',
    durableInjectMaxChars: 2000,
    durableMaxItems: 200,
    memoryCommandsEnabled: false,
    actionFollowupDepth: 0,
    reactionHandlerEnabled: false,
    reactionRemoveHandlerEnabled: false,
    reactionMaxAgeMs: 86400000,
    streamStallWarningMs: 0,
    botDisplayName: 'TestBot',
    ...overrides,
  };
}

beforeEach(() => {
  _resetMessageCoordinatorStateForTests();
  resetForgePlanRegistry();
});

describe('message coordinator run-state prompt guidance', () => {
  it('injects a dead-run guard into typed user prompts when no forge or plan run is active in the channel', async () => {
    let seenPrompt = '';
    const runtime = {
      id: 'test-runtime',
      capabilities: new Set(),
      invoke: vi.fn(async function* (p: any) {
        seenPrompt = String(p.prompt ?? '');
        yield { type: 'text_final', text: 'ok' } as any;
      }),
    } as any;

    const summaryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'message-run-state-'));
    const handler = createMessageCreateHandler(makeParams(runtime, summaryDir), makeQueue());

    await handler(makeMsg('Are you still working on ws-1219?', 'r1') as any);

    const runStateIdx = seenPrompt.indexOf('Tracked forge/plan run state: there is no active forge or plan run in this channel right now.');
    const boundaryIdx = seenPrompt.indexOf('The sections above are internal system context.');
    const userMessageIdx = seenPrompt.indexOf('User message:');

    expect(runStateIdx).toBeGreaterThanOrEqual(0);
    expect(boundaryIdx).toBeGreaterThan(runStateIdx);
    expect(userMessageIdx).toBeGreaterThan(boundaryIdx);
    expect(seenPrompt).toContain('Do not claim that work is currently running, auditing, being handled, or still in progress.');
  });

  it('injects the active-run note instead when a forge or plan run is active in the channel', async () => {
    addRunningPlan('plan-1219', 'chan');

    let seenPrompt = '';
    const runtime = {
      id: 'test-runtime',
      capabilities: new Set(),
      invoke: vi.fn(async function* (p: any) {
        seenPrompt = String(p.prompt ?? '');
        yield { type: 'text_final', text: 'ok' } as any;
      }),
    } as any;

    const summaryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'message-run-state-'));
    const handler = createMessageCreateHandler(makeParams(runtime, summaryDir), makeQueue());

    await handler(makeMsg('Status?', 'r2') as any);

    expect(seenPrompt).toContain('Tracked forge/plan run state: a forge or plan run is currently active in this channel.');
    expect(seenPrompt).not.toContain('there is no active forge or plan run in this channel right now');
  });

  it('injects the active-run note in a task thread when the run is registered with both thread and parent forum IDs', async () => {
    addRunningPlan('plan-1219', ['thread-1', 'forum-1']);

    let seenPrompt = '';
    const runtime = {
      id: 'test-runtime',
      capabilities: new Set(),
      invoke: vi.fn(async function* (p: any) {
        seenPrompt = String(p.prompt ?? '');
        yield { type: 'text_final', text: 'ok' } as any;
      }),
    } as any;

    const summaryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'message-run-state-thread-'));
    const handler = createMessageCreateHandler(makeParams(runtime, summaryDir), makeQueue());

    await handler({
      ...makeMsg('Status?', 'r3'),
      channelId: 'thread-1',
      channel: {
        send: vi.fn(async () => {}),
        isThread: () => true,
        parentId: 'forum-1',
        name: 'ws-1221',
        id: 'thread-1',
        messages: { fetch: vi.fn(async () => makeHistoryCollection([])) },
      },
    } as any);

    expect(seenPrompt).toContain('Tracked forge/plan run state: a forge or plan run is currently active in this channel.');
    expect(seenPrompt).not.toContain('there is no active forge or plan run in this channel right now');
  });
});
