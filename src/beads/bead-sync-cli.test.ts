import { describe, expect, it, vi } from 'vitest';
import { parseArgInt, runSyncWithStore } from './bead-sync-cli.js';
import {
  parseArgInt as parseTaskArgInt,
  runSyncWithStore as runTaskSyncWithStoreCompat,
} from '../tasks/task-sync-cli.js';

vi.mock('../tasks/bead-sync.js', () => ({
  runBeadSync: vi.fn().mockResolvedValue({ created: 0, updated: 0, closed: 0 }),
}));

// bead-sync-cli.ts uses an import.meta.url guard so that main() does NOT run
// when the module is imported (only when invoked as a script). This lets us
// import and test the exported helpers without triggering Discord connections
// or env-var validation.

describe('parseArgInt', () => {
  it('keeps compatibility exports aligned to canonical task sync CLI module', () => {
    expect(parseArgInt).toBe(parseTaskArgInt);
    expect(runSyncWithStore).toBe(runTaskSyncWithStoreCompat);
  });

  it('returns undefined when the flag is not in args', () => {
    expect(parseArgInt(['--foo', '1'], '--bar')).toBeUndefined();
  });

  it('returns undefined for an empty args array', () => {
    expect(parseArgInt([], '--throttle-ms')).toBeUndefined();
  });

  it('parses a positive integer', () => {
    expect(parseArgInt(['--throttle-ms', '500'], '--throttle-ms')).toBe(500);
  });

  it('parses zero', () => {
    expect(parseArgInt(['--throttle-ms', '0'], '--throttle-ms')).toBe(0);
  });

  it('parses a negative integer', () => {
    expect(parseArgInt(['--limit', '-1'], '--limit')).toBe(-1);
  });

  it('parses a decimal value', () => {
    expect(parseArgInt(['--throttle-ms', '2.5'], '--throttle-ms')).toBe(2.5);
  });

  it('finds the flag among mixed args', () => {
    expect(parseArgInt(['--archived-limit', '200', '--throttle-ms', '100'], '--throttle-ms')).toBe(100);
  });

  it('returns the value for the first occurrence when the flag appears more than once', () => {
    expect(parseArgInt(['--limit', '10', '--limit', '20'], '--limit')).toBe(10);
  });

  it('throws when the flag is present but no value follows', () => {
    expect(() => parseArgInt(['--throttle-ms'], '--throttle-ms')).toThrow('--throttle-ms requires a value');
  });

  it('throws when the value is a non-numeric string', () => {
    expect(() => parseArgInt(['--limit', 'abc'], '--limit')).toThrow('--limit must be a number');
  });

  it('throws when the value is "NaN"', () => {
    expect(() => parseArgInt(['--limit', 'NaN'], '--limit')).toThrow('must be a number');
  });

  it('throws when the value is "Infinity"', () => {
    expect(() => parseArgInt(['--limit', 'Infinity'], '--limit')).toThrow('must be a number');
  });
});

describe('runSyncWithStore', () => {
  it('passes store through to runBeadSync', async () => {
    const { runBeadSync } = await import('../tasks/bead-sync.js');
    const { TaskStore } = await import('../tasks/store.js');

    const store = new TaskStore();
    const fakeClient = {} as any;
    const fakeGuild = {} as any;

    await runSyncWithStore({
      client: fakeClient,
      guild: fakeGuild,
      forumId: 'forum-123',
      tagMap: {},
      store,
      throttleMs: 100,
      archivedDedupeLimit: 50,
    });

    expect(runBeadSync).toHaveBeenCalledWith(
      expect.objectContaining({ store }),
    );
  });
});
