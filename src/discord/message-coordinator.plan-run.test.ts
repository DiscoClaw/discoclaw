import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../workspace-bootstrap.js', () => ({
  isOnboardingComplete: vi.fn(async () => true),
}));

vi.mock('./plan-commands.js', () => ({
  parsePlanCommand: vi.fn((content: string) => {
    const trimmed = content.trim();
    if (!trimmed.startsWith('!plan run ')) return null;
    return { action: 'run', args: trimmed.slice('!plan run '.length) };
  }),
  handlePlanCommand: vi.fn(async () => 'ok'),
  preparePlanRun: vi.fn(async () => ({
    phasesFilePath: '/tmp/plans/plan-042-phases.md',
    planFilePath: '/tmp/plans/plan-042-test.md',
    planContent: '# Plan',
    nextPhase: { id: 'phase-1', title: 'First phase', kind: 'implement', status: 'pending', deps: [], contextFiles: [] },
  })),
  handlePlanSkip: vi.fn(async () => 'ok'),
  closePlanIfComplete: vi.fn(async () => ({ closed: false, reason: 'not_all_complete' })),
  NO_PHASES_SENTINEL: 'NO_PHASES',
  findPlanFile: vi.fn(async () => null),
  looksLikePlanId: vi.fn(() => false),
}));

vi.mock('./plan-manager.js', () => ({
  runNextPhase: vi.fn(async () => ({ result: 'nothing_to_run' })),
  resolveProjectCwd: vi.fn((_content: string, workspaceCwd: string) => workspaceCwd),
  deserializePhases: vi.fn(() => ({ phases: [] })),
  buildPostRunSummary: vi.fn(() => ''),
}));

vi.mock('./forge-plan-registry.js', () => ({
  acquireWriterLock: vi.fn(async () => vi.fn()),
  setActiveOrchestrator: vi.fn(),
  getActiveOrchestrator: vi.fn(() => null),
  addRunningPlan: vi.fn(),
  removeRunningPlan: vi.fn(),
  isPlanRunning: vi.fn(() => false),
}));

function makeParams() {
  const metrics = { increment: vi.fn() };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    allowUserIds: new Set(['user-1']),
    botDisplayName: 'Discoclaw',
    requireChannelContext: false,
    autoIndexChannelContext: false,
    autoJoinThreads: false,
    useRuntimeSessions: false,
    runtime: { id: 'claude', capabilities: {} },
    sessionManager: {} as any,
    workspaceCwd: '/tmp/workspace',
    projectCwd: '/tmp/workspace',
    groupsDir: '/tmp/workspace',
    useGroupDirCwd: false,
    runtimeModel: 'capable',
    runtimeTools: [],
    runtimeTimeoutMs: 30_000,
    discordActionsEnabled: false,
    discordActionsChannels: false,
    discordActionsMessaging: false,
    discordActionsGuild: false,
    discordActionsModeration: false,
    discordActionsPolls: false,
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
    planCommandsEnabled: true,
    planPhasesEnabled: true,
    planPhaseMaxContextFiles: 5,
    forgeCommandsEnabled: false,
    summaryToDurableEnabled: false,
    shortTermMemoryEnabled: false,
    shortTermDataDir: '/tmp/workspace',
    shortTermMaxEntries: 0,
    shortTermMaxAgeMs: 0,
    shortTermInjectMaxChars: 0,
    streamStallWarningMs: 10_000,
    actionFollowupDepth: 1,
    reactionHandlerEnabled: false,
    reactionRemoveHandlerEnabled: false,
    reactionMaxAgeMs: 0,
    healthCommandsEnabled: false,
    metrics,
    log,
  } as any;
}

function makeMessage(content: string) {
  const progressReply = {
    edit: vi.fn(async () => ({})),
  };
  const channel = {
    id: 'channel-1',
    name: 'general',
    send: vi.fn(async () => ({})),
    isThread: () => false,
  };
  return {
    id: 'm1',
    type: 0,
    content,
    author: { id: 'user-1', bot: false },
    guildId: 'g1',
    guild: { id: 'g1' },
    channelId: 'channel-1',
    channel,
    client: { channels: { cache: new Map() }, user: { id: 'bot-1' } },
    attachments: new Map(),
    stickers: new Map(),
    embeds: [],
    mentions: { has: () => false },
    reply: vi.fn(async () => progressReply),
    progressReply,
  };
}

async function makeHandler(params: any, queue: any) {
  const { createMessageCreateHandler } = await import('./message-coordinator.js');
  return createMessageCreateHandler(params, queue);
}

describe('message coordinator plan run phase-start posts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('posts phase-start updates for manual !plan run with non phase-* ids', async () => {
    const { runNextPhase } = await import('./plan-manager.js');
    (runNextPhase as any).mockImplementationOnce(async (_phases: string, _plan: string, opts: any) => {
      await opts.onPlanEvent?.({
        type: 'phase_start',
        planId: 'plan-042',
        phase: { id: 'audit-1', title: 'Post implementation audit', kind: 'audit' },
      });
      return { result: 'nothing_to_run' };
    });

    const queue = { run: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()) };
    const handler = await makeHandler(makeParams(), queue as any);
    const msg = makeMessage('!plan run plan-042');

    await handler(msg as any);
    await vi.waitFor(() => {
      expect(runNextPhase).toHaveBeenCalled();
      expect(msg.channel.send).toHaveBeenCalledWith(expect.objectContaining({
        content: 'Starting phase **audit-1**: Post implementation audit',
      }));
    });
  });

  it('deduplicates repeated phase-start progress lines in a single run', async () => {
    const { runNextPhase } = await import('./plan-manager.js');
    (runNextPhase as any).mockImplementationOnce(async (_phases: string, _plan: string, opts: any) => {
      const event = {
        type: 'phase_start',
        planId: 'plan-042',
        phase: { id: 'phase-1', title: 'First phase', kind: 'implement' },
      };
      await opts.onPlanEvent?.(event);
      await opts.onPlanEvent?.(event);
      return { result: 'nothing_to_run' };
    });

    const queue = { run: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()) };
    const handler = await makeHandler(makeParams(), queue as any);
    const msg = makeMessage('!plan run plan-042');

    await handler(msg as any);
    await vi.waitFor(() => {
      const phaseStartPosts = msg.channel.send.mock.calls
        .map((call: any[]) => String(call[0]?.content ?? ''))
        .filter((content: string) => content.includes('Starting phase **phase-1**: First phase'));
      expect(phaseStartPosts).toHaveLength(1);
    });
  });
});
