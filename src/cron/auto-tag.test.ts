import { describe, expect, it } from 'vitest';
import { autoTagCron, classifyCronModel } from './auto-tag.js';
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

const TAGS = ['reporting', 'monitoring', 'cleanup', 'notifications', 'sync', 'backup', 'maintenance', 'analytics'];

describe('autoTagCron', () => {
  it('returns valid tags from AI output', async () => {
    const runtime = makeMockRuntime('monitoring, cleanup');
    const result = await autoTagCron(runtime, 'Daily Cleanup', 'Remove old logs', TAGS);
    expect(result).toEqual(['monitoring', 'cleanup']);
  });

  it('drops unknown tags', async () => {
    const runtime = makeMockRuntime('monitoring, unknown, backup');
    const result = await autoTagCron(runtime, 'Backup Job', 'Backup database', TAGS);
    expect(result).toEqual(['monitoring', 'backup']);
  });

  it('limits to 3 tags', async () => {
    const runtime = makeMockRuntime('monitoring, cleanup, backup, sync, analytics');
    const result = await autoTagCron(runtime, 'Big Job', 'Do many things', TAGS);
    expect(result).toHaveLength(3);
  });

  it('handles case-insensitive matching', async () => {
    const runtime = makeMockRuntime('Monitoring, CLEANUP');
    const result = await autoTagCron(runtime, 'Test', 'Test', TAGS);
    expect(result).toEqual(['monitoring', 'cleanup']);
  });

  it('returns empty on error', async () => {
    const result = await autoTagCron(makeMockErrorRuntime(), 'Test', 'Test', TAGS);
    expect(result).toEqual([]);
  });

  it('returns empty with no available tags', async () => {
    const result = await autoTagCron(makeMockRuntime('monitoring'), 'Test', 'Test', []);
    expect(result).toEqual([]);
  });

  it('returns empty for empty AI output', async () => {
    const result = await autoTagCron(makeMockRuntime(''), 'Test', 'Test', TAGS);
    expect(result).toEqual([]);
  });
});

describe('classifyCronModel', () => {
  it('returns fast for frequent cadence without AI call', async () => {
    // Even if runtime would say capable, frequent → fast.
    const runtime = makeMockRuntime('capable');
    const result = await classifyCronModel(runtime, 'Check', 'Check health', 'frequent');
    expect(result).toBe('fast');
  });

  it('returns fast for hourly cadence without AI call', async () => {
    const runtime = makeMockRuntime('capable');
    const result = await classifyCronModel(runtime, 'Check', 'Check health', 'hourly');
    expect(result).toBe('fast');
  });

  it('returns capable when AI says capable for daily cron', async () => {
    const runtime = makeMockRuntime('capable');
    const result = await classifyCronModel(runtime, 'Report', 'Write detailed analysis report', 'daily');
    expect(result).toBe('capable');
  });

  it('returns fast when AI says fast for daily cron', async () => {
    const runtime = makeMockRuntime('fast');
    const result = await classifyCronModel(runtime, 'Ping', 'Check if server is alive', 'daily');
    expect(result).toBe('fast');
  });

  it('defaults to fast on unclear AI response', async () => {
    const runtime = makeMockRuntime('maybe something');
    const result = await classifyCronModel(runtime, 'Test', 'Test', 'weekly');
    expect(result).toBe('fast');
  });

  it('defaults to fast on error', async () => {
    const result = await classifyCronModel(makeMockErrorRuntime(), 'Test', 'Test', 'daily');
    expect(result).toBe('fast');
  });

  it('defaults to fast on empty response', async () => {
    const result = await classifyCronModel(makeMockRuntime(''), 'Test', 'Test', 'monthly');
    expect(result).toBe('fast');
  });
});
