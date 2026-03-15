import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  writeShutdownContext,
  patchShutdownContext,
  readAndClearShutdownContext,
  formatStartupInjection,
} from './shutdown-context.js';
import type { ShutdownContext, StartupContext } from './shutdown-context.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shutdown-ctx-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('writeShutdownContext', () => {
  it('writes a valid JSON file', async () => {
    const ctx: ShutdownContext = {
      reason: 'restart-command',
      message: 'User requested via !restart',
      timestamp: '2026-02-13T00:00:00.000Z',
      requestedBy: '12345',
    };
    await writeShutdownContext(tmpDir, ctx);

    const raw = await fs.readFile(path.join(tmpDir, 'shutdown-context.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.reason).toBe('restart-command');
    expect(parsed.requestedBy).toBe('12345');
    expect(parsed.message).toBe('User requested via !restart');
  });

  it('does not leave tmp files on success', async () => {
    await writeShutdownContext(tmpDir, {
      reason: 'unknown',
      timestamp: new Date().toISOString(),
    });

    const files = await fs.readdir(tmpDir);
    expect(files).toEqual(['shutdown-context.json']);
  });

  it('overwrites existing file by default', async () => {
    await writeShutdownContext(tmpDir, {
      reason: 'restart-command',
      timestamp: '2026-02-13T00:00:00.000Z',
    });
    await writeShutdownContext(tmpDir, {
      reason: 'unknown',
      timestamp: '2026-02-13T00:01:00.000Z',
    });

    const raw = await fs.readFile(path.join(tmpDir, 'shutdown-context.json'), 'utf-8');
    expect(JSON.parse(raw).reason).toBe('unknown');
  });

  it('skips write when skipIfExists is true and file exists', async () => {
    await writeShutdownContext(tmpDir, {
      reason: 'restart-command',
      message: 'rich context',
      timestamp: '2026-02-13T00:00:00.000Z',
    });
    await writeShutdownContext(
      tmpDir,
      { reason: 'unknown', timestamp: '2026-02-13T00:01:00.000Z' },
      { skipIfExists: true },
    );

    const raw = await fs.readFile(path.join(tmpDir, 'shutdown-context.json'), 'utf-8');
    expect(JSON.parse(raw).reason).toBe('restart-command');
    expect(JSON.parse(raw).message).toBe('rich context');
  });

  it('writes when skipIfExists is true but no file exists', async () => {
    await writeShutdownContext(
      tmpDir,
      { reason: 'unknown', timestamp: '2026-02-13T00:00:00.000Z' },
      { skipIfExists: true },
    );

    const raw = await fs.readFile(path.join(tmpDir, 'shutdown-context.json'), 'utf-8');
    expect(JSON.parse(raw).reason).toBe('unknown');
  });
});

