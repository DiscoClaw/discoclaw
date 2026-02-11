import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ChannelType } from 'discord.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { executeCronJob } from './executor.js';
import { safeCronId } from './job-lock.js';
import type { CronJob, ParsedCronDef } from './types.js';
import type { CronExecutorContext } from './executor.js';
import type { EngineEvent, RuntimeAdapter } from '../runtime/types.js';

function makeDef(overrides?: Partial<ParsedCronDef>): ParsedCronDef {
  return {
    schedule: '0 7 * * *',
    timezone: 'UTC',
    channel: 'general',
    prompt: 'Say hello.',
    ...overrides,
  };
}

function makeJob(overrides?: Partial<CronJob>): CronJob {
  return {
    id: 'thread-1',
    cronId: 'cron-test0001',
    threadId: 'thread-1',
    guildId: 'guild-1',
    name: 'Test Job',
    def: makeDef(),
    cron: null,
    running: false,
    ...overrides,
  };
}

function makeMockRuntime(response: string): RuntimeAdapter {
  return {
    id: 'claude_code',
    capabilities: new Set(['streaming_text']),
    async *invoke(): AsyncIterable<EngineEvent> {
      yield { type: 'text_final', text: response };
      yield { type: 'done' };
    },
  };
}

function makeMockRuntimeError(message: string): RuntimeAdapter {
  return {
    id: 'claude_code',
    capabilities: new Set(['streaming_text']),
    async *invoke(): AsyncIterable<EngineEvent> {
      yield { type: 'error', message };
      yield { type: 'done' };
    },
  };
}

function mockLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function mockChannel() {
  return { id: 'ch-1', name: 'general', type: ChannelType.GuildText, send: vi.fn().mockResolvedValue(undefined) };
}

function makeCtx(overrides?: Partial<CronExecutorContext>): CronExecutorContext {
  const channel = mockChannel();
  const guild = {
    channels: {
      cache: {
        get: vi.fn().mockReturnValue(channel),
        find: vi.fn().mockReturnValue(channel),
      },
    },
  };
  const client = {
    guilds: {
      cache: {
        get: vi.fn().mockReturnValue(guild),
      },
    },
  };

  return {
    client: client as any,
    runtime: makeMockRuntime('Hello from cron!'),
    model: 'haiku',
    cwd: '/tmp',
    tools: ['Bash', 'Read', 'Edit', 'WebSearch', 'WebFetch'],
    timeoutMs: 30_000,
    status: null,
    log: mockLog(),
    discordActionsEnabled: false,
    actionFlags: { channels: false, messaging: false, guild: false, moderation: false, polls: false, beads: false, crons: false, botProfile: false },
    ...overrides,
  };
}

