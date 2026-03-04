import { describe, expect, it, vi, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

vi.mock('../workspace-bootstrap.js', () => ({
  isOnboardingComplete: vi.fn(async () => true),
}));

vi.mock('./plan-commands.js', () => ({
  parsePlanCommand: vi.fn((content: string) => {
    const trimmed = content.trim();
    if (!trimmed.startsWith('!plan')) return null;
    const rest = trimmed.slice('!plan'.length).trim();
    const [action = '', ...argParts] = rest.split(/\s+/).filter(Boolean);
    const args = argParts.join(' ');
    if (action === 'run' || action === 'run-one' || action === 'run-phase' || action === 'skip' || action === 'skip-to') {
      return { action, args };
    }
    return null;
  }),
  handlePlanCommand: vi.fn(async (cmd: { action: string; args: string }) => {
    if (cmd.action === 'skip-to') {
      const tokens = cmd.args.split(/\s+/).filter(Boolean);
      if (tokens.length !== 2) return 'Usage: `!plan skip-to <plan-id> <phase-id>`';
      return `Skip-to ready for **${tokens[1]}**.`;
    }
    return 'ok';
  }),
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
  readPhasesFile: vi.fn(() => ({ phases: [] })),
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

vi.mock('./actions-plan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./actions-plan.js')>();
  return {
    ...actual,
    executePlanAction: vi.fn(async (action: { type?: string }) => {
      if (action?.type === 'planRun') return { ok: true, summary: 'Auto plan run summary' };
      return { ok: true, summary: 'ok' };
    }),
  };
});

vi.mock('./forge-auto-implement.js', () => ({
  autoImplementForgePlan: vi.fn(async (
    opts: { planId: string },
    deps: { planApprove: (planId: string) => Promise<void>; planRun: (planId: string) => Promise<{ summary: string }> },
  ) => {
    await deps.planApprove(opts.planId);
    const run = await deps.planRun(opts.planId);
    return { status: 'auto', planId: opts.planId, summary: run.summary };
  }),
}));

vi.mock('./forge-commands.js', () => {
  class ForgeOrchestrator {
    isRunning = false;
    requestCancel = vi.fn();
    run = vi.fn(async () => ({
      planId: 'plan-123',
      filePath: '/tmp/plan-123.md',
      finalVerdict: 'none',
      rounds: 1,
      reachedMaxRounds: false,
      planSummary: 'Plan summary',
    }));
    resume = vi.fn(async (planId: string) => ({
      planId,
      filePath: `/tmp/${planId}.md`,
      finalVerdict: 'none',
      rounds: 1,
      reachedMaxRounds: false,
      planSummary: 'Plan summary',
    }));
  }

  return {
    parseForgeCommand: vi.fn((content: string) => {
      const trimmed = content.trim();
      if (!trimmed.startsWith('!forge')) return null;
      const rest = trimmed.slice('!forge'.length).trim();
      if (!rest) return { action: 'help', args: '' };
      if (rest === 'status' || rest === 'cancel' || rest === 'help') return { action: rest, args: '' };
      return { action: 'create', args: rest };
    }),
    ForgeOrchestrator,
    buildPlanImplementationMessage: vi.fn((_skipReason?: string, planId?: string) => `manual ${planId ?? ''}`.trim()),
  };
});

function makeParams() {
  const metrics = { increment: vi.fn() };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    allowUserIds: new Set(['user-1']),
    allowBotIds: new Set<string>(),
    botMessageMemoryWriteEnabled: false,
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
  const phaseMsg = {
    edit: vi.fn(async () => ({})),
  };
  const progressReply = {
    edit: vi.fn(async () => ({})),
  };
  const channel = {
    id: 'channel-1',
    name: 'general',
    send: vi.fn(async () => phaseMsg),
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
    phaseMsg,
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
        content: '**Post implementation audit**...',
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
        .filter((content: string) => content.includes('**First phase**...'));
      expect(phaseStartPosts).toHaveLength(1);
    });
  });

  it('edits phase-start message to resolved state on phase_complete (done)', async () => {
    const { runNextPhase } = await import('./plan-manager.js');
    (runNextPhase as any).mockImplementationOnce(async (_phases: string, _plan: string, opts: any) => {
      await opts.onPlanEvent?.({
        type: 'phase_start',
        planId: 'plan-042',
        phase: { id: 'phase-1', title: 'First phase', kind: 'implement' },
      });
      await opts.onPlanEvent?.({
        type: 'phase_complete',
        planId: 'plan-042',
        phase: { id: 'phase-1', title: 'First phase', kind: 'implement' },
        status: 'done',
      });
      return { result: 'nothing_to_run' };
    });

    const queue = { run: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()) };
    const handler = await makeHandler(makeParams(), queue as any);
    const msg = makeMessage('!plan run plan-042');

    await handler(msg as any);
    await vi.waitFor(() => {
      expect(msg.channel.send).toHaveBeenCalledWith(expect.objectContaining({
        content: '**First phase**...',
      }));
      expect(msg.phaseMsg.edit).toHaveBeenCalledWith(expect.objectContaining({
        content: '[x] **First phase**',
      }));
    });
  });

  it('edits phase-start message with failure indicator on phase_complete (failed)', async () => {
    const { runNextPhase } = await import('./plan-manager.js');
    (runNextPhase as any).mockImplementationOnce(async (_phases: string, _plan: string, opts: any) => {
      await opts.onPlanEvent?.({
        type: 'phase_start',
        planId: 'plan-042',
        phase: { id: 'phase-1', title: 'First phase', kind: 'implement' },
      });
      await opts.onPlanEvent?.({
        type: 'phase_complete',
        planId: 'plan-042',
        phase: { id: 'phase-1', title: 'First phase', kind: 'implement' },
        status: 'failed',
      });
      return { result: 'nothing_to_run' };
    });

    const queue = { run: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()) };
    const handler = await makeHandler(makeParams(), queue as any);
    const msg = makeMessage('!plan run plan-042');

    await handler(msg as any);
    await vi.waitFor(() => {
      expect(msg.phaseMsg.edit).toHaveBeenCalledWith(expect.objectContaining({
        content: '[!] **First phase**',
      }));
    });
  });

  it('posts a final summary channel message after a full plan run', async () => {
    const { runNextPhase } = await import('./plan-manager.js');
    (runNextPhase as any)
      .mockImplementationOnce(async (_phases: string, _plan: string, opts: any) => {
        await opts.onPlanEvent?.({
          type: 'phase_start',
          planId: 'plan-042',
          phase: { id: 'phase-1', title: 'First phase', kind: 'implement' },
        });
        return {
          result: 'done',
          phase: { id: 'phase-1', title: 'First phase', kind: 'implement', status: 'done', dependsOn: [], contextFiles: [] },
          output: 'done',
          nextPhase: undefined,
        };
      })
      .mockImplementationOnce(async () => ({ result: 'nothing_to_run' }));

    const queue = { run: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()) };
    const handler = await makeHandler(makeParams(), queue as any);
    const msg = makeMessage('!plan run plan-042');

    await handler(msg as any);
    await vi.waitFor(() => {
      // The final channel.send should include a plan-run-complete summary
      const finalSend = msg.channel.send.mock.calls.find((call: any[]) => {
        const content = String(call[0]?.content ?? '');
        return content.includes('plan-042') && content.includes('phase');
      });
      expect(finalSend).toBeDefined();
    });
  });

  it('returns usage for !plan run-phase without a phase id', async () => {
    const { preparePlanRun } = await import('./plan-commands.js');
    const queue = { run: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()) };
    const handler = await makeHandler(makeParams(), queue as any);
    const msg = makeMessage('!plan run-phase plan-042');

    await handler(msg as any);

    expect(msg.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: 'Usage: `!plan run-phase <plan-id> <phase-id>`',
    }));
    expect(preparePlanRun).not.toHaveBeenCalled();
  });

  it('routes !plan run-phase target id into preparePlanRun and runNextPhase', async () => {
    const { preparePlanRun } = await import('./plan-commands.js');
    const { runNextPhase } = await import('./plan-manager.js');
    (runNextPhase as any).mockImplementationOnce(async () => ({ result: 'nothing_to_run' }));

    const queue = { run: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()) };
    const handler = await makeHandler(makeParams(), queue as any);
    const msg = makeMessage('!plan run-phase plan-042 phase-3');

    await handler(msg as any);
    await vi.waitFor(() => {
      expect(preparePlanRun).toHaveBeenCalledWith(
        'plan-042',
        expect.objectContaining({ workspaceCwd: '/tmp/workspace' }),
        'phase-3',
      );
      expect(runNextPhase).toHaveBeenCalledWith(
        '/tmp/plans/plan-042-phases.md',
        '/tmp/plans/plan-042-test.md',
        expect.any(Object),
        expect.any(Function),
        'phase-3',
      );
    });
  });

  it('returns usage for !plan skip-to without a phase id', async () => {
    const { acquireWriterLock } = await import('./forge-plan-registry.js');
    const queue = { run: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()) };
    const handler = await makeHandler(makeParams(), queue as any);
    const msg = makeMessage('!plan skip-to plan-042');

    await handler(msg as any);

    expect(msg.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: 'Usage: `!plan skip-to <plan-id> <phase-id>`',
    }));
    expect(acquireWriterLock).not.toHaveBeenCalled();
  });

  it('handles !plan skip-to via lock-wrapped plan command handler', async () => {
    const { acquireWriterLock } = await import('./forge-plan-registry.js');
    const { handlePlanCommand } = await import('./plan-commands.js');
    const queue = { run: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()) };
    const handler = await makeHandler(makeParams(), queue as any);
    const msg = makeMessage('!plan skip-to plan-042 phase-4');

    await handler(msg as any);

    expect(acquireWriterLock).toHaveBeenCalled();
    expect(handlePlanCommand).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'skip-to', args: 'plan-042 phase-4' }),
      expect.objectContaining({ workspaceCwd: '/tmp/workspace' }),
    );
    expect(msg.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: 'Skip-to ready for **phase-4**.',
    }));
  });

  it('includes convergence-guard/manual-intervention guidance in stop summaries', async () => {
    const { runNextPhase } = await import('./plan-manager.js');
    const retryDetail = 'Phase failed but has no modifiedFiles — cannot safely determine what to revert.';
    (runNextPhase as any).mockImplementationOnce(async () => ({
      result: 'retry_blocked',
      phase: { id: 'phase-1', title: 'First phase', kind: 'implement', status: 'failed', dependsOn: [], contextFiles: [] },
      message: retryDetail,
    }));

    const queue = { run: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()) };
    const handler = await makeHandler(makeParams(), queue as any);
    const msg = makeMessage('!plan run plan-042');

    await handler(msg as any);
    await vi.waitFor(() => {
      const summaryEdits = msg.progressReply.edit.mock.calls
        .map((call: any[]) => String(call[0]?.content ?? ''));
      expect(summaryEdits.some((content: string) =>
        content.includes(retryDetail))).toBe(true);
      expect(summaryEdits.some((content: string) =>
        content.includes('Convergence guard/manual intervention')
        && content.includes('!plan run-phase plan-042 <phase-id>')
        && content.includes('!plan skip-to plan-042 <phase-id>'))).toBe(true);
    });
  });

  it('wires watchdog fields into forge auto-implement planRun context', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'discoclaw-forge-auto-'));
    const planFilePath = path.join(tmpDir, 'plan-123.md');
    await fs.writeFile(planFilePath, '# Plan', 'utf8');

    const { looksLikePlanId, findPlanFile } = await import('./plan-commands.js');
    (looksLikePlanId as any).mockImplementation((value: string) => value === 'plan-123');
    (findPlanFile as any).mockResolvedValue({
      filePath: planFilePath,
      header: { planId: 'plan-123', title: 'Plan 123' },
    });

    const watchdog = {
      start: vi.fn(async () => ({ run: {}, deduped: false })),
      complete: vi.fn(async () => ({})),
      startupSweep: vi.fn(async () => ({
        interruptedRuns: 0,
        finalRetried: 0,
        finalPosted: 0,
        finalFailed: 0,
      })),
    };

    const params = {
      ...makeParams(),
      forgeCommandsEnabled: true,
      forgeAutoImplement: true,
      longRunWatchdog: watchdog,
      longRunStillRunningDelayMs: 43210,
    };
    const queue = { run: vi.fn(async (_key: string, fn: () => Promise<void>) => fn()) };
    const handler = await makeHandler(params, queue as any);
    const msg = makeMessage('!forge plan-123');

    await handler(msg as any);

    const { executePlanAction } = await import('./actions-plan.js');
    await vi.waitFor(() => {
      const planRunCalls = (executePlanAction as any).mock.calls.filter(
        (call: any[]) => call[0]?.type === 'planRun',
      );
      expect(planRunCalls).toHaveLength(1);
      const planCtx = planRunCalls[0][2];
      expect(planCtx.longRunWatchdog).toBe(watchdog);
      expect(planCtx.longRunStillRunningDelayMs).toBe(43210);
    });

    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
