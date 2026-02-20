import { describe, expect, it } from 'vitest';
import { autoTagBead } from './auto-tag.js';
import { autoTagTask } from '../tasks/auto-tag.js';
import type { RuntimeAdapter } from '../runtime/types.js';

function makeMockRuntime(output: string): RuntimeAdapter {
  return {
    id: 'other',
    capabilities: new Set(),
    async *invoke() {
      yield { type: 'text_final' as const, text: output };
    },
  };
}

function makeMockErrorRuntime(): RuntimeAdapter {
  return {
    id: 'other',
    capabilities: new Set(),
    async *invoke() {
      yield { type: 'error' as const, message: 'fail' };
    },
  };
}

const TAGS = ['feature', 'bug', 'personal', 'work', 'urgent'];

describe('autoTagBead', () => {
  it('returns valid tags from AI output', async () => {
    const runtime = makeMockRuntime('feature, personal');
    const result = await autoTagBead(runtime, 'Add login', 'New feature', TAGS);
    expect(result).toEqual(['feature', 'personal']);
  });

  it('drops unknown tags silently', async () => {
    const runtime = makeMockRuntime('feature, nonexistent, bug');
    const result = await autoTagBead(runtime, 'Fix crash', '', TAGS);
    expect(result).toEqual(['feature', 'bug']);
  });

  it('limits to 3 tags', async () => {
    const runtime = makeMockRuntime('feature, bug, personal, work, urgent');
    const result = await autoTagBead(runtime, 'Big task', '', TAGS);
    expect(result).toHaveLength(3);
  });

  it('handles case-insensitive matching', async () => {
    const runtime = makeMockRuntime('Feature, BUG');
    const result = await autoTagBead(runtime, 'Test', '', TAGS);
    expect(result).toEqual(['feature', 'bug']);
  });

  it('returns empty on runtime error', async () => {
    const runtime = makeMockErrorRuntime();
    const result = await autoTagBead(runtime, 'Test', '', TAGS);
    expect(result).toEqual([]);
  });

  it('returns empty when no available tags', async () => {
    const runtime = makeMockRuntime('feature');
    const result = await autoTagBead(runtime, 'Test', '', []);
    expect(result).toEqual([]);
  });

  it('handles empty AI output', async () => {
    const runtime = makeMockRuntime('');
    const result = await autoTagBead(runtime, 'Test', '', TAGS);
    expect(result).toEqual([]);
  });

  it('keeps bead compatibility export aligned to canonical task helper', () => {
    expect(autoTagBead).toBe(autoTagTask);
  });
});
