/**
 * Tests guild-chat prompt assembly — verifies the capability-refusal grounding
 * rule is injected alongside the live action inventory so the model trusts
 * the per-turn inventory over generic product knowledge.
 *
 * Also tests image input precedence across direct, reply-reference, and
 * history sources.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineEvent, ImageData } from '../runtime/types.js';
import { MAX_IMAGES_PER_INVOCATION } from '../runtime/types.js';
import { _resetForTest as resetAbortRegistry } from './abort-registry.js';
import { _resetForTest as resetInflightReplies, drainInFlightReplies } from './inflight-replies.js';
import { LongRunWatchdog } from './long-run-watchdog.js';
import type { AttachmentLike } from './image-download.js';

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

vi.mock('./image-download.js', () => ({
  downloadMessageImages: vi.fn(async () => ({ images: [], errors: [] })),
  resolveMediaType: vi.fn((att: any) => {
    const ct = att?.contentType;
    return ct && typeof ct === 'string' && ct.startsWith('image/') ? ct : null;
  }),
}));

vi.mock('./message-history.js', () => ({
  fetchMessageHistory: vi.fn(async () => ({ text: '', historyAttachments: [] })),
}));

vi.mock('./reply-reference.js', () => ({
  resolveReplyReference: vi.fn(async () => null),
}));

vi.mock('../health/config-doctor.js', () => ({
  inspect: vi.fn(async () => ({
    installMode: 'npm-managed',
    findings: [],
    configPaths: {
      env: '/tmp/workspace/.env',
      dataDir: '/tmp/workspace/data',
    },
  })),
  applyFixes: vi.fn(async () => ({
    applied: [],
    skipped: [],
    errors: [],
  })),
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

/** Runtime that captures both prompt and images passed to invoke. */
function makeImageCaptureRuntime() {
  let capturedPrompt = '';
  let capturedImages: ImageData[] | undefined;
  const runtime = {
    id: 'test',
    capabilities: new Set<string>(['streaming_text']),
    async *invoke(opts: { prompt: string; images?: ImageData[] }): AsyncIterable<EngineEvent> {
      capturedPrompt = opts.prompt;
      capturedImages = opts.images;
      yield { type: 'text_final', text: 'ok' };
      yield { type: 'done' };
    },
    get prompt() { return capturedPrompt; },
    get images() { return capturedImages; },
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

function makeGuildMessage(reply: any, overrides: Record<string, unknown> = {}) {
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
    ...overrides,
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
  const { _resetMessageCoordinatorStateForTests, createMessageCreateHandler } = await import('./message-coordinator.js');
  _resetMessageCoordinatorStateForTests();
  return createMessageCreateHandler(params, queue);
}

/** Create a fake ImageData object with an identifiable label baked into base64. */
function fakeImage(label: string): ImageData {
  return { base64: Buffer.from(label).toString('base64'), mediaType: 'image/png' };
}

/** Create a fake AttachmentLike with a CDN URL. */
function fakeAttachment(name: string, url?: string): AttachmentLike {
  return {
    url: url ?? `https://cdn.discordapp.com/${name}`,
    name,
    contentType: 'image/png',
    size: 1024,
  };
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

  it('adds an explicit prompt note when plan and forge are disabled', async () => {
    const runtime = makeCaptureRuntime();
    const reply = makeReply();
    const msg = makeGuildMessage(reply, {
      content: 'Make a plan to refactor the webhook handler',
    });
    const params = makeParams(runtime, {
      planCommandsEnabled: false,
      forgeCommandsEnabled: false,
    });
    const queue = { run: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()) };
    const handler = await makeHandler(params, queue);

    await handler(msg as any);

    expect(runtime.prompt).toContain('Runtime capability notes:');
    expect(runtime.prompt).toContain('Plan workflows are disabled for this instance.');
    expect(runtime.prompt).toContain('Forge workflows are disabled for this instance.');
    expect(runtime.prompt).toContain('respond in normal chat with an outline or next steps');
  });

  it('warns when automatic plan routing is disabled but !plan remains available', async () => {
    const runtime = makeCaptureRuntime();
    const reply = makeReply();
    const msg = makeGuildMessage(reply, {
      content: 'Make a plan to refactor the webhook handler',
    });
    const params = makeParams(runtime, {
      planCommandsEnabled: true,
      discordActionsPlan: false,
    });
    const queue = { run: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()) };
    const handler = await makeHandler(params, queue);

    await handler(msg as any);

    expect(runtime.prompt).toContain('Automatic plan routing is disabled for this instance.');
    expect(runtime.prompt).toContain('only use the plan workflow when the user explicitly issues `!plan`');
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

  it('includes attachment names in action-routing text so schema selection sees attachment-heavy turns', async () => {
    const runtime = makeCaptureRuntime();
    const reply = makeReply();
    const msg = makeGuildMessage(reply, {
      content: 'Make an interactive chart from this dataset',
      attachments: new Map([
        ['1', {
          url: 'https://cdn.discordapp.com/report.csv',
          name: 'report.csv',
          contentType: 'text/csv',
          size: 128,
        }],
      ]),
    });
    const params = makeParams(runtime);
    const queue = { run: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()) };
    const handler = await makeHandler(params, queue);
    const actionsMod = await import('./actions.js');
    const buildTiered = vi.mocked(actionsMod.buildTieredDiscordActionsPromptSection);

    await handler(msg as any);

    const selectionArgs = buildTiered.mock.calls.at(-1)?.[2];
    expect(selectionArgs?.userText).toContain('Make an interactive chart from this dataset');
    expect(selectionArgs?.userText).toContain('report.csv');
  });
});

