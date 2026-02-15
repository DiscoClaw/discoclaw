import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ChannelType } from 'discord.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { executeCronJob } from './executor.js';
import { safeCronId } from './job-lock.js';
import { CronRunControl } from './run-control.js';
import { loadWorkspacePaFiles } from '../discord/prompt-common.js';
import type { CronJob, ParsedCronDef } from './types.js';
import type { CronExecutorContext } from './executor.js';
import type { EngineEvent, RuntimeAdapter } from '../runtime/types.js';

vi.mock('../discord/prompt-common.js', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    loadWorkspacePaFiles: vi.fn(actual.loadWorkspacePaFiles),
  };
});

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
      beadSyncComplete: vi.fn(),
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
      beadSyncComplete: vi.fn(),
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
      beadSyncComplete: vi.fn(),
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
      beadSyncComplete: vi.fn(),
    };
    const ctx = makeCtx({ status, allowChannelIds: new Set(['ch-1']) });
    const job = makeJob();
    await executeCronJob(job, ctx);

    const guild = (ctx.client as any).guilds.cache.get('guild-1');
    const channel = guild.channels.cache.get('general');
    expect(channel.send).toHaveBeenCalledOnce();
  });

  it('suppresses sendMessage Done line from posted output', async () => {
    const responseWithAction = 'Sending now.\n<discord-action>{"type":"sendMessage","channel":"general","content":"hello"}</discord-action>';
    const runtime: RuntimeAdapter = {
      id: 'claude_code',
      capabilities: new Set(['streaming_text']),
      async *invoke(): AsyncIterable<EngineEvent> {
        yield { type: 'text_final', text: responseWithAction };
        yield { type: 'done' };
      },
    };
    const ctx = makeCtx({
      runtime,
      discordActionsEnabled: true,
      actionFlags: { channels: false, messaging: true, guild: false, moderation: false, polls: false, beads: false, crons: false, botProfile: false },
    });
    const job = makeJob();
    await executeCronJob(job, ctx);

    const guild = (ctx.client as any).guilds.cache.get('guild-1');
    const channel = guild.channels.cache.get('general');
    // Two sends: action's sendMessage ("hello") + cron output ("Sending now.").
    expect(channel.send).toHaveBeenCalledTimes(2);
    // The cron output post (second call) should contain the prose but not "Done:".
    const outputContent = channel.send.mock.calls[1][0].content;
    expect(outputContent).not.toContain('Done: Sent message');
    expect(outputContent).toContain('Sending now.');
  });

  it('skips cron output post when sendMessage-only with no prose', async () => {
    const responseActionOnly = '<discord-action>{"type":"sendMessage","channel":"general","content":"hello"}</discord-action>';
    const runtime: RuntimeAdapter = {
      id: 'claude_code',
      capabilities: new Set(['streaming_text']),
      async *invoke(): AsyncIterable<EngineEvent> {
        yield { type: 'text_final', text: responseActionOnly };
        yield { type: 'done' };
      },
    };
    const ctx = makeCtx({
      runtime,
      discordActionsEnabled: true,
      actionFlags: { channels: false, messaging: true, guild: false, moderation: false, polls: false, beads: false, crons: false, botProfile: false },
    });
    const job = makeJob();
    await executeCronJob(job, ctx);

    const guild = (ctx.client as any).guilds.cache.get('guild-1');
    const channel = guild.channels.cache.get('general');
    // Only one send: the action's sendMessage. No cron output post.
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel.send.mock.calls[0][0].content).toBe('hello');
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

  it('supports cancel requests via runControl', async () => {
    const runControl = new CronRunControl();
    const runtime: RuntimeAdapter = {
      id: 'claude_code',
      capabilities: new Set(['streaming_text']),
      async *invoke(): AsyncIterable<EngineEvent> {
        yield { type: 'text_delta', text: 'working...' };
        await new Promise((r) => setTimeout(r, 50));
        yield { type: 'text_final', text: 'done' };
        yield { type: 'done' };
      },
    };
    const ctx = makeCtx({ runtime, runControl });
    const job = makeJob();

    const runPromise = executeCronJob(job, ctx);
    expect(runControl.requestCancel(job.id)).toBe(true);
    await runPromise;

    const guild = (ctx.client as any).guilds.cache.get('guild-1');
    const channel = guild.channels.cache.get('general');
    expect(channel.send).not.toHaveBeenCalled();
    expect(job.running).toBe(false);
    expect(runControl.has(job.id)).toBe(false);
    expect(ctx.log?.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: job.id, cronId: job.cronId }),
      'cron:exec canceled',
    );
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

// ---------------------------------------------------------------------------
// permissionNote injection
// ---------------------------------------------------------------------------

describe('executeCronJob permissionNote injection', () => {
  let wsDir: string;

  beforeEach(async () => {
    wsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'executor-perm-'));
  });

  afterEach(async () => {
    await fs.rm(wsDir, { recursive: true, force: true });
  });

  function makeCapturingRuntime(response: string) {
    const invokeSpy = vi.fn();
    return {
      runtime: {
        id: 'claude_code',
        capabilities: new Set(['streaming_text']),
        async *invoke(params: any): AsyncIterable<EngineEvent> {
          invokeSpy(params);
          yield { type: 'text_final', text: response };
          yield { type: 'done' };
        },
      } as RuntimeAdapter,
      invokeSpy,
    };
  }

  it('injects permissionNote into the prompt when PERMISSIONS.json has a note', async () => {
    await fs.writeFile(
      path.join(wsDir, 'PERMISSIONS.json'),
      JSON.stringify({ tier: 'readonly', note: 'Read-only access for scheduled tasks.' }),
    );

    const { runtime, invokeSpy } = makeCapturingRuntime('Hello!');
    const ctx = makeCtx({ runtime, cwd: wsDir });
    const job = makeJob();

    await executeCronJob(job, ctx);

    expect(invokeSpy).toHaveBeenCalledOnce();
    const passedPrompt = invokeSpy.mock.calls[0][0].prompt;
    expect(passedPrompt).toContain('Permission note: Read-only access for scheduled tasks.');
  });

  it('does not inject permissionNote when PERMISSIONS.json has no note', async () => {
    await fs.writeFile(
      path.join(wsDir, 'PERMISSIONS.json'),
      JSON.stringify({ tier: 'standard' }),
    );

    const { runtime, invokeSpy } = makeCapturingRuntime('Hello!');
    const ctx = makeCtx({ runtime, cwd: wsDir });
    const job = makeJob();

    await executeCronJob(job, ctx);

    expect(invokeSpy).toHaveBeenCalledOnce();
    const passedPrompt = invokeSpy.mock.calls[0][0].prompt;
    expect(passedPrompt).not.toContain('Permission note:');
  });
});

