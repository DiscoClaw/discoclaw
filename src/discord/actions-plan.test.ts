import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PLAN_ACTION_TYPES, executePlanAction, planActionsPromptSection } from './actions-plan.js';
import type { PlanContext } from './actions-plan.js';
import type { ActionContext } from './actions.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('./plan-commands.js', () => ({
  findPlanFile: vi.fn(async (_dir: string, id: string) => {
    if (id === 'plan-notfound') return null;
    if (id === 'plan-implementing') {
      return {
        filePath: `/tmp/plans/${id}-test.md`,
        header: { planId: id, beadId: 'ws-010', status: 'IMPLEMENTING', title: 'Active Plan', project: 'discoclaw', created: '2026-01-01' },
      };
    }
    return {
      filePath: `/tmp/plans/${id}-test.md`,
      header: { planId: id, beadId: 'ws-001', status: 'REVIEW', title: 'Test Plan', project: 'discoclaw', created: '2026-01-01' },
    };
  }),
  listPlanFiles: vi.fn(async () => [
    {
      filePath: '/tmp/plans/plan-001-test.md',
      header: { planId: 'plan-001', beadId: 'ws-001', status: 'DRAFT', title: 'First Plan', project: 'discoclaw', created: '2026-01-01' },
    },
    {
      filePath: '/tmp/plans/plan-002-test.md',
      header: { planId: 'plan-002', beadId: 'ws-002', status: 'APPROVED', title: 'Second Plan', project: 'discoclaw', created: '2026-01-02' },
    },
  ]),
  updatePlanFileStatus: vi.fn(async () => {}),
  handlePlanCommand: vi.fn(async (_cmd: any, _opts: any) => {
    return 'Plan created: **plan-003** (bead: `ws-003`)\nFile: `workspace/plans/plan-003-test.md`\nDescription: New feature';
  }),
  preparePlanRun: vi.fn(async (_id: string, _opts: any) => ({
    phasesFilePath: '/tmp/plans/plan-042-phases.md',
    planFilePath: '/tmp/plans/plan-042-test.md',
    planContent: '---\nproject: discoclaw\n---\n# Plan',
    nextPhase: { id: 'phase-1', title: 'First phase', kind: 'implement', status: 'pending', deps: [], contextFiles: [] },
  })),
  NO_PHASES_SENTINEL: 'NO_PHASES',
  closePlanIfComplete: vi.fn(async () => ({ closed: false, reason: 'not_all_complete' })),
}));

vi.mock('./plan-manager.js', () => ({
  runNextPhase: vi.fn(async () => ({ result: 'nothing_to_run' })),
  resolveProjectCwd: vi.fn((_content: string, workspaceCwd: string) => workspaceCwd),
}));

vi.mock('./forge-plan-registry.js', () => ({
  acquireWriterLock: vi.fn(async () => vi.fn()),
  addRunningPlan: vi.fn(),
  removeRunningPlan: vi.fn(),
  isPlanRunning: vi.fn(() => false),
}));

vi.mock('../beads/bd-cli.js', () => ({
  bdUpdate: vi.fn(async () => {}),
  bdClose: vi.fn(async () => {}),
}));