describe('guild-chat prompt assembly — release rehearsal artifact contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAbortRegistry();
    resetInflightReplies();
  });

  it('preserves exact quoted rehearsal artifact names in the runtime prompt', async () => {
    const runtime = makeCaptureRuntime();
    const reply = makeReply();
    const msg = makeGuildMessage(reply, {
      content:
        'Create one rehearsal task titled `Release rehearsal rr-20260322-183045-slug task` through the live Discord path.\n' +
        'Create one rehearsal cron named `Release rehearsal rr-20260322-183045-slug cron` through the live Discord path.',
    });
    const params = makeParams(runtime);
    const queue = { run: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()) };
    const handler = await makeHandler(params, queue);

    await handler(msg as any);

    expect(runtime.prompt).toContain('Artifact contract:');
    expect(runtime.prompt).toContain(
      '- If you create a task, set its title to exactly "Release rehearsal rr-20260322-183045-slug task".',
    );
    expect(runtime.prompt).toContain(
      '- If you create a cron, set its name to exactly "Release rehearsal rr-20260322-183045-slug cron".',
    );
    expect(runtime.prompt).toContain(
      '- Preserve these rehearsal slug literals verbatim: "rr-20260322-183045-slug".',
    );
  });

  it('preserves exact unquoted rehearsal artifact names in the runtime prompt', async () => {
    const runtime = makeCaptureRuntime();
    const reply = makeReply();
    const msg = makeGuildMessage(reply, {
      content:
        'Create one rehearsal task titled Release rehearsal rr-20260322-183045-slug task through the live Discord path.\n' +
        'Create one rehearsal cron named Release rehearsal rr-20260322-183045-slug cron through the live Discord path.',
    });
    const params = makeParams(runtime);
    const queue = { run: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()) };
    const handler = await makeHandler(params, queue);

    await handler(msg as any);

    expect(runtime.prompt).toContain(
      '- If you create a task, set its title to exactly "Release rehearsal rr-20260322-183045-slug task".',
    );
    expect(runtime.prompt).toContain(
      '- If you create a cron, set its name to exactly "Release rehearsal rr-20260322-183045-slug cron".',
    );
  });
});

describe('system command routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAbortRegistry();
    resetInflightReplies();
  });

  it('appends a Claude-auth disclaimer to !doctor replies', async () => {
    const runtime = makeCaptureRuntime();
    const reply = makeReply();
    const msg = makeGuildMessage(reply, { content: '!doctor' });
    const params = makeParams(runtime, { healthCommandsEnabled: true });
    const queue = { run: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()) };
    const handler = await makeHandler(params, queue);

    await handler(msg as any);

    const replyCall = vi.mocked(msg.reply).mock.calls[0]?.[0];
    expect(replyCall?.content).toContain('Config Doctor');
    expect(replyCall?.content).toContain('config drift and missing secrets only');
    expect(replyCall?.content).toContain('discoclaw claude auth-smoke');
  });
});

// ---------------------------------------------------------------------------
// Image input precedence tests
// ---------------------------------------------------------------------------

