import { describe, expect, it } from 'vitest';
import { CONFIG_ACTION_TYPES, executeConfigAction, configActionsPromptSection } from './actions-config.js';
import type { ConfigActionRequest, ConfigContext, ConfigMutableParams } from './actions-config.js';
import type { RuntimeAdapter } from '../runtime/types.js';
import { RuntimeRegistry } from '../runtime/registry.js';
import type { ImagegenContext } from './actions-imagegen.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const stubRuntime: RuntimeAdapter = {
  id: 'claude_code',
  capabilities: new Set(),
  async *invoke() { /* no-op */ },
};

const openrouterRuntime: RuntimeAdapter = {
  id: 'openrouter',
  capabilities: new Set(),
  defaultModel: 'anthropic/claude-sonnet-4',
  async *invoke() { /* no-op */ },
};

function makeRegistry(...entries: [string, RuntimeAdapter][]): RuntimeRegistry {
  const reg = new RuntimeRegistry();
  for (const [name, adapter] of entries) {
    reg.register(name, adapter);
  }
  return reg;
}

function makeBotParams(overrides?: Partial<ConfigMutableParams>): ConfigMutableParams {
  return {
    runtimeModel: 'capable',
    summaryModel: 'fast',
    runtime: stubRuntime,
    forgeDrafterModel: undefined,
    forgeAuditorModel: undefined,
    cronCtx: { autoTagModel: 'fast', runtime: stubRuntime, executorCtx: { model: 'capable', runtime: stubRuntime } },
    taskCtx: { autoTagModel: 'fast' },
    ...overrides,
  };
}

function makeCtx(overrides?: Partial<ConfigMutableParams>): ConfigContext {
  return {
    botParams: makeBotParams(overrides),
    runtime: stubRuntime,
    runtimeRegistry: makeRegistry(),
    runtimeName: 'claude_code',
  };
}

// ---------------------------------------------------------------------------
// CONFIG_ACTION_TYPES
// ---------------------------------------------------------------------------

