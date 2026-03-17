import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EngineEvent, RuntimeAdapter, RuntimeCapability, RuntimeId } from '../../runtime/types.js';
import type { FrozenTestCase, Ledger } from '../types.js';
import { loadTestCasesFromFile } from '../loader.js';
import { runSuite } from '../runner.js';
import { scoreBatch } from '../scorer.js';
import { loadLedger, shouldPromote, promote, saveLedger } from '../keeper.js';
import { formatConsoleTable, formatSummary } from '../reporter.js';

// ── Helpers ─────────────────────────────────────────────────────────

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `si-cli-int-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

/** Creates a mock adapter that returns canned text with discord-action blocks. */
function cannedAdapter(actionBlocks: string): RuntimeAdapter {
  return {
    id: 'other' as RuntimeId,
    capabilities: new Set<RuntimeCapability>(['streaming_text']),
    defaultModel: 'test-model',
    invoke: async function* () {
      yield { type: 'text_delta', text: actionBlocks } as EngineEvent;
      yield { type: 'done' } as EngineEvent;
    },
  };
}

// ── End-to-end integration ──────────────────────────────────────────

describe('cli integration (end-to-end)', () => {
  it('runs a fixture suite, scores, and promotes when improved', async () => {
    // 1. Write fixture suite
    const suiteDir = join(testDir, 'suite');
    await mkdir(suiteDir);
    const fixture: FrozenTestCase[] = [
      {
        id: 'int-1',
        prompt: 'list channels',
        expectedActions: [{ type: 'channelList' }],
      },
      {
        id: 'int-2',
        prompt: 'send hello to general',
        expectedActions: [{ type: 'sendMessage', params: { channel: 'general' } }],
      },
    ];
    await writeFile(join(suiteDir, 'cases.json'), JSON.stringify(fixture));

    // 2. Write target instruction file
    const targetPath = join(testDir, 'instructions.md');
    const originalInstructions = 'You are a helpful assistant.';
    await writeFile(targetPath, originalInstructions);

    // 3. Set up ledger path
    const ledgerPath = join(testDir, 'instructions.md.ledger.json');

    // 4. Load test cases from fixture
    const testCases = await loadTestCasesFromFile(join(suiteDir, 'cases.json'));
    expect(testCases).toHaveLength(2);

    // 5. Create adapter that returns matching actions
    const adapter = cannedAdapter(
      '<discord-action>{"type":"channelList"}</discord-action>\n' +
        '<discord-action>{"type":"sendMessage","channel":"general"}</discord-action>',
    );

    // 6. Run suite
    const instructions = await readFile(targetPath, 'utf-8');
    const { results: runResults, actionsMap } = await runSuite(testCases, instructions, adapter);
    expect(runResults).toHaveLength(2);
    expect(actionsMap.size).toBe(2);

    // 7. Score
    const { results: scoreResults, meanScore } = scoreBatch(testCases, actionsMap);
    expect(scoreResults).toHaveLength(2);
    expect(meanScore).toBeGreaterThan(0);

    // 8. Report (verify no crashes)
    const table = formatConsoleTable(scoreResults, meanScore);
    expect(table).toContain('int-1');
    expect(table).toContain('int-2');
    const summary = formatSummary(meanScore, 0, true);
    expect(summary).toContain('Score:');

    // 9. Check promotion logic
    const ledger = await loadLedger(ledgerPath);
    expect(ledger.bestScore).toBe(0); // default
    expect(shouldPromote(ledger, meanScore)).toBe(true);

    // 10. Promote with mutated text
    const mutatedInstructions = 'You are an improved assistant.';
    const updated = await promote(targetPath, mutatedInstructions, ledgerPath, meanScore);
    expect(updated.bestScore).toBe(meanScore);
    expect(updated.iteration).toBe(1);

    // 11. Verify target file was replaced
    const newContent = await readFile(targetPath, 'utf-8');
    expect(newContent).toBe(mutatedInstructions);

    // 12. Verify ledger persisted
    const persistedLedger = await loadLedger(ledgerPath);
    expect(persistedLedger.bestScore).toBe(meanScore);
    expect(persistedLedger.iteration).toBe(1);
  });

  it('does not promote when score does not improve', async () => {
    // Set up fixture with one test case
    const suiteDir = join(testDir, 'suite-no-promote');
    await mkdir(suiteDir);
    const fixture: FrozenTestCase[] = [
      { id: 'np-1', prompt: 'list channels', expectedActions: [{ type: 'channelList' }] },
    ];
    await writeFile(join(suiteDir, 'cases.json'), JSON.stringify(fixture));

    const targetPath = join(testDir, 'target.md');
    const ledgerPath = join(testDir, 'target.ledger.json');
    await writeFile(targetPath, 'original text');

    // Pre-seed ledger with a high score
    await saveLedger(ledgerPath, { bestScore: 1.0, iteration: 5, promotedAt: '2025-01-01T00:00:00.000Z' });

    const testCases = await loadTestCasesFromFile(join(suiteDir, 'cases.json'));

    // Adapter returns a non-matching action → low score
    const adapter = cannedAdapter('<discord-action>{"type":"sendMessage"}</discord-action>');

    const instructions = await readFile(targetPath, 'utf-8');
    const { actionsMap } = await runSuite(testCases, instructions, adapter);
    const { meanScore } = scoreBatch(testCases, actionsMap);

    // Score should be 0 since type doesn't match
    expect(meanScore).toBe(0);

    const ledger = await loadLedger(ledgerPath);
    expect(shouldPromote(ledger, meanScore)).toBe(false);

    // Verify target file unchanged
    const content = await readFile(targetPath, 'utf-8');
    expect(content).toBe('original text');

    // Verify ledger unchanged
    const unchanged = await loadLedger(ledgerPath);
    expect(unchanged.bestScore).toBe(1.0);
    expect(unchanged.iteration).toBe(5);
  });

  it('handles empty suite gracefully', async () => {
    const suiteDir = join(testDir, 'suite-empty');
    await mkdir(suiteDir);
    await writeFile(join(suiteDir, 'cases.json'), JSON.stringify([]));

    const testCases = await loadTestCasesFromFile(join(suiteDir, 'cases.json'));
    expect(testCases).toEqual([]);

    const adapter = cannedAdapter('');
    const { results, actionsMap } = await runSuite(testCases, 'instructions', adapter);
    expect(results).toEqual([]);
    expect(actionsMap.size).toBe(0);

    const { results: scoreResults, meanScore } = scoreBatch(testCases, actionsMap);
    expect(scoreResults).toEqual([]);
    expect(meanScore).toBe(0);
  });
});
