import { describe, expect, it, vi } from 'vitest';
import { parseBdJson, normalizeBeadData, bdShow } from './bd-cli.js';
import type { BeadData } from './types.js';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

// ---------------------------------------------------------------------------
// parseBdJson
// ---------------------------------------------------------------------------

describe('parseBdJson', () => {
  it('parses array output', () => {
    const input = JSON.stringify([
      { id: 'ws-001', title: 'Test', status: 'open' },
      { id: 'ws-002', title: 'Test 2', status: 'closed' },
    ]);
    const result = parseBdJson(input);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('ws-001');
    expect(result[1].id).toBe('ws-002');
  });

  it('parses single-object output', () => {
    const input = JSON.stringify({ id: 'ws-001', title: 'Test', status: 'open' });
    const result = parseBdJson(input);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('ws-001');
  });

  it('strips markdown fences', () => {
    const input = '```json\n[{"id":"ws-001","title":"Test"}]\n```';
    const result = parseBdJson(input);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('ws-001');
  });

  it('strips bare markdown fences (no language tag)', () => {
    const input = '```\n{"id":"ws-001","title":"Test"}\n```';
    const result = parseBdJson(input);
    expect(result).toHaveLength(1);
  });

  it('returns empty array for empty input', () => {
    expect(parseBdJson('')).toEqual([]);
    expect(parseBdJson('  \n  ')).toEqual([]);
  });

  it('throws on error-only object', () => {
    const input = JSON.stringify({ error: 'not found' });
    expect(() => parseBdJson(input)).toThrow('not found');
  });

  it('throws on malformed JSON', () => {
    expect(() => parseBdJson('{bad json}')).toThrow();
  });

  it('returns empty array for non-object JSON', () => {
    expect(parseBdJson('"just a string"')).toEqual([]);
    expect(parseBdJson('42')).toEqual([]);
    expect(parseBdJson('null')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// normalizeBeadData
// ---------------------------------------------------------------------------

describe('normalizeBeadData', () => {
  const baseBead: BeadData = {
    id: 'ws-001',
    title: 'Test bead',
    status: 'open',
  };

  it('maps "done" → "closed"', () => {
    const bead = { ...baseBead, status: 'done' as BeadData['status'] };
    expect(normalizeBeadData(bead).status).toBe('closed');
  });

  it('maps "tombstone" → "closed"', () => {
    const bead = { ...baseBead, status: 'tombstone' as BeadData['status'] };
    expect(normalizeBeadData(bead).status).toBe('closed');
  });

  it('does not mutate the original bead when mapping', () => {
    const bead = { ...baseBead, status: 'done' as BeadData['status'] };
    normalizeBeadData(bead);
    expect(bead.status).toBe('done');
  });

  it.each(['open', 'in_progress', 'blocked', 'closed'] as const)(
    'passes through valid status "%s" unchanged',
    (status) => {
      const bead = { ...baseBead, status };
      const result = normalizeBeadData(bead);
      expect(result.status).toBe(status);
      expect(result).toBe(bead); // same reference — no copy
    },
  );
});

// ---------------------------------------------------------------------------
// bdShow — "not found" error handling
// ---------------------------------------------------------------------------

describe('bdShow', () => {
  it('returns null for "not found" errors', async () => {
    const { execa } = await import('execa');
    (execa as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'Error: not found',
    });

    const result = await bdShow('ws-999', '/tmp');
    expect(result).toBeNull();
  });

  it('returns null for "no issue found matching" errors (bd resolve failure)', async () => {
    const { execa } = await import('execa');
    (execa as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'Error: resolving ID ws-007: operation failed: failed to resolve ID: no issue found matching "ws-007"',
    });

    const result = await bdShow('ws-007', '/tmp');
    expect(result).toBeNull();
  });

  it('returns bead data on success', async () => {
    const { execa } = await import('execa');
    (execa as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify([{ id: 'ws-001', title: 'Test', status: 'open' }]),
      stderr: '',
    });

    const result = await bdShow('ws-001', '/tmp');
    expect(result).toEqual({ id: 'ws-001', title: 'Test', status: 'open' });
  });

  it('throws on unexpected errors', async () => {
    const { execa } = await import('execa');
    (execa as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'Error: database corruption detected',
    });

    await expect(bdShow('ws-001', '/tmp')).rejects.toThrow('database corruption');
  });
});
