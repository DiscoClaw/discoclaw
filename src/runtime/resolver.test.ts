import { describe, expect, it } from 'vitest';
import { RuntimeRegistry } from './registry.js';
import { resolvePrimaryRuntime } from './resolver.js';
import type { RuntimeAdapter, EngineEvent } from './types.js';

function makeMockAdapter(id: string): RuntimeAdapter {
  return {
    id: id as RuntimeAdapter['id'],
    capabilities: new Set(['streaming_text' as const]),
    invoke() {
      return (async function* (): AsyncGenerator<EngineEvent> {
        yield { type: 'text_final', text: '' };
        yield { type: 'done' };
      })();
    },
  };
}

function registryWith(...names: string[]): RuntimeRegistry {
  const reg = new RuntimeRegistry();
  for (const name of names) {
    reg.register(name, makeMockAdapter(name));
  }
  return reg;
}

describe('resolvePrimaryRuntime', () => {
  it('returns ok:true when the runtime is registered', () => {
    const reg = registryWith('claude-cli', 'openai');
    const result = resolvePrimaryRuntime('claude-cli', reg);
    expect(result.ok).toBe(true);
    expect(result.adapter).toBeDefined();
    expect(result.hint).toBeNull();
  });

  it('returns a renamed hint for "gemini"', () => {
    const reg = registryWith('claude-cli', 'gemini-api');
    const result = resolvePrimaryRuntime('gemini', reg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.hint?.kind).toBe('renamed');
      expect(result.message).toContain('renamed');
      expect(result.message).toContain('gemini-api');
    }
  });

  it('returns a removed hint for "gemini-cli"', () => {
    const reg = registryWith('claude-cli');
    const result = resolvePrimaryRuntime('gemini-cli', reg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.hint?.kind).toBe('removed');
      expect(result.message).toContain('removed');
      expect(result.message).toContain('TOS risk');
    }
  });

  it('returns a generic message for a completely unknown name', () => {
    const reg = registryWith('claude-cli', 'openai');
    const result = resolvePrimaryRuntime('nonexistent', reg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.hint).toBeNull();
      expect(result.message).toContain('not recognised');
      expect(result.message).toContain('claude-cli');
      expect(result.message).toContain('openai');
      expect(result.available).toEqual(['claude-cli', 'openai']);
    }
  });

  it('shows (none) when registry is empty', () => {
    const reg = new RuntimeRegistry();
    const result = resolvePrimaryRuntime('anything', reg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('(none)');
    }
  });
});
