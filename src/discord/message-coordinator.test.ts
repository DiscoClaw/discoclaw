/**
 * Tests guild-chat prompt assembly — verifies the capability-refusal grounding
 * rule is injected alongside the live action inventory so the model trusts
 * the per-turn inventory over generic product knowledge.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineEvent } from '../runtime/types.js';
import { _resetForTest as resetAbortRegistry } from './abort-registry.js';
import { _resetForTest as resetInflightReplies } from './inflight-replies.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../workspace-bootstrap.js', () => ({
  isOnboardingComplete: vi.fn(async () => true),
}));

const FAKE_INVENTORY_PROMPT =
  '### Available action types this turn\ncronCreate, cronList\n\n' +
  'Before refusing any Discord-managed resource request as manual-only or unsupported, ' +
  'check the list above.';

vi.mock('./actions.js', () => ({
  parseDiscordActions: vi.fn((_text: string) => ({
    actions: [],
    cleanText: _text,
    strippedUnrecognizedTypes: [],
    parseFailures: 0,
  })),
  executeDiscordActions: vi.fn(async () => []),
  buildTieredDiscordActionsPromptSection: vi.fn(() => ({
    prompt: FAKE_INVENTORY_PROMPT,
    includedCategories: ['crons'],
    tierBuckets: { core: [], channelContextual: [], keywordTriggered: ['crons'] },
    keywordHits: ['cron'],
  })),
  buildDisplayResultLines: vi.fn(() => []),
  buildAllResultLines: vi.fn(() => []),
  appendActionResults: vi.fn((body: string) => body),
  withoutRequesterGatedActionFlags: vi.fn((flags: unknown) => flags),
}));

vi.mock('./transport-client.js', () => ({
  DiscordTransportClient: vi.fn(() => ({})),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Runtime that captures the prompt passed to invoke. */
function makeCaptureRuntime() {
  let capturedPrompt = '';
  const runtime = {
    id: 'test',
    capabilities: new Set<string>(['streaming_text']),
    async *invoke(opts: { prompt: string }): AsyncIterable<EngineEvent> {
      capturedPrompt = opts.prompt;
      yield { type: 'text_final', text: 'Sure, I can create that cron job.' };
      yield { type: 'done' };
    },
    get prompt() {
      return capturedPrompt;
    },
  };
  return runtime;
}

function makeParams(runtime: any, overrides: Record<string, unknown> = {}) {
  return {
    allowUserIds: new Set(['user-1']),
    allowBotIds: new Set<string>(),
    botMessageMemoryWriteEnabled: false,
    botDisplayName: 'Weston',
    requireChannelContext: false,
    autoIndexChannelContext: false,
    autoJoinThreads: false,
    useRuntimeSessions: false,
    runtime,
    sessionManager: {} as any,
    workspaceCwd: '/tmp/workspace',
    projectCwd: '/tmp/workspace',
    groupsDir: '/tmp/workspace',
    useGroupDirCwd: false,
    runtimeModel: 'capable',
    runtimeTools: [],
    runtimeTimeoutMs: 30_000,
    discordActionsEnabled: true,
    discordActionsChannels: false,
    discordActionsMessaging: false,
    discordActionsGuild: false,
    discordActionsModeration: false,
    discordActionsPolls: false,
    discordActionsCrons: true,
    messageHistoryBudget: 0,
    summaryEnabled: false,
    summaryModel: 'fast',
    summaryMaxChars: 2000,
    summaryEveryNTurns: 6,
    summaryDataDir: '/tmp/workspace',
    durableMemoryEnabled: false,
    durableDataDir: '/tmp/workspace',
    durableInjectMaxChars: 2000,
    durableMaxItems: 100,
    memoryCommandsEnabled: false,
    planCommandsEnabled: false,
    forgeCommandsEnabled: false,
    summaryToDurableEnabled: false,
    shortTermMemoryEnabled: false,
    shortTermDataDir: '/tmp/workspace',
    shortTermMaxEntries: 0,
    shortTermMaxAgeMs: 0,
    shortTermInjectMaxChars: 0,
    streamStallWarningMs: 10_000,
    actionFollowupDepth: 0,
    reactionHandlerEnabled: false,
    reactionRemoveHandlerEnabled: false,
    reactionMaxAgeMs: 0,
    healthCommandsEnabled: false,
    metrics: {
      increment: vi.fn(),
      recordInvokeStart: vi.fn(),
      recordInvokeResult: vi.fn(),
      recordActionResult: vi.fn(),
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  } as any;
}

function makeGuildMessage(reply: any) {
  return {
    id: 'm1',
    type: 0,
    content: 'Create a cron job that posts daily at 9am',
    author: { id: 'user-1', bot: false },
    guildId: 'guild-1',
    guild: { id: 'guild-1' },
    channelId: 'ch-1',
    channel: {
      id: 'ch-1',
      name: 'general',
      send: vi.fn().mockResolvedValue({}),
      isThread: () => false,
    },
    client: { channels: { cache: new Map() }, user: { id: 'bot-1' } },
    attachments: new Map(),
    stickers: new Map(),
    embeds: [],
    mentions: { has: () => false },
    reply: vi.fn().mockResolvedValue(reply),
  };
}

function makeReply() {
  return {
    id: 'reply-1',
    edit: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    react: vi.fn(async () => ({ remove: vi.fn(async () => undefined) })),
  };
}

async function makeHandler(params: any, queue: any) {
  const { createMessageCreateHandler } = await import('./message-coordinator.js');
  return createMessageCreateHandler(params, queue);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('guild-chat prompt assembly — capability-refusal grounding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAbortRegistry();
    resetInflightReplies();
  });

  it('includes the capability-refusal grounding rule in the prompt when actions are enabled', async () => {
    const runtime = makeCaptureRuntime();
    const reply = makeReply();
    const msg = makeGuildMessage(reply);
    const params = makeParams(runtime);
    const queue = { run: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()) };
    const handler = await makeHandler(params, queue);

    await handler(msg as any);

    // The action inventory from the mock should be in the prompt
    expect(runtime.prompt).toContain('Available action types this turn');
    expect(runtime.prompt).toContain('cronCreate');

    // The coordinator-level capability-refusal grounding rule should be present
    expect(runtime.prompt).toContain('Capability-refusal rule');
    expect(runtime.prompt).toContain(
      'not general product knowledge or external documentation',
    );
    expect(runtime.prompt).toContain(
      'never claim the operation is manual-only or unsupported when the inventory says otherwise',
    );
  });

  it('omits the capability-refusal grounding rule when actions are disabled', async () => {
    const runtime = makeCaptureRuntime();
    const reply = makeReply();
    const msg = makeGuildMessage(reply);
    const params = makeParams(runtime, { discordActionsEnabled: false });
    const queue = { run: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()) };
    const handler = await makeHandler(params, queue);

    await handler(msg as any);

    expect(runtime.prompt).not.toContain('Capability-refusal rule');
  });
});
