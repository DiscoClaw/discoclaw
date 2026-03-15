import { describe, expect, it } from 'vitest';
import { RuntimeRegistry } from './registry.js';
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

describe('RuntimeRegistry', () => {
  it('register + get returns the adapter', () => {
    const registry = new RuntimeRegistry();
    const adapter = makeMockAdapter('openai');
    registry.register('openai', adapter);
    expect(registry.get('openai')).toBe(adapter);
  });

  it('get for unknown name returns undefined', () => {
    const registry = new RuntimeRegistry();
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('list returns registered names', () => {
    const registry = new RuntimeRegistry();
    registry.register('claude', makeMockAdapter('claude_code'));
    registry.register('openai', makeMockAdapter('openai'));
    expect(registry.list()).toEqual(['claude', 'openai']);
  });

  it('has returns correct boolean', () => {
    const registry = new RuntimeRegistry();
    registry.register('claude', makeMockAdapter('claude_code'));
    expect(registry.has('claude')).toBe(true);
    expect(registry.has('openai')).toBe(false);
  });

  it('registering the same name twice overwrites silently', () => {
    const registry = new RuntimeRegistry();
    const first = makeMockAdapter('openai');
    const second = makeMockAdapter('openai');
    registry.register('openai', first);
    registry.register('openai', second);
    expect(registry.get('openai')).toBe(second);
    expect(registry.list()).toEqual(['openai']);
  });
});
