import { afterEach, describe, expect, it } from 'vitest';

import {
  findRuntimeForModel,
  initTierOverrides,
  isModelTier,
  remapCrossRuntimeTierModel,
  resolveModel,
  resolveReasoningEffort,
} from './model-tiers.js';
import type { RuntimeId } from './types.js';

describe('isModelTier', () => {
  it('returns true for known tiers', () => {
    expect(isModelTier('fast')).toBe(true);
    expect(isModelTier('capable')).toBe(true);
  });

  it('returns false for legacy tier names', () => {
    expect(isModelTier('haiku')).toBe(false);
    expect(isModelTier('opus')).toBe(false);
  });

  it('returns false for arbitrary strings', () => {
    expect(isModelTier('')).toBe(false);
    expect(isModelTier('claude-sonnet-4-5-20250929')).toBe(false);
  });
});

describe('resolveModel', () => {
  describe('claude_code runtime', () => {
    it('resolves fast → haiku', () => {
      expect(resolveModel('fast', 'claude_code')).toBe('haiku');
    });

    it('resolves capable → claude-opus-4-6', () => {
      expect(resolveModel('capable', 'claude_code')).toBe('claude-opus-4-6');
    });
  });

  describe('openai runtime', () => {
    it('resolves fast → gpt-5-mini', () => {
      expect(resolveModel('fast', 'openai')).toBe('gpt-5-mini');
    });

    it('resolves capable → gpt-5.4', () => {
      expect(resolveModel('capable', 'openai')).toBe('gpt-5.4');
    });

    it('resolves deep → gpt-5.4-pro', () => {
      expect(resolveModel('deep', 'openai')).toBe('gpt-5.4-pro');
    });
  });

  describe('codex runtime', () => {
    it('resolves fast → gpt-5.1-codex-mini', () => {
      expect(resolveModel('fast', 'codex')).toBe('gpt-5.1-codex-mini');
    });

    it('resolves capable → gpt-5.4', () => {
      expect(resolveModel('capable', 'codex')).toBe('gpt-5.4');
    });

    it('resolves deep → gpt-5.4', () => {
      expect(resolveModel('deep', 'codex')).toBe('gpt-5.4');
    });
  });

  describe('gemini runtime', () => {
    it('resolves fast → gemini-2.5-flash', () => {
      expect(resolveModel('fast', 'gemini')).toBe('gemini-2.5-flash');
    });

    it('resolves capable → gemini-2.5-pro', () => {
      expect(resolveModel('capable', 'gemini')).toBe('gemini-2.5-pro');
    });
  });

  describe('unknown runtimes (other)', () => {
    it('resolves tiers to empty string', () => {
      expect(resolveModel('fast', 'other')).toBe('');
      expect(resolveModel('capable', 'other')).toBe('');
    });
  });

  describe('passthrough for non-tier strings', () => {
    it('passes through legacy model names', () => {
      expect(resolveModel('haiku', 'claude_code')).toBe('haiku');
      expect(resolveModel('opus', 'claude_code')).toBe('opus');
    });

    it('passes through full model identifiers', () => {
      expect(resolveModel('claude-sonnet-4-5-20250929', 'claude_code')).toBe(
        'claude-sonnet-4-5-20250929',
      );
      expect(resolveModel('gpt-4o', 'openai')).toBe('gpt-4o');
    });

    it('passes through empty string', () => {
      expect(resolveModel('', 'claude_code')).toBe('');
    });
  });
});

describe('initTierOverrides', () => {
  afterEach(() => {
    initTierOverrides({});
  });

  it('overrides a specific runtime+tier', () => {
    initTierOverrides({ DISCOCLAW_TIER_CLAUDE_CODE_FAST: 'sonnet' });
    expect(resolveModel('fast', 'claude_code')).toBe('sonnet');
  });

  it('leaves unrelated tiers and runtimes at their defaults', () => {
    initTierOverrides({ DISCOCLAW_TIER_CLAUDE_CODE_FAST: 'sonnet' });
    expect(resolveModel('capable', 'claude_code')).toBe('claude-opus-4-6');
    expect(resolveModel('fast', 'gemini')).toBe('gemini-2.5-flash');
    expect(resolveModel('capable', 'gemini')).toBe('gemini-2.5-pro');
  });

  it('accepts unknown runtimes and creates new map entries', () => {
    initTierOverrides({ DISCOCLAW_TIER_MYRUNTIME_FAST: 'my-model' });
    expect(resolveModel('fast', 'myruntime' as RuntimeId)).toBe('my-model');
  });

  it('is idempotent — second call replaces the first, does not accumulate', () => {
    initTierOverrides({ DISCOCLAW_TIER_CLAUDE_CODE_FAST: 'sonnet' });
    initTierOverrides({ DISCOCLAW_TIER_CLAUDE_CODE_CAPABLE: 'sonnet' });
    // First override must be gone; default restored for fast
    expect(resolveModel('fast', 'claude_code')).toBe('haiku');
    expect(resolveModel('capable', 'claude_code')).toBe('sonnet'); // overridden to sonnet
  });

  it('restores defaults when called with no matching env vars', () => {
    initTierOverrides({ DISCOCLAW_TIER_CLAUDE_CODE_FAST: 'sonnet' });
    initTierOverrides({});
    expect(resolveModel('fast', 'claude_code')).toBe('haiku');
    expect(resolveModel('capable', 'claude_code')).toBe('claude-opus-4-6');
  });

  it('ignores env vars with unrecognised tier suffixes', () => {
    initTierOverrides({ DISCOCLAW_TIER_CLAUDE_CODE_UNKNOWN: 'sonnet' });
    expect(resolveModel('fast', 'claude_code')).toBe('haiku');
  });
});

