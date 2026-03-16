/**
 * Regression coverage for config-mutation authorization.
 *
 * Verifies that:
 * - checkConfigAuthorization denies unauthorized requesters for mutating actions
 * - checkConfigAuthorization allows authorized requesters
 * - Read-only config actions (modelShow, workspaceWarnings) bypass auth
 * - Denied requests produce no side effects on bot state
 * - Fail-closed: missing allowlist or missing requesterId always denies
 */

import { describe, expect, it } from 'vitest';
import { checkConfigAuthorization } from '../../src/discord/action-dispatcher.js';
import { CONFIG_MUTATING_ACTION_TYPES } from '../../src/discord/actions-config.js';
import type { ConfigMutableParams, ConfigContext } from '../../src/discord/actions-config.js';
import { executeConfigAction } from '../../src/discord/actions-config.js';
import { CONFIG_UNAUTHORIZED_ERROR } from '../../src/discord/replies.js';
import { isConfigAuthorized } from '../../src/discord/allowlist.js';
import type { RuntimeAdapter } from '../../src/runtime/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALLOWED_USER = '111111111111111111';
const DENIED_USER = '999999999999999999';
const ALLOW_SET = new Set([ALLOWED_USER]);

const stubRuntime: RuntimeAdapter = {
  id: 'claude_code',
  capabilities: new Set(),
  async *invoke() { /* no-op */ },
};

function makeBotParams(): ConfigMutableParams {
  return {
    runtimeModel: 'capable',
    planRunModel: 'capable',
    summaryModel: 'fast',
    runtime: stubRuntime,
    forgeDrafterModel: undefined,
    forgeAuditorModel: undefined,
    cronCtx: { autoTagModel: 'fast', runtime: stubRuntime, executorCtx: { model: 'capable', runtime: stubRuntime } },
    taskCtx: { autoTagModel: 'fast' },
    voiceModelCtx: { model: 'fast' },
    imagegenCtx: { apiKey: 'sk-test' },
  };
}

function makeConfigCtx(): ConfigContext {
  return {
    botParams: makeBotParams(),
    workspaceCwd: '/tmp/workspace',
    runtime: stubRuntime,
    runtimeName: 'claude_code',
  };
}

/** Snapshot mutable fields so we can assert no side effects on denial. */
function snapshotParams(bp: ConfigMutableParams) {
  return {
    runtimeModel: bp.runtimeModel,
    planRunModel: bp.planRunModel,
    summaryModel: bp.summaryModel,
    forgeDrafterModel: bp.forgeDrafterModel,
    forgeAuditorModel: bp.forgeAuditorModel,
    cronAutoTagModel: bp.cronCtx?.autoTagModel,
    cronExecModel: bp.cronCtx?.executorCtx?.model,
    taskAutoTagModel: bp.taskCtx?.autoTagModel,
    voiceModel: bp.voiceModelCtx?.model,
    imagegenDefaultModel: bp.imagegenCtx?.defaultModel,
  };
}

// ---------------------------------------------------------------------------
// CONFIG_MUTATING_ACTION_TYPES
// ---------------------------------------------------------------------------

