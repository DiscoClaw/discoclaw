import { describe, expect, it } from 'vitest';
import { CONFIG_ACTION_TYPES, executeConfigAction, configActionsPromptSection } from './actions-config.js';
import type { ConfigActionRequest, ConfigContext, ConfigMutableParams } from './actions-config.js';
import type { RuntimeAdapter } from '../runtime/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBotParams(overrides?: Partial<ConfigMutableParams>): ConfigMutableParams {
  return {
    runtimeModel: 'capable',
    summaryModel: 'fast',
    forgeDrafterModel: undefined,
    forgeAuditorModel: undefined,
    cronCtx: { autoTagModel: 'fast' },
    beadCtx: { autoTagModel: 'fast' },
    ...overrides,
  };
}

const stubRuntime: RuntimeAdapter = {
  id: 'claude_code',
  capabilities: new Set(),
  async *invoke() { /* no-op */ },
};

function makeCtx(overrides?: Partial<ConfigMutableParams>): ConfigContext {
  return {
    botParams: makeBotParams(overrides),
    runtime: stubRuntime,
  };
}

// ---------------------------------------------------------------------------
// CONFIG_ACTION_TYPES
// ---------------------------------------------------------------------------

describe('CONFIG_ACTION_TYPES', () => {
  it('includes modelSet and modelShow', () => {
    expect(CONFIG_ACTION_TYPES.has('modelSet')).toBe(true);
    expect(CONFIG_ACTION_TYPES.has('modelShow')).toBe(true);
    expect(CONFIG_ACTION_TYPES.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// modelShow
// ---------------------------------------------------------------------------

describe('modelShow', () => {
  it('returns current model assignments', () => {
    const ctx = makeCtx();
    const result = executeConfigAction({ type: 'modelShow' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary).toContain('chat');
    expect(result.summary).toContain('capable');
    expect(result.summary).toContain('summary');
    expect(result.summary).toContain('forge-drafter');
    expect(result.summary).toContain('forge-auditor');
    expect(result.summary).toContain('cron');
  });

  it('shows forge models falling back to runtimeModel', () => {
    const ctx = makeCtx();
    const result = executeConfigAction({ type: 'modelShow' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // forge-drafter should show runtimeModel since forgeDrafterModel is undefined
    expect(result.summary).toContain('forge-drafter');
    expect(result.summary).toContain('capable');
  });

  it('shows explicit forge model override', () => {
    const ctx = makeCtx({ forgeDrafterModel: 'sonnet' });
    const result = executeConfigAction({ type: 'modelShow' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary).toContain('sonnet');
  });

  it('resolves tier names to concrete models for claude_code runtime', () => {
    const ctx = makeCtx();
    const result = executeConfigAction({ type: 'modelShow' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 'capable' resolves to 'opus' for claude_code
    expect(result.summary).toContain('opus');
    // 'fast' resolves to 'haiku' for claude_code
    expect(result.summary).toContain('haiku');
  });

  it('omits cron row when cronCtx is not set', () => {
    const ctx = makeCtx({ cronCtx: undefined });
    const result = executeConfigAction({ type: 'modelShow' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary).not.toContain('cron-auto-tag');
  });

  it('labels cron row as cron-auto-tag', () => {
    const ctx = makeCtx();
    const result = executeConfigAction({ type: 'modelShow' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary).toContain('cron-auto-tag');
  });

  it('shows runtime defaultModel when model value is empty', () => {
    const codexRuntime: RuntimeAdapter = {
      id: 'codex',
      capabilities: new Set(),
      defaultModel: 'gpt-5-codex-mini',
      async *invoke() { /* no-op */ },
    };
    const ctx: ConfigContext = {
      botParams: makeBotParams({ runtimeModel: '', summaryModel: '' }),
      runtime: codexRuntime,
    };
    const result = executeConfigAction({ type: 'modelShow' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary).toContain('gpt-5-codex-mini');
    expect(result.summary).not.toContain('(adapter default)');
  });

  it('falls back to (adapter default) when both model and defaultModel are empty', () => {
    const codexRuntime: RuntimeAdapter = {
      id: 'codex',
      capabilities: new Set(),
      async *invoke() { /* no-op */ },
    };
    const ctx: ConfigContext = {
      botParams: makeBotParams({ runtimeModel: '', summaryModel: '' }),
      runtime: codexRuntime,
    };
    const result = executeConfigAction({ type: 'modelShow' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary).toContain('(adapter default)');
  });
});

// ---------------------------------------------------------------------------
// modelSet
// ---------------------------------------------------------------------------

describe('modelSet', () => {
  it('sets chat model (runtimeModel)', () => {
    const ctx = makeCtx();
    const result = executeConfigAction({ type: 'modelSet', role: 'chat', model: 'sonnet' }, ctx);
    expect(result.ok).toBe(true);
    expect(ctx.botParams.runtimeModel).toBe('sonnet');
  });

  it('sets all fast-tier models at once', () => {
    const ctx = makeCtx();
    const result = executeConfigAction({ type: 'modelSet', role: 'fast', model: 'haiku' }, ctx);
    expect(result.ok).toBe(true);
    expect(ctx.botParams.summaryModel).toBe('haiku');
    expect(ctx.botParams.cronCtx!.autoTagModel).toBe('haiku');
    expect(ctx.botParams.beadCtx!.autoTagModel).toBe('haiku');
  });

  it('sets forge-drafter model', () => {
    const ctx = makeCtx();
    const result = executeConfigAction({ type: 'modelSet', role: 'forge-drafter', model: 'opus' }, ctx);
    expect(result.ok).toBe(true);
    expect(ctx.botParams.forgeDrafterModel).toBe('opus');
  });

  it('sets forge-auditor model', () => {
    const ctx = makeCtx();
    const result = executeConfigAction({ type: 'modelSet', role: 'forge-auditor', model: 'sonnet' }, ctx);
    expect(result.ok).toBe(true);
    expect(ctx.botParams.forgeAuditorModel).toBe('sonnet');
  });

  it('sets summary model independently', () => {
    const ctx = makeCtx();
    const result = executeConfigAction({ type: 'modelSet', role: 'summary', model: 'capable' }, ctx);
    expect(result.ok).toBe(true);
    expect(ctx.botParams.summaryModel).toBe('capable');
  });

  it('sets cron model', () => {
    const ctx = makeCtx();
    const result = executeConfigAction({ type: 'modelSet', role: 'cron', model: 'capable' }, ctx);
    expect(result.ok).toBe(true);
    expect(ctx.botParams.cronCtx!.autoTagModel).toBe('capable');
  });

  it('rejects empty model string', () => {
    const ctx = makeCtx();
    const result = executeConfigAction({ type: 'modelSet', role: 'chat', model: '' }, ctx);
    expect(result.ok).toBe(false);
  });

  it('rejects model with whitespace', () => {
    const ctx = makeCtx();
    const result = executeConfigAction({ type: 'modelSet', role: 'chat', model: 'some model' }, ctx);
    expect(result.ok).toBe(false);
  });

  it('rejects missing role', () => {
    const ctx = makeCtx();
    const result = executeConfigAction({ type: 'modelSet', role: '' as any, model: 'sonnet' }, ctx);
    expect(result.ok).toBe(false);
  });

  it('rejects missing model', () => {
    const ctx = makeCtx();
    const result = executeConfigAction({ type: 'modelSet', role: 'chat', model: '' }, ctx);
    expect(result.ok).toBe(false);
  });

  it('fails for cron role when cronCtx is not configured', () => {
    const ctx = makeCtx({ cronCtx: undefined });
    const result = executeConfigAction({ type: 'modelSet', role: 'cron', model: 'fast' }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('Cron subsystem not configured');
  });

  it('includes resolved model note for tier names', () => {
    const ctx = makeCtx();
    const result = executeConfigAction({ type: 'modelSet', role: 'chat', model: 'capable' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary).toContain('resolves to opus');
  });

  it('fast role succeeds when cronCtx and beadCtx are missing', () => {
    const ctx = makeCtx({ cronCtx: undefined, beadCtx: undefined });
    const result = executeConfigAction({ type: 'modelSet', role: 'fast', model: 'haiku' }, ctx);
    expect(result.ok).toBe(true);
    expect(ctx.botParams.summaryModel).toBe('haiku');
    if (!result.ok) return;
    // Only summary changed, cron/beads skipped silently
    expect(result.summary).toContain('summary');
    expect(result.summary).not.toContain('cron');
    expect(result.summary).not.toContain('beads');
  });

  it('accepts concrete model names as passthrough', () => {
    const ctx = makeCtx();
    const result = executeConfigAction({ type: 'modelSet', role: 'chat', model: 'claude-sonnet-4-5-20250929' }, ctx);
    expect(result.ok).toBe(true);
    expect(ctx.botParams.runtimeModel).toBe('claude-sonnet-4-5-20250929');
  });

  it('chat propagates to planCtx.model', () => {
    const ctx = makeCtx();
    ctx.botParams.planCtx = { model: 'old' };
    executeConfigAction({ type: 'modelSet', role: 'chat', model: 'sonnet' }, ctx);
    expect(ctx.botParams.planCtx!.model).toBe('sonnet');
  });

  it('chat propagates to cronCtx.executorCtx.model', () => {
    const ctx = makeCtx();
    ctx.botParams.cronCtx!.executorCtx = { model: 'old' };
    executeConfigAction({ type: 'modelSet', role: 'chat', model: 'sonnet' }, ctx);
    expect(ctx.botParams.cronCtx!.executorCtx!.model).toBe('sonnet');
  });

  it('fast propagates to cronCtx.syncCoordinator', () => {
    let updated = '';
    const ctx = makeCtx();
    ctx.botParams.cronCtx!.syncCoordinator = { setAutoTagModel: (m: string) => { updated = m; } };
    executeConfigAction({ type: 'modelSet', role: 'fast', model: 'haiku' }, ctx);
    expect(updated).toBe('haiku');
  });

  it('cron propagates to cronCtx.syncCoordinator', () => {
    let updated = '';
    const ctx = makeCtx();
    ctx.botParams.cronCtx!.syncCoordinator = { setAutoTagModel: (m: string) => { updated = m; } };
    executeConfigAction({ type: 'modelSet', role: 'cron', model: 'capable' }, ctx);
    expect(updated).toBe('capable');
  });

  it('chat skips planCtx/cronExecCtx propagation when not configured', () => {
    const ctx = makeCtx();
    // No planCtx or cronCtx.executorCtx — should not throw
    ctx.botParams.planCtx = undefined;
    const result = executeConfigAction({ type: 'modelSet', role: 'chat', model: 'sonnet' }, ctx);
    expect(result.ok).toBe(true);
    expect(ctx.botParams.runtimeModel).toBe('sonnet');
  });
});

// ---------------------------------------------------------------------------
// configActionsPromptSection
// ---------------------------------------------------------------------------

describe('configActionsPromptSection', () => {
  it('documents modelSet and modelShow', () => {
    const section = configActionsPromptSection();
    expect(section).toContain('modelShow');
    expect(section).toContain('modelSet');
    expect(section).toContain('role');
    expect(section).toContain('chat');
    expect(section).toContain('fast');
    expect(section).toContain('forge-drafter');
    expect(section).toContain('forge-auditor');
    expect(section).toContain('ephemeral');
  });
});
