import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ChannelType } from 'discord.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { executeCronJob } from './executor.js';
import { safeCronId } from './job-lock.js';
import { CronRunControl } from './run-control.js';
import { loadRunStats } from './run-stats.js';
import { loadWorkspacePaFiles } from '../discord/prompt-common.js';
import * as discordActions from '../discord/actions.js';
import type { ActionCategoryFlags } from '../discord/actions.js';
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
    triggerType: 'schedule',
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

const BASE_CRON_ACTION_FLAGS: ActionCategoryFlags = {
  channels: false,
  messaging: false,
  guild: false,
  moderation: false,
  polls: false,
  tasks: false,
  crons: false,
  botProfile: false,
  forge: false,
  plan: false,
  memory: false,
  config: false,
  defer: false,
  voice: false,
};

function makeCronActionFlags(overrides?: Partial<ActionCategoryFlags>): ActionCategoryFlags {
  return { ...BASE_CRON_ACTION_FLAGS, ...overrides };
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

  const baseCtx: CronExecutorContext = {
    client: client as any,
    runtime: makeMockRuntime('Hello from cron!'),
    model: 'haiku',
    cwd: '/tmp',
    tools: ['Bash', 'Read', 'Edit', 'WebSearch', 'WebFetch'],
    timeoutMs: 30_000,
    status: null,
    log: mockLog(),
    discordActionsEnabled: false,
    actionFlags: makeCronActionFlags(),
  };

  const ctx: CronExecutorContext = { ...baseCtx, ...overrides };
  ctx.actionFlags = makeCronActionFlags(overrides?.actionFlags);
  return ctx;
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
      taskSyncComplete: vi.fn(),
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
      taskSyncComplete: vi.fn(),
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
      taskSyncComplete: vi.fn(),
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
      taskSyncComplete: vi.fn(),
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
      actionFlags: { channels: false, messaging: true, guild: false, moderation: false, polls: false, tasks: false, crons: false, botProfile: false, forge: false, plan: false, memory: false, config: false, defer: false },
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
      actionFlags: { channels: false, messaging: true, guild: false, moderation: false, polls: false, tasks: false, crons: false, botProfile: false, forge: false, plan: false, memory: false, config: false, defer: false },
    });
    const job = makeJob();
    await executeCronJob(job, ctx);

    const guild = (ctx.client as any).guilds.cache.get('guild-1');
    const channel = guild.channels.cache.get('general');
    // Only one send: the action's sendMessage. No cron output post.
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel.send.mock.calls[0][0].content).toBe('hello');
  });

  it('posts unavailable action notice when action types are stripped', async () => {
    const responseWithUnknownAction = '<discord-action>{"type":"totallyUnknownAction"}</discord-action>';
    const runtime: RuntimeAdapter = {
      id: 'claude_code',
      capabilities: new Set(['streaming_text']),
      async *invoke(): AsyncIterable<EngineEvent> {
        yield { type: 'text_final', text: responseWithUnknownAction };
        yield { type: 'done' };
      },
    };
    const ctx = makeCtx({
      runtime,
      discordActionsEnabled: true,
      actionFlags: { channels: true, messaging: false, guild: false, moderation: false, polls: false, tasks: false, crons: false, botProfile: false, forge: false, plan: false, memory: false, config: false, defer: false },
    });
    const job = makeJob();
    await executeCronJob(job, ctx);

    const guild = (ctx.client as any).guilds.cache.get('guild-1');
    const channel = guild.channels.cache.get('general');
    expect(channel.send).toHaveBeenCalledOnce();
    const outputContent = channel.send.mock.calls[0][0].content;
    expect(outputContent).toContain('Ignored unavailable action type:');
    expect(outputContent).toContain('`totallyUnknownAction`');
  });

  it('passes imagegenCtx to executeDiscordActions when present', async () => {
    const executeDiscordActionsSpy = vi.spyOn(discordActions, 'executeDiscordActions');
    const responseWithAction = '<discord-action>{"type":"generateImage","prompt":"a sunset"}</discord-action>';
    const runtime: RuntimeAdapter = {
      id: 'claude_code',
      capabilities: new Set(['streaming_text']),
      async *invoke(): AsyncIterable<EngineEvent> {
        yield { type: 'text_final', text: responseWithAction };
        yield { type: 'done' };
      },
    };
    const imagegenCtx = { generateImage: vi.fn().mockResolvedValue({ ok: true, url: 'http://example.com/img.png' }) } as any;
    const ctx = makeCtx({
      runtime,
      discordActionsEnabled: true,
      actionFlags: makeCronActionFlags({ imagegen: true } as any),
      imagegenCtx,
    });
    const job = makeJob();
    await executeCronJob(job, ctx);

    expect(executeDiscordActionsSpy).toHaveBeenCalledOnce();
    const subsArg = executeDiscordActionsSpy.mock.calls[0][3];
    expect(subsArg).toMatchObject({ imagegenCtx });

    executeDiscordActionsSpy.mockRestore();
  });

  it('passes voiceCtx to executeDiscordActions when present', async () => {
    const executeDiscordActionsSpy = vi.spyOn(discordActions, 'executeDiscordActions');
    const responseWithAction = '<discord-action>{"type":"voiceStatus"}</discord-action>';
    const runtime: RuntimeAdapter = {
      id: 'claude_code',
      capabilities: new Set(['streaming_text']),
      async *invoke(): AsyncIterable<EngineEvent> {
        yield { type: 'text_final', text: responseWithAction };
        yield { type: 'done' };
      },
    };
    const voiceCtx = { voiceManager: { join: vi.fn(), leave: vi.fn(), getState: vi.fn(), getConnection: vi.fn() } } as any;
    const ctx = makeCtx({
      runtime,
      discordActionsEnabled: true,
      actionFlags: makeCronActionFlags({ voice: true } as any),
      voiceCtx,
    });
    const job = makeJob();
    await executeCronJob(job, ctx);

    expect(executeDiscordActionsSpy).toHaveBeenCalledOnce();
    const subsArg = executeDiscordActionsSpy.mock.calls[0][3];
    expect(subsArg).toMatchObject({ voiceCtx });

    executeDiscordActionsSpy.mockRestore();
  });

  it('suppresses HEARTBEAT_OK output', async () => {
    const ctx = makeCtx({ runtime: makeMockRuntime('HEARTBEAT_OK') });
    const job = makeJob();
    await executeCronJob(job, ctx);

    const guild = (ctx.client as any).guilds.cache.get('guild-1');
    const channel = guild.channels.cache.get('general');
    expect(channel.send).not.toHaveBeenCalled();
    expect(ctx.log?.info).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: job.id, sentinel: 'HEARTBEAT_OK' }),
      'cron:exec sentinel output suppressed',
    );
  });

  it('suppresses (no output) output', async () => {
    const ctx = makeCtx({ runtime: makeMockRuntime('(no output)') });
    const job = makeJob();
    await executeCronJob(job, ctx);

    const guild = (ctx.client as any).guilds.cache.get('guild-1');
    const channel = guild.channels.cache.get('general');
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('does not suppress HEARTBEAT_OK when images are present', async () => {
    const runtime: RuntimeAdapter = {
      id: 'claude_code',
      capabilities: new Set(['streaming_text']),
      async *invoke(): AsyncIterable<EngineEvent> {
        yield { type: 'text_final', text: 'HEARTBEAT_OK' };
        yield { type: 'image_data', image: { mediaType: 'image/png', base64: 'abc123' } };
        yield { type: 'done' };
      },
    };
    const ctx = makeCtx({ runtime });
    const job = makeJob();
    await executeCronJob(job, ctx);

    const guild = (ctx.client as any).guilds.cache.get('guild-1');
    const channel = guild.channels.cache.get('general');
    expect(channel.send).toHaveBeenCalled();
  });

  it('records success in statsStore when sentinel is suppressed', async () => {
    const statsStore = {
      recordRun: vi.fn().mockResolvedValue(undefined),
      recordRunStart: vi.fn().mockResolvedValue(undefined),
      getRecord: vi.fn().mockReturnValue(undefined),
      upsertRecord: vi.fn().mockResolvedValue(undefined),
    } as any;
    const ctx = makeCtx({ runtime: makeMockRuntime('HEARTBEAT_OK'), statsStore });
    const job = makeJob();
    await executeCronJob(job, ctx);

    expect(statsStore.recordRun).toHaveBeenCalledWith('cron-test0001', 'success');
    const guild = (ctx.client as any).guilds.cache.get('guild-1');
    const channel = guild.channels.cache.get('general');
    expect(channel.send).not.toHaveBeenCalled();
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

  it('prompt starts with ## Security Policy when PA files exist', async () => {
    await fs.writeFile(path.join(wsDir, 'SOUL.md'), 'Be helpful.');

    const { runtime, invokeSpy } = makeCapturingRuntime('Hello!');
    const ctx = makeCtx({ runtime, cwd: wsDir });
    const job = makeJob();

    await executeCronJob(job, ctx);

    const prompt = invokeSpy.mock.calls[0][0].prompt;
    expect(prompt).toMatch(/^## Security Policy/);
  });

  it('prompt starts with ## Security Policy when no PA files exist', async () => {
    const { runtime, invokeSpy } = makeCapturingRuntime('Hello!');
    const ctx = makeCtx({ runtime, cwd: wsDir });
    const job = makeJob();

    await executeCronJob(job, ctx);

    const prompt = invokeSpy.mock.calls[0][0].prompt;
    expect(prompt).toMatch(/^## Security Policy/);
  });

  it('uses cronExecModel over ctx.model when set', async () => {
    let invokedModel = '';
    const runtime: RuntimeAdapter = {
      id: 'claude_code',
      capabilities: new Set(['streaming_text']),
      async *invoke(params): AsyncIterable<EngineEvent> {
        invokedModel = params.model;
        yield { type: 'text_final', text: 'ok' };
        yield { type: 'done' };
      },
    };
    const ctx = makeCtx({ runtime, model: 'sonnet', cronExecModel: 'haiku' });
    await executeCronJob(makeJob(), ctx);
    expect(invokedModel).toBe('haiku');
  });

  it('falls back to ctx.model when cronExecModel is not set', async () => {
    let invokedModel = '';
    const runtime: RuntimeAdapter = {
      id: 'claude_code',
      capabilities: new Set(['streaming_text']),
      async *invoke(params): AsyncIterable<EngineEvent> {
        invokedModel = params.model;
        yield { type: 'text_final', text: 'ok' };
        yield { type: 'done' };
      },
    };
    const ctx = makeCtx({ runtime, model: 'sonnet' });
    await executeCronJob(makeJob(), ctx);
    expect(invokedModel).toBe('sonnet');
  });
});

// ---------------------------------------------------------------------------
// Write-ahead status tracking (statsStore integration)
// ---------------------------------------------------------------------------

describe('executeCronJob write-ahead status tracking', () => {
  let statsDir: string;

  beforeEach(async () => {
    statsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'executor-stats-'));
  });

  afterEach(async () => {
    await fs.rm(statsDir, { recursive: true, force: true });
  });

  it('writes running status before execution and success after', async () => {
    const statsPath = path.join(statsDir, 'stats.json');
    const statsStore = await loadRunStats(statsPath);
    await statsStore.upsertRecord('cron-test0001', 'thread-1');

    const recordRunStartSpy = vi.spyOn(statsStore, 'recordRunStart');
    const recordRunSpy = vi.spyOn(statsStore, 'recordRun');

    const ctx = makeCtx({ statsStore });
    const job = makeJob();
    await executeCronJob(job, ctx);

    expect(recordRunStartSpy).toHaveBeenCalledWith('cron-test0001');
    expect(recordRunSpy).toHaveBeenCalledWith('cron-test0001', 'success');

    // recordRunStart must be called before recordRun.
    const startOrder = recordRunStartSpy.mock.invocationCallOrder[0];
    const runOrder = recordRunSpy.mock.invocationCallOrder[0];
    expect(startOrder).toBeLessThan(runOrder);
  });

  it('writes running status then error on runtime error', async () => {
    const statsPath = path.join(statsDir, 'stats.json');
    const statsStore = await loadRunStats(statsPath);
    await statsStore.upsertRecord('cron-test0001', 'thread-1');

    const recordRunStartSpy = vi.spyOn(statsStore, 'recordRunStart');
    const recordRunSpy = vi.spyOn(statsStore, 'recordRun');

    const ctx = makeCtx({ statsStore, runtime: makeMockRuntimeError('timeout') });
    const job = makeJob();
    await executeCronJob(job, ctx);

    expect(recordRunStartSpy).toHaveBeenCalledWith('cron-test0001');
    expect(recordRunSpy).toHaveBeenCalledWith('cron-test0001', 'error', 'timeout');
  });

  it('persists running status mid-run (visible to a concurrent reader)', async () => {
    const statsPath = path.join(statsDir, 'stats.json');
    const statsStore = await loadRunStats(statsPath);
    await statsStore.upsertRecord('cron-test0001', 'thread-1');

    let statusDuringRun: string | null | undefined = null;
    const runtime: RuntimeAdapter = {
      id: 'claude_code',
      capabilities: new Set(['streaming_text']),
      async *invoke(): AsyncIterable<EngineEvent> {
        // Read the on-disk status mid-run to verify the write-ahead record exists.
        const onDisk = await loadRunStats(statsPath);
        statusDuringRun = onDisk.getRecord('cron-test0001')?.lastRunStatus ?? null;
        yield { type: 'text_final', text: 'done' };
        yield { type: 'done' };
      },
    };

    const ctx = makeCtx({ statsStore, runtime });
    await executeCronJob(makeJob(), ctx);

    expect(statusDuringRun).toBe('running');
  });

  it('skips recordRunStart when statsStore is not set', async () => {
    const ctx = makeCtx(); // no statsStore
    const job = makeJob();
    // Should complete without error — no statsStore means no-op on stats paths.
    await expect(executeCronJob(job, ctx)).resolves.toBeUndefined();
  });

  it('execution continues when recordRunStart throws', async () => {
    const statsPath = path.join(statsDir, 'stats.json');
    const statsStore = await loadRunStats(statsPath);
    await statsStore.upsertRecord('cron-test0001', 'thread-1');

    vi.spyOn(statsStore, 'recordRunStart').mockRejectedValueOnce(new Error('disk full'));
    const recordRunSpy = vi.spyOn(statsStore, 'recordRun');

    const ctx = makeCtx({ statsStore });
    const job = makeJob();
    await executeCronJob(job, ctx);

    // Execution should complete and post to channel despite recordRunStart failing.
    const guild = (ctx.client as any).guilds.cache.get('guild-1');
    const channel = guild.channels.cache.get('general');
    expect(channel.send).toHaveBeenCalledOnce();
    expect(recordRunSpy).toHaveBeenCalledWith('cron-test0001', 'success');
  });

  it('records success when output is empty and statsStore is set', async () => {
    const statsPath = path.join(statsDir, 'stats.json');
    const statsStore = await loadRunStats(statsPath);
    await statsStore.upsertRecord('cron-test0001', 'thread-1');

    const ctx = makeCtx({ statsStore, runtime: makeMockRuntime('') });
    const job = makeJob();
    await executeCronJob(job, ctx);

    const rec = statsStore.getRecord('cron-test0001');
    expect(rec?.lastRunStatus).toBe('success');
  });
});

// ---------------------------------------------------------------------------
// Silent mode suppression
// ---------------------------------------------------------------------------

describe('executeCronJob silent mode', () => {
  let statsDir: string;

  beforeEach(async () => {
    statsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'executor-silent-'));
  });

  afterEach(async () => {
    await fs.rm(statsDir, { recursive: true, force: true });
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

  it('injects HEARTBEAT_OK instruction into the prompt when silent is true', async () => {
    const statsPath = path.join(statsDir, 'stats.json');
    const statsStore = await loadRunStats(statsPath);
    await statsStore.upsertRecord('cron-test0001', 'thread-1', { silent: true });

    const { runtime, invokeSpy } = makeCapturingRuntime('Hello!');
    const ctx = makeCtx({ statsStore, runtime });
    const job = makeJob();

    await executeCronJob(job, ctx);

    expect(invokeSpy).toHaveBeenCalledOnce();
    const prompt = invokeSpy.mock.calls[0][0].prompt;
    expect(prompt).toContain('respond with exactly `HEARTBEAT_OK`');
  });

  it('suppresses short responses under the threshold when silent is true', async () => {
    const statsPath = path.join(statsDir, 'stats.json');
    const statsStore = await loadRunStats(statsPath);
    await statsStore.upsertRecord('cron-test0001', 'thread-1', { silent: true });

    const ctx = makeCtx({ statsStore, runtime: makeMockRuntime('No task-labeled emails found.') });
    const job = makeJob();

    await executeCronJob(job, ctx);

    const guild = (ctx.client as any).guilds.cache.get('guild-1');
    const channel = guild.channels.cache.get('general');
    expect(channel.send).not.toHaveBeenCalled();
    expect(ctx.log?.info).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: job.id, name: job.name }),
      'cron:exec silent short-response suppressed',
    );
  });

  it('does NOT suppress longer substantive responses when silent is true', async () => {
    const statsPath = path.join(statsDir, 'stats.json');
    const statsStore = await loadRunStats(statsPath);
    await statsStore.upsertRecord('cron-test0001', 'thread-1', { silent: true });

    const longResponse = 'Here is a detailed summary of the tasks completed today, including several important updates that need your attention.';
    const ctx = makeCtx({ statsStore, runtime: makeMockRuntime(longResponse) });
    const job = makeJob();

    await executeCronJob(job, ctx);

    const guild = (ctx.client as any).guilds.cache.get('guild-1');
    const channel = guild.channels.cache.get('general');
    expect(channel.send).toHaveBeenCalledOnce();
    expect(channel.send.mock.calls[0][0].content).toContain(longResponse);
  });

  it('does not apply short-response gate when silent is false', async () => {
    const statsPath = path.join(statsDir, 'stats.json');
    const statsStore = await loadRunStats(statsPath);
    await statsStore.upsertRecord('cron-test0001', 'thread-1', { silent: false });

    const ctx = makeCtx({ statsStore, runtime: makeMockRuntime('No emails found.') });
    const job = makeJob();

    await executeCronJob(job, ctx);

    const guild = (ctx.client as any).guilds.cache.get('guild-1');
    const channel = guild.channels.cache.get('general');
    expect(channel.send).toHaveBeenCalledOnce();
  });

  it('does NOT suppress short text when images are present (silent mode)', async () => {
    const statsPath = path.join(statsDir, 'stats.json');
    const statsStore = await loadRunStats(statsPath);
    await statsStore.upsertRecord('cron-test0001', 'thread-1', { silent: true });

    const runtime: RuntimeAdapter = {
      id: 'claude_code',
      capabilities: new Set(['streaming_text']),
      async *invoke(): AsyncIterable<EngineEvent> {
        yield { type: 'text_final', text: 'Short.' };
        yield { type: 'image_data', image: { mediaType: 'image/png', base64: 'abc123' } };
        yield { type: 'done' };
      },
    };
    const ctx = makeCtx({ statsStore, runtime });
    const job = makeJob();

    await executeCronJob(job, ctx);

    const guild = (ctx.client as any).guilds.cache.get('guild-1');
    const channel = guild.channels.cache.get('general');
    expect(channel.send).toHaveBeenCalled();
  });

  it('records success in statsStore when silent short-response is suppressed', async () => {
    const statsPath = path.join(statsDir, 'stats.json');
    const statsStore = await loadRunStats(statsPath);
    await statsStore.upsertRecord('cron-test0001', 'thread-1', { silent: true });

    const recordRunSpy = vi.spyOn(statsStore, 'recordRun');
    const ctx = makeCtx({ statsStore, runtime: makeMockRuntime('Nothing to report.') });
    const job = makeJob();

    await executeCronJob(job, ctx);

    expect(recordRunSpy).toHaveBeenCalledWith('cron-test0001', 'success');
    const guild = (ctx.client as any).guilds.cache.get('guild-1');
    const channel = guild.channels.cache.get('general');
    expect(channel.send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// allowedActions filtering
// ---------------------------------------------------------------------------

describe('executeCronJob allowedActions filtering', () => {
  let statsDir: string;

  beforeEach(async () => {
    statsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'executor-allowed-actions-'));
  });

  afterEach(async () => {
    await fs.rm(statsDir, { recursive: true, force: true });
  });

  it('executes permitted action and blocks denied action when allowedActions is set', async () => {
    const statsPath = path.join(statsDir, 'stats.json');
    const statsStore = await loadRunStats(statsPath);
    await statsStore.upsertRecord('cron-test0001', 'thread-1', { allowedActions: ['sendMessage'] });

    const executeDiscordActionsSpy = vi.spyOn(discordActions, 'executeDiscordActions');

    // Response with sendMessage (permitted) + channelCreate (blocked).
    const responseWithActions = [
      'Doing some work.',
      '<discord-action>{"type":"sendMessage","channel":"general","content":"hello"}</discord-action>',
      '<discord-action>{"type":"channelCreate","name":"new-channel"}</discord-action>',
    ].join('\n');

    const runtime: RuntimeAdapter = {
      id: 'claude_code',
      capabilities: new Set(['streaming_text']),
      async *invoke(): AsyncIterable<EngineEvent> {
        yield { type: 'text_final', text: responseWithActions };
        yield { type: 'done' };
      },
    };

    const ctx = makeCtx({
      runtime,
      statsStore,
      discordActionsEnabled: true,
      actionFlags: makeCronActionFlags({ messaging: true, channels: true }),
    });
    const job = makeJob();
    await executeCronJob(job, ctx);

    // Only sendMessage should have been passed to executeDiscordActions.
    expect(executeDiscordActionsSpy).toHaveBeenCalledOnce();
    const actionsArg = executeDiscordActionsSpy.mock.calls[0][0];
    expect(actionsArg).toHaveLength(1);
    expect(actionsArg[0].type).toBe('sendMessage');

    // Blocked action should have been logged.
    expect(ctx.log?.warn).toHaveBeenCalledWith(
      expect.objectContaining({ actionType: 'channelCreate' }),
      'cron:exec action blocked by allowedActions',
    );

    // Output should contain blocked notice.
    const guild = (ctx.client as any).guilds.cache.get('guild-1');
    const channel = guild.channels.cache.get('general');
    const allContent = channel.send.mock.calls.map((c: any) => c[0].content).join('\n');
    expect(allContent).toContain('Blocked action `channelCreate`');

    executeDiscordActionsSpy.mockRestore();
  });

  it('executes all actions when allowedActions is undefined', async () => {
    const statsPath = path.join(statsDir, 'stats.json');
    const statsStore = await loadRunStats(statsPath);
    // No allowedActions set — all actions should pass through.
    await statsStore.upsertRecord('cron-test0001', 'thread-1');

    const executeDiscordActionsSpy = vi.spyOn(discordActions, 'executeDiscordActions');

    const responseWithActions = [
      'Doing some work.',
      '<discord-action>{"type":"sendMessage","channel":"general","content":"hello"}</discord-action>',
    ].join('\n');

    const runtime: RuntimeAdapter = {
      id: 'claude_code',
      capabilities: new Set(['streaming_text']),
      async *invoke(): AsyncIterable<EngineEvent> {
        yield { type: 'text_final', text: responseWithActions };
        yield { type: 'done' };
      },
    };

    const ctx = makeCtx({
      runtime,
      statsStore,
      discordActionsEnabled: true,
      actionFlags: makeCronActionFlags({ messaging: true }),
    });
    const job = makeJob();
    await executeCronJob(job, ctx);

    // All parsed actions should be executed unfiltered.
    expect(executeDiscordActionsSpy).toHaveBeenCalledOnce();
    const actionsArg = executeDiscordActionsSpy.mock.calls[0][0];
    expect(actionsArg).toHaveLength(1);
    expect(actionsArg[0].type).toBe('sendMessage');

    // No blocked-action warnings.
    const warnCalls = (ctx.log?.warn as ReturnType<typeof vi.fn>).mock.calls;
    const blockedWarn = warnCalls.find((c: any[]) => c[1] === 'cron:exec action blocked by allowedActions');
    expect(blockedWarn).toBeUndefined();

    executeDiscordActionsSpy.mockRestore();
  });
});
