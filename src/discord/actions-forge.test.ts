import { describe, expect, it, vi, beforeEach } from 'vitest';
import { FORGE_ACTION_TYPES, executeForgeAction, forgeActionsPromptSection } from './actions-forge.js';
import type { ForgeContext } from './actions-forge.js';
import type { ActionContext } from './actions.js';
import { _resetForTest, setActiveOrchestrator } from './forge-plan-registry.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('./plan-commands.js', () => ({
  looksLikePlanId: vi.fn((id: string) => /^\d+$/.test(id) || /^plan-\d+$/.test(id)),
  findPlanFile: vi.fn(async (_dir: string, id: string) => {
    if (id === 'plan-notfound') return null;
    return {
      filePath: `/tmp/plans/${id}-test.md`,
      header: { planId: id, beadId: 'ws-001', status: 'REVIEW', title: 'Test Plan', project: 'discoclaw', created: '2026-01-01' },
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

function makeCtx(): ActionContext {
  return {
    guild: {} as any,
    client: {} as any,
    channelId: 'test-channel',
    messageId: 'test-message',
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
    beadsCwd: '/tmp/beads',
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

    it('fails without description', async () => {
      const result = await executeForgeAction(
        { type: 'forgeCreate', description: '' },
        makeCtx(),
        makeForgeCtx(),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('requires a description');
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
});
