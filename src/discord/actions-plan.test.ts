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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(): ActionContext {
  return {
    guild: {} as any,
    client: {} as any,
    channelId: 'test-channel',
    messageId: 'test-message',
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