vi.mock('./allowed-mentions.js', () => ({
  NO_MENTIONS: { parse: [] },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStatusMessage() {
  return { edit: vi.fn(async (_opts: { content: string; allowedMentions: unknown }) => {}) };
}

function makeSendFn(statusMsg?: ReturnType<typeof makeStatusMessage>) {
  const msg = statusMsg ?? makeStatusMessage();
  return { fn: vi.fn(async (_payload: { content: string; allowedMentions: unknown }) => msg), msg };
}

function makeCtx(sendSetup?: ReturnType<typeof makeSendFn>): ActionContext & { statusMsg: ReturnType<typeof makeStatusMessage> } {
  const setup = sendSetup ?? makeSendFn();
  return {
    guild: {} as any,
    client: {
      channels: {
        fetch: vi.fn(async () => ({ send: setup.fn })),
      },
    } as any,
    channelId: 'test-channel',
    messageId: 'test-message',
    statusMsg: setup.msg,
  };
}

function makePlanCtx(overrides?: Partial<PlanContext>): PlanContext {
  return {
    plansDir: '/tmp/plans',
    workspaceCwd: '/tmp/workspace',
    beadsCwd: '/tmp/beads',
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PLAN_ACTION_TYPES', () => {
  it('contains all plan action types', () => {
    expect(PLAN_ACTION_TYPES.has('planList')).toBe(true);
    expect(PLAN_ACTION_TYPES.has('planShow')).toBe(true);
    expect(PLAN_ACTION_TYPES.has('planApprove')).toBe(true);
    expect(PLAN_ACTION_TYPES.has('planClose')).toBe(true);
    expect(PLAN_ACTION_TYPES.has('planCreate')).toBe(true);
    expect(PLAN_ACTION_TYPES.has('planRun')).toBe(true);
  });

  it('does not contain non-plan types', () => {
    expect(PLAN_ACTION_TYPES.has('forgeCreate')).toBe(false);
    expect(PLAN_ACTION_TYPES.has('beadCreate')).toBe(false);
  });
});

describe('executePlanAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('planList', () => {
    it('lists all plans', async () => {
      const result = await executePlanAction(
        { type: 'planList' },
        makeCtx(),
        makePlanCtx(),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.summary).toContain('plan-001');
        expect(result.summary).toContain('plan-002');
        expect(result.summary).toContain('First Plan');
        expect(result.summary).toContain('Second Plan');
      }
    });

    it('filters by status', async () => {
      const result = await executePlanAction(
        { type: 'planList', status: 'APPROVED' },
        makeCtx(),
        makePlanCtx(),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.summary).toContain('plan-002');
        expect(result.summary).not.toContain('plan-001');
      }
    });

    it('returns message when no plans match status filter', async () => {
      const result = await executePlanAction(
        { type: 'planList', status: 'IMPLEMENTING' },
        makeCtx(),
        makePlanCtx(),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.summary).toContain('No plans with status');
      }
    });

    it('returns message when no plans exist', async () => {
      const { listPlanFiles } = await import('./plan-commands.js');
      (listPlanFiles as any).mockResolvedValueOnce([]);

      const result = await executePlanAction(
        { type: 'planList' },
        makeCtx(),
        makePlanCtx(),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.summary).toContain('No plans found');
      }
    });
  });

  describe('planShow', () => {
    it('shows plan details', async () => {
      const result = await executePlanAction(
        { type: 'planShow', planId: 'plan-042' },
        makeCtx(),
        makePlanCtx(),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.summary).toContain('plan-042');
        expect(result.summary).toContain('Test Plan');
        expect(result.summary).toContain('REVIEW');
      }
    });

    it('fails without planId', async () => {
      const result = await executePlanAction(
        { type: 'planShow', planId: '' },
        makeCtx(),
        makePlanCtx(),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('requires a planId');
    });

    it('fails when plan not found', async () => {
      const result = await executePlanAction(
        { type: 'planShow', planId: 'plan-notfound' },
        makeCtx(),
        makePlanCtx(),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('Plan not found');
    });
  });

  describe('planApprove', () => {
    it('approves a plan', async () => {
      const { updatePlanFileStatus } = await import('./plan-commands.js');
      const { bdUpdate } = await import('../beads/bd-cli.js');

      const result = await executePlanAction(
        { type: 'planApprove', planId: 'plan-042' },
        makeCtx(),
        makePlanCtx(),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.summary).toContain('approved');
        expect(result.summary).toContain('plan-042');
      }
      expect(updatePlanFileStatus).toHaveBeenCalledWith(
        '/tmp/plans/plan-042-test.md',
        'APPROVED',
      );
      expect(bdUpdate).toHaveBeenCalledWith('ws-001', { status: 'in_progress' }, '/tmp/beads');
    });

    it('fails without planId', async () => {
      const result = await executePlanAction(
        { type: 'planApprove', planId: '' },
        makeCtx(),
        makePlanCtx(),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('requires a planId');
    });

    it('fails when plan not found', async () => {
      const result = await executePlanAction(
        { type: 'planApprove', planId: 'plan-notfound' },
        makeCtx(),
        makePlanCtx(),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('Plan not found');
    });

    it('rejects when plan is currently implementing', async () => {
      const result = await executePlanAction(
        { type: 'planApprove', planId: 'plan-implementing' },
        makeCtx(),
        makePlanCtx(),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('currently being implemented');
    });
  });

  describe('planClose', () => {
    it('closes a plan', async () => {
      const { updatePlanFileStatus } = await import('./plan-commands.js');
      const { bdClose } = await import('../beads/bd-cli.js');

      const result = await executePlanAction(
        { type: 'planClose', planId: 'plan-042' },
        makeCtx(),
        makePlanCtx(),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.summary).toContain('closed');
        expect(result.summary).toContain('plan-042');
      }
      expect(updatePlanFileStatus).toHaveBeenCalledWith(
        '/tmp/plans/plan-042-test.md',
        'CLOSED',
      );
      expect(bdClose).toHaveBeenCalledWith('ws-001', 'Plan closed', '/tmp/beads');
    });

    it('fails without planId', async () => {
      const result = await executePlanAction(
        { type: 'planClose', planId: '' },
        makeCtx(),
        makePlanCtx(),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('requires a planId');
    });

    it('fails when plan not found', async () => {
      const result = await executePlanAction(
        { type: 'planClose', planId: 'plan-notfound' },
        makeCtx(),
        makePlanCtx(),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('Plan not found');
    });

    it('rejects when plan is currently implementing', async () => {
      const result = await executePlanAction(
        { type: 'planClose', planId: 'plan-implementing' },
        makeCtx(),
        makePlanCtx(),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('currently being implemented');
    });
  });

  describe('planCreate', () => {
    it('creates a new plan', async () => {
      const result = await executePlanAction(
        { type: 'planCreate', description: 'New feature' },
        makeCtx(),
        makePlanCtx(),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.summary).toContain('plan-003');
        expect(result.summary).toContain('New feature');
      }
    });

    it('passes context to handlePlanCommand', async () => {
      const { handlePlanCommand } = await import('./plan-commands.js');

      await executePlanAction(
        { type: 'planCreate', description: 'New feature', context: 'Extra context here' },
        makeCtx(),
        makePlanCtx(),
      );

      expect(handlePlanCommand).toHaveBeenCalledWith(
        { action: 'create', args: 'New feature', context: 'Extra context here' },
        { workspaceCwd: '/tmp/workspace', beadsCwd: '/tmp/beads' },
      );
    });

    it('fails without description', async () => {
      const result = await executePlanAction(
        { type: 'planCreate', description: '' },
        makeCtx(),
        makePlanCtx(),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('requires a description');
    });

    it('returns error when handlePlanCommand fails', async () => {
      const { handlePlanCommand } = await import('./plan-commands.js');
      (handlePlanCommand as any).mockResolvedValueOnce('Failed to create backing bead: ENOENT');

      const result = await executePlanAction(
        { type: 'planCreate', description: 'Broken plan' },
        makeCtx(),
        makePlanCtx(),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('Failed');
    });
  });

  describe('planRun', () => {
    it('starts a plan run and returns summary', async () => {
      const result = await executePlanAction(
        { type: 'planRun', planId: 'plan-042' },
        makeCtx(),
        makePlanCtx({ runtime: {} as any, model: 'opus' }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.summary).toContain('Plan run started');
        expect(result.summary).toContain('plan-042');
      }
    });

    it('fails without planId', async () => {
      const result = await executePlanAction(
        { type: 'planRun', planId: '' },
        makeCtx(),
        makePlanCtx({ runtime: {} as any, model: 'opus' }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('requires a planId');
    });

    it('fails without runtime', async () => {
      const result = await executePlanAction(
        { type: 'planRun', planId: 'plan-042' },
        makeCtx(),
        makePlanCtx(),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('requires runtime');
    });

    it('blocks at recursion depth >= 1', async () => {
      const result = await executePlanAction(
        { type: 'planRun', planId: 'plan-042' },
        makeCtx(),
        makePlanCtx({ runtime: {} as any, model: 'opus', depth: 1 }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('recursion depth');
    });

    it('rejects when plan is already running', async () => {
      const { isPlanRunning } = await import('./forge-plan-registry.js');
      (isPlanRunning as any).mockReturnValueOnce(true);

      const result = await executePlanAction(
        { type: 'planRun', planId: 'plan-042' },
        makeCtx(),
        makePlanCtx({ runtime: {} as any, model: 'opus' }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('already in progress');
    });

    it('rejects plan with DRAFT status via preparePlanRun gate', async () => {
      const { preparePlanRun } = await import('./plan-commands.js');
      (preparePlanRun as any).mockResolvedValueOnce({ error: 'Plan plan-draft has status DRAFT — must be APPROVED or IMPLEMENTING to run.' });

      const result = await executePlanAction(
        { type: 'planRun', planId: 'plan-draft' },
        makeCtx(),
        makePlanCtx({ runtime: {} as any, model: 'opus' }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('DRAFT');
    });

    it('rejects plan with REVIEW status via preparePlanRun gate', async () => {
      const { preparePlanRun } = await import('./plan-commands.js');
      (preparePlanRun as any).mockResolvedValueOnce({ error: 'Plan plan-review has status REVIEW — must be APPROVED or IMPLEMENTING to run.' });

      const result = await executePlanAction(
        { type: 'planRun', planId: 'plan-review' },
        makeCtx(),
        makePlanCtx({ runtime: {} as any, model: 'opus' }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('REVIEW');
    });

    it('calls closePlanIfComplete after phase loop completes', async () => {
      const { closePlanIfComplete } = await import('./plan-commands.js');

      const result = await executePlanAction(
        { type: 'planRun', planId: 'plan-042' },
        makeCtx(),
        makePlanCtx({ runtime: {} as any, model: 'opus' }),
      );
      expect(result.ok).toBe(true);

      // closePlanIfComplete is called in the fire-and-forget async block;
      // yield to let it execute.
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(closePlanIfComplete).toHaveBeenCalledWith(
        '/tmp/plans/plan-042-phases.md',
        '/tmp/plans/plan-042-test.md',
        '/tmp/beads',
        expect.any(Function),
        expect.anything(),
      );
    });

    it('calls closePlanIfComplete even when some phases fail', async () => {
      const { runNextPhase } = await import('./plan-manager.js');
      const { closePlanIfComplete } = await import('./plan-commands.js');
      (runNextPhase as any).mockResolvedValueOnce({ result: 'failed', phase: { id: 'phase-1', title: 'Fail' }, error: 'build error' });

      await executePlanAction(
        { type: 'planRun', planId: 'plan-042' },
        makeCtx(),
        makePlanCtx({ runtime: {} as any, model: 'opus' }),
      );

      await new Promise(resolve => setTimeout(resolve, 50));

      // closePlanIfComplete should still be called — it checks internally
      expect(closePlanIfComplete).toHaveBeenCalled();
    });

    it('sends initial status message and edits it with final outcome after run finishes', async () => {
      const setup = makeSendFn();
      const ctx = makeCtx(setup);

      await executePlanAction(
        { type: 'planRun', planId: 'plan-042' },
        ctx,
        makePlanCtx({ runtime: {} as any, model: 'opus' }),
      );

      await new Promise(resolve => setTimeout(resolve, 50));

      // Initial send: status message posted at start
      expect(setup.fn).toHaveBeenCalledOnce();
      const sendContent: string = setup.fn.mock.calls[0]![0]!.content;
      expect(sendContent).toContain('plan-042');
      expect(sendContent).toContain('Plan run started');

      // Final edit: status message updated with completion summary
      expect(setup.msg.edit).toHaveBeenCalled();
      const lastEdit = setup.msg.edit.mock.calls.at(-1)![0]!;
      expect(lastEdit.content).toContain('plan-042');
      expect(lastEdit.content).toContain('Phases run:');
      expect(lastEdit.allowedMentions).toEqual({ parse: [] });
    });

    it('skips completion notification when skipCompletionNotify is true', async () => {
      const setup = makeSendFn();
      const ctx = makeCtx(setup);

      await executePlanAction(
        { type: 'planRun', planId: 'plan-042' },
        ctx,
        makePlanCtx({ runtime: {} as any, model: 'opus', skipCompletionNotify: true }),
      );

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(setup.fn).not.toHaveBeenCalled();
      expect(setup.msg.edit).not.toHaveBeenCalled();
    });

    it('includes stop reason in completion notification when a phase fails', async () => {
      const { runNextPhase } = await import('./plan-manager.js');
      (runNextPhase as any).mockResolvedValueOnce({ result: 'audit_failed', error: 'lint errors' });

      const setup = makeSendFn();
      const ctx = makeCtx(setup);

      await executePlanAction(
        { type: 'planRun', planId: 'plan-042' },
        ctx,
        makePlanCtx({ runtime: {} as any, model: 'opus' }),
      );

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(setup.fn).toHaveBeenCalledOnce();
      const lastEdit = setup.msg.edit.mock.calls.at(-1)![0]!;
      expect(lastEdit.content).toContain('Stopped:');
    });

    it('calls onRunComplete with final content after run completes', async () => {
      const onRunComplete = vi.fn(async (_content: string) => {});

      await executePlanAction(
        { type: 'planRun', planId: 'plan-042' },
        makeCtx(),
        makePlanCtx({ runtime: {} as any, model: 'opus', onRunComplete }),
      );

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(onRunComplete).toHaveBeenCalledOnce();
      const content: string = onRunComplete.mock.calls[0]![0]!;
      expect(content).toContain('Plan run complete');
      expect(content).toContain('plan-042');
      expect(content).toContain('Phases run:');
    });

    it('calls onRunComplete even when skipCompletionNotify is true', async () => {
      const onRunComplete = vi.fn(async (_content: string) => {});
      const setup = makeSendFn();
      const ctx = makeCtx(setup);

      await executePlanAction(
        { type: 'planRun', planId: 'plan-042' },
        ctx,
        makePlanCtx({ runtime: {} as any, model: 'opus', skipCompletionNotify: true, onRunComplete }),
      );

      await new Promise(resolve => setTimeout(resolve, 50));

      // No Discord messages should be sent
      expect(setup.fn).not.toHaveBeenCalled();
      expect(setup.msg.edit).not.toHaveBeenCalled();
      // But onRunComplete is still called
      expect(onRunComplete).toHaveBeenCalledOnce();
      const content: string = onRunComplete.mock.calls[0]![0]!;
      expect(content).toContain('Plan run complete');
      expect(content).toContain('plan-042');
    });

    it('includes auto-close note in completion notification when plan is closed', async () => {
      const { closePlanIfComplete } = await import('./plan-commands.js');
      (closePlanIfComplete as any).mockResolvedValueOnce({ closed: true, reason: 'all_phases_complete' });

      const setup = makeSendFn();
      const ctx = makeCtx(setup);

      await executePlanAction(
        { type: 'planRun', planId: 'plan-042' },
        ctx,
        makePlanCtx({ runtime: {} as any, model: 'opus' }),
      );

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(setup.fn).toHaveBeenCalledOnce();
      const lastEdit = setup.msg.edit.mock.calls.at(-1)![0]!;
      expect(lastEdit.content).toContain('auto-closed');
    });
  });
});

describe('planActionsPromptSection', () => {
  it('returns non-empty prompt section', () => {
    const section = planActionsPromptSection();
    expect(section).toContain('planList');
    expect(section).toContain('planShow');
    expect(section).toContain('planApprove');
    expect(section).toContain('planClose');
    expect(section).toContain('planCreate');
    expect(section).toContain('planRun');
  });

  it('includes plan guidelines', () => {
    const section = planActionsPromptSection();
    expect(section).toContain('DRAFT');
    expect(section).toContain('APPROVED');
    expect(section).toContain('forgeCreate');
  });
});
