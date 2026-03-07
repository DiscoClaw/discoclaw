import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _resetMessageCoordinatorStateForTests, createMessageCreateHandler } from './message-coordinator.js';
import { loadSummary, saveSummary } from './summarizer.js';

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

beforeEach(() => {
  _resetMessageCoordinatorStateForTests();
});

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
  let last = '';
  for (let i = 0; i < 200; i += 1) {
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

async function waitForStoredSummary(
  summaryDir: string,
  sessionKey: string,
  predicate: (summary: NonNullable<Awaited<ReturnType<typeof loadSummary>>>) => boolean,
): Promise<NonNullable<Awaited<ReturnType<typeof loadSummary>>>> {
  for (let i = 0; i < 200; i += 1) {
    const summary = await loadSummary(summaryDir, sessionKey);
    if (summary && predicate(summary)) return summary;
    await sleep(20);
  }
  throw new Error(`Timed out waiting for summary state for ${sessionKey}`);
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

  it('bootstraps continuation capsule persistence before the first rolling summary exists', async () => {
    let seenPrompt = '';
    const runtime = {
      id: 'test-runtime',
      capabilities: new Set(),
      invoke: vi.fn(async function* (p: any) {
        const prompt = String(p.prompt ?? '');
        if (!prompt.includes('Updated summary:')) seenPrompt = prompt;
        yield {
          type: 'text_final',
          text: [
            'Working on it.',
            '<continuation-capsule>',
            '{"activeTaskId":"ws-1170","currentFocus":"Keep the current task pinned","nextStep":"Patch the persistence path","blockedOn":"Need bootstrap storage"}',
            '</continuation-capsule>',
            'Done.',
          ].join('\n'),
        } as any;
      }),
    } as any;

    const summaryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-capsule-bootstrap-'));
    const handler = createMessageCreateHandler(
      makeParams(runtime, summaryDir, { summaryEveryNTurns: 99 }),
      makeQueue(),
    );

    await handler(makeMsg('start fresh', 'r-bootstrap'));

    expect(seenPrompt).toContain('Conversation memory:');
    expect(seenPrompt).toContain('No rolling summary yet.');
    expect(seenPrompt).toContain('emit an updated <continuation-capsule> block');

    const stored = await waitForStoredSummary(summaryDir, 'discord:channel:chan', summary =>
      summary.continuationCapsule?.activeTaskId === 'ws-1170',
    );
    expect(stored.summary).toBe('');
    expect(stored.continuationCapsule).toEqual({
      activeTaskId: 'ws-1170',
      currentFocus: 'Keep the current task pinned',
      nextStep: 'Patch the persistence path',
      blockedOn: 'Need bootstrap storage',
    });
  });

  it('shows summary age and newer-turn count when regeneratedAt is available', async () => {
    const now = Date.parse('2026-03-06T20:00:00.000Z');
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    let seenPrompt = '';
    const runtime = {
      id: 'test-runtime',
      capabilities: new Set(),
      invoke: vi.fn(async function* (p: any) {
        const prompt = String(p.prompt ?? '');
        if (!prompt.includes('Updated summary:')) seenPrompt = prompt;
        yield { type: 'text_final', text: 'ok' } as any;
      }),
    } as any;

    const summaryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-recency-'));
    try {
      await saveSummary(summaryDir, 'discord:channel:chan', {
        summary: '!models reset is pending and forge-auditor default is unset.',
        updatedAt: now - 5_000,
        regeneratedAt: now - 7_500_000,
        turnsSinceUpdate: 2,
      });

      const handler = createMessageCreateHandler(
        makeParams(runtime, summaryDir, {
          summaryEveryNTurns: 99,
          messageHistoryBudget: 200,
        }),
        makeQueue(),
      );

      const msg = makeMsg('What is the current status?', 'r-recency');
      msg.channel.messages = {
        fetch: vi.fn(async () => makeHistoryCollection([
          {
            author: { bot: false, username: 'tester', displayName: 'Tester' },
            content: 'The fix is merged, deployed, and already working.',
          },
        ])),
      };

      await handler(msg);

      expect(seenPrompt).toContain('Conversation memory:');
      expect(seenPrompt).toContain('Last regenerated 2h 5m ago; 2 newer turns since then.');
      expect(seenPrompt).toContain('trust the fresher evidence');
      expect(seenPrompt).toContain('Recent conversation:\n[Tester]: The fix is merged, deployed, and already working.');
      expect(seenPrompt.indexOf('Conversation memory:')).toBeLessThan(seenPrompt.indexOf('Recent conversation:'));
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('omits the recency annotation for legacy summary files without regeneratedAt', async () => {
    const now = Date.parse('2026-03-06T20:00:00.000Z');
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    let seenPrompt = '';
    const runtime = {
      id: 'test-runtime',
      capabilities: new Set(),
      invoke: vi.fn(async function* (p: any) {
        const prompt = String(p.prompt ?? '');
        if (!prompt.includes('Updated summary:')) seenPrompt = prompt;
        yield { type: 'text_final', text: 'ok' } as any;
      }),
    } as any;

    const summaryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-recency-legacy-'));
    try {
      await saveSummary(summaryDir, 'discord:channel:chan', {
        summary: 'Legacy rolling summary text.',
        updatedAt: now - 5_000,
        turnsSinceUpdate: 2,
      });

      const handler = createMessageCreateHandler(
        makeParams(runtime, summaryDir, { summaryEveryNTurns: 99 }),
        makeQueue(),
      );

      await handler(makeMsg('Status?', 'r-recency-legacy'));

      expect(seenPrompt).toContain('Conversation memory:');
      expect(seenPrompt).not.toContain('Last regenerated');
      expect(seenPrompt).not.toContain('newer turns since then');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('preserves regeneratedAt during counter-progress saves', async () => {
    const now = Date.parse('2026-03-06T20:00:00.000Z');
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    const runtime = {
      id: 'test-runtime',
      capabilities: new Set(),
      invoke: vi.fn(async function* () {
        yield { type: 'text_final', text: 'ok' } as any;
      }),
    } as any;

    const summaryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-regenerated-at-'));
    const regeneratedAt = now - 7_500_000;
    try {
      await saveSummary(summaryDir, 'discord:channel:chan', {
        summary: 'Existing summary',
        updatedAt: now - 1_000,
        regeneratedAt,
        turnsSinceUpdate: 2,
      });

      const handler = createMessageCreateHandler(
        makeParams(runtime, summaryDir, { summaryEveryNTurns: 99 }),
        makeQueue(),
      );

      await handler(makeMsg('Another turn', 'r-counter-progress'));

      const stored = await waitForStoredSummary(
        summaryDir,
        'discord:channel:chan',
        (summary) => summary.turnsSinceUpdate === 3,
      );

      expect(stored.updatedAt).toBe(now);
      expect(stored.regeneratedAt).toBe(regeneratedAt);
      expect(stored.turnsSinceUpdate).toBe(3);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('preserves newer async-written capsule state during counter-progress saves', async () => {
    let signalInvokeStarted: (() => void) | undefined;
    let releaseInvoke: (() => void) | undefined;
    const invokeStarted = new Promise<void>((resolve) => {
      signalInvokeStarted = resolve;
    });
    const invokeReleased = new Promise<void>((resolve) => {
      releaseInvoke = resolve;
    });
    const runtime = {
      id: 'test-runtime',
      capabilities: new Set(),
      invoke: vi.fn(async function* () {
        signalInvokeStarted?.();
        await invokeReleased;
        yield { type: 'text_final', text: 'ok' } as any;
      }),
    } as any;

    const summaryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-counter-progress-capsule-'));
    try {
      await saveSummary(summaryDir, 'discord:channel:chan', {
        summary: 'Older summary',
        updatedAt: 100,
        regeneratedAt: 100,
        turnsSinceUpdate: 2,
        continuationCapsule: {
          currentFocus: 'Older focus',
          nextStep: 'Older next step',
          blockedOn: 'Older blocker',
        },
      });

      const handler = createMessageCreateHandler(
        makeParams(runtime, summaryDir, { summaryEveryNTurns: 99 }),
        makeQueue(),
      );

      const turnPromise = handler(makeMsg('Another turn', 'r-counter-progress-capsule'));
      await invokeStarted;

      await saveSummary(summaryDir, 'discord:channel:chan', {
        summary: 'New regenerated summary',
        updatedAt: 200,
        regeneratedAt: 200,
        turnsSinceUpdate: 0,
        continuationCapsule: {
          currentFocus: 'Newer focus',
          nextStep: 'Newer next step',
          blockedOn: 'Newer blocker',
        },
      });

      releaseInvoke?.();
      await turnPromise;

      const stored = await waitForStoredSummary(
        summaryDir,
        'discord:channel:chan',
        (summary) => summary.summary === 'New regenerated summary' && summary.turnsSinceUpdate === 1,
      );

      expect(stored.regeneratedAt).toBe(200);
      expect(stored.continuationCapsule).toEqual({
        currentFocus: 'Newer focus',
        nextStep: 'Newer next step',
        blockedOn: 'Newer blocker',
      });
    } finally {
      releaseInvoke?.();
    }
  });

  it('runs one-pass summary recompression when generated summary exceeds token threshold', async () => {
    let recompressCalls = 0;
    const runtime = {
      id: 'test-runtime',
      capabilities: new Set(),
      invoke: vi.fn(async function* (p: any) {
        const prompt = String(p.prompt ?? '');
        if (prompt.includes('Updated summary:')) {
          // 200 chars ~= 50 estimated tokens.
          yield { type: 'text_final', text: 'A'.repeat(200) } as any;
          return;
        }
        if (prompt.includes('Recompressed summary:')) {
          recompressCalls += 1;
          yield { type: 'text_final', text: 'compressed' } as any;
          return;
        }
        yield { type: 'text_final', text: 'ok' } as any;
      }),
    } as any;
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const summaryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-recompress-'));
    const handler = createMessageCreateHandler(
      makeParams(runtime, summaryDir, {
        summaryEveryNTurns: 1,
        summaryMaxTokens: 20,
        summaryTargetRatio: 0.5,
        log,
      }),
      makeQueue(),
    );

    await handler(makeMsg('trigger summary', 'r1'));

    const summaryFile = path.join(summaryDir, 'discord:channel:chan.json');
    await waitForFileSummary(summaryFile, 'compressed');

    expect(recompressCalls).toBe(1);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: 'discord:channel:chan',
        beforeTokens: 50,
        afterTokens: 3,
        thresholdTokens: 20,
        targetTokens: 10,
      }),
      'discord:summary recompression',
    );
    expect(log.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      'discord:summary recompression still above threshold',
    );
  });

  it('does not recompress when generated summary is under token threshold', async () => {
    let recompressCalls = 0;
    const runtime = {
      id: 'test-runtime',
      capabilities: new Set(),
      invoke: vi.fn(async function* (p: any) {
        const prompt = String(p.prompt ?? '');
        if (prompt.includes('Updated summary:')) {
          // 40 chars ~= 10 estimated tokens.
          yield { type: 'text_final', text: 'B'.repeat(40) } as any;
          return;
        }
        if (prompt.includes('Recompressed summary:')) {
          recompressCalls += 1;
          yield { type: 'text_final', text: 'should-not-run' } as any;
          return;
        }
        yield { type: 'text_final', text: 'ok' } as any;
      }),
    } as any;
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const summaryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-no-recompress-'));
    const handler = createMessageCreateHandler(
      makeParams(runtime, summaryDir, {
        summaryEveryNTurns: 1,
        summaryMaxTokens: 20,
        summaryTargetRatio: 0.5,
        log,
      }),
      makeQueue(),
    );

    await handler(makeMsg('trigger summary', 'r1'));

    const summaryFile = path.join(summaryDir, 'discord:channel:chan.json');
    await waitForFileSummary(summaryFile, 'B'.repeat(40));

    expect(recompressCalls).toBe(0);
    expect(log.info).not.toHaveBeenCalledWith(
      expect.anything(),
      'discord:summary recompression',
    );
    expect(log.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      'discord:summary recompression still above threshold',
    );
  });

  it('keeps original summary when recompression output is empty/whitespace', async () => {
    let recompressCalls = 0;
    const originalSummary = 'C'.repeat(200);
    const runtime = {
      id: 'test-runtime',
      capabilities: new Set(),
      invoke: vi.fn(async function* (p: any) {
        const prompt = String(p.prompt ?? '');
        if (prompt.includes('Updated summary:')) {
          yield { type: 'text_final', text: originalSummary } as any;
          return;
        }
        if (prompt.includes('Recompressed summary:')) {
          recompressCalls += 1;
          yield { type: 'text_final', text: '   \n\t   ' } as any;
          return;
        }
        yield { type: 'text_final', text: 'ok' } as any;
      }),
    } as any;
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const summaryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-empty-recompress-'));
    const handler = createMessageCreateHandler(
      makeParams(runtime, summaryDir, {
        summaryEveryNTurns: 1,
        summaryMaxTokens: 20,
        summaryTargetRatio: 0.5,
        log,
      }),
      makeQueue(),
    );

    await handler(makeMsg('trigger summary', 'r1'));

    const summaryFile = path.join(summaryDir, 'discord:channel:chan.json');
    await waitForFileSummary(summaryFile, originalSummary);

    expect(recompressCalls).toBe(1);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: 'discord:channel:chan',
        beforeTokens: 50,
        afterTokens: 50,
        thresholdTokens: 20,
        targetTokens: 10,
      }),
      'discord:summary recompression',
    );
  });

  it('warns once and does not loop when recompressed summary remains over threshold', async () => {
    let recompressCalls = 0;
    const runtime = {
      id: 'test-runtime',
      capabilities: new Set(),
      invoke: vi.fn(async function* (p: any) {
        const prompt = String(p.prompt ?? '');
        if (prompt.includes('Updated summary:')) {
          // 200 chars ~= 50 estimated tokens.
          yield { type: 'text_final', text: 'D'.repeat(200) } as any;
          return;
        }
        if (prompt.includes('Recompressed summary:')) {
          recompressCalls += 1;
          // 120 chars ~= 30 estimated tokens, still above threshold(20).
          yield { type: 'text_final', text: 'E'.repeat(120) } as any;
          return;
        }
        yield { type: 'text_final', text: 'ok' } as any;
      }),
    } as any;
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const summaryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-still-over-threshold-'));
    const handler = createMessageCreateHandler(
      makeParams(runtime, summaryDir, {
        summaryEveryNTurns: 1,
        summaryMaxTokens: 20,
        summaryTargetRatio: 0.5,
        log,
      }),
      makeQueue(),
    );

    await handler(makeMsg('trigger summary', 'r1'));

    const summaryFile = path.join(summaryDir, 'discord:channel:chan.json');
    await waitForFileSummary(summaryFile, 'E'.repeat(120));

    expect(recompressCalls).toBe(1);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: 'discord:channel:chan',
        beforeTokens: 50,
        afterTokens: 30,
        thresholdTokens: 20,
        targetTokens: 10,
      }),
      'discord:summary recompression',
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: 'discord:channel:chan',
        beforeTokens: 50,
        afterTokens: 30,
        thresholdTokens: 20,
        targetTokens: 10,
      }),
      'discord:summary recompression still above threshold',
    );
  });
});
