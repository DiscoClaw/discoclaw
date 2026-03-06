import { afterEach, describe, expect, it } from 'vitest';

import { initTierOverrides, isModelTier, resolveModel, resolveReasoningEffort } from './model-tiers.js';
import type { ModelTier } from './model-tiers.js';
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

    it('resolves capable → sonnet', () => {
      expect(resolveModel('capable', 'claude_code')).toBe('sonnet');
    });
  });

  describe('openai runtime', () => {
    it('resolves tiers to empty string (adapter-default)', () => {
      expect(resolveModel('fast', 'openai')).toBe('');
      expect(resolveModel('capable', 'openai')).toBe('');
    });
  });

  describe('codex runtime', () => {
    it('resolves fast → gpt-5.1-codex-mini', () => {
      expect(resolveModel('fast', 'codex')).toBe('gpt-5.1-codex-mini');
    });

    it('resolves capable/deep to empty string (adapter-default)', () => {
      expect(resolveModel('capable', 'codex')).toBe('');
      expect(resolveModel('deep', 'codex')).toBe('');
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
    expect(resolveModel('capable', 'claude_code')).toBe('sonnet');
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
    expect(resolveModel('capable', 'claude_code')).toBe('sonnet');
  });

  it('restores defaults when called with no matching env vars', () => {
    initTierOverrides({ DISCOCLAW_TIER_CLAUDE_CODE_FAST: 'sonnet' });
    initTierOverrides({});
    expect(resolveModel('fast', 'claude_code')).toBe('haiku');
    expect(resolveModel('capable', 'claude_code')).toBe('sonnet');
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

  it('returns low for codex fast tier', () => {
    expect(resolveReasoningEffort('fast', 'codex')).toBe('low');
  });

  it('returns low for claude_code fast tier', () => {
    expect(resolveReasoningEffort('fast', 'claude_code')).toBe('low');
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