describe('CONFIG_ACTION_TYPES', () => {
  it('includes modelSet and modelShow', () => {
    expect(CONFIG_ACTION_TYPES.has('modelSet')).toBe(true);
    expect(CONFIG_ACTION_TYPES.has('modelShow')).toBe(true);
    expect(CONFIG_ACTION_TYPES.has('modelReset')).toBe(true);
    expect(CONFIG_ACTION_TYPES.size).toBe(3);
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
    // forge-drafter and forge-auditor should show (follows chat) since their models are undefined
    const lines = result.summary.split('\n');
    const drafterLine = lines.find(l => l.includes('forge-drafter'));
    const auditorLine = lines.find(l => l.includes('forge-auditor'));
    expect(drafterLine).toContain('follows chat');
    expect(auditorLine).toContain('follows chat');
  });

  it('shows explicit forge model override', () => {
    const ctx = makeCtx({ forgeDrafterModel: 'sonnet' });
    const result = executeConfigAction({ type: 'modelShow' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary).toContain('sonnet');
  });

  it('shows explicit forge-drafter model without (follows chat) annotation', () => {
    const ctx = makeCtx({ forgeDrafterModel: 'sonnet' });
    const result = executeConfigAction({ type: 'modelShow' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lines = result.summary.split('\n');
    const drafterLine = lines.find(l => l.includes('forge-drafter'));
    expect(drafterLine).toContain('sonnet');
    expect(drafterLine).not.toContain('follows chat');
  });

  it('resolves tier names to concrete models for claude_code runtime', () => {
    const ctx = makeCtx();
    const result = executeConfigAction({ type: 'modelShow' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 'capable' resolves to 'sonnet' for claude_code
    expect(result.summary).toContain('sonnet');
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

  it('shows cron-exec following chat when no override set', () => {
    const ctx = makeCtx();
    const result = executeConfigAction({ type: 'modelShow' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary).toContain('cron-exec');
    expect(result.summary).toContain('follows chat');
  });

  it('shows explicit cron-exec model when set', () => {
    const ctx = makeCtx();
    ctx.botParams.cronCtx!.executorCtx!.cronExecModel = 'haiku';
    const result = executeConfigAction({ type: 'modelShow' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lines = result.summary.split('\n');
    const cronExecLine = lines.find(l => l.includes('cron-exec'));
    expect(cronExecLine).toContain('haiku');
    expect(cronExecLine).not.toContain('follows chat');
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
      runtimeRegistry: makeRegistry(),
      runtimeName: 'codex',
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
      runtimeRegistry: makeRegistry(),
      runtimeName: 'codex',
    };
    const result = executeConfigAction({ type: 'modelShow' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary).toContain('(adapter default)');
  });
});

// ---------------------------------------------------------------------------
// modelShow — imagegen row
// ---------------------------------------------------------------------------

describe('modelShow imagegen row', () => {
  it('shows imagegen row with OpenAI config (apiKey set)', () => {
    const imagegenCtx: ImagegenContext = { apiKey: 'sk-test' };
    const ctx = makeCtx({ imagegenCtx });
    const result = executeConfigAction({ type: 'modelShow' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary).toContain('imagegen');
    expect(result.summary).toContain('dall-e-3');
    expect(result.summary).toContain('openai');
  });

  it('shows imagegen row with Gemini config (geminiApiKey only)', () => {
    const imagegenCtx: ImagegenContext = { geminiApiKey: 'gk-test' };
    const ctx = makeCtx({ imagegenCtx });
    const result = executeConfigAction({ type: 'modelShow' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary).toContain('imagegen');
    expect(result.summary).toContain('imagen-4.0-generate-001');
    expect(result.summary).toContain('gemini');
  });

  it('respects explicit defaultModel', () => {
    const imagegenCtx: ImagegenContext = { apiKey: 'sk-test', defaultModel: 'gpt-image-1' };
    const ctx = makeCtx({ imagegenCtx });
    const result = executeConfigAction({ type: 'modelShow' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary).toContain('imagegen');
    expect(result.summary).toContain('gpt-image-1');
    expect(result.summary).toContain('openai');
  });

  it('omits imagegen row when imagegenCtx is absent', () => {
    const ctx = makeCtx({ imagegenCtx: undefined });
    const result = executeConfigAction({ type: 'modelShow' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary).not.toContain('imagegen');
  });

  it('defaults to dall-e-3/openai when both apiKey and geminiApiKey are set', () => {
    const imagegenCtx: ImagegenContext = { apiKey: 'sk-test', geminiApiKey: 'gk-test' };
    const ctx = makeCtx({ imagegenCtx });
    const result = executeConfigAction({ type: 'modelShow' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary).toContain('imagegen');
    expect(result.summary).toContain('dall-e-3');
    expect(result.summary).toContain('openai');
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
    expect(ctx.botParams.taskCtx!.autoTagModel).toBe('haiku');
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
    expect(result.summary).toContain('resolves to sonnet');
  });

  it('fast role succeeds when cronCtx and taskCtx are missing', () => {
    const ctx = makeCtx({ cronCtx: undefined, taskCtx: undefined });
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
    ctx.botParams.planCtx = { model: 'old', runtime: stubRuntime };
    executeConfigAction({ type: 'modelSet', role: 'chat', model: 'sonnet' }, ctx);
    expect(ctx.botParams.planCtx!.model).toBe('sonnet');
  });

  it('chat propagates to cronCtx.executorCtx.model', () => {
    const ctx = makeCtx();
    ctx.botParams.cronCtx!.executorCtx = { model: 'old', runtime: stubRuntime };
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

  it('sets cron-exec model', () => {
    const ctx = makeCtx();
    const result = executeConfigAction({ type: 'modelSet', role: 'cron-exec', model: 'haiku' }, ctx);
    expect(result.ok).toBe(true);
    expect(ctx.botParams.cronCtx!.executorCtx!.cronExecModel).toBe('haiku');
  });

  it('cron-exec "default" clears the override', () => {
    const ctx = makeCtx();
    ctx.botParams.cronCtx!.executorCtx!.cronExecModel = 'haiku';
    const result = executeConfigAction({ type: 'modelSet', role: 'cron-exec', model: 'default' }, ctx);
    expect(result.ok).toBe(true);
    expect(ctx.botParams.cronCtx!.executorCtx!.cronExecModel).toBeUndefined();
    if (!result.ok) return;
    expect(result.summary).toContain('follows chat');
  });

  it('cron-exec fails when cron subsystem not configured', () => {
    const ctx = makeCtx({ cronCtx: undefined });
    const result = executeConfigAction({ type: 'modelSet', role: 'cron-exec', model: 'haiku' }, ctx);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// modelSet — runtime swap
// ---------------------------------------------------------------------------

describe('modelSet runtime swap', () => {
  it('swaps all runtime refs and sets default model for a registered runtime name', () => {
    const ctx = makeCtx();
    ctx.runtimeRegistry = makeRegistry(['openrouter', openrouterRuntime]);
    ctx.botParams.planCtx = { model: 'capable', runtime: stubRuntime };
    ctx.botParams.deferOpts = { runtime: stubRuntime };
    const result = executeConfigAction({ type: 'modelSet', role: 'chat', model: 'openrouter' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Runtime swapped everywhere
    expect(ctx.botParams.runtime).toBe(openrouterRuntime);
    expect(ctx.runtime).toBe(openrouterRuntime);
    expect(ctx.runtimeName).toBe('openrouter');
    expect(ctx.botParams.runtimeModel).toBe('anthropic/claude-sonnet-4');
    expect(ctx.botParams.planCtx!.runtime).toBe(openrouterRuntime);
    expect(ctx.botParams.planCtx!.model).toBe('anthropic/claude-sonnet-4');
    expect(ctx.botParams.cronCtx!.runtime).toBe(openrouterRuntime);
    expect(ctx.botParams.cronCtx!.executorCtx!.runtime).toBe(openrouterRuntime);
    expect(ctx.botParams.cronCtx!.executorCtx!.model).toBe('anthropic/claude-sonnet-4');
    expect(ctx.botParams.deferOpts!.runtime).toBe(openrouterRuntime);
    expect(result.summary).toContain('runtime → openrouter');
    expect(result.summary).toContain('adapter default');
  });

  it('does not swap runtime for a plain model name like opus', () => {
    const ctx = makeCtx();
    ctx.runtimeRegistry = makeRegistry(['openrouter', openrouterRuntime]);
    const result = executeConfigAction({ type: 'modelSet', role: 'chat', model: 'opus' }, ctx);
    expect(result.ok).toBe(true);
    expect(ctx.botParams.runtime).toBe(stubRuntime);
    expect(ctx.runtime).toBe(stubRuntime);
    expect(ctx.runtimeName).toBe('claude_code');
    expect(ctx.botParams.runtimeModel).toBe('opus');
  });

  it('passes through unregistered name as model string without error', () => {
    const ctx = makeCtx();
    ctx.runtimeRegistry = makeRegistry(['openrouter', openrouterRuntime]);
    const result = executeConfigAction({ type: 'modelSet', role: 'chat', model: 'mistral' }, ctx);
    expect(result.ok).toBe(true);
    // No swap — treated as model string
    expect(ctx.botParams.runtime).toBe(stubRuntime);
    expect(ctx.botParams.runtimeModel).toBe('mistral');
  });

  it('case-insensitive matching — OpenRouter matches openrouter', () => {
    const ctx = makeCtx();
    ctx.runtimeRegistry = makeRegistry(['openrouter', openrouterRuntime]);
    const result = executeConfigAction({ type: 'modelSet', role: 'chat', model: 'OpenRouter' }, ctx);
    expect(result.ok).toBe(true);
    expect(ctx.botParams.runtime).toBe(openrouterRuntime);
    expect(ctx.runtimeName).toBe('openrouter');
  });

  it('swap then set model name — runtime stays swapped, model changes', () => {
    const ctx = makeCtx();
    ctx.runtimeRegistry = makeRegistry(['openrouter', openrouterRuntime]);
    // First swap runtime
    executeConfigAction({ type: 'modelSet', role: 'chat', model: 'openrouter' }, ctx);
    expect(ctx.botParams.runtime).toBe(openrouterRuntime);
    // Then set a plain model name — runtime stays
    executeConfigAction({ type: 'modelSet', role: 'chat', model: 'gpt-4o' }, ctx);
    expect(ctx.botParams.runtime).toBe(openrouterRuntime);
    expect(ctx.botParams.runtimeModel).toBe('gpt-4o');
  });

  it('propagation to syncCoordinator.setRuntime is called when present', () => {
    const ctx = makeCtx();
    ctx.runtimeRegistry = makeRegistry(['openrouter', openrouterRuntime]);
    let capturedRuntime: RuntimeAdapter | undefined;
    ctx.botParams.cronCtx!.syncCoordinator = {
      setAutoTagModel: () => {},
      setRuntime: (rt: RuntimeAdapter) => { capturedRuntime = rt; },
    };
    executeConfigAction({ type: 'modelSet', role: 'chat', model: 'openrouter' }, ctx);
    expect(capturedRuntime).toBe(openrouterRuntime);
  });
});

// ---------------------------------------------------------------------------
// modelShow — runtime line
// ---------------------------------------------------------------------------

describe('modelShow runtime line', () => {
  it('displays active runtime name', () => {
    const ctx = makeCtx();
    const result = executeConfigAction({ type: 'modelShow' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary).toContain('runtime');
    expect(result.summary).toContain('claude_code');
  });

  it('displays swapped runtime name after swap', () => {
    const ctx = makeCtx();
    ctx.runtimeRegistry = makeRegistry(['openrouter', openrouterRuntime]);
    executeConfigAction({ type: 'modelSet', role: 'chat', model: 'openrouter' }, ctx);
    const result = executeConfigAction({ type: 'modelShow' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary).toContain('openrouter');
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
    expect(section).toContain('persisted');
    expect(section).toContain('modelReset');
  });
});
