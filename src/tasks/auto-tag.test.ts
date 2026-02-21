import { describe, expect, it, vi } from 'vitest';
import { autoTagTask } from './auto-tag.js';
import type { TaskRuntimeAdapter } from './runtime-types.js';

function makeMockRuntime(output: string): TaskRuntimeAdapter {
  return {
    id: 'other',
    capabilities: new Set(),
    async *invoke() {
      yield { type: 'text_final' as const, text: output };
    },
  };
}

function makeMockErrorRuntime(): TaskRuntimeAdapter {
  return {
    id: 'other',
    capabilities: new Set(),
    async *invoke() {
      yield { type: 'error' as const, message: 'fail' };
    },
  };
}

const TAGS = ['feature', 'bug', 'personal', 'work', 'urgent'];

describe('autoTagTask', () => {
  it('returns valid tags from AI output', async () => {
    const runtime = makeMockRuntime('feature, personal');
    const result = await autoTagTask(runtime, 'Add login', 'New feature', TAGS);
    expect(result).toEqual(['feature', 'personal']);
  });

  it('drops unknown tags silently', async () => {
    const runtime = makeMockRuntime('feature, nonexistent, bug');
    const result = await autoTagTask(runtime, 'Fix crash', '', TAGS);
    expect(result).toEqual(['feature', 'bug']);
  });

  it('limits to 3 tags', async () => {
    const runtime = makeMockRuntime('feature, bug, personal, work, urgent');
    const result = await autoTagTask(runtime, 'Big task', '', TAGS);
    expect(result).toHaveLength(3);
  });

  it('handles case-insensitive matching', async () => {
    const runtime = makeMockRuntime('Feature, BUG');
    const result = await autoTagTask(runtime, 'Test', '', TAGS);
    expect(result).toEqual(['feature', 'bug']);
  });

  it('returns empty on runtime error', async () => {
    const runtime = makeMockErrorRuntime();
    const result = await autoTagTask(runtime, 'Test', '', TAGS);
    expect(result).toEqual([]);
  });

  it('returns empty when no available tags', async () => {
    const runtime = makeMockRuntime('feature');
    const result = await autoTagTask(runtime, 'Test', '', []);
    expect(result).toEqual([]);
  });

  it('handles empty AI output', async () => {
    const runtime = makeMockRuntime('');
    const result = await autoTagTask(runtime, 'Test', '', TAGS);
    expect(result).toEqual([]);
  });

  it('uses injected model resolver when provided', async () => {
    const runtime = makeMockRuntime('feature');
    const resolve = vi.fn((model: string) => `resolved-${model}`);
    await autoTagTask(runtime, 'Test', '', TAGS, { model: 'fast', modelResolver: resolve });
    expect(resolve).toHaveBeenCalledWith('fast', runtime.id);
  });
});
