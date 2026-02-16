import { describe, expect, it } from 'vitest';

import { isModelTier, resolveModel } from './model-tiers.js';
import type { ModelTier } from './model-tiers.js';

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

    it('resolves capable → opus', () => {
      expect(resolveModel('capable', 'claude_code')).toBe('opus');
    });
  });

  describe('openai runtime', () => {
    it('resolves tiers to empty string (adapter-default)', () => {
      expect(resolveModel('fast', 'openai')).toBe('');
      expect(resolveModel('capable', 'openai')).toBe('');
    });
  });

  describe('codex runtime', () => {
    it('resolves tiers to empty string (adapter-default)', () => {
      expect(resolveModel('fast', 'codex')).toBe('');
      expect(resolveModel('capable', 'codex')).toBe('');
    });
  });

  describe('unknown runtimes (gemini, other)', () => {
    it('resolves tiers to empty string', () => {
      expect(resolveModel('fast', 'gemini')).toBe('');
      expect(resolveModel('capable', 'gemini')).toBe('');
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
