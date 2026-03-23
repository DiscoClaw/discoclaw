import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildReleaseRehearsalSlug,
  cleanupLocalRehearsalRoot,
  DEV_READY_LOG_LINE,
  hasReachedDevReadyBoundary,
  looksLikeSourceCheckout,
  runReleaseRehearsal,
  type ReleaseRehearsalCommandSpec,
  type ReleaseRehearsalDevSession,
} from './release-rehearsal.js';

type FixtureOptions = {
  withEnv?: boolean;
  envLines?: string[];
};

function makeSourceCheckoutFixture(options: FixtureOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-rehearsal-'));

  fs.writeFileSync(path.join(root, '.git'), 'gitdir: /tmp/discoclaw-test-gitdir\n');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
  fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export {};\n');
  fs.writeFileSync(path.join(root, 'scripts', 'doctor.ts'), 'export {};\n');

  if (options.withEnv !== false) {
    fs.writeFileSync(
      path.join(root, '.env'),
      (options.envLines ?? [
        'PRIMARY_RUNTIME=claude',
        'DISCORD_TOKEN=test-token',
        'DISCORD_GUILD_ID=123456789012345678',
      ]).join('\n') + '\n',
    );
  }

  return {
    root,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function makePassingDevSession(): ReleaseRehearsalDevSession {
  return {
    ready: vi.fn(async () => ({
      exitCode: 0,
      stdout: `${DEV_READY_LOG_LINE}\n`,
      stderr: '',
    })),
    stop: vi.fn(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    })),
  };
}

