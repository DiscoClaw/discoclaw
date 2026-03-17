import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadLedger, saveLedger, shouldPromote, promote } from '../keeper.js';
import type { Ledger } from '../types.js';

// ── Helpers ─────────────────────────────────────────────────────────

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `si-keeper-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

// ── loadLedger ──────────────────────────────────────────────────────

describe('loadLedger', () => {
  it('returns default ledger when file does not exist', async () => {
    const ledger = await loadLedger(join(testDir, 'missing.json'));
    expect(ledger).toEqual({ bestScore: 0, iteration: 0, promotedAt: '' });
  });

  it('loads a valid ledger from disk', async () => {
    const data: Ledger = { bestScore: 0.85, iteration: 3, promotedAt: '2025-01-01T00:00:00.000Z' };
    await writeFile(join(testDir, 'ledger.json'), JSON.stringify(data));
    const ledger = await loadLedger(join(testDir, 'ledger.json'));
    expect(ledger.bestScore).toBe(0.85);
    expect(ledger.iteration).toBe(3);
    expect(ledger.promotedAt).toBe('2025-01-01T00:00:00.000Z');
  });

  it('throws on invalid schema', async () => {
    await writeFile(join(testDir, 'bad.json'), JSON.stringify({ bestScore: 'not-a-number' }));
    await expect(loadLedger(join(testDir, 'bad.json'))).rejects.toThrow('Invalid ledger schema');
  });

  it('throws on malformed JSON', async () => {
    await writeFile(join(testDir, 'bad.json'), 'not json');
    await expect(loadLedger(join(testDir, 'bad.json'))).rejects.toThrow();
  });
});

// ── saveLedger ──────────────────────────────────────────────────────

describe('saveLedger', () => {
  it('writes a pretty-printed ledger to disk', async () => {
    const data: Ledger = { bestScore: 0.9, iteration: 1, promotedAt: '2025-06-01T12:00:00.000Z' };
    const path = join(testDir, 'ledger.json');
    await saveLedger(path, data);
    const raw = await readFile(path, 'utf-8');
    expect(raw).toContain('"bestScore": 0.9');
    expect(raw).toContain('"iteration": 1');
    expect(raw.endsWith('\n')).toBe(true);
  });
});

// ── load/save round-trip ────────────────────────────────────────────

describe('ledger round-trip', () => {
  it('saves then loads back identical data', async () => {
    const original: Ledger = { bestScore: 0.75, iteration: 5, promotedAt: '2025-03-15T08:30:00.000Z' };
    const path = join(testDir, 'roundtrip.json');
    await saveLedger(path, original);
    const loaded = await loadLedger(path);
    expect(loaded).toEqual(original);
  });
});

// ── shouldPromote ───────────────────────────────────────────────────

describe('shouldPromote', () => {
  it('returns true when candidate is higher than current best', () => {
    const ledger: Ledger = { bestScore: 0.5, iteration: 1, promotedAt: '' };
    expect(shouldPromote(ledger, 0.6)).toBe(true);
  });

  it('returns false when candidate equals current best', () => {
    const ledger: Ledger = { bestScore: 0.5, iteration: 1, promotedAt: '' };
    expect(shouldPromote(ledger, 0.5)).toBe(false);
  });

  it('returns false when candidate is lower than current best', () => {
    const ledger: Ledger = { bestScore: 0.8, iteration: 2, promotedAt: '' };
    expect(shouldPromote(ledger, 0.7)).toBe(false);
  });

  it('returns true when promoting from default (score 0)', () => {
    const ledger: Ledger = { bestScore: 0, iteration: 0, promotedAt: '' };
    expect(shouldPromote(ledger, 0.1)).toBe(true);
  });
});

// ── promote ─────────────────────────────────────────────────────────

describe('promote', () => {
  it('atomically replaces the target file with mutated text', async () => {
    const targetPath = join(testDir, 'instructions.md');
    const ledgerPath = join(testDir, 'instructions.md.ledger.json');
    await writeFile(targetPath, 'original instructions');

    await promote(targetPath, 'mutated instructions', ledgerPath, 0.9);

    const content = await readFile(targetPath, 'utf-8');
    expect(content).toBe('mutated instructions');
  });

  it('creates and updates the ledger file', async () => {
    const targetPath = join(testDir, 'target.md');
    const ledgerPath = join(testDir, 'target.ledger.json');
    await writeFile(targetPath, 'original');

    const updated = await promote(targetPath, 'new content', ledgerPath, 0.85);

    expect(updated.bestScore).toBe(0.85);
    expect(updated.iteration).toBe(1);
    expect(updated.promotedAt).toBeTruthy();

    // Verify persisted ledger matches
    const persisted = await loadLedger(ledgerPath);
    expect(persisted.bestScore).toBe(0.85);
    expect(persisted.iteration).toBe(1);
  });

  it('increments iteration on successive promotions', async () => {
    const targetPath = join(testDir, 'iter.md');
    const ledgerPath = join(testDir, 'iter.ledger.json');
    await writeFile(targetPath, 'v0');

    await promote(targetPath, 'v1', ledgerPath, 0.5);
    const second = await promote(targetPath, 'v2', ledgerPath, 0.7);

    expect(second.iteration).toBe(2);
    expect(second.bestScore).toBe(0.7);
  });

  it('does not leave staging temp files behind', async () => {
    const targetPath = join(testDir, 'clean.md');
    const ledgerPath = join(testDir, 'clean.ledger.json');
    await writeFile(targetPath, 'original');

    await promote(targetPath, 'new', ledgerPath, 0.9);

    const { readdir } = await import('node:fs/promises');
    const files = await readdir(testDir);
    const stagingFiles = files.filter((f) => f.startsWith('.self-improve-staging-'));
    expect(stagingFiles).toHaveLength(0);
  });
});