describe('executeCronJob', () => {
  it('posts result to target channel', async () => {
    const ctx = makeCtx();
    const job = makeJob();
    await executeCronJob(job, ctx);

    const guild = (ctx.client as any).guilds.cache.get('guild-1');
    const channel = guild.channels.cache.get('general');
    expect(channel.send).toHaveBeenCalledOnce();
    expect(channel.send.mock.calls[0][0].content).toContain('Hello from cron!');
  });

  it('sets running flag and clears it after', async () => {
    const ctx = makeCtx();
    const job = makeJob();
    expect(job.running).toBe(false);
    await executeCronJob(job, ctx);
    expect(job.running).toBe(false);
  });

  it('skips if previous run is still active (overlap guard)', async () => {
    const ctx = makeCtx();
    const job = makeJob({ running: true });
    await executeCronJob(job, ctx);

    const guild = (ctx.client as any).guilds.cache.get('guild-1');
    const channel = guild.channels.cache.get('general');
    expect(channel.send).not.toHaveBeenCalled();
    expect(ctx.log?.warn).toHaveBeenCalled();
  });

  it('handles runtime error gracefully', async () => {
    const status = {
      online: vi.fn(),
      offline: vi.fn(),
      runtimeError: vi.fn(),
      handlerError: vi.fn(),
      actionFailed: vi.fn(),
    };
    const ctx = makeCtx({ runtime: makeMockRuntimeError('timeout'), status });
    const job = makeJob();
    await executeCronJob(job, ctx);

    expect(status.runtimeError).toHaveBeenCalledOnce();
    expect(job.running).toBe(false);
  });

  it('handles guild not found gracefully', async () => {
    const client = {
      guilds: { cache: { get: vi.fn().mockReturnValue(undefined) } },
    };
    const ctx = makeCtx({ client: client as any });
    const job = makeJob();
    await executeCronJob(job, ctx);

    expect(ctx.log?.error).toHaveBeenCalled();
    expect(job.running).toBe(false);
  });

  it('handles channel not found gracefully', async () => {
    const guild = {
      channels: {
        cache: {
          get: vi.fn().mockReturnValue(undefined),
          find: vi.fn().mockReturnValue(undefined),
        },
      },
    };
    const client = {
      guilds: { cache: { get: vi.fn().mockReturnValue(guild) } },
    };
    const status = {
      online: vi.fn(),
      offline: vi.fn(),
      runtimeError: vi.fn(),
      handlerError: vi.fn(),
      actionFailed: vi.fn(),
    };
    const ctx = makeCtx({ client: client as any, status });
    const job = makeJob();
    await executeCronJob(job, ctx);

    expect(status.runtimeError).toHaveBeenCalledOnce();
    expect(job.running).toBe(false);
  });

  it('does not post if target channel is not allowlisted', async () => {
    const status = {
      online: vi.fn(),
      offline: vi.fn(),
      runtimeError: vi.fn(),
      handlerError: vi.fn(),
      actionFailed: vi.fn(),
    };
    const ctx = makeCtx({ status, allowChannelIds: new Set(['some-other-channel']) });
    const job = makeJob();
    await executeCronJob(job, ctx);

    const guild = (ctx.client as any).guilds.cache.get('guild-1');
    const channel = guild.channels.cache.get('general');
    expect(channel.send).not.toHaveBeenCalled();
    expect(status.runtimeError).toHaveBeenCalledOnce();
  });

  it('posts when target channel is allowlisted', async () => {
    const status = {
      online: vi.fn(),
      offline: vi.fn(),
      runtimeError: vi.fn(),
      handlerError: vi.fn(),
      actionFailed: vi.fn(),
    };
    const ctx = makeCtx({ status, allowChannelIds: new Set(['ch-1']) });
    const job = makeJob();
    await executeCronJob(job, ctx);

    const guild = (ctx.client as any).guilds.cache.get('guild-1');
    const channel = guild.channels.cache.get('general');
    expect(channel.send).toHaveBeenCalledOnce();
  });

  it('does not post if output is empty', async () => {
    const ctx = makeCtx({ runtime: makeMockRuntime('') });
    const job = makeJob();
    await executeCronJob(job, ctx);

    const guild = (ctx.client as any).guilds.cache.get('guild-1');
    const channel = guild.channels.cache.get('general');
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('clears running flag even on exception', async () => {
    const guild = {
      channels: {
        cache: {
          get: vi.fn().mockReturnValue({
            id: 'ch-1',
            name: 'general',
            type: ChannelType.GuildText,
            send: vi.fn().mockRejectedValue(new Error('Discord API error')),
          }),
          find: vi.fn(),
        },
      },
    };
    const client = {
      guilds: { cache: { get: vi.fn().mockReturnValue(guild) } },
    };
    const ctx = makeCtx({ client: client as any });
    const job = makeJob();
    await executeCronJob(job, ctx);

    expect(job.running).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// File-lock integration
// ---------------------------------------------------------------------------

describe('executeCronJob file lock integration', () => {
  let lockDir: string;

  beforeEach(async () => {
    lockDir = await fs.mkdtemp(path.join(os.tmpdir(), 'executor-lock-test-'));
  });

  afterEach(async () => {
    await fs.rm(lockDir, { recursive: true, force: true });
  });

  it('acquires and releases lock when lockDir is set', async () => {
    const ctx = makeCtx({ lockDir });
    const job = makeJob();
    const lockPath = path.join(lockDir, safeCronId(job.cronId) + '.lock');

    await executeCronJob(job, ctx);

    // Lock should be released after execution.
    await expect(fs.stat(lockPath)).rejects.toThrow();
    expect(job.running).toBe(false);
  });

  it('releases lock even on early return (guild not found)', async () => {
    const client = {
      guilds: { cache: { get: vi.fn().mockReturnValue(undefined) } },
    };
    const ctx = makeCtx({ client: client as any, lockDir });
    const job = makeJob();
    const lockPath = path.join(lockDir, safeCronId(job.cronId) + '.lock');

    await executeCronJob(job, ctx);

    await expect(fs.stat(lockPath)).rejects.toThrow();
    expect(job.running).toBe(false);
  });

  it('skips execution when lock is already held by another process', async () => {
    const ctx = makeCtx({ lockDir });
    const job = makeJob();

    // Pre-create a lock with a fake alive PID (our own PID, so it's alive).
    const lockPath = path.join(lockDir, safeCronId(job.cronId) + '.lock');
    await fs.mkdir(lockPath);
    await fs.writeFile(
      path.join(lockPath, 'meta.json'),
      JSON.stringify({ pid: process.pid, token: 'other-token', acquiredAt: new Date().toISOString() }),
    );

    await executeCronJob(job, ctx);

    // Should have been skipped — no channel send.
    const guild = (ctx.client as any).guilds.cache.get('guild-1');
    const channel = guild.channels.cache.get('general');
    expect(channel.send).not.toHaveBeenCalled();
    expect(ctx.log?.warn).toHaveBeenCalled();

    // Lock should still exist (we didn't acquire it, so we shouldn't touch it).
    const stat = await fs.stat(lockPath);
    expect(stat.isDirectory()).toBe(true);
  });
});