describe('patchShutdownContext', () => {
  it('merges cancelledDefers into existing context', async () => {
    await writeShutdownContext(tmpDir, {
      reason: 'restart-command',
      message: 'User requested via !restart',
      timestamp: '2026-02-13T00:00:00.000Z',
      requestedBy: '12345',
    });
    await patchShutdownContext(tmpDir, { cancelledDefers: 3 });

    const raw = await fs.readFile(path.join(tmpDir, 'shutdown-context.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.reason).toBe('restart-command');
    expect(parsed.requestedBy).toBe('12345');
    expect(parsed.cancelledDefers).toBe(3);
  });

  it('is a no-op when no file exists', async () => {
    await patchShutdownContext(tmpDir, { cancelledDefers: 5 });

    const files = await fs.readdir(tmpDir);
    expect(files).toEqual([]);
  });

  it('is a no-op when file contains corrupted JSON', async () => {
    await fs.writeFile(path.join(tmpDir, 'shutdown-context.json'), 'not json!!!', 'utf-8');
    await patchShutdownContext(tmpDir, { cancelledDefers: 2 });

    const raw = await fs.readFile(path.join(tmpDir, 'shutdown-context.json'), 'utf-8');
    expect(raw).toBe('not json!!!');
  });

  it('is a no-op when file contains non-object JSON', async () => {
    await fs.writeFile(path.join(tmpDir, 'shutdown-context.json'), '"hello"', 'utf-8');
    await patchShutdownContext(tmpDir, { cancelledDefers: 2 });

    const raw = await fs.readFile(path.join(tmpDir, 'shutdown-context.json'), 'utf-8');
    expect(raw).toBe('"hello"');
  });

  it('merges cancelledSpawns into existing context', async () => {
    await writeShutdownContext(tmpDir, {
      reason: 'restart-command',
      message: 'User requested via !restart',
      timestamp: '2026-02-13T00:00:00.000Z',
      requestedBy: '12345',
    });
    await patchShutdownContext(tmpDir, { cancelledSpawns: 2 });

    const raw = await fs.readFile(path.join(tmpDir, 'shutdown-context.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.reason).toBe('restart-command');
    expect(parsed.requestedBy).toBe('12345');
    expect(parsed.cancelledSpawns).toBe(2);
  });

  it('preserves all existing fields when patching', async () => {
    await writeShutdownContext(tmpDir, {
      reason: 'deploy',
      message: 'rolling update',
      timestamp: '2026-02-13T00:00:00.000Z',
      activeForge: 'plan-037',
    });
    await patchShutdownContext(tmpDir, { cancelledDefers: 1 });

    const raw = await fs.readFile(path.join(tmpDir, 'shutdown-context.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.reason).toBe('deploy');
    expect(parsed.message).toBe('rolling update');
    expect(parsed.activeForge).toBe('plan-037');
    expect(parsed.cancelledDefers).toBe(1);
  });
});

describe('readAndClearShutdownContext', () => {
  it('returns crash when no file exists', async () => {
    const result = await readAndClearShutdownContext(tmpDir);
    expect(result.type).toBe('crash');
    expect(result.shutdown).toBeUndefined();
  });

  it('returns first-boot when no file exists and firstBoot hint is set', async () => {
    const result = await readAndClearShutdownContext(tmpDir, { firstBoot: true });
    expect(result.type).toBe('first-boot');
    expect(result.shutdown).toBeUndefined();
  });

  it('ignores firstBoot hint when file exists', async () => {
    await writeShutdownContext(tmpDir, {
      reason: 'restart-command',
      timestamp: '2026-02-13T00:00:00.000Z',
    });
    const result = await readAndClearShutdownContext(tmpDir, { firstBoot: true });
    expect(result.type).toBe('intentional');
  });

  it('returns graceful-unknown for reason: unknown', async () => {
    await writeShutdownContext(tmpDir, {
      reason: 'unknown',
      timestamp: '2026-02-13T00:00:00.000Z',
    });

    const result = await readAndClearShutdownContext(tmpDir);
    expect(result.type).toBe('graceful-unknown');
    expect(result.shutdown?.reason).toBe('unknown');
  });

  it('returns intentional for reason: restart-command', async () => {
    await writeShutdownContext(tmpDir, {
      reason: 'restart-command',
      message: 'User requested',
      timestamp: '2026-02-13T00:00:00.000Z',
      requestedBy: '99999',
    });

    const result = await readAndClearShutdownContext(tmpDir);
    expect(result.type).toBe('intentional');
    expect(result.shutdown?.reason).toBe('restart-command');
    expect(result.shutdown?.requestedBy).toBe('99999');
  });

  it('returns intentional for reason: deploy', async () => {
    await writeShutdownContext(tmpDir, {
      reason: 'deploy',
      timestamp: '2026-02-13T00:00:00.000Z',
    });

    const result = await readAndClearShutdownContext(tmpDir);
    expect(result.type).toBe('intentional');
  });

  it('deletes the file after reading', async () => {
    await writeShutdownContext(tmpDir, {
      reason: 'restart-command',
      timestamp: '2026-02-13T00:00:00.000Z',
    });

    await readAndClearShutdownContext(tmpDir);

    const files = await fs.readdir(tmpDir);
    expect(files).toEqual([]);
  });

  it('returns crash for corrupted JSON', async () => {
    await fs.writeFile(path.join(tmpDir, 'shutdown-context.json'), 'not json!!!', 'utf-8');
    const result = await readAndClearShutdownContext(tmpDir);
    expect(result.type).toBe('crash');
  });

  it.each([
    ['null', 'null'],
    ['string', '"hello"'],
    ['number', '42'],
    ['array', '[1,2,3]'],
  ])('returns crash for valid JSON that is %s', async (_label, json) => {
    await fs.writeFile(path.join(tmpDir, 'shutdown-context.json'), json, 'utf-8');
    const result = await readAndClearShutdownContext(tmpDir);
    expect(result.type).toBe('crash');
  });

  it('preserves activeForge in shutdown context', async () => {
    await writeShutdownContext(tmpDir, {
      reason: 'restart-command',
      timestamp: '2026-02-13T00:00:00.000Z',
      activeForge: 'plan-037',
    });

    const result = await readAndClearShutdownContext(tmpDir);
    expect(result.shutdown?.activeForge).toBe('plan-037');
  });

  it('classifies unrecognized reason as graceful-unknown', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'shutdown-context.json'),
      JSON.stringify({ reason: 'banana', timestamp: '2026-02-13T00:00:00.000Z' }),
    );
    const result = await readAndClearShutdownContext(tmpDir);
    expect(result.type).toBe('graceful-unknown');
    expect(result.shutdown?.reason).toBe('unknown');
  });

  it('classifies missing reason as graceful-unknown', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'shutdown-context.json'),
      JSON.stringify({ timestamp: '2026-02-13T00:00:00.000Z' }),
    );
    const result = await readAndClearShutdownContext(tmpDir);
    expect(result.type).toBe('graceful-unknown');
  });

  it('preserves cancelledDefers in shutdown context', async () => {
    await writeShutdownContext(tmpDir, {
      reason: 'restart-command',
      timestamp: '2026-02-13T00:00:00.000Z',
      cancelledDefers: 3,
    });

    const result = await readAndClearShutdownContext(tmpDir);
    expect(result.shutdown?.cancelledDefers).toBe(3);
  });

  it('preserves cancelledLoops in shutdown context', async () => {
    await writeShutdownContext(tmpDir, {
      reason: 'restart-command',
      timestamp: '2026-02-13T00:00:00.000Z',
      cancelledLoops: 2,
    });

    const result = await readAndClearShutdownContext(tmpDir);
    expect(result.shutdown?.cancelledLoops).toBe(2);
  });

  it('reads cancelledDefers patched into existing context', async () => {
    await writeShutdownContext(tmpDir, {
      reason: 'restart-command',
      message: 'User requested via !restart',
      timestamp: '2026-02-13T00:00:00.000Z',
    });
    await patchShutdownContext(tmpDir, { cancelledDefers: 5 });

    const result = await readAndClearShutdownContext(tmpDir);
    expect(result.type).toBe('intentional');
    expect(result.shutdown?.cancelledDefers).toBe(5);
    expect(result.shutdown?.message).toBe('User requested via !restart');
  });

  it('reads cancelledLoops patched into existing context', async () => {
    await writeShutdownContext(tmpDir, {
      reason: 'restart-command',
      message: 'User requested via !restart',
      timestamp: '2026-02-13T00:00:00.000Z',
    });
    await patchShutdownContext(tmpDir, { cancelledLoops: 4 });

    const result = await readAndClearShutdownContext(tmpDir);
    expect(result.type).toBe('intentional');
    expect(result.shutdown?.cancelledLoops).toBe(4);
    expect(result.shutdown?.message).toBe('User requested via !restart');
  });

  it('ignores cancelledDefers when zero', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'shutdown-context.json'),
      JSON.stringify({ reason: 'restart-command', timestamp: '', cancelledDefers: 0 }),
    );
    const result = await readAndClearShutdownContext(tmpDir);
    expect(result.shutdown?.cancelledDefers).toBeUndefined();
  });

  it('ignores cancelledDefers when negative', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'shutdown-context.json'),
      JSON.stringify({ reason: 'restart-command', timestamp: '', cancelledDefers: -1 }),
    );
    const result = await readAndClearShutdownContext(tmpDir);
    expect(result.shutdown?.cancelledDefers).toBeUndefined();
  });

  it('ignores cancelledDefers when not a number', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'shutdown-context.json'),
      JSON.stringify({ reason: 'restart-command', timestamp: '', cancelledDefers: 'three' }),
    );
    const result = await readAndClearShutdownContext(tmpDir);
    expect(result.shutdown?.cancelledDefers).toBeUndefined();
  });

  it('floors fractional cancelledDefers', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'shutdown-context.json'),
      JSON.stringify({ reason: 'restart-command', timestamp: '', cancelledDefers: 2.7 }),
    );
    const result = await readAndClearShutdownContext(tmpDir);
    expect(result.shutdown?.cancelledDefers).toBe(2);
  });

  it('ignores cancelledLoops when zero', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'shutdown-context.json'),
      JSON.stringify({ reason: 'restart-command', timestamp: '', cancelledLoops: 0 }),
    );
    const result = await readAndClearShutdownContext(tmpDir);
    expect(result.shutdown?.cancelledLoops).toBeUndefined();
  });

  it('ignores cancelledLoops when negative', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'shutdown-context.json'),
      JSON.stringify({ reason: 'restart-command', timestamp: '', cancelledLoops: -1 }),
    );
    const result = await readAndClearShutdownContext(tmpDir);
    expect(result.shutdown?.cancelledLoops).toBeUndefined();
  });

  it('ignores cancelledLoops when not a number', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'shutdown-context.json'),
      JSON.stringify({ reason: 'restart-command', timestamp: '', cancelledLoops: 'three' }),
    );
    const result = await readAndClearShutdownContext(tmpDir);
    expect(result.shutdown?.cancelledLoops).toBeUndefined();
  });

  it('floors fractional cancelledLoops', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'shutdown-context.json'),
      JSON.stringify({ reason: 'restart-command', timestamp: '', cancelledLoops: 2.7 }),
    );
    const result = await readAndClearShutdownContext(tmpDir);
    expect(result.shutdown?.cancelledLoops).toBe(2);
  });

  it('preserves cancelledSpawns in shutdown context', async () => {
    await writeShutdownContext(tmpDir, {
      reason: 'restart-command',
      timestamp: '2026-02-13T00:00:00.000Z',
      cancelledSpawns: 4,
    });

    const result = await readAndClearShutdownContext(tmpDir);
    expect(result.shutdown?.cancelledSpawns).toBe(4);
  });

  it('reads cancelledSpawns patched into existing context', async () => {
    await writeShutdownContext(tmpDir, {
      reason: 'restart-command',
      message: 'User requested via !restart',
      timestamp: '2026-02-13T00:00:00.000Z',
    });
    await patchShutdownContext(tmpDir, { cancelledSpawns: 3 });

    const result = await readAndClearShutdownContext(tmpDir);
    expect(result.type).toBe('intentional');
    expect(result.shutdown?.cancelledSpawns).toBe(3);
    expect(result.shutdown?.message).toBe('User requested via !restart');
  });

  it('ignores cancelledSpawns when zero', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'shutdown-context.json'),
      JSON.stringify({ reason: 'restart-command', timestamp: '', cancelledSpawns: 0 }),
    );
    const result = await readAndClearShutdownContext(tmpDir);
    expect(result.shutdown?.cancelledSpawns).toBeUndefined();
  });

  it('ignores cancelledSpawns when negative', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'shutdown-context.json'),
      JSON.stringify({ reason: 'restart-command', timestamp: '', cancelledSpawns: -2 }),
    );
    const result = await readAndClearShutdownContext(tmpDir);
    expect(result.shutdown?.cancelledSpawns).toBeUndefined();
  });

  it('ignores cancelledSpawns when not a number', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'shutdown-context.json'),
      JSON.stringify({ reason: 'restart-command', timestamp: '', cancelledSpawns: 'five' }),
    );
    const result = await readAndClearShutdownContext(tmpDir);
    expect(result.shutdown?.cancelledSpawns).toBeUndefined();
  });

  it('floors fractional cancelledSpawns', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'shutdown-context.json'),
      JSON.stringify({ reason: 'restart-command', timestamp: '', cancelledSpawns: 3.9 }),
    );
    const result = await readAndClearShutdownContext(tmpDir);
    expect(result.shutdown?.cancelledSpawns).toBe(3);
  });

  it('truncates oversized message and activeForge fields', async () => {
    const long = 'x'.repeat(1000);
    await fs.writeFile(
      path.join(tmpDir, 'shutdown-context.json'),
      JSON.stringify({ reason: 'restart-command', timestamp: '', message: long, activeForge: long }),
    );
    const result = await readAndClearShutdownContext(tmpDir);
    expect(result.shutdown?.message?.length).toBe(500);
    expect(result.shutdown?.activeForge?.length).toBe(500);
  });
});