describe('image input precedence — direct > reply-ref > history', () => {
  let mockDownloadImages: ReturnType<typeof vi.fn>;
  let mockFetchHistory: ReturnType<typeof vi.fn>;
  let mockReplyRef: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetAbortRegistry();
    resetInflightReplies();

    const imgMod = await import('./image-download.js');
    mockDownloadImages = vi.mocked(imgMod.downloadMessageImages);
    // Reset to safe default — clearAllMocks only clears call history, not implementations.
    mockDownloadImages.mockResolvedValue({ images: [], errors: [] });

    const histMod = await import('./message-history.js');
    mockFetchHistory = vi.mocked(histMod.fetchMessageHistory);
    mockFetchHistory.mockResolvedValue({ text: '', historyAttachments: [] } as any);

    const refMod = await import('./reply-reference.js');
    mockReplyRef = vi.mocked(refMod.resolveReplyReference);
    mockReplyRef.mockResolvedValue(null);
  });

  it('direct images appear before reply-ref images', async () => {
    const directImg = fakeImage('direct-1');
    const refImg = fakeImage('ref-1');

    // downloadMessageImages is called once for direct attachments.
    mockDownloadImages.mockResolvedValueOnce({ images: [directImg], errors: [] });
    // resolveReplyReference already has downloaded images.
    mockReplyRef.mockResolvedValue({ section: '[User]: hi', images: [refImg] });

    const runtime = makeImageCaptureRuntime();
    const reply = makeReply();
    const att = fakeAttachment('pic.png');
    const attachments = new Map([['1', att]]);
    const msg = makeGuildMessage(reply, { attachments });
    const params = makeParams(runtime);
    const queue = { run: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()) };
    const handler = await makeHandler(params, queue);

    await handler(msg as any);

    expect(runtime.images).toEqual([directImg, refImg]);
  });

  it('reply-ref images appear before history images', async () => {
    const refImg = fakeImage('ref-1');
    const histImg = fakeImage('hist-1');

    // No direct attachments → downloadMessageImages not called for direct.
    mockReplyRef.mockResolvedValue({ section: '[User]: hi', images: [refImg] });
    // History returns attachments.
    const histAtt = fakeAttachment('hist.png');
    mockFetchHistory.mockResolvedValue({ text: 'history text', historyAttachments: [histAtt] });
    // downloadMessageImages called once for history attachments.
    mockDownloadImages.mockResolvedValueOnce({ images: [histImg], errors: [] });

    const runtime = makeImageCaptureRuntime();
    const reply = makeReply();
    const msg = makeGuildMessage(reply);
    const params = makeParams(runtime, { messageHistoryBudget: 500 });
    const queue = { run: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()) };
    const handler = await makeHandler(params, queue);

    await handler(msg as any);

    expect(runtime.images).toEqual([refImg, histImg]);
  });

  it('history images are downloaded newest-first (preserving fetchMessageHistory order)', async () => {
    const histImgA = fakeImage('hist-a');
    const histImgB = fakeImage('hist-b');

    // History returns attachments in newest-first order.
    const attNew = fakeAttachment('new.png');
    const attOld = fakeAttachment('old.png');
    mockFetchHistory.mockResolvedValue({
      text: 'history',
      historyAttachments: [attNew, attOld],
    });
    // downloadMessageImages receives them in the same order and returns both.
    mockDownloadImages.mockResolvedValueOnce({ images: [histImgA, histImgB], errors: [] });

    const runtime = makeImageCaptureRuntime();
    const reply = makeReply();
    const msg = makeGuildMessage(reply);
    const params = makeParams(runtime, { messageHistoryBudget: 500 });
    const queue = { run: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()) };
    const handler = await makeHandler(params, queue);

    await handler(msg as any);

    // Verify downloadMessageImages received attachments in newest-first order.
    expect(mockDownloadImages).toHaveBeenCalledWith(
      [attNew, attOld],
      expect.any(Number),
    );
    expect(runtime.images).toEqual([histImgA, histImgB]);
  });

  it('duplicate URLs between direct and history are only counted once', async () => {
    const directImg = fakeImage('direct-shared');
    const histImg = fakeImage('hist-unique');

    const sharedUrl = 'https://cdn.discordapp.com/shared.png';
    const directAtt = fakeAttachment('shared.png', sharedUrl);
    const histAttShared = fakeAttachment('shared.png', sharedUrl);
    const histAttUnique = fakeAttachment('unique.png');

    // Direct download returns one image.
    mockDownloadImages
      .mockResolvedValueOnce({ images: [directImg], errors: [] })
      // History download receives only the unique attachment (deduped).
      .mockResolvedValueOnce({ images: [histImg], errors: [] });

    mockFetchHistory.mockResolvedValue({
      text: 'history',
      historyAttachments: [histAttShared, histAttUnique],
    });

    const runtime = makeImageCaptureRuntime();
    const reply = makeReply();
    const attachments = new Map([['1', directAtt]]);
    const msg = makeGuildMessage(reply, { attachments });
    const params = makeParams(runtime, { messageHistoryBudget: 500 });
    const queue = { run: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()) };
    const handler = await makeHandler(params, queue);

    await handler(msg as any);

    // The second downloadMessageImages call should only receive the unique attachment.
    expect(mockDownloadImages).toHaveBeenCalledTimes(2);
    const historyCall = mockDownloadImages.mock.calls[1];
    expect(historyCall![0]).toEqual([histAttUnique]);
    expect(runtime.images).toEqual([directImg, histImg]);
  });

  it('history download is skipped when higher-priority sources exhaust the cap', async () => {
    // Fill budget with direct images (MAX_IMAGES_PER_INVOCATION).
    const directImages = Array.from({ length: MAX_IMAGES_PER_INVOCATION }, (_, i) =>
      fakeImage(`direct-${i}`),
    );
    mockDownloadImages.mockResolvedValueOnce({ images: directImages, errors: [] });

    // History has attachments, but budget should be exhausted.
    const histAtt = fakeAttachment('hist.png');
    mockFetchHistory.mockResolvedValue({
      text: 'history',
      historyAttachments: [histAtt],
    });

    const runtime = makeImageCaptureRuntime();
    const reply = makeReply();
    const directAtts = Array.from({ length: MAX_IMAGES_PER_INVOCATION }, (_, i) =>
      fakeAttachment(`img-${i}.png`),
    );
    const attachments = new Map(directAtts.map((a, i) => [String(i), a]));
    const msg = makeGuildMessage(reply, { attachments });
    const params = makeParams(runtime, { messageHistoryBudget: 500 });
    const queue = { run: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()) };
    const handler = await makeHandler(params, queue);

    await handler(msg as any);

    // downloadMessageImages should be called only once (for direct), not for history.
    expect(mockDownloadImages).toHaveBeenCalledTimes(1);
    expect(runtime.images).toEqual(directImages);
  });

  it('history images are skipped for codex runtime to avoid session reset', async () => {
    const histAtt = fakeAttachment('hist.png');
    mockFetchHistory.mockResolvedValue({ text: 'history', historyAttachments: [histAtt] });
    // Do NOT set mockResolvedValueOnce — download should never be called.

    const runtime = makeImageCaptureRuntime();
    // Override runtime id to 'codex'.
    (runtime as any).id = 'codex';
    const reply = makeReply();
    const msg = makeGuildMessage(reply);
    const params = makeParams(runtime, { messageHistoryBudget: 500 });
    const queue = { run: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()) };
    const handler = await makeHandler(params, queue);

    await handler(msg as any);

    // History images should NOT be downloaded for codex runtime.
    expect(mockDownloadImages).not.toHaveBeenCalled();
    expect(runtime.images).toBeUndefined();
  });

  it('reply-ref images are truncated when direct images consume most of the budget', async () => {
    // Direct fills budget minus 1 slot.
    const directImages = Array.from({ length: MAX_IMAGES_PER_INVOCATION - 1 }, (_, i) =>
      fakeImage(`direct-${i}`),
    );
    const refImages = [fakeImage('ref-0'), fakeImage('ref-1'), fakeImage('ref-2')];

    mockDownloadImages.mockResolvedValueOnce({ images: directImages, errors: [] });
    mockReplyRef.mockResolvedValue({ section: '[User]: hi', images: refImages });

    const runtime = makeImageCaptureRuntime();
    const reply = makeReply();
    const directAtts = Array.from({ length: MAX_IMAGES_PER_INVOCATION - 1 }, (_, i) =>
      fakeAttachment(`img-${i}.png`),
    );
    const attachments = new Map(directAtts.map((a, i) => [String(i), a]));
    const msg = makeGuildMessage(reply, { attachments });
    const params = makeParams(runtime);
    const queue = { run: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()) };
    const handler = await makeHandler(params, queue);

    await handler(msg as any);

    // Only 1 slot remains for reply-ref — should get only the first ref image.
    expect(runtime.images).toHaveLength(MAX_IMAGES_PER_INVOCATION);
    expect(runtime.images![0]).toEqual(directImages[0]);
    expect(runtime.images![runtime.images!.length - 1]).toEqual(refImages[0]);
  });
});

