import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  FORGE_ACTION_TYPES,
  evaluateForgeTurnGate,
  executeForgeAction,
  forgeActionsPromptSection,
  normalizeForgeCandidatePath,
  resolveForgeTurnRoute,
} from './actions-forge.js';
import type { ForgeContext } from './actions-forge.js';
import type { ActionContext } from './actions.js';
import { _resetForTest, setActiveOrchestrator, addRunningPlan, setForgePlanMetadata } from './forge-plan-registry.js';
import { TaskStore } from '../tasks/store.js';

const { readFileMock } = vi.hoisted(() => ({
  readFileMock: vi.fn(async () => '# Plan: Test Plan\n\n## Changes\n\n- `src/discord/actions-forge.ts` — tighten forge gating.\n'),
}));

vi.mock('node:fs/promises', () => ({
  readFile: readFileMock,
}));

vi.mock('./actions-plan.js', () => ({
  executePlanAction: vi.fn(async (action: { type: string; planId: string }) => ({
    ok: true,
    summary: `Plan run started for **${action.planId}**`,
  })),
}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('./plan-commands.js', () => ({
  looksLikePlanId: vi.fn((id: string) => /^\d+$/.test(id) || /^plan-\d+$/.test(id)),
  findPlanFile: vi.fn(async (_dir: string, id: string) => {
    if (id === 'plan-notfound') return null;
    return {
      filePath: `/tmp/plans/${id}-test.md`,
      header: { planId: id, taskId: 'ws-001', status: 'REVIEW', title: 'Test Plan', project: 'discoclaw', created: '2026-01-01' },
    };
  }),
  listPlanFiles: vi.fn(async () => []),
}));

vi.mock('./forge-commands.js', () => ({
  buildPlanSummary: vi.fn(() => '**plan-042** — Test Plan\nStatus: REVIEW'),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides?: Partial<ActionContext>): ActionContext {
  return {
    guild: {} as any,
    client: {} as any,
    channelId: 'test-channel',
    messageId: 'test-message',
    ...overrides,
  };
}

function makeMockOrchestrator(overrides?: { isRunning?: boolean; activePlanId?: string }) {
  return {
    isRunning: overrides?.isRunning ?? false,
    activePlanId: overrides?.activePlanId,
    requestCancel: vi.fn(),
    run: vi.fn(async () => ({
      planId: 'plan-042',
      filePath: '/tmp/plans/plan-042-test.md',
      finalVerdict: 'minor',
      rounds: 2,
      reachedMaxRounds: false,
    })),
    resume: vi.fn(async () => ({
      planId: 'plan-042',
      filePath: '/tmp/plans/plan-042-test.md',
      finalVerdict: 'minor',
      rounds: 1,
      reachedMaxRounds: false,
    })),
  };
}

function makeForgeCtx(overrides?: Partial<ForgeContext>): ForgeContext {
  const mockOrch = makeMockOrchestrator();
  return {
    orchestratorFactory: vi.fn(() => mockOrch) as any,
    plansDir: '/tmp/plans',
    workspaceCwd: '/tmp/workspace',
    taskStore: new TaskStore(),
    onProgress: vi.fn(async () => {}),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetForTest();
  vi.clearAllMocks();
  readFileMock.mockResolvedValue('# Plan: Test Plan\n\n## Changes\n\n- `src/discord/actions-forge.ts` — tighten forge gating.\n');
});

describe('FORGE_ACTION_TYPES', () => {
  it('contains all forge action types', () => {
    expect(FORGE_ACTION_TYPES.has('forgeCreate')).toBe(true);
    expect(FORGE_ACTION_TYPES.has('forgeResume')).toBe(true);
    expect(FORGE_ACTION_TYPES.has('forgeStatus')).toBe(true);
    expect(FORGE_ACTION_TYPES.has('forgeCancel')).toBe(true);
  });

  it('does not contain non-forge types', () => {
    expect(FORGE_ACTION_TYPES.has('beadCreate')).toBe(false);
    expect(FORGE_ACTION_TYPES.has('cronCreate')).toBe(false);
  });
});

describe('forge turn gate', () => {
  it('rejects final strict-output turns before research completes', () => {
    const decision = evaluateForgeTurnGate({
      phase: 'draft_artifact',
      researchComplete: false,
      allowlistPaths: ['src/discord/actions-forge.ts'],
      candidatePaths: ['src/discord/actions-forge.ts'],
    });

    expect(decision.status).toBe('reject');
    expect(decision.nextPhase).toBe('draft_artifact');
    expect(decision.route).toBe('cli');
    expect(decision.reason).toContain('Research must be marked complete');
  });

  it('normalizes candidate paths before enforcing the allowlist', () => {
    expect(normalizeForgeCandidatePath('`./src\\\\discord/./actions-forge.ts`')).toBe('src/discord/actions-forge.ts');

    const decision = evaluateForgeTurnGate({
      phase: 'revision_artifact',
      researchComplete: true,
      allowlistPaths: [
        'src/discord/actions-forge.ts',
        'src/discord/actions-forge.test.ts',
      ],
      candidatePaths: [
        '`./src\\\\discord/./actions-forge.ts`',
        'src/discord//actions-forge.test.ts',
      ],
    });

    expect(decision.status).toBe('allow');
    expect(decision.route).toBe('cli');
    expect(decision.normalizedCandidatePaths).toEqual([
      'src/discord/actions-forge.ts',
      'src/discord/actions-forge.test.ts',
    ]);
    expect(decision.outOfBoundsPaths).toEqual([]);
  });

  it('rejects out-of-bounds candidate paths when forge does not explicitly re-enter research', () => {
    const decision = evaluateForgeTurnGate({
      phase: 'revision_artifact',
      researchComplete: true,
      allowlistPaths: ['src/discord/actions-forge.ts'],
      candidatePaths: ['src/discord/actions-forge.ts', 'src/discord/forge-commands.ts'],
    });

    expect(decision.status).toBe('reject');
    expect(decision.nextPhase).toBe('revision_artifact');
    expect(decision.outOfBoundsPaths).toEqual(['src/discord/forge-commands.ts']);
    expect(decision.reason).toContain('outside the bounded forge allowlist');
  });

  it('fails closed on invalid candidate paths instead of dropping them during normalization', () => {
    const decision = evaluateForgeTurnGate({
      phase: 'revision_artifact',
      researchComplete: true,
      allowlistPaths: ['src/discord/actions-forge.ts'],
      candidatePaths: ['../secrets.txt'],
    });

    expect(decision.status).toBe('reject');
    expect(decision.outOfBoundsPaths).toEqual(['../secrets.txt']);
  });

  it('redirects out-of-bounds audit access into explicit re-research when allowed', () => {
    const decision = evaluateForgeTurnGate({
      phase: 'audit',
      researchComplete: true,
      allowlistPaths: ['src/discord/actions-forge.ts'],
      candidatePaths: ['src/discord/forge-commands.ts'],
      allowResearchReset: true,
    });

    expect(decision.status).toBe('re_research');
    expect(decision.nextPhase).toBe('revision_research');
    expect(decision.route).toBe('native');
    expect(decision.reason).toContain('Re-enter revision_research');
  });

  it('rejects audit when research is incomplete or the allowlist is empty', () => {
    const incompleteDecision = evaluateForgeTurnGate({
      phase: 'audit',
      researchComplete: false,
      allowlistPaths: ['src/discord/actions-forge.ts'],
      candidatePaths: ['src/discord/actions-forge.ts'],
    });
    expect(incompleteDecision.status).toBe('reject');
    expect(incompleteDecision.reason).toContain('Research must be marked complete');

    const ungroundedDecision = evaluateForgeTurnGate({
      phase: 'audit',
      researchComplete: true,
      allowlistPaths: [],
      candidatePaths: [],
    });
    expect(ungroundedDecision.status).toBe('reject');
    expect(ungroundedDecision.reason).toContain('missing a grounded candidate allowlist');
  });

  it('routes forge turns by bounded phase instead of salvage side effects', () => {
    expect(resolveForgeTurnRoute('draft_research')).toBe('native');
    expect(resolveForgeTurnRoute('audit')).toBe('hybrid');
    expect(resolveForgeTurnRoute('revision_artifact')).toBe('cli');
  });
});

describe('executeForgeAction', () => {
  describe('forgeCreate', () => {
    it('starts a forge run and returns summary', async () => {
      const forgeCtx = makeForgeCtx();
      const result = await executeForgeAction(
        { type: 'forgeCreate', description: 'Add retry logic' },
        makeCtx(),
        forgeCtx,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.summary).toContain('Forge started');
        expect(result.summary).toContain('Add retry logic');
      }
      expect(forgeCtx.orchestratorFactory).toHaveBeenCalled();
    });

    it('reuses linked task when invoked from a task thread', async () => {
      const taskStore = new TaskStore();
      const task = taskStore.create({
        title: 'Token budget awareness',
        description: 'Instrument per-section token counts',
      });
      taskStore.update(task.id, { externalRef: 'discord:thread-1122' });

      const forgeCtx = makeForgeCtx({ taskStore });
      const result = await executeForgeAction(
        { type: 'forgeCreate', description: 'this' },
        {
          ...makeCtx(),
          channelId: 'thread-1122',
          threadParentId: 'forum-1',
        },
        forgeCtx,
      );

      expect(result.ok).toBe(true);
      expect(forgeCtx.orchestratorFactory).toHaveBeenCalledWith(
        expect.objectContaining({
          existingTaskId: task.id,
          taskDescription: task.description,
        }),
      );
    });

    it('does not forward runtime events when toolAwareStreaming is disabled', async () => {
      const edit = vi.fn(async () => ({}));
      const send = vi.fn(async () => ({ edit }));
      const fetch = vi.fn(async () => ({ send }));

      const forgeCtx = makeForgeCtx({ toolAwareStreaming: false });
      const result = await executeForgeAction(
        { type: 'forgeCreate', description: 'Add retry logic' },
        makeCtx({ client: { channels: { fetch } } as any }),
        forgeCtx,
      );

      expect(result.ok).toBe(true);
      const orch = (forgeCtx.orchestratorFactory as any).mock.results[0]?.value;
      const runCall = orch?.run?.mock.calls[0];
      expect(typeof runCall?.[1]).toBe('function');
      expect(runCall?.[3]).toBeUndefined();
    });

    it('forwards runtime events when toolAwareStreaming is enabled', async () => {
      const edit = vi.fn(async () => ({}));
      const send = vi.fn(async () => ({ edit }));
      const fetch = vi.fn(async () => ({ send }));

      const forgeCtx = makeForgeCtx({ toolAwareStreaming: true });
      const result = await executeForgeAction(
        { type: 'forgeCreate', description: 'Add retry logic' },
        makeCtx({ client: { channels: { fetch } } as any }),
        forgeCtx,
      );

      expect(result.ok).toBe(true);
      const orch = (forgeCtx.orchestratorFactory as any).mock.results[0]?.value;
      const runCall = orch?.run?.mock.calls[0];
      expect(typeof runCall?.[1]).toBe('function');
      expect(typeof runCall?.[3]).toBe('function');
    });

    it('posts an emoji-prefixed starting progress message', async () => {
      const edit = vi.fn(async () => ({}));
      const send = vi.fn(async () => ({ edit }));
      const fetch = vi.fn(async () => ({ send }));

      const forgeCtx = makeForgeCtx();
      const result = await executeForgeAction(
        { type: 'forgeCreate', description: 'Add retry logic' },
        makeCtx({ client: { channels: { fetch } } as any }),
        forgeCtx,
      );

      expect(result.ok).toBe(true);
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        content: '🛠️ Starting forge: Add retry logic',
      }));
    });

    it('does not silently swallow archived-thread (50083) progress failures', async () => {
      const err50083 = Object.assign(new Error('Thread is archived'), { code: 50083 });
      const edit = vi.fn(async () => {
        throw err50083;
      });
      const send = vi.fn(async () => ({ edit }));
      const fetch = vi.fn(async () => ({ send }));

      const orch = makeMockOrchestrator();
      orch.run = vi.fn(async (_description: string, onProgress: (msg: string, opts?: { force?: boolean }) => Promise<void>) => {
        await onProgress('phase update', { force: true });
        return {
          planId: 'plan-042',
          filePath: '/tmp/plans/plan-042-test.md',
          finalVerdict: 'minor',
          rounds: 1,
          reachedMaxRounds: false,
        };
      });
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const forgeCtx = makeForgeCtx({
        orchestratorFactory: vi.fn(() => orch) as any,
        log,
      });
      const result = await executeForgeAction(
        { type: 'forgeCreate', description: 'Add retry logic' },
        makeCtx({ client: { channels: { fetch } } as any }),
        forgeCtx,
      );

      expect(result.ok).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.anything() }),
        'forge:action:create failed',
      );
    });

    it('fails without description', async () => {
      const result = await executeForgeAction(
        { type: 'forgeCreate', description: '' },
        makeCtx(),
        makeForgeCtx(),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('requires a description');
    });

    it('blocks at recursion depth >= 1', async () => {
      const result = await executeForgeAction(
        { type: 'forgeCreate', description: 'New thing' },
        makeCtx(),
        makeForgeCtx({ depth: 1 }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('recursion depth');
    });

    it('rejects when a forge is already running', async () => {
      const runningOrch = makeMockOrchestrator({ isRunning: true, activePlanId: 'plan-001' });
      setActiveOrchestrator(runningOrch as any);

      const result = await executeForgeAction(
        { type: 'forgeCreate', description: 'New thing' },
        makeCtx(),
        makeForgeCtx(),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('already running');
        expect(result.error).toContain('plan-001');
      }
    });
  });

  describe('forgeResume', () => {
    it('resumes forge on existing plan', async () => {
      setForgePlanMetadata('plan-042', {
        phaseState: {
          currentPhase: 'audit',
          researchComplete: true,
        },
        candidateBounds: {
          candidatePaths: ['src/discord/actions-forge.ts'],
          allowlistPaths: ['src/discord/actions-forge.ts'],
        },
        fallbackPolicy: {
          onOutOfBounds: 're_research',
          reResearchPhase: 'revision_research',
        },
      });
      const forgeCtx = makeForgeCtx();
      const result = await executeForgeAction(
        { type: 'forgeResume', planId: 'plan-042' },
        makeCtx(),
        forgeCtx,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.summary).toContain('Forge resumed');
        expect(result.summary).toContain('plan-042');
      }
    });

    it('posts a status-aware forge review progress message for review plans', async () => {
      setForgePlanMetadata('plan-042', {
        phaseState: {
          currentPhase: 'audit',
          researchComplete: true,
        },
        candidateBounds: {
          candidatePaths: ['src/discord/actions-forge.ts'],
          allowlistPaths: ['src/discord/actions-forge.ts'],
        },
        fallbackPolicy: {
          onOutOfBounds: 're_research',
          reResearchPhase: 'revision_research',
        },
      });
      const edit = vi.fn(async () => ({}));
      const send = vi.fn(async () => ({ edit }));
      const fetch = vi.fn(async () => ({ send }));

      const forgeCtx = makeForgeCtx();
      const result = await executeForgeAction(
        { type: 'forgeResume', planId: 'plan-042' },
        makeCtx({ client: { channels: { fetch } } as any }),
        forgeCtx,
      );

      expect(result.ok).toBe(true);
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        content: 'Resuming forge review for **plan-042** from REVIEW status...',
      }));
    });

    it('posts a status-aware forge review progress message for draft plans', async () => {
      const { findPlanFile } = await import('./plan-commands.js');
      (findPlanFile as any).mockResolvedValueOnce({
        filePath: '/tmp/plans/plan-123-test.md',
        header: {
          planId: 'plan-123',
          taskId: 'ws-123',
          status: 'DRAFT',
          title: 'Draft Plan',
          project: 'discoclaw',
          created: '2026-01-01',
        },
      });

      const edit = vi.fn(async () => ({}));
      const send = vi.fn(async () => ({ edit }));
      const fetch = vi.fn(async () => ({ send }));
      setForgePlanMetadata('plan-123', {
        phaseState: {
          currentPhase: 'audit',
          researchComplete: true,
        },
        candidateBounds: {
          candidatePaths: ['src/discord/actions-forge.ts'],
          allowlistPaths: ['src/discord/actions-forge.ts'],
        },
        fallbackPolicy: {
          onOutOfBounds: 're_research',
          reResearchPhase: 'revision_research',
        },
      });

      const forgeCtx = makeForgeCtx();
      const result = await executeForgeAction(
        { type: 'forgeResume', planId: 'plan-123' },
        makeCtx({ client: { channels: { fetch } } as any }),
        forgeCtx,
      );

      expect(result.ok).toBe(true);
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        content: 'Resuming forge review for **plan-123** from DRAFT status...',
      }));
    });

    it('uses stored bounded metadata for root-level resume allowlists without reading the plan body', async () => {
      readFileMock.mockResolvedValueOnce([
        '# Plan: Test Plan',
        '',
        '## Changes',
        '',
        '- `src/discord/forge-commands.ts` — unrelated nested path mention.',
        '',
        '## Audit Log',
        '',
        '- Mentioned `docs/out-of-bounds.md` in prose.',
      ].join('\n'));
      setForgePlanMetadata('plan-042', {
        phaseState: {
          currentPhase: 'audit',
          researchComplete: true,
        },
        candidateBounds: {
          candidatePaths: ['package.json', 'README.md'],
          allowlistPaths: ['package.json', 'README.md'],
        },
        fallbackPolicy: {
          onOutOfBounds: 're_research',
          reResearchPhase: 'revision_research',
        },
      });

      const forgeCtx = makeForgeCtx();
      const result = await executeForgeAction(
        { type: 'forgeResume', planId: 'plan-042' },
        makeCtx(),
        forgeCtx,
      );

      expect(result.ok).toBe(true);
      expect(readFileMock).not.toHaveBeenCalled();
      expect(forgeCtx.orchestratorFactory).toHaveBeenCalled();
    });

    it('blocks resume when bounded metadata is missing instead of inferring scope from the plan content', async () => {
      readFileMock.mockResolvedValueOnce('# Plan: Test Plan\n\n## Changes\n\n- `package.json` — root file.\n- `README.md` — docs.\n');

      const forgeCtx = makeForgeCtx();
      const result = await executeForgeAction(
        { type: 'forgeResume', planId: 'plan-042' },
        makeCtx(),
        forgeCtx,
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected resume to be blocked');
      expect(result.error).toContain('Re-enter revision_research');
      expect(readFileMock).not.toHaveBeenCalled();
      expect(forgeCtx.orchestratorFactory).not.toHaveBeenCalled();
    });

    it('routes approved plans into planRun instead of re-auditing', async () => {
      const { findPlanFile } = await import('./plan-commands.js');
      const { executePlanAction } = await import('./actions-plan.js');
      (findPlanFile as any).mockResolvedValueOnce({
        filePath: '/tmp/plans/plan-777-test.md',
        header: {
          planId: 'plan-777',
          taskId: 'ws-777',
          status: 'APPROVED',
          title: 'Approved Plan',
          project: 'discoclaw',
          created: '2026-01-01',
        },
      });

      const forgeCtx = makeForgeCtx({
        planCtx: {
          plansDir: '/tmp/plans',
          workspaceCwd: '/tmp/workspace',
          taskStore: new TaskStore(),
          runtime: { id: 'claude_code', capabilities: new Set() } as any,
          model: 'capable',
        } as any,
      });

      const result = await executeForgeAction(
        { type: 'forgeResume', planId: 'plan-777' },
        makeCtx(),
        forgeCtx,
      );

      expect(result.ok).toBe(true);
      expect(executePlanAction).toHaveBeenCalledWith(
        { type: 'planRun', planId: 'plan-777' },
        expect.any(Object),
        forgeCtx.planCtx,
      );
      expect(forgeCtx.orchestratorFactory).not.toHaveBeenCalled();
    });

    it('routes implementing plans into planRun instead of re-auditing', async () => {
      const { findPlanFile } = await import('./plan-commands.js');
      const { executePlanAction } = await import('./actions-plan.js');
      (findPlanFile as any).mockResolvedValueOnce({
        filePath: '/tmp/plans/plan-888-test.md',
        header: {
          planId: 'plan-888',
          taskId: 'ws-888',
          status: 'IMPLEMENTING',
          title: 'Implementing Plan',
          project: 'discoclaw',
          created: '2026-01-01',
        },
      });

      const forgeCtx = makeForgeCtx({
        planCtx: {
          plansDir: '/tmp/plans',
          workspaceCwd: '/tmp/workspace',
          taskStore: new TaskStore(),
          runtime: { id: 'claude_code', capabilities: new Set() } as any,
          model: 'capable',
        } as any,
      });

      const result = await executeForgeAction(
        { type: 'forgeResume', planId: 'plan-888' },
        makeCtx(),
        forgeCtx,
      );

      expect(result.ok).toBe(true);
      expect(executePlanAction).toHaveBeenCalledWith(
        { type: 'planRun', planId: 'plan-888' },
        expect.any(Object),
        forgeCtx.planCtx,
      );
      expect(forgeCtx.orchestratorFactory).not.toHaveBeenCalled();
    });

    it('blocks at recursion depth >= 1', async () => {
      const result = await executeForgeAction(
        { type: 'forgeResume', planId: 'plan-042' },
        makeCtx(),
        makeForgeCtx({ depth: 1 }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('recursion depth');
    });

    it('fails without planId', async () => {
      const result = await executeForgeAction(
        { type: 'forgeResume', planId: '' },
        makeCtx(),
        makeForgeCtx(),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('requires a planId');
    });

    it('fails when plan not found', async () => {
      const result = await executeForgeAction(
        { type: 'forgeResume', planId: 'plan-notfound' },
        makeCtx(),
        makeForgeCtx(),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('Plan not found');
    });

    it('rejects when a forge is already running', async () => {
      const runningOrch = makeMockOrchestrator({ isRunning: true });
      setActiveOrchestrator(runningOrch as any);

      const result = await executeForgeAction(
        { type: 'forgeResume', planId: 'plan-042' },
        makeCtx(),
        makeForgeCtx(),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('already running');
    });
  });

  describe('forgeStatus', () => {
    it('reports when no forge is running', async () => {
      const result = await executeForgeAction(
        { type: 'forgeStatus' },
        makeCtx(),
        makeForgeCtx(),
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.summary).toContain('No forge');
    });

    it('reports active forge with plan ID', async () => {
      const runningOrch = makeMockOrchestrator({ isRunning: true, activePlanId: 'plan-007' });
      setActiveOrchestrator(runningOrch as any);

      const result = await executeForgeAction(
        { type: 'forgeStatus' },
        makeCtx(),
        makeForgeCtx(),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.summary).toContain('running');
        expect(result.summary).toContain('plan-007');
      }
    });

    it('reports plan runs when no forge is running', async () => {
      addRunningPlan('plan-042', 'ch-1');
      addRunningPlan('plan-305', 'ch-2');

      const result = await executeForgeAction(
        { type: 'forgeStatus' },
        makeCtx(),
        makeForgeCtx(),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.summary).toContain('No forge');
        expect(result.summary).toContain('plan-042');
        expect(result.summary).toContain('plan-305');
      }
    });

    it('reports both forge and plan runs when both are active', async () => {
      const runningOrch = makeMockOrchestrator({ isRunning: true, activePlanId: 'plan-007' });
      setActiveOrchestrator(runningOrch as any);
      addRunningPlan('plan-099', 'ch-1');

      const result = await executeForgeAction(
        { type: 'forgeStatus' },
        makeCtx(),
        makeForgeCtx(),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.summary).toContain('running');
        expect(result.summary).toContain('plan-007');
        expect(result.summary).toContain('plan-099');
      }
    });

    it('reports all IDs when multiple plan runs are active', async () => {
      addRunningPlan('plan-010', 'ch-1');
      addRunningPlan('plan-020', 'ch-2');
      addRunningPlan('plan-030', 'ch-3');

      const result = await executeForgeAction(
        { type: 'forgeStatus' },
        makeCtx(),
        makeForgeCtx(),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.summary).toContain('plan-010');
        expect(result.summary).toContain('plan-020');
        expect(result.summary).toContain('plan-030');
      }
    });
  });

  describe('forgeCancel', () => {
    it('cancels a running forge', async () => {
      const runningOrch = makeMockOrchestrator({ isRunning: true, activePlanId: 'plan-010' });
      setActiveOrchestrator(runningOrch as any);

      const result = await executeForgeAction(
        { type: 'forgeCancel' },
        makeCtx(),
        makeForgeCtx(),
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.summary).toContain('Cancel requested');
      expect(runningOrch.requestCancel).toHaveBeenCalled();
    });

    it('fails when no forge is running', async () => {
      const result = await executeForgeAction(
        { type: 'forgeCancel' },
        makeCtx(),
        makeForgeCtx(),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('No forge');
    });
  });
});

describe('forgeActionsPromptSection', () => {
  it('returns non-empty prompt section', () => {
    const section = forgeActionsPromptSection();
    expect(section).toContain('forgeCreate');
    expect(section).toContain('forgeResume');
    expect(section).toContain('forgeStatus');
    expect(section).toContain('forgeCancel');
  });

  it('includes forge guidelines', () => {
    const section = forgeActionsPromptSection();
    expect(section).toContain('one forge');
    expect(section).toContain('asynchronous');
  });

  it('describes forgeResume as status-dependent', () => {
    const section = forgeActionsPromptSection();
    expect(section).toContain('Continue an existing plan based on its current status');
    expect(section).toContain('DRAFT / REVIEW');
    expect(section).toContain('APPROVED / IMPLEMENTING');
    expect(section).toContain('planRun');
    expect(section).toContain('pick up a plan again; the next step depends on the plan\'s status');
  });

  it('documents the bounded forge phase gate', () => {
    const section = forgeActionsPromptSection();
    expect(section).toContain('research/discovery completes before any final strict-output turn');
    expect(section).toContain('grounded allowlist');
  });
});
