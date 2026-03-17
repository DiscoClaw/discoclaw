// ── Frozen fixture integration test ─────────────────────────────────
//
// Validates that every JSON file in test-suites/action-compliance/
// loads, parses, and passes schema validation.
// Also verifies IDs are globally unique and counts meet expectations.

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { loadTestCasesFromDir, filterByTags } from './loader.js';

const SUITES_DIR = join(import.meta.dirname, '../../test-suites/action-compliance');

describe('frozen action-compliance fixtures', () => {
  it('loads all fixtures without validation errors', async () => {
    const cases = await loadTestCasesFromDir(SUITES_DIR);
    expect(cases.length).toBeGreaterThanOrEqual(90);
  });

  it('all IDs are unique', async () => {
    const cases = await loadTestCasesFromDir(SUITES_DIR);
    const ids = cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every case has at least one expectedAction', async () => {
    const cases = await loadTestCasesFromDir(SUITES_DIR);
    for (const c of cases) {
      expect(c.expectedActions.length, `${c.id} has no expectedActions`).toBeGreaterThan(0);
    }
  });

  it('every case has a non-empty prompt', async () => {
    const cases = await loadTestCasesFromDir(SUITES_DIR);
    for (const c of cases) {
      expect(c.prompt.length, `${c.id} has empty prompt`).toBeGreaterThan(0);
    }
  });

  it('every case has tags', async () => {
    const cases = await loadTestCasesFromDir(SUITES_DIR);
    for (const c of cases) {
      expect(c.tags, `${c.id} missing tags`).toBeDefined();
      expect(c.tags!.length, `${c.id} has empty tags`).toBeGreaterThan(0);
    }
  });

  it('filterByTags works on loaded fixtures', async () => {
    const cases = await loadTestCasesFromDir(SUITES_DIR);
    const messaging = filterByTags(cases, ['messaging']);
    expect(messaging.length).toBeGreaterThan(0);
    for (const c of messaging) {
      expect(c.tags).toContain('messaging');
    }
  });

  it('covers multiple action categories', async () => {
    const cases = await loadTestCasesFromDir(SUITES_DIR);
    const allTags = new Set(cases.flatMap((c) => c.tags ?? []));
    // Verify we cover the major categories
    for (const tag of ['messaging', 'channels', 'guild', 'moderation', 'tasks', 'memory', 'config', 'crons', 'plans', 'voice', 'events', 'deferred', 'reaction-prompts']) {
      expect(allTags.has(tag), `missing tag category: ${tag}`).toBe(true);
    }
  });
});
