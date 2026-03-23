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
    expect(state?.completionDetail).toBeNull();
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

  it('posts a final follow-up for fast failed runs when a durable failure detail is provided', async () => {
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
      runId: 'run-fast-failed',
      channelId: 'chan-1',
      messageId: 'msg-1',
    });
    await watchdog.complete('run-fast-failed', {
      outcome: 'failed',
      detail: 'Forge failed during plan-553: codex app-server websocket closed',
    });

    expect(postStillRunning).toHaveBeenCalledTimes(0);
    expect(postFinal).toHaveBeenCalledTimes(1);
    const state = await watchdog.getRun('run-fast-failed');
    expect(state?.completion).toBe('failed');
    expect(state?.completionDetail).toBe('Forge failed during plan-553: codex app-server websocket closed');
    expect(state?.finalPosted).toBe(true);
    watchdog.dispose();
  });

  it('skips generic final notices when completion notifications are disabled', async () => {
    const filePath = path.join(tmpDir, 'watchdog.json');
    const postStillRunning = vi.fn(async () => {});
    const postFinal = vi.fn(async () => {});
    const watchdog = new LongRunWatchdog({
      dataFilePath: filePath,
      postStillRunning,
      postFinal,
      stillRunningDelayMs: 1_000,
    });

    await watchdog.start({
      runId: 'run-chat',
      channelId: 'chan-1',
      messageId: 'msg-1',
      notifyOnCompletion: false,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await watchdog._waitForIdleForTest();
    expect(postStillRunning).toHaveBeenCalledTimes(1);

    await watchdog.complete('run-chat', { outcome: 'succeeded' });

    expect(postFinal).toHaveBeenCalledTimes(0);
    const state = await watchdog.getRun('run-chat');
    expect(state?.notifyOnCompletion).toBe(false);
    expect(state?.status).toBe('completed');
    expect(state?.checkInPosted).toBe(true);
    expect(state?.finalPosted).toBe(false);

    const sweep = await watchdog.startupSweep();
    expect(sweep.finalRetried).toBe(0);
    expect(sweep.finalPosted).toBe(0);
    expect(sweep.finalFailed).toBe(0);
    watchdog.dispose();
  });

  it('suppresses reposts after an explicit stop mark even if recovery text was staged', async () => {
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
      runId: 'run-explicit-stop',
      channelId: 'chan-1',
      messageId: 'msg-1',
    });
    await watchdog.stageRecovery('run-explicit-stop', { text: 'Recovered answer text.' });
    await watchdog.markExplicitStop('msg-1');
    await watchdog.complete('run-explicit-stop', { outcome: 'failed' });

    expect(postFinal).toHaveBeenCalledTimes(0);
    const state = await watchdog.getRun('run-explicit-stop');
    expect(state?.explicitStop).toBe(true);
    expect(state?.recoveryText).toBeNull();
    expect(state?.notifyOnCompletion).toBe(false);

    const sweep = await watchdog.startupSweep();
    expect(sweep.finalRetried).toBe(0);
    expect(sweep.finalPosted).toBe(0);
    expect(sweep.finalFailed).toBe(0);
    watchdog.dispose();
  });

  it('posts final follow-up when notifyOnCompletion is true and check-in was posted', async () => {
    const filePath = path.join(tmpDir, 'watchdog.json');
    const postStillRunning = vi.fn(async () => {});
    const postFinal = vi.fn(async () => {});
    const watchdog = new LongRunWatchdog({
      dataFilePath: filePath,
      postStillRunning,
      postFinal,
      stillRunningDelayMs: 1_000,
    });

    await watchdog.start({
      runId: 'run-chat-notify',
      channelId: 'chan-1',
      messageId: 'msg-1',
      notifyOnCompletion: true,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await watchdog._waitForIdleForTest();
    expect(postStillRunning).toHaveBeenCalledTimes(1);

    await watchdog.complete('run-chat-notify', { outcome: 'succeeded' });

    expect(postFinal).toHaveBeenCalledTimes(1);
    const state = await watchdog.getRun('run-chat-notify');
    expect(state?.notifyOnCompletion).toBe(true);
    expect(state?.status).toBe('completed');
    expect(state?.checkInPosted).toBe(true);
    expect(state?.finalPosted).toBe(true);
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

  it('persists follow-up run kind and correlation token for discord action follow-ups', async () => {
    const filePath = path.join(tmpDir, 'watchdog.json');
    const watchdog = new LongRunWatchdog({
      dataFilePath: filePath,
      postStillRunning: vi.fn(async () => {}),
      postFinal: vi.fn(async () => {}),
      stillRunningDelayMs: 1_000,
    });

    await watchdog.start({
      runId: 'run-followup',
      channelId: 'chan-1',
      messageId: 'msg-1',
      runKind: 'discord-action-followup',
      correlationToken: 'abc123',
    });

    const state = await watchdog.getRun('run-followup');
    expect(state?.runKind).toBe('discord-action-followup');
    expect(state?.correlationToken).toBe('abc123');

    const persisted = await readRun(filePath, 'run-followup');
    expect(persisted?.runKind).toBe('discord-action-followup');
    expect(persisted?.correlationToken).toBe('abc123');
    watchdog.dispose();
  });

  it('persists only the normalized bounded staged recovery payload', async () => {
    const filePath = path.join(tmpDir, 'watchdog.json');
    const watchdog = new LongRunWatchdog({
      dataFilePath: filePath,
      postStillRunning: vi.fn(async () => {}),
      postFinal: vi.fn(async () => {}),
      stillRunningDelayMs: 60_000,
    });

    await watchdog.start({
      runId: 'run-recovery-stage',
      channelId: 'chan-1',
      messageId: 'msg-1',
    });

    const stagedText = ` \r\n${'x'.repeat(1_900)}\r\n `;
    const expectedText = 'x'.repeat(1_800);
    await watchdog.stageRecovery('run-recovery-stage', { text: stagedText });

    const state = await watchdog.getRun('run-recovery-stage');
    expect(state?.recoveryText).toBe(expectedText);

    const persisted = await readRun(filePath, 'run-recovery-stage');
    expect(persisted?.recoveryText).toBe(expectedText);
    watchdog.dispose();
  });

  it('leaves finalPosted false when a recovered live final post fails', async () => {
    const filePath = path.join(tmpDir, 'watchdog.json');
    const recoveryText = 'Recovered successful summary.';
    const postFinal = vi.fn(async (run: { recoveryText: string | null }) => {
      expect(run.recoveryText).toBe(recoveryText);
      throw new Error('transient discord error');
    });
    const watchdog = new LongRunWatchdog({
      dataFilePath: filePath,
      postStillRunning: vi.fn(async () => {}),
      postFinal,
      stillRunningDelayMs: 60_000,
    });

    await watchdog.start({
      runId: 'run-recovery-live-fail',
      channelId: 'chan-1',
      messageId: 'msg-1',
    });
    await watchdog.stageRecovery('run-recovery-live-fail', { text: recoveryText });
    await watchdog.complete('run-recovery-live-fail', { outcome: 'succeeded' });

    expect(postFinal).toHaveBeenCalledTimes(1);
    const state = await watchdog.getRun('run-recovery-live-fail');
    expect(state?.completion).toBe('succeeded');
    expect(state?.recoveryText).toBe(recoveryText);
    expect(state?.finalPosted).toBe(false);
    expect(state?.finalError).toBe('transient discord error');

    const persisted = await readRun(filePath, 'run-recovery-live-fail');
    expect(persisted?.finalPosted).toBe(false);
    expect(persisted?.recoveryText).toBe(recoveryText);
    watchdog.dispose();
  });

  it('startup sweep reposts staged recovered summary for completed successful runs', async () => {
    const filePath = path.join(tmpDir, 'watchdog.json');
    const recoveryText = 'Recovered successful summary.';
    const beforeRestart = new LongRunWatchdog({
      dataFilePath: filePath,
      postStillRunning: vi.fn(async () => {}),
      postFinal: vi.fn(async () => {
        throw new Error('transient discord error');
      }),
      stillRunningDelayMs: 60_000,
    });

    await beforeRestart.start({
      runId: 'run-recovery-restart',
      channelId: 'chan-1',
      messageId: 'msg-1',
      notifyOnCompletion: false,
    });
    await beforeRestart.stageRecovery('run-recovery-restart', { text: recoveryText });
    await beforeRestart.complete('run-recovery-restart', { outcome: 'succeeded' });

    const afterFailedPost = await beforeRestart.getRun('run-recovery-restart');
    expect(afterFailedPost?.finalPosted).toBe(false);
    expect(afterFailedPost?.recoveryText).toBe(recoveryText);
    beforeRestart.dispose();

    const postFinalAfterRestart = vi.fn(async (run: { completion: string | null; recoveryText: string | null }) => {
      expect(run.completion).toBe('succeeded');
      expect(run.recoveryText).toBe(recoveryText);
    });
    const afterRestart = new LongRunWatchdog({
      dataFilePath: filePath,
      postStillRunning: vi.fn(async () => {}),
      postFinal: postFinalAfterRestart,
      stillRunningDelayMs: 60_000,
    });

    const sweep = await afterRestart.startupSweep();
    expect(sweep.finalRetried).toBe(1);
    expect(sweep.finalPosted).toBe(1);
    expect(sweep.finalFailed).toBe(0);
    expect(postFinalAfterRestart).toHaveBeenCalledTimes(1);

    const recovered = await afterRestart.getRun('run-recovery-restart');
    expect(recovered?.recoveryText).toBe(recoveryText);
    expect(recovered?.finalPosted).toBe(true);
    afterRestart.dispose();
  });

  it('marks coordinator-confirmed visible delivery as finalPosted so startup sweep skips it after restart', async () => {
    const filePath = path.join(tmpDir, 'watchdog.json');
    const recoveryText = 'Recovered successful summary.';
    const beforeRestartPostFinal = vi.fn(async () => {});
    const beforeRestart = new LongRunWatchdog({
      dataFilePath: filePath,
      postStillRunning: vi.fn(async () => {}),
      postFinal: beforeRestartPostFinal,
      stillRunningDelayMs: 60_000,
    });

    await beforeRestart.start({
      runId: 'run-recovery-acked',
      channelId: 'chan-1',
      messageId: 'msg-1',
    });
    await beforeRestart.stageRecovery('run-recovery-acked', { text: recoveryText });
    await beforeRestart.complete('run-recovery-acked', {
      outcome: 'succeeded',
      deliveryConfirmed: true,
    });

    expect(beforeRestartPostFinal).toHaveBeenCalledTimes(0);
    const acknowledged = await beforeRestart.getRun('run-recovery-acked');
    expect(acknowledged?.deliveryConfirmed).toBe(true);
    expect(acknowledged?.finalPosted).toBe(true);

    const persisted = await readRun(filePath, 'run-recovery-acked');
    expect(persisted?.deliveryConfirmed).toBe(true);
    expect(persisted?.finalPosted).toBe(true);
    beforeRestart.dispose();

    const afterRestartPostFinal = vi.fn(async () => {});
    const afterRestart = new LongRunWatchdog({
      dataFilePath: filePath,
      postStillRunning: vi.fn(async () => {}),
      postFinal: afterRestartPostFinal,
      stillRunningDelayMs: 60_000,
    });

    const sweep = await afterRestart.startupSweep();
    expect(sweep.finalRetried).toBe(0);
    expect(sweep.finalPosted).toBe(0);
    expect(sweep.finalFailed).toBe(0);
    expect(afterRestartPostFinal).toHaveBeenCalledTimes(0);

    const recovered = await afterRestart.getRun('run-recovery-acked');
    expect(recovered?.deliveryConfirmed).toBe(true);
    expect(recovered?.finalPosted).toBe(true);
    afterRestart.dispose();
  });

  it('persists failure detail across retries and restart recovery', async () => {
    const filePath = path.join(tmpDir, 'watchdog.json');
    const postStillRunningA = vi.fn(async () => {});
    const postFinalA = vi.fn()
      .mockRejectedValueOnce(new Error('transient discord error'))
      .mockResolvedValue(undefined);

    const beforeRestart = new LongRunWatchdog({
      dataFilePath: filePath,
      postStillRunning: postStillRunningA,
      postFinal: postFinalA,
      stillRunningDelayMs: 1_000,
    });

    await beforeRestart.start({
      runId: 'run-detail',
      channelId: 'chan-1',
      messageId: 'msg-1',
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await beforeRestart._waitForIdleForTest();
    await beforeRestart.complete('run-detail', {
      outcome: 'failed',
      detail: 'Forge failed during plan-553: codex app-server websocket closed',
    });

    const afterFailedPost = await beforeRestart.getRun('run-detail');
    expect(afterFailedPost?.completionDetail).toBe('Forge failed during plan-553: codex app-server websocket closed');
    expect(afterFailedPost?.finalPosted).toBe(false);
    beforeRestart.dispose();

    const postStillRunningB = vi.fn(async () => {});
    const postFinalB = vi.fn(async (run: { completionDetail: string | null }) => {
      expect(run.completionDetail).toBe('Forge failed during plan-553: codex app-server websocket closed');
    });
    const afterRestart = new LongRunWatchdog({
      dataFilePath: filePath,
      postStillRunning: postStillRunningB,
      postFinal: postFinalB,
      stillRunningDelayMs: 1_000,
    });

    const sweep = await afterRestart.startupSweep();
    expect(sweep.finalRetried).toBe(1);
    expect(sweep.finalPosted).toBe(1);
    expect(postFinalB).toHaveBeenCalledTimes(1);

    const recovered = await afterRestart.getRun('run-detail');
    expect(recovered?.completionDetail).toBe('Forge failed during plan-553: codex app-server websocket closed');
    expect(recovered?.finalPosted).toBe(true);
    afterRestart.dispose();
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
