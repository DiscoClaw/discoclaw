import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMessageCreateHandler } from '../discord.js';

function makeQueue() {
  return {
    run: vi.fn(async (_key: string, fn: () => Promise<any>) => fn()),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    channel: { send: vi.fn(async () => {}), isThread: () => false, name: 'general', id: 'chan' },
    content,
    attachments: new Map(),
    stickers: new Map(),
    embeds: [],
    mentions: { has: () => false },
    client: { user: { id: 'bot-1' }, channels: { cache: new Map() } },
    reply: vi.fn(async () => replyObj),
  };
}

function makeParams(runtime: any, summaryDataDir: string, overrides: Partial<any> = {}) {
  return {
    allowUserIds: new Set(['123']),
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
    summaryEnabled: true,
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
    durableMemoryEnabled: true,
    durableDataDir: '/tmp/durable',
    durableInjectMaxChars: 2000,
    durableMaxItems: 200,
    memoryCommandsEnabled: true,
    actionFollowupDepth: 0,
    reactionHandlerEnabled: false,
    reactionRemoveHandlerEnabled: false,
    reactionMaxAgeMs: 86400000,
    streamStallWarningMs: 0,
    botDisplayName: 'TestBot',
    ...overrides,
  };
}

async function waitForFileSummary(filePath: string, expected: string): Promise<void> {
  const deadline = Date.now() + 4000;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      last = JSON.parse(raw).summary;
      if (last === expected) return;
    } catch {
      // keep polling
    }
    await sleep(20);
  }
  throw new Error(`Timed out waiting for summary "${expected}". Last seen: "${last}"`);
}

describe('memory timing integration', () => {
  it('serializes summary writes so stale async completions do not overwrite newer summary', async () => {
    let summaryCall = 0;
    const runtime = {
      id: 'test-runtime',
      capabilities: new Set(),
      invoke: vi.fn(async function* (p: any) {
        const prompt = String(p.prompt ?? '');
        if (prompt.includes('Updated summary:')) {
          summaryCall += 1;
          if (summaryCall === 1) await sleep(80);
          if (summaryCall === 2) await sleep(10);
          yield { type: 'text_final', text: summaryCall === 1 ? 'summary:first' : 'summary:second' } as any;
          return;
        }
        yield { type: 'text_final', text: 'ok' } as any;
      }),
    } as any;

    const summaryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-timing-summary-'));
    const handler = createMessageCreateHandler(
      makeParams(runtime, summaryDir, { summaryEveryNTurns: 1 }),
      makeQueue(),
    );

    await handler(makeMsg('first turn', 'r1'));
    await handler(makeMsg('second turn', 'r2'));

    const summaryFile = path.join(summaryDir, 'discord:channel:chan.json');
    await waitForFileSummary(summaryFile, 'summary:second');
  });

  it('reset rolling clears in-memory turn counter so next turn does not prematurely regenerate summary', async () => {
    const runtime = {
      id: 'test-runtime',
      capabilities: new Set(),
      invoke: vi.fn(async function* (p: any) {
        const prompt = String(p.prompt ?? '');
        if (prompt.includes('Updated summary:')) {
          yield { type: 'text_final', text: 'summary:generated' } as any;
          return;
        }
        yield { type: 'text_final', text: 'ok' } as any;
      }),
    } as any;

    const summaryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-reset-counter-'));
    const handler = createMessageCreateHandler(
      makeParams(runtime, summaryDir, { summaryEveryNTurns: 2 }),
      makeQueue(),
    );

    await handler(makeMsg('turn one', 'r1'));
    await handler(makeMsg('!memory reset rolling', 'r2'));
    await handler(makeMsg('turn two', 'r3'));
    await sleep(200);

    const summaryFile = path.join(summaryDir, 'discord:channel:chan.json');
    await expect(fs.access(summaryFile)).rejects.toThrow();
  });
});