describe('manual message finalization guard', () => {
  const PROMISED_ACTION_WARNING =
    'Warning: this reply says Discord-managed work is starting or being handled now';

  beforeEach(() => {
    vi.clearAllMocks();
    resetAbortRegistry();
    resetInflightReplies();
  });

  it('warns and stages recovery when a reply claims immediate work but emits zero actionable or executed actions', async () => {
    const order: string[] = [];
    const runtime = {
      id: 'test',
      capabilities: new Set<string>(['streaming_text']),
      async *invoke(): AsyncIterable<EngineEvent> {
        yield { type: 'text_final', text: "I'm creating that task now." };
        yield { type: 'done' };
      },
    };
    const reply = {
      id: 'reply-1',
      edit: vi.fn(async (opts: { content: string }) => {
        order.push(`edit:${opts.content}`);
      }),
      delete: vi.fn(async () => undefined),
      react: vi.fn(async () => ({ remove: vi.fn(async () => undefined) })),
    };
    const msg = makeGuildMessage(reply);
    const actionsMod = await import('./actions.js');
    const watchdog = {
      start: vi.fn(async () => ({})),
      stageRecovery: vi.fn(async (_runId: string, input: { text?: string | null }) => {
        order.push(`stage:${input.text ?? ''}`);
        return {};
      }),
      complete: vi.fn(async () => null),
      startupSweep: vi.fn(async () => ({
        interruptedRuns: 0,
        finalRetried: 0,
        finalPosted: 0,
        finalFailed: 0,
      })),
    };
    const params = makeParams(runtime, { longRunWatchdog: watchdog });
    const queue = { run: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()) };
    const handler = await makeHandler(params, queue);

    await handler(msg as any);

    expect(vi.mocked(actionsMod.executeDiscordActions)).not.toHaveBeenCalled();
    expect(watchdog.stageRecovery).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        text: expect.stringContaining(PROMISED_ACTION_WARNING),
      }),
    );
    const stagedWarningIndex = order.findIndex(
      (entry) => entry.startsWith('stage:') && entry.includes(PROMISED_ACTION_WARNING),
    );
    let finalEditWarningIndex = -1;
    for (let i = order.length - 1; i >= 0; i -= 1) {
      const entry = order[i];
      if (entry.startsWith('edit:') && entry.includes(PROMISED_ACTION_WARNING)) {
        finalEditWarningIndex = i;
        break;
      }
    }
    expect(stagedWarningIndex).toBeGreaterThanOrEqual(0);
    expect(finalEditWarningIndex).toBeGreaterThanOrEqual(0);
    expect(stagedWarningIndex).toBeLessThan(finalEditWarningIndex);
    expect(reply.edit).toHaveBeenLastCalledWith({
      content: expect.stringContaining(PROMISED_ACTION_WARNING),
      allowedMentions: { parse: [] },
    });
  });

  it('warns for successful delta-only completions that claim immediate work but never emit actions', async () => {
    const runtime = {
      id: 'test',
      capabilities: new Set<string>(['streaming_text']),
      async *invoke(): AsyncIterable<EngineEvent> {
        yield { type: 'text_delta', text: "I'm creating that task now." };
        yield { type: 'done' };
      },
    };
    const reply = makeReply();
    const msg = makeGuildMessage(reply);
    const actionsMod = await import('./actions.js');
    const watchdog = {
      start: vi.fn(async () => ({})),
      stageRecovery: vi.fn(async () => ({})),
      complete: vi.fn(async () => null),
      startupSweep: vi.fn(async () => ({
        interruptedRuns: 0,
        finalRetried: 0,
        finalPosted: 0,
        finalFailed: 0,
      })),
    };
    const params = makeParams(runtime, { longRunWatchdog: watchdog });
    const queue = { run: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()) };
    const handler = await makeHandler(params, queue);

    await handler(msg as any);

    expect(vi.mocked(actionsMod.parseDiscordActions)).not.toHaveBeenCalled();
    expect(watchdog.stageRecovery).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        text: expect.stringContaining(PROMISED_ACTION_WARNING),
      }),
    );
    expect(reply.edit).toHaveBeenLastCalledWith({
      content: expect.stringContaining(PROMISED_ACTION_WARNING),
      allowedMentions: { parse: [] },
    });
  });

  it('does not warn when a real action executed', async () => {
    const runtime = {
      id: 'test',
      capabilities: new Set<string>(['streaming_text']),
      async *invoke(): AsyncIterable<EngineEvent> {
        yield { type: 'text_final', text: "I'm creating that task now." };
        yield { type: 'done' };
      },
    };
    const reply = makeReply();
    const msg = makeGuildMessage(reply);
    const actionsMod = await import('./actions.js');
    vi.mocked(actionsMod.parseDiscordActions).mockReturnValueOnce({
      actions: [{ type: 'sendMessage' } as any],
      cleanText: "I'm creating that task now.",
      strippedUnrecognizedTypes: [],
      parseFailures: 0,
    });
    vi.mocked(actionsMod.executeDiscordActions).mockResolvedValueOnce([
      { ok: true, summary: 'sent' } as any,
    ]);
    const watchdog = {
      start: vi.fn(async () => ({})),
      stageRecovery: vi.fn(async () => ({})),
      complete: vi.fn(async () => null),
      startupSweep: vi.fn(async () => ({
        interruptedRuns: 0,
        finalRetried: 0,
        finalPosted: 0,
        finalFailed: 0,
      })),
    };
    const params = makeParams(runtime, { longRunWatchdog: watchdog });
    const queue = { run: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()) };
    const handler = await makeHandler(params, queue);

    await handler(msg as any);

    expect(vi.mocked(actionsMod.executeDiscordActions)).toHaveBeenCalledTimes(1);
    expect(reply.edit).toHaveBeenLastCalledWith({
      content: "I'm creating that task now.",
      allowedMentions: { parse: [] },
    });
    expect(watchdog.stageRecovery).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        text: "I'm creating that task now.",
      }),
    );
    expect(reply.edit.mock.calls.at(-1)?.[0]?.content).not.toContain(PROMISED_ACTION_WARNING);
  });

  it('does not warn when the manual Discord action path is disabled entirely', async () => {
    const runtime = {
      id: 'test',
      capabilities: new Set<string>(['streaming_text']),
      async *invoke(): AsyncIterable<EngineEvent> {
        yield { type: 'text_final', text: "I'm creating that task now." };
        yield { type: 'done' };
      },
    };
    const reply = makeReply();
    const msg = makeGuildMessage(reply);
    const actionsMod = await import('./actions.js');
    const watchdog = {
      start: vi.fn(async () => ({})),
      stageRecovery: vi.fn(async () => ({})),
      complete: vi.fn(async () => null),
      startupSweep: vi.fn(async () => ({
        interruptedRuns: 0,
        finalRetried: 0,
        finalPosted: 0,
        finalFailed: 0,
      })),
    };
    const params = makeParams(runtime, {
      discordActionsEnabled: false,
      longRunWatchdog: watchdog,
    });
    const queue = { run: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()) };
    const handler = await makeHandler(params, queue);

    await handler(msg as any);

    expect(vi.mocked(actionsMod.parseDiscordActions)).not.toHaveBeenCalled();
    expect(reply.edit).toHaveBeenLastCalledWith({
      content: "I'm creating that task now.",
      allowedMentions: { parse: [] },
    });
    expect(watchdog.stageRecovery).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        text: "I'm creating that task now.",
      }),
    );
    expect(reply.edit.mock.calls.at(-1)?.[0]?.content).not.toContain(PROMISED_ACTION_WARNING);
  });
});