describe('release-rehearsal source gate', () => {
  it('recognizes only real git checkouts with the source-checkout markers it depends on', () => {
    const fixture = makeSourceCheckoutFixture();

    try {
      expect(looksLikeSourceCheckout(fixture.root)).toBe(true);
      fs.unlinkSync(path.join(fixture.root, '.git'));
      expect(looksLikeSourceCheckout(fixture.root)).toBe(false);
      fs.writeFileSync(path.join(fixture.root, '.git'), 'gitdir: /tmp/discoclaw-test-gitdir\n');
      fs.unlinkSync(path.join(fixture.root, 'scripts', 'doctor.ts'));
      expect(looksLikeSourceCheckout(fixture.root)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  it('refuses when the repo-local .env is missing', async () => {
    const fixture = makeSourceCheckoutFixture({ withEnv: false });

    try {
      const result = await runReleaseRehearsal({
        cwd: fixture.root,
        env: { RELEASE_REHEARSAL_CHECKOUT_PROVENANCE: 'reused-checkout' },
        deps: {
          log: () => {},
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.summary.verdict).toBe('blocked');
      expect(result.summary.repoRoot).toBe(fixture.root);
      expect(result.summary.envPath).toBe(path.join(fixture.root, '.env'));
      expect(result.summary.checkoutProvenance).toBe('reused-checkout');
      expect(result.summary.refusalReason).toContain('repo-local .env');
      expect(result.summary.steps).toContainEqual(expect.objectContaining({
        id: 'validate-repo-env',
        status: 'blocked',
      }));
    } finally {
      fixture.cleanup();
    }
  });

  it('refuses when the repo-local runtime is not claude', async () => {
    const fixture = makeSourceCheckoutFixture({
      envLines: [
        'PRIMARY_RUNTIME=openai',
        'DISCORD_TOKEN=test-token',
      ],
    });

    try {
      const result = await runReleaseRehearsal({
        cwd: fixture.root,
        env: { RELEASE_REHEARSAL_CHECKOUT_PROVENANCE: 'reused-checkout' },
        deps: {
          log: () => {},
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.summary.verdict).toBe('blocked');
      expect(result.summary.repoRoot).toBe(fixture.root);
      expect(result.summary.envPath).toBe(path.join(fixture.root, '.env'));
      expect(result.summary.checkoutProvenance).toBe('reused-checkout');
      expect(result.summary.refusalReason).toContain('PRIMARY_RUNTIME=openai');
      expect(result.summary.steps).toContainEqual(expect.objectContaining({
        id: 'validate-primary-runtime',
        status: 'blocked',
      }));
    } finally {
      fixture.cleanup();
    }
  });

  it('refuses when the repo-local .env does not define PRIMARY_RUNTIME explicitly', async () => {
    const fixture = makeSourceCheckoutFixture({
      envLines: [
        'DISCORD_TOKEN=test-token',
        'DISCORD_GUILD_ID=123456789012345678',
      ],
    });
    const runCommand = vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }));

    try {
      const result = await runReleaseRehearsal({
        cwd: fixture.root,
        env: {
          PRIMARY_RUNTIME: 'claude',
          RELEASE_REHEARSAL_CHECKOUT_PROVENANCE: 'reused-checkout',
        },
        deps: {
          log: () => {},
          runCommand,
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.summary.verdict).toBe('blocked');
      expect(result.summary.refusalReason).toContain('PRIMARY_RUNTIME is missing');
      expect(result.summary.steps).toContainEqual(expect.objectContaining({
        id: 'validate-primary-runtime',
        status: 'blocked',
      }));
      expect(runCommand).not.toHaveBeenCalled();
    } finally {
      fixture.cleanup();
    }
  });

  it('refuses when the repo-local .env does not define DISCORD_GUILD_ID explicitly', async () => {
    const fixture = makeSourceCheckoutFixture({
      envLines: [
        'PRIMARY_RUNTIME=claude',
        'DISCORD_TOKEN=test-token',
      ],
    });
    const runCommand = vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }));

    try {
      const result = await runReleaseRehearsal({
        cwd: fixture.root,
        env: { RELEASE_REHEARSAL_CHECKOUT_PROVENANCE: 'reused-checkout' },
        deps: {
          log: () => {},
          runCommand,
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.summary.verdict).toBe('blocked');
      expect(result.summary.refusalReason).toContain('DISCORD_GUILD_ID is missing');
      expect(result.summary.steps).toContainEqual(expect.objectContaining({
        id: 'validate-discord-guild-id',
        status: 'blocked',
      }));
      expect(runCommand).not.toHaveBeenCalled();
    } finally {
      fixture.cleanup();
    }
  });
});

describe('release-rehearsal runner', () => {
  it('isolates child processes from ambient shell config while preserving repo-local env and rehearsal overrides', async () => {
    const fixture = makeSourceCheckoutFixture({
      envLines: [
        'PRIMARY_RUNTIME=claude',
        'DISCORD_TOKEN=repo-token',
        'DISCORD_GUILD_ID=123456789012345678',
        'REPO_ONLY_FLAG=from-repo-env',
        'DISCOCLAW_TASKS_TAG_MAP=./data/beads-tag-map.json',
        'DISCOCLAW_WEBHOOK_CONFIG=/tmp/discoclaw-webhooks.json',
        'AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium-browser',
      ],
    });
    const commandCalls: ReleaseRehearsalCommandSpec[] = [];
    const devCalls: ReleaseRehearsalCommandSpec[] = [];

    try {
      const result = await runReleaseRehearsal({
        cwd: fixture.root,
        env: {
          HOME: '/tmp/rehearsal-home',
          INHERITED_SHELL_VALUE: 'kept',
          PATH: '/test/bin',
          PRIMARY_RUNTIME: 'codex',
          DISCORD_TOKEN: 'host-token',
          DISCORD_GUILD_ID: '999999999999999999',
          RELEASE_REHEARSAL_CHECKOUT_PROVENANCE: 'throwaway-clone',
        },
        deps: {
          now: () => new Date('2026-03-22T18:30:45.000Z'),
          randomSuffix: () => 'ab12',
          log: () => {},
          runCommand: vi.fn(async (spec) => {
            commandCalls.push(spec);
            return { exitCode: 0, stdout: `${spec.id} ok`, stderr: '' };
          }),
          startDev: vi.fn(async (spec) => {
            devCalls.push(spec);
            return makePassingDevSession();
          }),
          promptCheckpoint: vi.fn(async () => 'pass'),
          cleanupArtifacts: vi.fn(async () => ({
            closedTaskIds: ['rr-001'],
            archivedTaskThreadIds: ['task-thread-1'],
            archivedCronThreadIds: ['cron-thread-1'],
            disabledCronIds: ['cron-001'],
            leftovers: [],
            notes: [],
          })),
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.summary.verdict).toBe('pass');
      expect(result.summary.repoRoot).toBe(fixture.root);
      expect(result.summary.envPath).toBe(path.join(fixture.root, '.env'));
      expect(result.summary.checkoutProvenance).toBe('throwaway-clone');
      expect(result.summary.closeoutJsonPath).toBe(
        path.join(fixture.root, 'docs', 'release-audit', 'claude-release-rehearsal-rr-20260322-183045-ab12.json'),
      );
      expect(fs.existsSync(result.summary.closeoutJsonPath)).toBe(true);
      expect(fs.existsSync(result.summary.closeoutMarkdownPath)).toBe(true);
      expect(JSON.parse(fs.readFileSync(result.summary.closeoutJsonPath, 'utf8'))).toEqual(expect.objectContaining({
        checkoutProvenance: 'throwaway-clone',
      }));
      expect(fs.readFileSync(result.summary.closeoutMarkdownPath, 'utf8')).toContain(
        '- Checkout provenance: `throwaway clone`',
      );

      const expectedPrefix = result.summary.envOverrides.DISCOCLAW_TASKS_PREFIX;
      expect(expectedPrefix).toBe('rr183045ab12');

      for (const spec of [...commandCalls, ...devCalls]) {
        expect(spec.cwd).toBe(fixture.root);
        expect(spec.env.HOME).toBe('/tmp/rehearsal-home');
        expect(spec.env.PATH).toBe('/test/bin');
        expect(spec.env.PRIMARY_RUNTIME).toBe('claude');
        expect(spec.env.DISCORD_TOKEN).toBe('repo-token');
        expect(spec.env.DISCORD_GUILD_ID).toBe('123456789012345678');
        expect(spec.env.REPO_ONLY_FLAG).toBe('from-repo-env');
        expect(spec.env.AGENT_BROWSER_EXECUTABLE_PATH).toBe('/usr/bin/chromium-browser');
        expect(spec.env.DISCOCLAW_DATA_DIR).toContain(path.join('discoclaw-release-rehearsal', result.summary.slug, 'data'));
        expect(spec.env.WORKSPACE_CWD).toContain(path.join('discoclaw-release-rehearsal', result.summary.slug, 'workspace'));
        expect(spec.env.GROUPS_DIR).toContain(path.join('discoclaw-release-rehearsal', result.summary.slug, 'workspace', 'groups'));
        expect(spec.env.BEADS_DIR).toContain(path.join('discoclaw-release-rehearsal', result.summary.slug, 'workspace', '.beads'));
        expect(spec.env.DISCOCLAW_TASKS_PREFIX).toBe(expectedPrefix);
        expect(spec.env.CLAUDE_DEBUG_FILE).toContain(
          path.join('discoclaw-release-rehearsal', result.summary.slug, 'claude-debug.log'),
        );
        expect(spec.env.DISCOCLAW_STARTUP_READY_FILE).toContain(
          path.join('discoclaw-release-rehearsal', result.summary.slug, 'startup-ready.json'),
        );
        expect(spec.env.DISCOCLAW_TASKS_TAG_MAP).toBeUndefined();
        expect(spec.env.DISCOCLAW_WEBHOOK_CONFIG).toBeUndefined();
        expect(spec.env.INHERITED_SHELL_VALUE).toBeUndefined();
      }
      expect(commandCalls).toContainEqual(expect.objectContaining({
        id: 'discord-smoke-test',
        command: ['pnpm', 'discord:smoke-test', '--', '--guild-id', '123456789012345678'],
      }));
      expect(result.summary.envOverrides.CLAUDE_DEBUG_FILE).toContain(
        path.join('discoclaw-release-rehearsal', result.summary.slug, 'claude-debug.log'),
      );
      expect(result.summary.envOverrides.DISCOCLAW_STARTUP_READY_FILE).toContain(
        path.join('discoclaw-release-rehearsal', result.summary.slug, 'startup-ready.json'),
      );
      expect(fs.readFileSync(result.summary.closeoutMarkdownPath, 'utf8')).toContain('CLAUDE_DEBUG_FILE=');
      expect(fs.readFileSync(result.summary.closeoutMarkdownPath, 'utf8')).toContain('DISCOCLAW_STARTUP_READY_FILE=');
    } finally {
      fixture.cleanup();
    }
  });

  it('uses the per-run slug in rehearsal task titles and cron names', async () => {
    const fixture = makeSourceCheckoutFixture();

    try {
      const result = await runReleaseRehearsal({
        cwd: fixture.root,
        env: { RELEASE_REHEARSAL_CHECKOUT_PROVENANCE: 'reused-checkout' },
        deps: {
          now: () => new Date('2026-03-22T18:30:45.000Z'),
          randomSuffix: () => 'slug',
          log: () => {},
          runCommand: vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' })),
          startDev: vi.fn(async () => makePassingDevSession()),
          promptCheckpoint: vi.fn(async () => 'pass'),
          cleanupArtifacts: vi.fn(async () => ({
            closedTaskIds: ['rr-001'],
            archivedTaskThreadIds: ['task-thread-1'],
            archivedCronThreadIds: ['cron-thread-1'],
            disabledCronIds: ['cron-001'],
            leftovers: [],
            notes: [],
          })),
        },
      });

      expect(result.summary.slug).toBe('rr-20260322-183045-slug');
      expect(result.summary.artifacts.taskTitle).toBe('Release rehearsal rr-20260322-183045-slug task');
      expect(result.summary.artifacts.cronName).toBe('Release rehearsal rr-20260322-183045-slug cron');
    } finally {
      fixture.cleanup();
    }
  });

  it('does not block non-interactive runs when checkout provenance is omitted', async () => {
    const fixture = makeSourceCheckoutFixture();

    try {
      const result = await runReleaseRehearsal({
        cwd: fixture.root,
        env: {},
        deps: {
          log: () => {},
          runCommand: vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' })),
          startDev: vi.fn(async () => makePassingDevSession()),
          promptCheckpoint: vi.fn(async () => 'pass'),
          cleanupArtifacts: vi.fn(async () => ({
            closedTaskIds: ['rr-001'],
            archivedTaskThreadIds: ['task-thread-1'],
            archivedCronThreadIds: ['cron-thread-1'],
            disabledCronIds: ['cron-001'],
            leftovers: [],
            notes: [],
          })),
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.summary.verdict).toBe('pass');
      expect(result.summary.checkoutProvenance).toBeUndefined();
      expect(result.summary.steps).toContainEqual(expect.objectContaining({
        id: 'record-checkout-provenance',
        status: 'skipped',
      }));
    } finally {
      fixture.cleanup();
    }
  });

  it('blocks when the required same-conversation follow-up checkpoint is skipped', async () => {
    const fixture = makeSourceCheckoutFixture();
    const promptCheckpoint = vi.fn()
      .mockResolvedValueOnce('pass')
      .mockResolvedValueOnce('skip')
      .mockResolvedValueOnce('pass')
      .mockResolvedValueOnce('pass')
      .mockResolvedValueOnce('pass');

    try {
      const result = await runReleaseRehearsal({
        cwd: fixture.root,
        env: { RELEASE_REHEARSAL_CHECKOUT_PROVENANCE: 'reused-checkout' },
        deps: {
          log: () => {},
          runCommand: vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' })),
          startDev: vi.fn(async () => makePassingDevSession()),
          promptCheckpoint,
          cleanupArtifacts: vi.fn(async () => ({
            closedTaskIds: ['rr-001'],
            archivedTaskThreadIds: ['task-thread-1'],
            archivedCronThreadIds: ['cron-thread-1'],
            disabledCronIds: ['cron-001'],
            leftovers: [],
            notes: [],
          })),
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.summary.verdict).toBe('blocked');
      expect(result.summary.steps).toContainEqual(expect.objectContaining({
        id: 'checkpoint-follow-up-reply',
        status: 'blocked',
      }));
    } finally {
      fixture.cleanup();
    }
  });

  it('treats unresolved cleanup leftovers as a blocked verdict', async () => {
    const fixture = makeSourceCheckoutFixture();

    try {
      const result = await runReleaseRehearsal({
        cwd: fixture.root,
        env: { RELEASE_REHEARSAL_CHECKOUT_PROVENANCE: 'reused-checkout' },
        deps: {
          now: () => new Date('2026-03-22T18:30:45.000Z'),
          randomSuffix: () => 'left',
          log: () => {},
          runCommand: vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' })),
          startDev: vi.fn(async () => makePassingDevSession()),
          promptCheckpoint: vi.fn(async () => 'pass'),
          cleanupArtifacts: vi.fn(async () => ({
            closedTaskIds: ['rr-001'],
            archivedTaskThreadIds: [],
            archivedCronThreadIds: ['cron-thread-1'],
            disabledCronIds: [],
            leftovers: [
              {
                kind: 'cron-thread',
                id: 'thread-42',
                name: 'Release rehearsal rr-20260322-183045-left cron',
                reason: 'Cron thread remained active after teardown archive.',
              },
            ],
            notes: [],
          })),
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.summary.verdict).toBe('blocked');
      expect(result.summary.cleanup.leftovers).toHaveLength(1);
      expect(result.summary.cleanup.leftovers[0]?.id).toBe('thread-42');
      expect(result.summary.steps).toContainEqual(expect.objectContaining({
        id: 'teardown',
        status: 'blocked',
      }));
    } finally {
      fixture.cleanup();
    }
  });

  it('still runs teardown after an early command failure and lets cleanup leftovers block the verdict', async () => {
    const fixture = makeSourceCheckoutFixture();
    const cleanupArtifacts = vi.fn(async () => ({
      closedTaskIds: [],
      archivedTaskThreadIds: [],
      archivedCronThreadIds: [],
      disabledCronIds: [],
      leftovers: [
        {
          kind: 'tmp-root',
          id: 'rr-root',
          name: 'rr-root',
          reason: 'Local rehearsal temp root still exists after teardown.',
        },
      ],
      notes: [],
    }));

    try {
      const result = await runReleaseRehearsal({
        cwd: fixture.root,
        env: { RELEASE_REHEARSAL_CHECKOUT_PROVENANCE: 'reused-checkout' },
        deps: {
          log: () => {},
          runCommand: vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'preflight failed' })),
          cleanupArtifacts,
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.summary.verdict).toBe('blocked');
      expect(cleanupArtifacts).toHaveBeenCalledOnce();
      expect(result.summary.steps).toContainEqual(expect.objectContaining({
        id: 'preflight-blank-machine',
        status: 'fail',
      }));
      expect(result.summary.steps).toContainEqual(expect.objectContaining({
        id: 'teardown',
        status: 'blocked',
      }));
    } finally {
      fixture.cleanup();
    }
  });

  it('stops the restarted dev session before teardown begins', async () => {
    const fixture = makeSourceCheckoutFixture();
    const events: string[] = [];
    let startCount = 0;

    try {
      const result = await runReleaseRehearsal({
        cwd: fixture.root,
        env: { RELEASE_REHEARSAL_CHECKOUT_PROVENANCE: 'reused-checkout' },
        deps: {
          log: () => {},
          runCommand: vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' })),
          startDev: vi.fn(async () => {
            startCount += 1;
            const label = startCount === 1 ? 'first' : 'second';
            events.push(`start:${label}`);
            return {
              ready: vi.fn(async () => ({
                exitCode: 0,
                stdout: `${DEV_READY_LOG_LINE}\n`,
                stderr: '',
              })),
              stop: vi.fn(async () => {
                events.push(`stop:${label}`);
                return { exitCode: 0, stdout: '', stderr: '' };
              }),
            };
          }),
          promptCheckpoint: vi.fn(async () => 'pass'),
          cleanupArtifacts: vi.fn(async () => {
            events.push('cleanup');
            return {
              closedTaskIds: ['rr-001'],
              archivedTaskThreadIds: ['task-thread-1'],
              archivedCronThreadIds: ['cron-thread-1'],
              disabledCronIds: ['cron-001'],
              leftovers: [],
              notes: [],
            };
          }),
        },
      });

      expect(result.exitCode).toBe(0);
      expect(events).toEqual([
        'start:first',
        'stop:first',
        'start:second',
        'stop:second',
        'cleanup',
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  it('records the manual chat-artifact cleanup note without blocking the verdict', async () => {
    const fixture = makeSourceCheckoutFixture();

    try {
      const result = await runReleaseRehearsal({
        cwd: fixture.root,
        env: { RELEASE_REHEARSAL_CHECKOUT_PROVENANCE: 'reused-checkout' },
        deps: {
          now: () => new Date('2026-03-22T18:30:45.000Z'),
          randomSuffix: () => 'chat',
          log: () => {},
          runCommand: vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' })),
          startDev: vi.fn(async () => makePassingDevSession()),
          promptCheckpoint: vi.fn()
            .mockResolvedValueOnce('pass')
            .mockResolvedValueOnce('pass')
            .mockResolvedValueOnce('pass')
            .mockResolvedValueOnce('pass')
            .mockResolvedValueOnce('pass')
            .mockResolvedValueOnce('skip'),
          cleanupArtifacts: vi.fn(async () => ({
            closedTaskIds: ['rr-001'],
            archivedTaskThreadIds: ['task-thread-1'],
            archivedCronThreadIds: ['cron-thread-1'],
            disabledCronIds: ['cron-001'],
            leftovers: [],
            notes: [],
          })),
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.summary.verdict).toBe('pass');
      expect(result.summary.cleanup.leftovers).toEqual([]);
      expect(result.summary.cleanup.notes).toContain(
        'Operator did not confirm the message-handling/restart-recovery chat artifact cleanup note; this does not change the teardown verdict because those artifacts are not rehearsal-owned cleanup blockers.',
      );
      expect(result.summary.steps).toContainEqual(expect.objectContaining({
        id: 'record-chat-artifact-cleanup',
        status: 'skipped',
      }));
    } finally {
      fixture.cleanup();
    }
  });

  it('blocks the rehearsal when a required live checkpoint is skipped', async () => {
    const fixture = makeSourceCheckoutFixture();
    const cleanupArtifacts = vi.fn(async () => ({
      closedTaskIds: ['rr-001'],
      archivedTaskThreadIds: ['task-thread-1'],
      archivedCronThreadIds: ['cron-thread-1'],
      disabledCronIds: ['cron-001'],
      leftovers: [],
      notes: [],
    }));

    try {
      const result = await runReleaseRehearsal({
        cwd: fixture.root,
        env: { RELEASE_REHEARSAL_CHECKOUT_PROVENANCE: 'reused-checkout' },
        deps: {
          now: () => new Date('2026-03-22T18:30:45.000Z'),
          randomSuffix: () => 'skip',
          log: () => {},
          runCommand: vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' })),
          startDev: vi.fn(async () => makePassingDevSession()),
          promptCheckpoint: vi.fn()
            .mockResolvedValueOnce('skip')
            .mockResolvedValueOnce('pass')
            .mockResolvedValueOnce('pass')
            .mockResolvedValueOnce('pass')
            .mockResolvedValueOnce('pass'),
          cleanupArtifacts,
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.summary.verdict).toBe('blocked');
      expect(result.summary.steps).toContainEqual(expect.objectContaining({
        id: 'checkpoint-message-handling',
        status: 'blocked',
      }));
      expect(cleanupArtifacts).toHaveBeenCalledOnce();
    } finally {
      fixture.cleanup();
    }
  });

  it('blocks instead of failing when manual checkpoints are unavailable without a TTY', async () => {
    const fixture = makeSourceCheckoutFixture();
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

    try {
      const result = await runReleaseRehearsal({
        cwd: fixture.root,
        env: { RELEASE_REHEARSAL_CHECKOUT_PROVENANCE: 'reused-checkout' },
        deps: {
          now: () => new Date('2026-03-22T18:30:45.000Z'),
          randomSuffix: () => 'notty',
          log: () => {},
          runCommand: vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' })),
          startDev: vi.fn(async () => makePassingDevSession()),
          cleanupArtifacts: vi.fn(async () => ({
            closedTaskIds: ['rr-001'],
            archivedTaskThreadIds: ['task-thread-1'],
            archivedCronThreadIds: ['cron-thread-1'],
            disabledCronIds: ['cron-001'],
            leftovers: [],
            notes: [],
          })),
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.summary.verdict).toBe('blocked');
      expect(result.summary.steps).toContainEqual(expect.objectContaining({
        id: 'checkpoint-message-handling',
        status: 'blocked',
      }));
      expect(result.summary.steps).not.toContainEqual(expect.objectContaining({
        id: 'release-rehearsal',
        status: 'fail',
      }));
    } finally {
      if (stdinDescriptor) {
        Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
      } else {
        delete (process.stdin as NodeJS.ReadStream & { isTTY?: boolean }).isTTY;
      }
      if (stdoutDescriptor) {
        Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
      } else {
        delete (process.stdout as NodeJS.WriteStream & { isTTY?: boolean }).isTTY;
      }
      fixture.cleanup();
    }
  });

  it('blocks and still tears down when pnpm dev never reaches the ready boundary', async () => {
    const fixture = makeSourceCheckoutFixture();
    const stop = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const cleanupArtifacts = vi.fn(async () => ({
      closedTaskIds: [],
      archivedTaskThreadIds: [],
      archivedCronThreadIds: [],
      disabledCronIds: [],
      leftovers: [],
      notes: [],
    }));

    try {
      const result = await runReleaseRehearsal({
        cwd: fixture.root,
        env: { RELEASE_REHEARSAL_CHECKOUT_PROVENANCE: 'reused-checkout' },
        deps: {
          now: () => new Date('2026-03-22T18:30:45.000Z'),
          randomSuffix: () => 'hang',
          log: () => {},
          runCommand: vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' })),
          startDev: vi.fn(async () => ({
            ready: vi.fn(async () => ({
              exitCode: 1,
              stdout: 'startup noise\n',
              stderr: `Timed out waiting for dev ready boundary (${DEV_READY_LOG_LINE}).`,
            })),
            stop,
          })),
          cleanupArtifacts,
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.summary.verdict).toBe('blocked');
      expect(stop).toHaveBeenCalledOnce();
      expect(cleanupArtifacts).toHaveBeenCalledOnce();
      expect(result.summary.steps).toContainEqual(expect.objectContaining({
        id: 'dev-start',
        status: 'blocked',
      }));
      expect(result.summary.steps).toContainEqual(expect.objectContaining({
        id: 'teardown',
        status: 'pass',
      }));
      expect(fs.existsSync(result.summary.closeoutJsonPath)).toBe(true);
      expect(JSON.parse(fs.readFileSync(result.summary.closeoutJsonPath, 'utf8'))).toEqual(expect.objectContaining({
        verdict: 'blocked',
        slug: 'rr-20260322-183045-hang',
      }));
    } finally {
      fixture.cleanup();
    }
  });

  it('blocks when live task and cron checkpoints passed but teardown saw no machine-observed evidence', async () => {
    const fixture = makeSourceCheckoutFixture();

    try {
      const result = await runReleaseRehearsal({
        cwd: fixture.root,
        env: { RELEASE_REHEARSAL_CHECKOUT_PROVENANCE: 'reused-checkout' },
        deps: {
          log: () => {},
          runCommand: vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' })),
          startDev: vi.fn(async () => makePassingDevSession()),
          promptCheckpoint: vi.fn(async () => 'pass'),
          cleanupArtifacts: vi.fn(async () => ({
            closedTaskIds: [],
            archivedTaskThreadIds: [],
            archivedCronThreadIds: [],
            disabledCronIds: [],
            leftovers: [],
            notes: [],
          })),
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.summary.verdict).toBe('blocked');
      expect(result.summary.cleanup.leftovers).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'missing-machine-task-evidence',
          kind: 'task',
        }),
        expect.objectContaining({
          id: 'missing-machine-cron-evidence',
          kind: 'cron-thread',
        }),
      ]));
      expect(result.summary.steps).toContainEqual(expect.objectContaining({
        id: 'teardown',
        status: 'blocked',
      }));
    } finally {
      fixture.cleanup();
    }
  });

  it('runs teardown and writes a durable closeout when interrupted during dev ready wait', async () => {
    const fixture = makeSourceCheckoutFixture();
    const cleanupArtifacts = vi.fn(async () => ({
      closedTaskIds: [],
      archivedTaskThreadIds: [],
      archivedCronThreadIds: [],
      disabledCronIds: [],
      leftovers: [],
      notes: [],
    }));
    const stop = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));

    try {
      const result = await runReleaseRehearsal({
        cwd: fixture.root,
        env: { RELEASE_REHEARSAL_CHECKOUT_PROVENANCE: 'reused-checkout' },
        deps: {
          now: () => new Date('2026-03-22T18:30:45.000Z'),
          randomSuffix: () => 'sig1',
          log: () => {},
          runCommand: vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' })),
          startDev: vi.fn(async () => {
            queueMicrotask(() => {
              process.emit('SIGINT');
            });
            return {
              ready: vi.fn(() => new Promise<never>(() => {})),
              stop,
            };
          }),
          cleanupArtifacts,
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.summary.verdict).toBe('blocked');
      expect(stop).toHaveBeenCalledOnce();
      expect(cleanupArtifacts).toHaveBeenCalledOnce();
      expect(result.summary.steps).toContainEqual(expect.objectContaining({
        id: 'release-rehearsal',
        status: 'blocked',
      }));
      expect(result.summary.steps).toContainEqual(expect.objectContaining({
        id: 'teardown',
        status: 'pass',
      }));
      expect(fs.existsSync(result.summary.closeoutMarkdownPath)).toBe(true);
      expect(fs.readFileSync(result.summary.closeoutMarkdownPath, 'utf8')).toContain('`blocked`');
    } finally {
      fixture.cleanup();
    }
  });

  it('runs teardown and blocks the verdict when interrupted mid-rehearsal', async () => {
    const fixture = makeSourceCheckoutFixture();
    const cleanupArtifacts = vi.fn(async () => ({
      closedTaskIds: [],
      archivedTaskThreadIds: [],
      archivedCronThreadIds: [],
      disabledCronIds: [],
      leftovers: [],
      notes: [],
    }));
    let emittedSignal = false;

    try {
      const result = await runReleaseRehearsal({
        cwd: fixture.root,
        env: { RELEASE_REHEARSAL_CHECKOUT_PROVENANCE: 'reused-checkout' },
        deps: {
          log: () => {},
          runCommand: vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' })),
          startDev: vi.fn(async () => makePassingDevSession()),
          promptCheckpoint: vi.fn(async () => {
            if (!emittedSignal) {
              emittedSignal = true;
              process.emit('SIGINT');
              await new Promise((resolve) => setTimeout(resolve, 0));
            }
            return 'pass';
          }),
          cleanupArtifacts,
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.summary.verdict).toBe('blocked');
      expect(cleanupArtifacts).toHaveBeenCalledOnce();
      expect(result.summary.steps).toContainEqual(expect.objectContaining({
        id: 'release-rehearsal',
        status: 'blocked',
      }));
      expect(result.summary.steps).toContainEqual(expect.objectContaining({
        id: 'teardown',
        status: 'pass',
      }));
    } finally {
      fixture.cleanup();
    }
  });
});

describe('release-rehearsal helpers', () => {
  it('builds stable rehearsal slugs from the provided timestamp and suffix', () => {
    expect(buildReleaseRehearsalSlug(new Date('2026-03-22T18:30:45.000Z'), 'ab12'))
      .toBe('rr-20260322-183045-ab12');
  });

  it('treats only the actual Discord-ready log line as the dev ready boundary', () => {
    expect(hasReachedDevReadyBoundary(`startup noise\n${DEV_READY_LOG_LINE}\n`)).toBe(true);
    expect(hasReachedDevReadyBoundary('workspace permissions loaded\n')).toBe(false);
    expect(hasReachedDevReadyBoundary('resolved bot display name\n')).toBe(false);
    expect(hasReachedDevReadyBoundary('PID lock acquired\n')).toBe(false);
    expect(hasReachedDevReadyBoundary('Discord bot started\n')).toBe(false);
  });

  it('removes the local rehearsal temp root and reports unexpected paths as leftovers', async () => {
    const rehearsalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'discoclaw-release-rehearsal-'));
    const namespacedRoot = path.join(rehearsalRoot, 'discoclaw-release-rehearsal', 'rr-20260322-183045-ab12');
    fs.mkdirSync(path.join(namespacedRoot, 'data'), { recursive: true });

    const removed = await cleanupLocalRehearsalRoot(namespacedRoot, 'rr-20260322-183045-ab12');
    expect(removed.note).toContain(namespacedRoot);
    expect(fs.existsSync(namespacedRoot)).toBe(false);

    const unexpected = await cleanupLocalRehearsalRoot(path.join(rehearsalRoot, 'wrong-place'), 'rr-20260322-183045-ab12');
    expect(unexpected.leftover).toEqual(expect.objectContaining({
      kind: 'tmp-root',
    }));

    fs.rmSync(rehearsalRoot, { recursive: true, force: true });
  });
});
