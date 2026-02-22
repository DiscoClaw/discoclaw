import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  parseStatusCommand,
  renderStatusReport,
  collectStatusSnapshot,
} from './status-command.js';
import type { StatusSnapshot, CollectStatusOpts } from './status-command.js';
import * as credentialCheck from '../health/credential-check.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSnapshot(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    uptimeMs: 3_661_000, // 1h 1m 1s
    lastMessageAt: Date.now() - 90_000, // 1m 30s ago
    crons: [],
    openTaskCount: 0,
    durableItemCount: 0,
    rollingSummaryCharCount: 0,
    apiChecks: [],
    paFiles: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseStatusCommand
// ---------------------------------------------------------------------------

describe('parseStatusCommand', () => {
  it('returns true for !status', () => {
    expect(parseStatusCommand('!status')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(parseStatusCommand('!STATUS')).toBe(true);
    expect(parseStatusCommand('!Status')).toBe(true);
  });

  it('trims surrounding whitespace', () => {
    expect(parseStatusCommand('  !status  ')).toBe(true);
  });

  it('returns null for non-status commands', () => {
    expect(parseStatusCommand('!health')).toBeNull();
    expect(parseStatusCommand('!memory')).toBeNull();
    expect(parseStatusCommand('hello')).toBeNull();
    expect(parseStatusCommand('')).toBeNull();
  });

  it('returns null for !status with subcommands', () => {
    expect(parseStatusCommand('!status verbose')).toBeNull();
    expect(parseStatusCommand('!status foo')).toBeNull();
  });

  it('handles non-string input gracefully', () => {
    expect(parseStatusCommand(undefined as any)).toBeNull();
    expect(parseStatusCommand(null as any)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// renderStatusReport
// ---------------------------------------------------------------------------

describe('renderStatusReport', () => {
  it('renders uptime correctly', () => {
    const out = renderStatusReport(makeSnapshot({ uptimeMs: 3_661_000 }));
    expect(out).toContain('Uptime: 1h 1m 1s');
  });

  it('renders last message when present', () => {
    const snap = makeSnapshot({ lastMessageAt: Date.now() - 90_000 });
    const out = renderStatusReport(snap);
    expect(out).toMatch(/Last message: \d+m ago/);
  });

  it('renders "none since startup" when lastMessageAt is null', () => {
    const out = renderStatusReport(makeSnapshot({ lastMessageAt: null }));
    expect(out).toContain('Last message: none since startup');
  });

  it('renders crons=none when empty', () => {
    const out = renderStatusReport(makeSnapshot({ crons: [] }));
    expect(out).toContain('Crons: none');
  });

  it('renders cron list with next run times', () => {
    // Use 10m + 30s buffer so the "in Xm" label is stable regardless of test latency.
    const futureDate = new Date(Date.now() + 10 * 60_000 + 30_000);
    const snap = makeSnapshot({
      crons: [
        { name: 'morning-report', schedule: '0 7 * * 1-5', nextRun: futureDate },
        { name: 'weekly-digest', schedule: '0 9 * * 1', nextRun: null },
        { name: 'manual-job', schedule: undefined, nextRun: null },
      ],
    });
    const out = renderStatusReport(snap);
    expect(out).toContain('Crons (3):');
    expect(out).toContain('morning-report: next=in 10m');
    expect(out).toContain('weekly-digest: next=stopped');
    expect(out).toContain('manual-job: next=manual/webhook');
  });

  it('renders imminent next run when date is in the past', () => {
    const pastDate = new Date(Date.now() - 1000);
    const snap = makeSnapshot({
      crons: [{ name: 'overdue', schedule: '* * * * *', nextRun: pastDate }],
    });
    const out = renderStatusReport(snap);
    expect(out).toContain('overdue: next=imminent');
  });

  it('renders open task count', () => {
    const out = renderStatusReport(makeSnapshot({ openTaskCount: 7 }));
    expect(out).toContain('Open tasks: 7');
  });

  it('renders memory stats', () => {
    const out = renderStatusReport(
      makeSnapshot({ durableItemCount: 42, rollingSummaryCharCount: 1234 }),
    );
    expect(out).toContain('Memory: durable=42 items, summaries=1234 chars');
  });

  it('renders API check results', () => {
    const snap = makeSnapshot({
      apiChecks: [
        { name: 'discord-token', status: 'ok' },
        { name: 'openai-key', status: 'skip' },
      ],
    });
    const out = renderStatusReport(snap);
    expect(out).toContain('API: discord-token: ok, openai-key: skip');
  });

  it('renders API FAIL with message', () => {
    const snap = makeSnapshot({
      apiChecks: [
        { name: 'discord-token', status: 'fail', message: 'invalid or revoked token (401)' },
      ],
    });
    const out = renderStatusReport(snap);
    expect(out).toContain('discord-token: FAIL (invalid or revoked token (401))');
  });

  it('renders API: no checks when array is empty', () => {
    const out = renderStatusReport(makeSnapshot({ apiChecks: [] }));
    expect(out).toContain('API: no checks');
  });

  it('renders workspace PA as ok when all files exist', () => {
    const snap = makeSnapshot({
      paFiles: [
        { label: 'pa.md', exists: true },
        { label: 'pa-safety.md', exists: true },
      ],
    });
    const out = renderStatusReport(snap);
    expect(out).toContain('Workspace PA: ok');
    expect(out).toContain('pa.md: ok');
    expect(out).toContain('pa-safety.md: ok');
  });

  it('renders workspace PA as DEGRADED when a file is missing', () => {
    const snap = makeSnapshot({
      paFiles: [
        { label: 'pa.md', exists: true },
        { label: 'pa-safety.md', exists: false },
      ],
    });
    const out = renderStatusReport(snap);
    expect(out).toContain('Workspace PA: DEGRADED');
    expect(out).toContain('pa-safety.md: MISSING');
  });

  it('renders workspace PA as DEGRADED when no files configured', () => {
    const out = renderStatusReport(makeSnapshot({ paFiles: [] }));
    expect(out).toContain('Workspace PA: DEGRADED');
    expect(out).toContain('none configured');
  });

  it('uses custom bot display name', () => {
    const out = renderStatusReport(makeSnapshot(), 'MyBot');
    expect(out).toContain('MyBot Status');
    expect(out).not.toContain('Discoclaw Status');
  });

  it('defaults to Discoclaw when no name provided', () => {
    const out = renderStatusReport(makeSnapshot());
    expect(out).toContain('Discoclaw Status');
  });

  it('wraps output in a fenced text code block', () => {
    const out = renderStatusReport(makeSnapshot());
    expect(out).toMatch(/^```text\n/);
    expect(out).toMatch(/\n```$/);
  });

  it('renders next run in days for distant future', () => {
    const farFuture = new Date(Date.now() + 2 * 24 * 60 * 60_000 + 3 * 60 * 60_000); // 2d 3h
    const snap = makeSnapshot({
      crons: [{ name: 'rare-job', schedule: '0 0 * * 0', nextRun: farFuture }],
    });
    const out = renderStatusReport(snap);
    expect(out).toContain('rare-job: next=in 2d');
  });
});

// ---------------------------------------------------------------------------
// collectStatusSnapshot
// ---------------------------------------------------------------------------

describe('collectStatusSnapshot', () => {
  beforeEach(() => {
    vi.spyOn(credentialCheck, 'checkDiscordToken').mockResolvedValue({
      name: 'discord-token',
      status: 'ok',
    });
    vi.spyOn(credentialCheck, 'checkOpenAiKey').mockResolvedValue({
      name: 'openai-key',
      status: 'skip',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function baseOpts(overrides: Partial<CollectStatusOpts> = {}): CollectStatusOpts {
    return {
      startedAt: Date.now() - 60_000,
      lastMessageAt: null,
      scheduler: null,
      taskStore: null,
      durableDataDir: null,
      summaryDataDir: null,
      discordToken: 'test-token',
      paFilePaths: [],
      ...overrides,
    };
  }

  it('returns uptime based on startedAt', async () => {
    const startedAt = Date.now() - 5000;
    const snap = await collectStatusSnapshot(baseOpts({ startedAt }));
    expect(snap.uptimeMs).toBeGreaterThanOrEqual(5000);
    expect(snap.uptimeMs).toBeLessThan(10_000);
  });

  it('passes lastMessageAt through unchanged', async () => {
    const ts = Date.now() - 1234;
    const snap = await collectStatusSnapshot(baseOpts({ lastMessageAt: ts }));
    expect(snap.lastMessageAt).toBe(ts);
  });

  it('returns empty crons when scheduler is null', async () => {
    const snap = await collectStatusSnapshot(baseOpts({ scheduler: null }));
    expect(snap.crons).toEqual([]);
  });

  it('delegates cron list to scheduler.listJobs()', async () => {
    const mockJobs = [{ id: 'j1', name: 'test-job', schedule: '* * * * *', timezone: 'UTC', nextRun: null }];
    const mockScheduler = { listJobs: vi.fn().mockReturnValue(mockJobs) } as any;
    const snap = await collectStatusSnapshot(baseOpts({ scheduler: mockScheduler }));
    expect(mockScheduler.listJobs).toHaveBeenCalledOnce();
    expect(snap.crons).toEqual(mockJobs);
  });

  it('returns 0 open tasks when taskStore is null', async () => {
    const snap = await collectStatusSnapshot(baseOpts({ taskStore: null }));
    expect(snap.openTaskCount).toBe(0);
  });

  it('delegates task count to taskStore.list()', async () => {
    const mockStore = { list: vi.fn().mockReturnValue([{}, {}, {}]) } as any;
    const snap = await collectStatusSnapshot(baseOpts({ taskStore: mockStore }));
    expect(snap.openTaskCount).toBe(3);
  });

  it('returns 0 durable items when durableDataDir is null', async () => {
    const snap = await collectStatusSnapshot(baseOpts({ durableDataDir: null }));
    expect(snap.durableItemCount).toBe(0);
  });

  it('returns 0 summary chars when summaryDataDir is null', async () => {
    const snap = await collectStatusSnapshot(baseOpts({ summaryDataDir: null }));
    expect(snap.rollingSummaryCharCount).toBe(0);
  });

  it('includes apiChecks from credential check functions', async () => {
    const snap = await collectStatusSnapshot(baseOpts({ discordToken: 'tok', openaiApiKey: 'key' }));
    expect(credentialCheck.checkDiscordToken).toHaveBeenCalledWith('tok');
    expect(credentialCheck.checkOpenAiKey).toHaveBeenCalledWith({ apiKey: 'key', baseUrl: undefined });
    expect(snap.apiChecks).toHaveLength(2);
    expect(snap.apiChecks[0]).toEqual({ name: 'discord-token', status: 'ok' });
    expect(snap.apiChecks[1]).toEqual({ name: 'openai-key', status: 'skip' });
  });

  it('passes openaiBaseUrl to checkOpenAiKey', async () => {
    await collectStatusSnapshot(
      baseOpts({ openaiApiKey: 'key', openaiBaseUrl: 'https://example.com/v1' }),
    );
    expect(credentialCheck.checkOpenAiKey).toHaveBeenCalledWith({
      apiKey: 'key',
      baseUrl: 'https://example.com/v1',
    });
  });

  it('returns paFiles with exists=false for missing paths', async () => {
    const snap = await collectStatusSnapshot(
      baseOpts({
        paFilePaths: [
          { label: 'pa.md', path: '/nonexistent/path/pa.md' },
          { label: 'pa-safety.md', path: '/nonexistent/path/pa-safety.md' },
        ],
      }),
    );
    expect(snap.paFiles).toEqual([
      { label: 'pa.md', exists: false },
      { label: 'pa-safety.md', exists: false },
    ]);
  });

  it('handles API check failure gracefully — snapshot still resolves', async () => {
    vi.spyOn(credentialCheck, 'checkDiscordToken').mockResolvedValue({
      name: 'discord-token',
      status: 'fail',
      message: 'network error: timeout',
    });
    const snap = await collectStatusSnapshot(baseOpts());
    expect(snap.apiChecks[0]?.status).toBe('fail');
  });

  it('handles non-existent durableDataDir without throwing', async () => {
    const snap = await collectStatusSnapshot(
      baseOpts({ durableDataDir: '/tmp/discoclaw-test-nonexistent-durable-dir-xyz' }),
    );
    expect(snap.durableItemCount).toBe(0);
  });

  it('handles non-existent summaryDataDir without throwing', async () => {
    const snap = await collectStatusSnapshot(
      baseOpts({ summaryDataDir: '/tmp/discoclaw-test-nonexistent-summary-dir-xyz' }),
    );
    expect(snap.rollingSummaryCharCount).toBe(0);
  });
});
