import { describe, expect, it, beforeEach } from 'vitest';
import { inferModelTier, filterToolsByTier, initToolTierOverrides } from './tool-tiers.js';

describe('inferModelTier', () => {
  beforeEach(() => {
    initToolTierOverrides({});
  });

  describe('Claude models', () => {
    it('classifies haiku as basic', () => {
      expect(inferModelTier('haiku')).toBe('basic');
      expect(inferModelTier('claude-haiku-4-5-20251001')).toBe('basic');
    });

    it('classifies sonnet as standard', () => {
      expect(inferModelTier('sonnet')).toBe('standard');
      expect(inferModelTier('claude-sonnet-4-5-20250929')).toBe('standard');
    });

    it('classifies opus as full', () => {
      expect(inferModelTier('opus')).toBe('full');
      expect(inferModelTier('claude-opus-4-6')).toBe('full');
    });
  });

  describe('Gemini models', () => {
    it('classifies flash as basic', () => {
      expect(inferModelTier('gemini-2.5-flash')).toBe('basic');
      expect(inferModelTier('gemini-2.0-flash-lite')).toBe('basic');
    });

    it('classifies pro as full', () => {
      expect(inferModelTier('gemini-2.5-pro')).toBe('full');
    });
  });

  describe('OpenAI models', () => {
    it('classifies gpt-4o-mini as basic', () => {
      expect(inferModelTier('gpt-4o-mini')).toBe('basic');
    });

    it('classifies o-series mini as basic', () => {
      expect(inferModelTier('o1-mini')).toBe('basic');
      expect(inferModelTier('o3-mini')).toBe('basic');
    });
  });

  describe('defaults', () => {
    it('defaults to full for unknown models', () => {
      expect(inferModelTier('some-custom-model')).toBe('full');
      expect(inferModelTier('gpt-4o')).toBe('full');
    });

    it('defaults to full for empty string', () => {
      expect(inferModelTier('')).toBe('full');
    });
  });

  describe('env var overrides', () => {
    it('overrides opus to standard via DISCOCLAW_TOOL_TIER_MAP', () => {
      initToolTierOverrides({ DISCOCLAW_TOOL_TIER_MAP: 'opus=standard' });
      expect(inferModelTier('opus')).toBe('standard');
    });

    it('supports multiple overrides', () => {
      initToolTierOverrides({ DISCOCLAW_TOOL_TIER_MAP: 'haiku=full,sonnet=basic' });
      expect(inferModelTier('haiku')).toBe('full');
      expect(inferModelTier('sonnet')).toBe('basic');
    });

    it('matches overrides as substrings of full model names', () => {
      initToolTierOverrides({ DISCOCLAW_TOOL_TIER_MAP: 'opus=standard' });
      expect(inferModelTier('claude-opus-4-6')).toBe('standard');
    });

    it('ignores invalid tiers in env var', () => {
      initToolTierOverrides({ DISCOCLAW_TOOL_TIER_MAP: 'haiku=invalid,sonnet=basic' });
      // haiku ignored (invalid tier), falls back to pattern
      expect(inferModelTier('haiku')).toBe('basic');
      // sonnet override is valid
      expect(inferModelTier('sonnet')).toBe('basic');
    });

    it('resets overrides on re-init', () => {
      initToolTierOverrides({ DISCOCLAW_TOOL_TIER_MAP: 'opus=basic' });
      expect(inferModelTier('opus')).toBe('basic');
      initToolTierOverrides({});
      expect(inferModelTier('opus')).toBe('full');
    });
  });
});

describe('filterToolsByTier', () => {
  const allTools = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];

  it('returns all tools unchanged for full tier', () => {
    const result = filterToolsByTier(allTools, 'full');
    expect(result.tools).toEqual(allTools);
    expect(result.dropped).toEqual([]);
  });

  it('drops Bash and Write for standard tier', () => {
    const result = filterToolsByTier(allTools, 'standard');
    expect(result.tools).toEqual(['Read', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch']);
    expect(result.dropped).toEqual(['Bash', 'Write']);
  });

  it('drops Bash, Write, and Edit for basic tier', () => {
    const result = filterToolsByTier(allTools, 'basic');
    expect(result.tools).toEqual(['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch']);
    expect(result.dropped).toEqual(['Bash', 'Write', 'Edit']);
  });

  it('passes through unknown/custom tools on all tiers including basic', () => {
    const tools = ['Read', 'CustomTool', 'MyPlugin'];
    const basicResult = filterToolsByTier(tools, 'basic');
    expect(basicResult.tools).toEqual(['Read', 'CustomTool', 'MyPlugin']);
    expect(basicResult.dropped).toEqual([]);

    const standardResult = filterToolsByTier(tools, 'standard');
    expect(standardResult.tools).toEqual(['Read', 'CustomTool', 'MyPlugin']);
    expect(standardResult.dropped).toEqual([]);

    const fullResult = filterToolsByTier(tools, 'full');
    expect(fullResult.tools).toEqual(['Read', 'CustomTool', 'MyPlugin']);
    expect(fullResult.dropped).toEqual([]);
  });

  it('returns empty arrays when no tools match basic tier', () => {
    const result = filterToolsByTier(['Bash', 'Write', 'Edit'], 'basic');
    expect(result.tools).toEqual([]);
    expect(result.dropped).toEqual(['Bash', 'Write', 'Edit']);
  });

  it('handles empty tools array', () => {
    const result = filterToolsByTier([], 'basic');
    expect(result.tools).toEqual([]);
    expect(result.dropped).toEqual([]);
  });

  it('preserves original array order', () => {
    const result = filterToolsByTier(['Grep', 'WebFetch', 'Read'], 'basic');
    expect(result.tools).toEqual(['Grep', 'WebFetch', 'Read']);
  });
});