// ---------------------------------------------------------------------------
// Workspace PA context injection
// ---------------------------------------------------------------------------

describe('executeCronJob workspace PA context', () => {
  let wsDir: string;

  beforeEach(async () => {
    wsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'executor-pa-'));
  });

  afterEach(async () => {
    await fs.rm(wsDir, { recursive: true, force: true });
  });

  function makeCapturingRuntime(response: string) {
    const invokeSpy = vi.fn();
    return {
      runtime: {
        id: 'claude_code',
        capabilities: new Set(['streaming_text']),
        async *invoke(params: any): AsyncIterable<EngineEvent> {
          invokeSpy(params);
          yield { type: 'text_final', text: response };
          yield { type: 'done' };
        },
      } as RuntimeAdapter,
      invokeSpy,
    };
  }

  it('inlines all PA files into the prompt', async () => {
    await fs.writeFile(path.join(wsDir, 'SOUL.md'), 'Be helpful.');
    await fs.writeFile(path.join(wsDir, 'IDENTITY.md'), 'Test Bot Identity');
    await fs.writeFile(path.join(wsDir, 'USER.md'), 'User info here.');
    await fs.writeFile(path.join(wsDir, 'TOOLS.md'), 'Tool list here.');

    const { runtime, invokeSpy } = makeCapturingRuntime('Hello!');
    const ctx = makeCtx({ runtime, cwd: wsDir });
    const job = makeJob();

    await executeCronJob(job, ctx);

    expect(invokeSpy).toHaveBeenCalledOnce();
    const prompt = invokeSpy.mock.calls[0][0].prompt;
    expect(prompt).toContain('--- SOUL.md ---');
    expect(prompt).toContain('Be helpful.');
    expect(prompt).toContain('--- IDENTITY.md ---');
    expect(prompt).toContain('Test Bot Identity');
    expect(prompt).toContain('--- USER.md ---');
    expect(prompt).toContain('User info here.');
    expect(prompt).toContain('--- TOOLS.md ---');
    expect(prompt).toContain('Tool list here.');
  });

  it('executes normally when no PA files exist', async () => {
    const { runtime, invokeSpy } = makeCapturingRuntime('Hello!');
    const ctx = makeCtx({ runtime, cwd: wsDir });
    const job = makeJob();

    await executeCronJob(job, ctx);

    expect(invokeSpy).toHaveBeenCalledOnce();
    const prompt = invokeSpy.mock.calls[0][0].prompt;
    expect(prompt).toContain('You are executing a scheduled cron job');
    expect(prompt).not.toContain('--- ');

    const guild = (ctx.client as any).guilds.cache.get('guild-1');
    const channel = guild.channels.cache.get('general');
    expect(channel.send).toHaveBeenCalledOnce();
  });

  it('includes only existing PA files (partial set)', async () => {
    await fs.writeFile(path.join(wsDir, 'SOUL.md'), 'Soul content.');
    await fs.writeFile(path.join(wsDir, 'IDENTITY.md'), 'Identity content');

    const { runtime, invokeSpy } = makeCapturingRuntime('Hello!');
    const ctx = makeCtx({ runtime, cwd: wsDir });
    const job = makeJob();

    await executeCronJob(job, ctx);

    expect(invokeSpy).toHaveBeenCalledOnce();
    const prompt = invokeSpy.mock.calls[0][0].prompt;
    expect(prompt).toContain('--- SOUL.md ---');
    expect(prompt).toContain('Soul content.');
    expect(prompt).toContain('--- IDENTITY.md ---');
    expect(prompt).toContain('Identity content');
    expect(prompt).not.toContain('--- USER.md ---');
    expect(prompt).not.toContain('--- TOOLS.md ---');
  });

  it('places PA context before the cron instruction', async () => {
    await fs.writeFile(path.join(wsDir, 'IDENTITY.md'), 'Bot identity here');

    const { runtime, invokeSpy } = makeCapturingRuntime('Hello!');
    const ctx = makeCtx({ runtime, cwd: wsDir });
    const job = makeJob();

    await executeCronJob(job, ctx);

    const prompt = invokeSpy.mock.calls[0][0].prompt;
    const paIndex = prompt.indexOf('--- IDENTITY.md ---');
    const cronIndex = prompt.indexOf('You are executing a scheduled cron job');
    expect(paIndex).toBeGreaterThanOrEqual(0);
    expect(cronIndex).toBeGreaterThan(paIndex);
  });

  it('includes IDENTITY.md alone without errors', async () => {
    await fs.writeFile(path.join(wsDir, 'IDENTITY.md'), 'Just identity');

    const { runtime, invokeSpy } = makeCapturingRuntime('Hello!');
    const ctx = makeCtx({ runtime, cwd: wsDir });
    const job = makeJob();

    await executeCronJob(job, ctx);

    expect(invokeSpy).toHaveBeenCalledOnce();
    const prompt = invokeSpy.mock.calls[0][0].prompt;
    expect(prompt).toContain('--- IDENTITY.md ---');
    expect(prompt).toContain('Just identity');

    const guild = (ctx.client as any).guilds.cache.get('guild-1');
    const channel = guild.channels.cache.get('general');
    expect(channel.send).toHaveBeenCalledOnce();
  });

  it('continues with bare prompt when PA loading throws (try/catch fallback)', async () => {
    vi.mocked(loadWorkspacePaFiles).mockRejectedValueOnce(new Error('disk exploded'));

    const { runtime, invokeSpy } = makeCapturingRuntime('Hello!');
    const ctx = makeCtx({ runtime, cwd: wsDir });
    const job = makeJob();

    await executeCronJob(job, ctx);

    expect(invokeSpy).toHaveBeenCalledOnce();
    const prompt = invokeSpy.mock.calls[0][0].prompt;
    expect(prompt).toContain('You are executing a scheduled cron job');
    expect(prompt).not.toContain('--- ');

    const guild = (ctx.client as any).guilds.cache.get('guild-1');
    const channel = guild.channels.cache.get('general');
    expect(channel.send).toHaveBeenCalledOnce();

    expect(ctx.log?.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: job.id, err: expect.any(Error) }),
      'cron:exec PA file loading failed, continuing without context',
    );
  });
});