describe('resolveReasoningEffort', () => {
  it('returns high for codex capable tier', () => {
    expect(resolveReasoningEffort('capable', 'codex')).toBe('high');
  });

  it('returns xhigh for codex deep tier', () => {
    expect(resolveReasoningEffort('deep', 'codex')).toBe('xhigh');
  });

  it('returns undefined for codex fast tier (no effort on fast models)', () => {
    expect(resolveReasoningEffort('fast', 'codex')).toBeUndefined();
  });

  it('returns undefined for claude_code fast tier (no effort on fast models)', () => {
    expect(resolveReasoningEffort('fast', 'claude_code')).toBeUndefined();
  });

  it('returns medium for claude_code capable tier', () => {
    expect(resolveReasoningEffort('capable', 'claude_code')).toBe('medium');
  });

  it('returns high for claude_code deep tier', () => {
    expect(resolveReasoningEffort('deep', 'claude_code')).toBe('high');
  });

  it('returns undefined for runtimes without effort mappings', () => {
    expect(resolveReasoningEffort('deep', 'openai')).toBeUndefined();
  });

  it('returns undefined for non-tier strings', () => {
    expect(resolveReasoningEffort('o3', 'codex')).toBeUndefined();
    expect(resolveReasoningEffort('', 'codex')).toBeUndefined();
  });
});

describe('findRuntimeForModel', () => {
  afterEach(() => {
    initTierOverrides({});
  });

  it('returns the owning runtime when a model is unique to one tier map', () => {
    expect(findRuntimeForModel('haiku')).toBe('claude_code');
    expect(findRuntimeForModel('gemini-2.5-pro')).toBe('gemini');
  });

  it('returns undefined when no runtime claims the model', () => {
    expect(findRuntimeForModel('some-custom-model')).toBeUndefined();
  });

  it('returns undefined when multiple runtimes claim the same model', () => {
    expect(findRuntimeForModel('gpt-5.4')).toBeUndefined();
  });

  it('supports env-defined runtime maps when ownership is unique', () => {
    initTierOverrides({ DISCOCLAW_TIER_OPENROUTER_FAST: 'openai/gpt-5-mini' });
    expect(findRuntimeForModel('openai/gpt-5-mini')).toBe('openrouter');
  });

  it('returns undefined when an env override makes ownership ambiguous', () => {
    initTierOverrides({ DISCOCLAW_TIER_OPENROUTER_FAST: 'gpt-5-mini' });
    expect(findRuntimeForModel('gpt-5-mini')).toBeUndefined();
  });

  it('infers claude ownership for legacy family aliases', () => {
    expect(findRuntimeForModel('haiku')).toBe('claude_code');
    expect(findRuntimeForModel('sonnet')).toBe('claude_code');
    expect(findRuntimeForModel('opus')).toBe('claude_code');
  });

  it('infers claude ownership for full claude model identifiers', () => {
    expect(findRuntimeForModel('claude-sonnet-4-5-20250929')).toBe('claude_code');
    expect(findRuntimeForModel('claude-haiku-4-5-20251001')).toBe('claude_code');
  });

  it('infers openrouter ownership for provider-prefixed model identifiers', () => {
    expect(findRuntimeForModel('anthropic/claude-sonnet-4')).toBe('openrouter');
    expect(findRuntimeForModel('openai/gpt-5-mini')).toBe('openrouter');
  });

  it('infers openai ownership for openai-only model families outside the tier map', () => {
    expect(findRuntimeForModel('gpt-4o')).toBe('openai');
    expect(findRuntimeForModel('o3-mini')).toBe('openai');
  });

  it('keeps exact ambiguity ahead of heuristic ownership inference', () => {
    initTierOverrides({
      DISCOCLAW_TIER_CLAUDE_CODE_FAST: 'sonnet',
      DISCOCLAW_TIER_OPENROUTER_FAST: 'sonnet',
    });
    expect(findRuntimeForModel('sonnet')).toBeUndefined();
  });
});

describe('remapCrossRuntimeTierModel', () => {
  afterEach(() => {
    initTierOverrides({});
  });

  it('maps openai fast-tier defaults onto codex fast-tier defaults', () => {
    expect(remapCrossRuntimeTierModel('gpt-5-mini', 'codex')).toEqual({
      sourceRuntimeId: 'openai',
      sourceTier: 'fast',
      targetRuntimeId: 'codex',
      model: 'gpt-5.1-codex-mini',
    });
  });

  it('maps openai deep-tier defaults onto codex deep-tier defaults', () => {
    expect(remapCrossRuntimeTierModel('gpt-5.4-pro', 'codex')).toEqual({
      sourceRuntimeId: 'openai',
      sourceTier: 'deep',
      targetRuntimeId: 'codex',
      model: 'gpt-5.4',
    });
  });

  it('does not remap ambiguous cross-runtime models', () => {
    expect(remapCrossRuntimeTierModel('gpt-5.4', 'codex')).toBeNull();
  });

  it('does not remap arbitrary literal models outside the tier map', () => {
    expect(remapCrossRuntimeTierModel('gpt-4o', 'codex')).toBeNull();
  });
});
