import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LongRunWatchdog } from './long-run-watchdog.js';

async function readRun(
  filePath: string,
  runId: string,
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as { runs?: Record<string, Record<string, unknown>> };
    return parsed.runs?.[runId] ?? null;
  } catch {
    return null;
  }
}

let tmpDir = '';

beforeEach(async () => {
  vi.useFakeTimers();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'long-run-watchdog-'));
});

afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

describe('LongRunWatchdog', () => {
  it('persists completion before final post and sets finalPosted after success', async () => {
    const filePath = path.join(tmpDir, 'watchdog.json');
    const postStillRunning = vi.fn(async () => {});
    const postFinal = vi.fn(async () => {
      const persisted = await readRun(filePath, 'run-1');
      expect(persisted?.status).toBe('completed');
      expect(persisted?.finalPosted).toBe(false);
      expect(persisted?.completion).toBe('succeeded');
    });

    const watchdog = new LongRunWatchdog({
      dataFilePath: filePath,
      postStillRunning,
      postFinal,
      stillRunningDelayMs: 1_000,
    });

    await watchdog.start({
      runId: 'run-1',
      channelId: 'chan-1',
      messageId: 'msg-1',
      sessionKey: 'sess-1',
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await watchdog._waitForIdleForTest();
    expect(postStillRunning).toHaveBeenCalledTimes(1);
    await watchdog.complete('run-1', { outcome: 'succeeded' });

    expect(postFinal).toHaveBeenCalledTimes(1);
    const state = await watchdog.getRun('run-1');
    expect(state?.status).toBe('completed');
    expect(state?.completion).toBe('succeeded');
    expect(state?.finalPosted).toBe(true);
    expect(state?.finalError).toBeNull();

    const persisted = await readRun(filePath, 'run-1');
    expect(persisted?.finalPosted).toBe(true);
    watchdog.dispose();
  });

  it('does not post a final follow-up for fast runs that never posted check-in', async () => {
    const filePath = path.join(tmpDir, 'watchdog.json');
    const postStillRunning = vi.fn(async () => {});
    const postFinal = vi.fn(async () => {});
    const watchdog = new LongRunWatchdog({
      dataFilePath: filePath,
      postStillRunning,
      postFinal,
      stillRunningDelayMs: 10_000,
    });

    await watchdog.start({
      runId: 'run-fast',
      channelId: 'chan-1',
      messageId: 'msg-1',
    });
    await watchdog.complete('run-fast', { outcome: 'succeeded' });

    expect(postStillRunning).toHaveBeenCalledTimes(0);
    expect(postFinal).toHaveBeenCalledTimes(0);
    const state = await watchdog.getRun('run-fast');
    expect(state?.status).toBe('completed');
    expect(state?.checkInPosted).toBe(false);
    expect(state?.finalPosted).toBe(false);

    const sweep = await watchdog.startupSweep();
    expect(sweep.finalRetried).toBe(0);
    expect(sweep.finalPosted).toBe(0);
    expect(sweep.finalFailed).toBe(0);
    watchdog.dispose();
  });

  it('posts a single deferred still-running check-in via timer', async () => {
    const filePath = path.join(tmpDir, 'watchdog.json');
    const postStillRunning = vi.fn(async () => {});
    const postFinal = vi.fn(async () => {});
    const watchdog = new LongRunWatchdog({
      dataFilePath: filePath,
      postStillRunning,
      postFinal,
    });

    await watchdog.start({
      runId: 'run-checkin',
      channelId: 'chan-1',
      messageId: 'msg-1',
      stillRunningDelayMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(postStillRunning).toHaveBeenCalledTimes(0);

    await vi.advanceTimersByTimeAsync(1);
    await watchdog._waitForIdleForTest();
    expect(postStillRunning).toHaveBeenCalledTimes(1);

    const state = await watchdog.getRun('run-checkin');
    expect(state?.checkInPosted).toBe(true);
    expect(state?.checkInPostedAt).not.toBeNull();

    await vi.advanceTimersByTimeAsync(10_000);
    await watchdog._waitForIdleForTest();
    expect(postStillRunning).toHaveBeenCalledTimes(1);
    watchdog.dispose();
  });

  it('dedupes duplicate start/complete calls for the same run', async () => {
    const filePath = path.join(tmpDir, 'watchdog.json');
    const postStillRunning = vi.fn(async () => {});
    const postFinal = vi.fn(async () => {});
    const watchdog = new LongRunWatchdog({
      dataFilePath: filePath,
      postStillRunning,
      postFinal,
    });

    const first = await watchdog.start({
      runId: 'run-dedupe',
      channelId: 'chan-1',
      messageId: 'msg-1',
      stillRunningDelayMs: 1000,
    });
    const second = await watchdog.start({
      runId: 'run-dedupe',
      channelId: 'chan-1',
      messageId: 'msg-1',
      stillRunningDelayMs: 1000,
    });

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    await watchdog._waitForIdleForTest();
    expect(postStillRunning).toHaveBeenCalledTimes(1);

    await watchdog.complete('run-dedupe', { outcome: 'failed' });
    await watchdog.complete('run-dedupe', { outcome: 'failed' });
    expect(postFinal).toHaveBeenCalledTimes(1);

    const state = await watchdog.getRun('run-dedupe');
    expect(state?.status).toBe('completed');
    expect(state?.finalPosted).toBe(true);
    watchdog.dispose();
  });

  it('startup sweep retries failed final posts until one succeeds, then stops', async () => {
    const filePath = path.join(tmpDir, 'watchdog.json');
    const postStillRunning = vi.fn(async () => {});
    const postFinal = vi.fn()
      .mockRejectedValueOnce(new Error('transient discord error'))
      .mockResolvedValue(undefined);

    const watchdog = new LongRunWatchdog({
      dataFilePath: filePath,
      postStillRunning,
      postFinal,
    });

    await watchdog.start({
      runId: 'run-retry',
      channelId: 'chan-1',
      messageId: 'msg-1',
      stillRunningDelayMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await watchdog._waitForIdleForTest();
    await watchdog.complete('run-retry', { outcome: 'succeeded' });

    const afterComplete = await watchdog.getRun('run-retry');
    expect(afterComplete?.status).toBe('completed');
    expect(afterComplete?.finalPosted).toBe(false);
    expect(afterComplete?.finalPostAttempts).toBe(1);

    const firstSweep = await watchdog.startupSweep();
    expect(firstSweep.interruptedRuns).toBe(0);
    expect(firstSweep.finalRetried).toBe(1);
    expect(firstSweep.finalPosted).toBe(1);
    expect(firstSweep.finalFailed).toBe(0);
    expect(postFinal).toHaveBeenCalledTimes(2);

    const afterSweep = await watchdog.getRun('run-retry');
    expect(afterSweep?.finalPosted).toBe(true);
    expect(afterSweep?.finalPostAttempts).toBe(2);

    const secondSweep = await watchdog.startupSweep();
    expect(secondSweep.finalRetried).toBe(0);
    expect(postFinal).toHaveBeenCalledTimes(2);
    watchdog.dispose();
  });

  it('startup sweep closes orphaned running runs as interrupted and posts final status', async () => {
    const filePath = path.join(tmpDir, 'watchdog.json');
    const postStillRunningA = vi.fn(async () => {});
    const postFinalA = vi.fn(async () => {});

    const beforeRestart = new LongRunWatchdog({
      dataFilePath: filePath,
      postStillRunning: postStillRunningA,
      postFinal: postFinalA,
      stillRunningDelayMs: 1_000,
    });
    await beforeRestart.start({
      runId: 'run-interrupted',
      channelId: 'chan-1',
      messageId: 'msg-1',
      sessionKey: 'sess-1',
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await beforeRestart._waitForIdleForTest();
    beforeRestart.dispose();

    const postStillRunningB = vi.fn(async () => {});
    const postFinalB = vi.fn(async (run: { completion: string | null }) => {
      expect(run.completion).toBe('interrupted');
    });
    const afterRestart = new LongRunWatchdog({
      dataFilePath: filePath,
      postStillRunning: postStillRunningB,
      postFinal: postFinalB,
    });

    const sweep = await afterRestart.startupSweep();
    expect(sweep.interruptedRuns).toBe(1);
    expect(sweep.finalRetried).toBe(1);
    expect(sweep.finalPosted).toBe(1);
    expect(postFinalB).toHaveBeenCalledTimes(1);

    const state = await afterRestart.getRun('run-interrupted');
    expect(state?.status).toBe('completed');
    expect(state?.completion).toBe('interrupted');
    expect(state?.finalPosted).toBe(true);
    afterRestart.dispose();
  });

  it('startup sweep posts final status for orphaned interrupted runs even without persisted check-in', async () => {
    const filePath = path.join(tmpDir, 'watchdog.json');
    const postStillRunningA = vi.fn(async () => {});
    const postFinalA = vi.fn(async () => {});

    const beforeRestart = new LongRunWatchdog({
      dataFilePath: filePath,
      postStillRunning: postStillRunningA,
      postFinal: postFinalA,
      stillRunningDelayMs: 60_000,
    });
    await beforeRestart.start({
      runId: 'run-interrupted-no-checkin',
      channelId: 'chan-1',
      messageId: 'msg-1',
      sessionKey: 'sess-1',
    });
    beforeRestart.dispose();

    const postStillRunningB = vi.fn(async () => {});
    const postFinalB = vi.fn(async (run: { completion: string | null }) => {
      expect(run.completion).toBe('interrupted');
    });
    const afterRestart = new LongRunWatchdog({
      dataFilePath: filePath,
      postStillRunning: postStillRunningB,
      postFinal: postFinalB,
      stillRunningDelayMs: 60_000,
    });

    const sweep = await afterRestart.startupSweep();
    expect(sweep.interruptedRuns).toBe(1);
    expect(sweep.finalRetried).toBe(1);
    expect(sweep.finalPosted).toBe(1);
    expect(postFinalB).toHaveBeenCalledTimes(1);

    const state = await afterRestart.getRun('run-interrupted-no-checkin');
    expect(state?.status).toBe('completed');
    expect(state?.completion).toBe('interrupted');
    expect(state?.checkInPosted).toBe(false);
    expect(state?.finalPosted).toBe(true);
    afterRestart.dispose();
  });

  it('startup sweep does not interrupt runs started in the current process', async () => {
    const filePath = path.join(tmpDir, 'watchdog.json');
    const postStillRunning = vi.fn(async () => {});
    const postFinal = vi.fn(async () => {});
    const watchdog = new LongRunWatchdog({
      dataFilePath: filePath,
      postStillRunning,
      postFinal,
    });

    await watchdog.start({
      runId: 'run-fresh',
      channelId: 'chan-1',
      messageId: 'msg-1',
      stillRunningDelayMs: 10_000,
    });

    const sweep = await watchdog.startupSweep();
    expect(sweep.interruptedRuns).toBe(0);
    expect(sweep.finalRetried).toBe(0);

    const state = await watchdog.getRun('run-fresh');
    expect(state?.status).toBe('running');
    expect(state?.completion).toBeNull();
    watchdog.dispose();
  });
});