describe('formatStartupInjection', () => {
  it('formats intentional restart', () => {
    const ctx: StartupContext = {
      type: 'intentional',
      shutdown: {
        reason: 'restart-command',
        message: 'User requested via !restart',
        timestamp: '2026-02-13T00:00:00.000Z',
        requestedBy: '12345',
      },
    };
    const result = formatStartupInjection(ctx);
    expect(result).toContain('restarted via !restart');
    expect(result).toContain('<@12345>');
    expect(result).toContain('User requested via !restart');
  });

  it('formats intentional restart without requestedBy', () => {
    const ctx: StartupContext = {
      type: 'intentional',
      shutdown: {
        reason: 'restart-command',
        timestamp: '2026-02-13T00:00:00.000Z',
      },
    };
    const result = formatStartupInjection(ctx);
    expect(result).toContain('restarted via !restart');
    expect(result).not.toContain('<@');
  });

  it('formats deploy reason correctly', () => {
    const ctx: StartupContext = {
      type: 'intentional',
      shutdown: {
        reason: 'deploy',
        timestamp: '2026-02-13T00:00:00.000Z',
      },
    };
    const result = formatStartupInjection(ctx);
    expect(result).toContain('restarted for a deploy');
    expect(result).not.toContain('!restart');
  });

  it('formats code-fix reason correctly', () => {
    const ctx: StartupContext = {
      type: 'intentional',
      shutdown: {
        reason: 'code-fix',
        message: 'Applied hotfix for memory leak',
        timestamp: '2026-02-13T00:00:00.000Z',
      },
    };
    const result = formatStartupInjection(ctx);
    expect(result).toContain('apply a code fix');
    expect(result).toContain('Applied hotfix for memory leak');
    expect(result).not.toContain('!restart');
  });

  it('returns null for first-boot', () => {
    const ctx: StartupContext = { type: 'first-boot' };
    expect(formatStartupInjection(ctx)).toBeNull();
  });

  it('formats graceful-unknown', () => {
    const ctx: StartupContext = {
      type: 'graceful-unknown',
      shutdown: {
        reason: 'unknown',
        timestamp: '2026-02-13T00:00:00.000Z',
      },
    };
    const result = formatStartupInjection(ctx);
    expect(result).toContain('graceful shutdown');
    expect(result).toContain('reason unknown');
  });

  it('formats crash', () => {
    const ctx: StartupContext = { type: 'crash' };
    const result = formatStartupInjection(ctx);
    expect(result).toContain('crashed or been killed');
    expect(result).toContain('journalctl');
  });

  it('appends active forge info when present', () => {
    const ctx: StartupContext = {
      type: 'intentional',
      shutdown: {
        reason: 'restart-command',
        timestamp: '2026-02-13T00:00:00.000Z',
        activeForge: 'plan-037',
      },
    };
    const result = formatStartupInjection(ctx);
    expect(result).toContain('plan-037');
    expect(result).toContain('forge run was in progress');
  });

  it('appends active forge info for crash type', () => {
    // Crash with forge info shouldn't happen (no file = no forge info),
    // but the formatter handles it gracefully.
    const ctx: StartupContext = {
      type: 'crash',
      shutdown: {
        reason: 'unknown',
        timestamp: '2026-02-13T00:00:00.000Z',
        activeForge: 'plan-042',
      },
    };
    const result = formatStartupInjection(ctx);
    expect(result).toContain('plan-042');
  });

  it('appends cancelled defers info (singular) when cancelledDefers is 1', () => {
    const ctx: StartupContext = {
      type: 'intentional',
      shutdown: {
        reason: 'restart-command',
        timestamp: '2026-02-13T00:00:00.000Z',
        cancelledDefers: 1,
      },
    };
    const result = formatStartupInjection(ctx);
    expect(result).toContain('1 deferred action was cancelled and did not run.');
  });

  it('appends cancelled defers info (plural) when cancelledDefers > 1', () => {
    const ctx: StartupContext = {
      type: 'intentional',
      shutdown: {
        reason: 'restart-command',
        timestamp: '2026-02-13T00:00:00.000Z',
        cancelledDefers: 3,
      },
    };
    const result = formatStartupInjection(ctx);
    expect(result).toContain('3 deferred actions were cancelled and did not run.');
  });

  it('appends cancelled loops info (singular) when cancelledLoops is 1', () => {
    const ctx: StartupContext = {
      type: 'intentional',
      shutdown: {
        reason: 'restart-command',
        timestamp: '2026-02-13T00:00:00.000Z',
        cancelledLoops: 1,
      },
    };
    const result = formatStartupInjection(ctx);
    expect(result).toContain('1 repeating loop was cancelled and will not run again.');
  });

  it('appends cancelled loops info (plural) when cancelledLoops > 1', () => {
    const ctx: StartupContext = {
      type: 'intentional',
      shutdown: {
        reason: 'restart-command',
        timestamp: '2026-02-13T00:00:00.000Z',
        cancelledLoops: 3,
      },
    };
    const result = formatStartupInjection(ctx);
    expect(result).toContain('3 repeating loops were cancelled and will not run again.');
  });

  it('does not mention cancelled defers when count is 0 or absent', () => {
    const ctx: StartupContext = {
      type: 'intentional',
      shutdown: {
        reason: 'restart-command',
        timestamp: '2026-02-13T00:00:00.000Z',
      },
    };
    const result = formatStartupInjection(ctx);
    expect(result).not.toContain('deferred action');
  });

  it('does not mention cancelled loops when count is 0 or absent', () => {
    const ctx: StartupContext = {
      type: 'intentional',
      shutdown: {
        reason: 'restart-command',
        timestamp: '2026-02-13T00:00:00.000Z',
      },
    };
    const result = formatStartupInjection(ctx);
    expect(result).not.toContain('repeating loop');
  });

  it('includes both forge and cancelled defers when both present', () => {
    const ctx: StartupContext = {
      type: 'intentional',
      shutdown: {
        reason: 'restart-command',
        timestamp: '2026-02-13T00:00:00.000Z',
        activeForge: 'plan-037',
        cancelledDefers: 2,
      },
    };
    const result = formatStartupInjection(ctx);
    expect(result).toContain('plan-037');
    expect(result).toContain('2 deferred actions were cancelled');
  });

  it('includes both cancelled defers and cancelled loops when both present', () => {
    const ctx: StartupContext = {
      type: 'intentional',
      shutdown: {
        reason: 'restart-command',
        timestamp: '2026-02-13T00:00:00.000Z',
        cancelledDefers: 2,
        cancelledLoops: 3,
      },
    };
    const result = formatStartupInjection(ctx);
    expect(result).toContain('2 deferred actions were cancelled');
    expect(result).toContain('3 repeating loops were cancelled');
  });

  it('appends cancelled spawns info (singular) when cancelledSpawns is 1', () => {
    const ctx: StartupContext = {
      type: 'intentional',
      shutdown: {
        reason: 'restart-command',
        timestamp: '2026-02-13T00:00:00.000Z',
        cancelledSpawns: 1,
      },
    };
    const result = formatStartupInjection(ctx);
    expect(result).toContain('1 spawned agent was cancelled and did not complete.');
  });

  it('appends cancelled spawns info (plural) when cancelledSpawns > 1', () => {
    const ctx: StartupContext = {
      type: 'intentional',
      shutdown: {
        reason: 'restart-command',
        timestamp: '2026-02-13T00:00:00.000Z',
        cancelledSpawns: 5,
      },
    };
    const result = formatStartupInjection(ctx);
    expect(result).toContain('5 spawned agents were cancelled and did not complete.');
  });

  it('does not mention cancelled spawns when count is 0 or absent', () => {
    const ctx: StartupContext = {
      type: 'intentional',
      shutdown: {
        reason: 'restart-command',
        timestamp: '2026-02-13T00:00:00.000Z',
      },
    };
    const result = formatStartupInjection(ctx);
    expect(result).not.toContain('spawned agent');
  });

  it('includes both cancelledDefers and cancelledSpawns when both present', () => {
    const ctx: StartupContext = {
      type: 'intentional',
      shutdown: {
        reason: 'restart-command',
        timestamp: '2026-02-13T00:00:00.000Z',
        cancelledDefers: 2,
        cancelledSpawns: 3,
      },
    };
    const result = formatStartupInjection(ctx);
    expect(result).toContain('2 deferred actions were cancelled');
    expect(result).toContain('3 spawned agents were cancelled');
  });

  it('includes forge, cancelledDefers, and cancelledSpawns when all present', () => {
    const ctx: StartupContext = {
      type: 'intentional',
      shutdown: {
        reason: 'restart-command',
        timestamp: '2026-02-13T00:00:00.000Z',
        activeForge: 'plan-099',
        cancelledDefers: 1,
        cancelledSpawns: 2,
      },
    };
    const result = formatStartupInjection(ctx);
    expect(result).toContain('plan-099');
    expect(result).toContain('1 deferred action was cancelled');
    expect(result).toContain('2 spawned agents were cancelled');
  });

  it('includes cancelled spawns for graceful-unknown type', () => {
    const ctx: StartupContext = {
      type: 'graceful-unknown',
      shutdown: {
        reason: 'unknown',
        timestamp: '2026-02-13T00:00:00.000Z',
        cancelledSpawns: 2,
      },
    };
    const result = formatStartupInjection(ctx);
    expect(result).toContain('2 spawned agents were cancelled');
  });

  it('includes cancelled defers for graceful-unknown type', () => {
    const ctx: StartupContext = {
      type: 'graceful-unknown',
      shutdown: {
        reason: 'unknown',
        timestamp: '2026-02-13T00:00:00.000Z',
        cancelledDefers: 4,
      },
    };
    const result = formatStartupInjection(ctx);
    expect(result).toContain('4 deferred actions were cancelled');
  });

  it('includes cancelled loops for graceful-unknown type', () => {
    const ctx: StartupContext = {
      type: 'graceful-unknown',
      shutdown: {
        reason: 'unknown',
        timestamp: '2026-02-13T00:00:00.000Z',
        cancelledLoops: 2,
      },
    };
    const result = formatStartupInjection(ctx);
    expect(result).toContain('2 repeating loops were cancelled');
  });

  it('includes resolved-task guard for all non-null results', () => {
    const cases: StartupContext[] = [
      { type: 'intentional', shutdown: { reason: 'restart-command', timestamp: '' } },
      { type: 'graceful-unknown', shutdown: { reason: 'unknown', timestamp: '' } },
      { type: 'crash' },
    ];
    for (const ctx of cases) {
      const result = formatStartupInjection(ctx);
      expect(result).toContain('already resolved');
    }
  });
});