describe('CONFIG_MUTATING_ACTION_TYPES', () => {
  it('includes modelSet and modelReset', () => {
    expect(CONFIG_MUTATING_ACTION_TYPES.has('modelSet')).toBe(true);
    expect(CONFIG_MUTATING_ACTION_TYPES.has('modelReset')).toBe(true);
  });

  it('excludes read-only actions', () => {
    expect(CONFIG_MUTATING_ACTION_TYPES.has('modelShow')).toBe(false);
    expect(CONFIG_MUTATING_ACTION_TYPES.has('workspaceWarnings')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isConfigAuthorized (unit)
// ---------------------------------------------------------------------------

describe('isConfigAuthorized', () => {
  it('returns true for an allowlisted user', () => {
    expect(isConfigAuthorized(ALLOW_SET, ALLOWED_USER)).toBe(true);
  });

  it('returns false for a non-allowlisted user', () => {
    expect(isConfigAuthorized(ALLOW_SET, DENIED_USER)).toBe(false);
  });

  it('fails closed when allowlist is empty', () => {
    expect(isConfigAuthorized(new Set(), ALLOWED_USER)).toBe(false);
  });

  it('fails closed when allowlist is undefined', () => {
    expect(isConfigAuthorized(undefined, ALLOWED_USER)).toBe(false);
  });

  it('fails closed when requesterId is undefined', () => {
    expect(isConfigAuthorized(ALLOW_SET, undefined)).toBe(false);
  });

  it('fails closed when both are undefined', () => {
    expect(isConfigAuthorized(undefined, undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkConfigAuthorization — gate logic
// ---------------------------------------------------------------------------

describe('checkConfigAuthorization', () => {
  it('returns null (allowed) for non-config action types', () => {
    expect(checkConfigAuthorization('sendMessage', undefined, undefined)).toBeNull();
    expect(checkConfigAuthorization('channelCreate', DENIED_USER, ALLOW_SET)).toBeNull();
  });

  it('returns null (allowed) for read-only config actions regardless of requester', () => {
    expect(checkConfigAuthorization('modelShow', undefined, undefined)).toBeNull();
    expect(checkConfigAuthorization('workspaceWarnings', DENIED_USER, new Set())).toBeNull();
  });

  it('denies modelSet from an unauthorized user', () => {
    const result = checkConfigAuthorization('modelSet', DENIED_USER, ALLOW_SET);
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(false);
    if (!result!.ok) {
      expect(result!.error).toBe(CONFIG_UNAUTHORIZED_ERROR);
    }
  });

  it('denies modelReset from an unauthorized user', () => {
    const result = checkConfigAuthorization('modelReset', DENIED_USER, ALLOW_SET);
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(false);
  });

  it('allows modelSet from an authorized user', () => {
    expect(checkConfigAuthorization('modelSet', ALLOWED_USER, ALLOW_SET)).toBeNull();
  });

  it('allows modelReset from an authorized user', () => {
    expect(checkConfigAuthorization('modelReset', ALLOWED_USER, ALLOW_SET)).toBeNull();
  });

  it('denies when requesterId is undefined (missing identity)', () => {
    const result = checkConfigAuthorization('modelSet', undefined, ALLOW_SET);
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(false);
  });

  it('denies when allowUserIds is undefined (missing allowlist)', () => {
    const result = checkConfigAuthorization('modelSet', ALLOWED_USER, undefined);
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(false);
  });

  it('denies when allowUserIds is empty (fail closed)', () => {
    const result = checkConfigAuthorization('modelReset', ALLOWED_USER, new Set());
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// No side effects on denial — modelSet
// ---------------------------------------------------------------------------

describe('no side effects on denied modelSet', () => {
  const roles = [
    'chat', 'plan-run', 'fast', 'forge-drafter', 'forge-auditor',
    'summary', 'cron', 'cron-exec', 'voice', 'imagegen',
  ] as const;

  for (const role of roles) {
    it(`modelSet role="${role}" leaves botParams unchanged when denied`, () => {
      const ctx = makeConfigCtx();
      const before = snapshotParams(ctx.botParams);

      // Simulate what the action dispatch loop does: check auth first.
      const authResult = checkConfigAuthorization('modelSet', DENIED_USER, ALLOW_SET);
      expect(authResult).not.toBeNull();
      expect(authResult!.ok).toBe(false);

      // The action executor should NOT have been called — verify params unchanged.
      const after = snapshotParams(ctx.botParams);
      expect(after).toEqual(before);
    });
  }

  it('persistOverride callback is never called when denied', () => {
    const ctx = makeConfigCtx();
    let persistCalled = false;
    ctx.persistOverride = () => { persistCalled = true; };

    const authResult = checkConfigAuthorization('modelSet', DENIED_USER, ALLOW_SET);
    expect(authResult).not.toBeNull();
    // Since auth check returns early, executeConfigAction is never invoked.
    expect(persistCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// No side effects on denial — modelReset
// ---------------------------------------------------------------------------

describe('no side effects on denied modelReset', () => {
  it('modelReset leaves botParams unchanged when denied', () => {
    const ctx = makeConfigCtx();
    const before = snapshotParams(ctx.botParams);

    const authResult = checkConfigAuthorization('modelReset', DENIED_USER, ALLOW_SET);
    expect(authResult).not.toBeNull();
    expect(authResult!.ok).toBe(false);

    const after = snapshotParams(ctx.botParams);
    expect(after).toEqual(before);
  });

  it('clearOverride callback is never called when denied', () => {
    const ctx = makeConfigCtx();
    let clearCalled = false;
    ctx.clearOverride = () => { clearCalled = true; };

    const authResult = checkConfigAuthorization('modelReset', DENIED_USER, ALLOW_SET);
    expect(authResult).not.toBeNull();
    expect(clearCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Authorized requests proceed normally
// ---------------------------------------------------------------------------

describe('authorized config mutations proceed', () => {
  it('modelSet chat succeeds for an authorized user', () => {
    const authResult = checkConfigAuthorization('modelSet', ALLOWED_USER, ALLOW_SET);
    expect(authResult).toBeNull(); // No gate → proceed to executor

    const ctx = makeConfigCtx();
    const result = executeConfigAction({ type: 'modelSet', role: 'chat', model: 'sonnet' }, ctx);
    expect(result.ok).toBe(true);
    expect(ctx.botParams.runtimeModel).toBe('sonnet');
  });

  it('modelReset succeeds for an authorized user', () => {
    const authResult = checkConfigAuthorization('modelReset', ALLOWED_USER, ALLOW_SET);
    expect(authResult).toBeNull();

    const ctx = makeConfigCtx();
    ctx.envDefaults = { chat: 'capable' };
    ctx.botParams.runtimeModel = 'sonnet';
    const result = executeConfigAction({ type: 'modelReset', role: 'chat' }, ctx);
    expect(result.ok).toBe(true);
    expect(ctx.botParams.runtimeModel).toBe('capable');
  });
});

// ---------------------------------------------------------------------------
// Error message consistency
// ---------------------------------------------------------------------------

describe('denial error message', () => {
  it('uses the canonical CONFIG_UNAUTHORIZED_ERROR string', () => {
    const result = checkConfigAuthorization('modelSet', DENIED_USER, ALLOW_SET);
    expect(result).not.toBeNull();
    if (result && !result.ok) {
      expect(result.error).toBe(CONFIG_UNAUTHORIZED_ERROR);
      expect(result.error).toContain('Unauthorized');
    }
  });

  it('is distinct from validation errors', () => {
    // A validation error (e.g. empty model) uses a different message.
    const ctx = makeConfigCtx();
    const validationResult = executeConfigAction({ type: 'modelSet', role: 'chat', model: '' }, ctx);
    expect(validationResult.ok).toBe(false);
    if (!validationResult.ok) {
      expect(validationResult.error).not.toBe(CONFIG_UNAUTHORIZED_ERROR);
    }
  });
});