describe('message finalization recovery staging', () => {
  const COMPLETED_WITHOUT_VISIBLE_OUTPUT =
    'Completed successfully. Discord actions ran, but there was no additional reply text.';
  const COMPLETED_WITH_IMAGE_OUTPUT =
    'Completed successfully. Output included image attachments, but there was no additional reply text.';
  const FINALIZATION_LOSS_VISIBLE_TEXT =
    'Final delivery safeguard failed before I could post the terminal reply. Leaving this message visible instead of deleting it.';

  beforeEach(() => {
    vi.clearAllMocks();
    resetAbortRegistry();
    resetInflightReplies();
  });

  it('stages recovery before visible no-prose delivery and confirms delivery', async () => {
    const order: string[] = [];
    const runtime = makeCaptureRuntime();
    const reply = {
      id: 'reply-1',
      edit: vi.fn(async (opts: { content: string }) => {
        order.push(`edit:${opts.content}`);
      }),
      delete: vi.fn(async () => {
        order.push('delete');
      }),
      react: vi.fn(async () => ({ remove: vi.fn(async () => undefined) })),
    };
    const msg = makeGuildMessage(reply);
    const actionsMod = await import('./actions.js');
    vi.mocked(actionsMod.parseDiscordActions).mockReturnValueOnce({
      actions: [{ type: 'sendMessage' } as any],
      cleanText: '',
      strippedUnrecognizedTypes: [],
      parseFailures: 0,
    });
    vi.mocked(actionsMod.executeDiscordActions).mockResolvedValueOnce([
      { ok: true, summary: 'sent' } as any,
    ]);
    const watchdog = {
      start: vi.fn(async () => ({})),
      stageRecovery: vi.fn(async (_runId: string, input: { text?: string | null }) => {
        order.push(`stage:${input.text ?? ''}`);
        return {};
      }),
      complete: vi.fn(async () => null),
      startupSweep: vi.fn(async () => ({
        interruptedRuns: 0,
        finalRetried: 0,
        finalPosted: 0,
        finalFailed: 0,
      })),
    };
    const metrics = {
      increment: vi.fn(),
      recordInvokeStart: vi.fn(),
      recordInvokeResult: vi.fn(),
      recordActionResult: vi.fn(),
    };
    const params = makeParams(runtime, { longRunWatchdog: watchdog, metrics });
    const queue = { run: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()) };
    const handler = await makeHandler(params, queue);

    await handler(msg as any);

    expect(watchdog.stageRecovery).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ text: COMPLETED_WITHOUT_VISIBLE_OUTPUT }),
    );
    expect(order.indexOf(`stage:${COMPLETED_WITHOUT_VISIBLE_OUTPUT}`)).toBeLessThan(
      order.indexOf(`edit:${COMPLETED_WITHOUT_VISIBLE_OUTPUT}`),
    );
    expect(reply.edit).toHaveBeenCalledWith({
      content: COMPLETED_WITHOUT_VISIBLE_OUTPUT,
      allowedMentions: { parse: [] },
    });
    expect(reply.delete).not.toHaveBeenCalled();
    expect(metrics.increment).toHaveBeenCalledWith('discord.message.completed_without_visible_output');
    expect(metrics.increment).not.toHaveBeenCalledWith('discord.message.finalization_loss');
  });

  it('stages recovery for image-only completions before final Discord delivery', async () => {
    const order: string[] = [];
    const runtime = {
      id: 'test',
      capabilities: new Set<string>(['streaming_text']),
      async *invoke(): AsyncIterable<EngineEvent> {
        yield { type: 'image_data', image: fakeImage('chart') };
        yield { type: 'done' };
      },
    };
    const reply = {
      id: 'reply-1',
      edit: vi.fn(async (opts: { content: string }) => {
        order.push(`edit:${opts.content}`);
      }),
      delete: vi.fn(async () => {
        order.push('delete');
      }),
      react: vi.fn(async () => ({ remove: vi.fn(async () => undefined) })),
    };
    const msg = makeGuildMessage(reply);
    const watchdog = {
      start: vi.fn(async () => ({})),
      stageRecovery: vi.fn(async (_runId: string, input: { text?: string | null }) => {
        order.push(`stage:${input.text ?? ''}`);
        return {};
      }),
      complete: vi.fn(async () => null),
      startupSweep: vi.fn(async () => ({
        interruptedRuns: 0,
        finalRetried: 0,
        finalPosted: 0,
        finalFailed: 0,
      })),
    };
    const params = makeParams(runtime, { longRunWatchdog: watchdog });
    const queue = { run: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()) };
    const handler = await makeHandler(params, queue);

    await handler(msg as any);

    expect(watchdog.stageRecovery).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ text: COMPLETED_WITH_IMAGE_OUTPUT }),
    );
    expect(order.indexOf(`stage:${COMPLETED_WITH_IMAGE_OUTPUT}`)).toBeGreaterThanOrEqual(0);
    expect(reply.delete).not.toHaveBeenCalled();
  });

  it('treats a missing staged watchdog run as a staging failure', async () => {
    const runtime = makeCaptureRuntime();
    const reply = {
      id: 'reply-1',
      edit: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      react: vi.fn(async () => ({ remove: vi.fn(async () => undefined) })),
    };
    const msg = makeGuildMessage(reply);
    const actionsMod = await import('./actions.js');
    vi.mocked(actionsMod.parseDiscordActions).mockReturnValueOnce({
      actions: [{ type: 'sendMessage' } as any],
      cleanText: '',
      strippedUnrecognizedTypes: [],
      parseFailures: 0,
    });
    vi.mocked(actionsMod.executeDiscordActions).mockResolvedValueOnce([
      { ok: true, summary: 'sent' } as any,
    ]);
    const watchdog = {
      start: vi.fn(async () => ({})),
      stageRecovery: vi.fn(async () => null),
      complete: vi.fn(async () => null),
      startupSweep: vi.fn(async () => ({
        interruptedRuns: 0,
        finalRetried: 0,
        finalPosted: 0,
        finalFailed: 0,
      })),
    };
    const metrics = {
      increment: vi.fn(),
      recordInvokeStart: vi.fn(),
      recordInvokeResult: vi.fn(),
      recordActionResult: vi.fn(),
    };
    const params = makeParams(runtime, { longRunWatchdog: watchdog, metrics });
    const queue = { run: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()) };
    const handler = await makeHandler(params, queue);

    await handler(msg as any);

    expect(reply.edit).toHaveBeenCalledWith({
      content: FINALIZATION_LOSS_VISIBLE_TEXT,
      allowedMentions: { parse: [] },
    });
    expect(metrics.increment).toHaveBeenCalledWith('discord.message.finalization_loss');
    expect(watchdog.complete).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ outcome: 'failed', deliveryConfirmed: true }),
    );
  });

  it('does not confirm delivery or silently delete when staging and fallback edit both fail', async () => {
    const runtime = makeCaptureRuntime();
    const reply = {
      id: 'reply-1',
      edit: vi.fn(async (opts: { content: string }) => {
        if (opts.content === FINALIZATION_LOSS_VISIBLE_TEXT) {
          throw new Error('edit failed');
        }
      }),
      delete: vi.fn(async () => undefined),
      react: vi.fn(async () => ({ remove: vi.fn(async () => undefined) })),
    };
    const msg = makeGuildMessage(reply);
    const actionsMod = await import('./actions.js');
    vi.mocked(actionsMod.parseDiscordActions).mockReturnValueOnce({
      actions: [{ type: 'sendMessage' } as any],
      cleanText: '',
      strippedUnrecognizedTypes: [],
      parseFailures: 0,
    });
    vi.mocked(actionsMod.executeDiscordActions).mockResolvedValueOnce([
      { ok: true, summary: 'sent' } as any,
    ]);
    const watchdog = {
      start: vi.fn(async () => ({})),
      stageRecovery: vi.fn(async () => {
        throw new Error('stage failed');
      }),
      complete: vi.fn(async () => null),
      startupSweep: vi.fn(async () => ({
        interruptedRuns: 0,
        finalRetried: 0,
        finalPosted: 0,
        finalFailed: 0,
      })),
    };
    const metrics = {
      increment: vi.fn(),
      recordInvokeStart: vi.fn(),
      recordInvokeResult: vi.fn(),
      recordActionResult: vi.fn(),
    };
    const params = makeParams(runtime, { longRunWatchdog: watchdog, metrics });
    const queue = { run: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()) };
    const handler = await makeHandler(params, queue);

    await handler(msg as any);

    expect(reply.edit).toHaveBeenCalledWith({
      content: FINALIZATION_LOSS_VISIBLE_TEXT,
      allowedMentions: { parse: [] },
    });
    expect(reply.delete).not.toHaveBeenCalled();
    expect(metrics.increment).toHaveBeenCalledWith('discord.message.completed_without_visible_output');
    expect(metrics.increment).toHaveBeenCalledWith('discord.message.finalization_loss');
  });

  it('clears staged recovery on explicit stop without posting a second aborted placeholder or restart repost', async () => {
    const order: string[] = [];
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'discoclaw-watchdog-'));
    const dataFilePath = path.join(tmpDir, 'watchdog.json');
    const postFinal = vi.fn(async (_run?: unknown) => undefined);
    let handlerPromise: Promise<void> | null = null;
    let stopIssued = false;
    let handler: ((msg: any) => Promise<void>) | null = null;
    let stopMsg: ReturnType<typeof makeGuildMessage> | null = null;
    let explicitStopPersistedBeforeThrow = false;

    const runtime = {
      id: 'test',
      capabilities: new Set<string>(['streaming_text']),
      async *invoke(): AsyncIterable<EngineEvent> {
        yield { type: 'text_final', text: 'Recovered final summary.' };
        yield { type: 'done' };
      },
    };
    const stopReply = makeReply();
    const reply = {
      id: 'reply-1',
      edit: vi.fn(async (opts: { content: string }) => {
        order.push(`edit:${opts.content}`);
        if (opts.content === 'Recovered final summary.' && !stopIssued) {
          stopIssued = true;
          stopMsg = makeGuildMessage(stopReply, {
            id: 'm-stop',
            content: '!stop',
            channelId: 'ch-1',
            guildId: 'guild-1',
            guild: { id: 'guild-1' },
          });
          await handler?.(stopMsg as any);
          const [run] = await watchdog.listRuns();
          explicitStopPersistedBeforeThrow = run?.explicitStop === true;
          throw new Error('edit interrupted after explicit stop');
        }
      }),
      delete: vi.fn(async () => {
        order.push('delete');
      }),
      react: vi.fn(async () => ({ remove: vi.fn(async () => undefined) })),
    };
    const msg = makeGuildMessage(reply);
    const watchdog = new LongRunWatchdog({
      dataFilePath,
      postStillRunning: vi.fn(async () => undefined),
      postFinal: vi.fn(async (run) => {
        order.push(`postFinal:${run.recoveryText ?? ''}`);
        await postFinal(run);
      }),
    });
    const params = makeParams(runtime, { longRunWatchdog: watchdog });
    const queue = { run: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()) };

    try {
      handler = await makeHandler(params, queue);
      handlerPromise = handler(msg as any);
      await handlerPromise;
      await watchdog._waitForIdleForTest();

      expect(reply.edit.mock.calls.some((call) => call[0]?.content === '*(Response aborted.)*')).toBe(false);
      expect(reply.delete).toHaveBeenCalledTimes(1);
      expect(stopMsg).not.toBeNull();
      expect(vi.mocked(stopMsg!.reply).mock.calls[0]?.[0]?.content).toContain('Aborted 1 active stream.');
      expect(explicitStopPersistedBeforeThrow).toBe(true);

      const [run] = await watchdog.listRuns();
      expect(run).toBeDefined();
      expect(run?.explicitStop).toBe(true);
      expect(run?.recoveryText).toBeNull();

      await watchdog.startupSweep();
      await watchdog._waitForIdleForTest();

      expect(postFinal).not.toHaveBeenCalled();
      expect(order).not.toContain('postFinal:Recovered final summary.');
    } finally {
      watchdog.dispose();
      await fs.rm(tmpDir, { recursive: true, force: true });
      await handlerPromise;
    }
  });

  it('suppresses the aborted placeholder for reaction-stop abort causes', async () => {
    let registeredReplyId = '';
    const runtime = {
      id: 'test',
      capabilities: new Set<string>(['streaming_text']),
      async *invoke(): AsyncIterable<EngineEvent> {
        yield { type: 'text_delta', text: 'Working...' };
        if (registeredReplyId) {
          const { tryAbort } = await import('./abort-registry.js');
          tryAbort(registeredReplyId, { cause: 'reaction-stop' });
        }
        yield { type: 'error', message: 'interrupted by reaction stop' };
      },
    };
    const reply = {
      id: 'reply-1',
      edit: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      react: vi.fn(async () => ({ remove: vi.fn(async () => undefined) })),
    };
    registeredReplyId = reply.id;
    const msg = makeGuildMessage(reply);
    const params = makeParams(runtime);
    const queue = { run: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()) };
    const handler = await makeHandler(params, queue);

    await handler(msg as any);

    expect(reply.edit.mock.calls.some((call: any[]) => call[0]?.content === '*(Response aborted.)*')).toBe(false);
  });

  it('keeps a staged successful completion recoverable when shutdown begins before final Discord delivery', async () => {
    const runtime = {
      id: 'test',
      capabilities: new Set<string>(['streaming_text']),
      async *invoke(): AsyncIterable<EngineEvent> {
        yield { type: 'text_final', text: 'Recovered final summary.' };
        await drainInFlightReplies();
        yield { type: 'done' };
      },
    };
    const reply = {
      id: 'reply-1',
      edit: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      react: vi.fn(async () => ({ remove: vi.fn(async () => undefined) })),
    };
    const msg = makeGuildMessage(reply);
    const watchdog = {
      start: vi.fn(async () => ({})),
      stageRecovery: vi.fn(async () => ({})),
      complete: vi.fn(async () => null),
      startupSweep: vi.fn(async () => ({
        interruptedRuns: 0,
        finalRetried: 0,
        finalPosted: 0,
        finalFailed: 0,
      })),
    };
    const params = makeParams(runtime, { longRunWatchdog: watchdog });
    const queue = { run: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()) };
    const handler = await makeHandler(params, queue);

    await handler(msg as any);

    expect(watchdog.stageRecovery).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ text: 'Recovered final summary.' }),
    );
    expect(watchdog.complete).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ outcome: 'succeeded', deliveryConfirmed: false }),
    );
  });
});
