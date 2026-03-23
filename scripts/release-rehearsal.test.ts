import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildReleaseRehearsalSlug,
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
      stdout: 'workspace permissions loaded\n',
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
  it('recognizes the source-checkout markers it depends on', () => {
    const fixture = makeSourceCheckoutFixture();

    try {
      expect(looksLikeSourceCheckout(fixture.root)).toBe(true);
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
        env: {},
        deps: {
          log: () => {},
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.summary.verdict).toBe('blocked');
      expect(result.summary.repoRoot).toBe(fixture.root);
      expect(result.summary.envPath).toBe(path.join(fixture.root, '.env'));
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
        env: {},
        deps: {
          log: () => {},
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.summary.verdict).toBe('blocked');
      expect(result.summary.repoRoot).toBe(fixture.root);
      expect(result.summary.envPath).toBe(path.join(fixture.root, '.env'));
      expect(result.summary.refusalReason).toContain('PRIMARY_RUNTIME=openai');
      expect(result.summary.steps).toContainEqual(expect.objectContaining({
        id: 'validate-primary-runtime',
        status: 'blocked',
      }));
    } finally {
      fixture.cleanup();
    }
  });
});

describe('release-rehearsal runner', () => {
  it('records repo root, writes closeout, and enforces rehearsal-only env overrides for every child process', async () => {
    const fixture = makeSourceCheckoutFixture();
    const commandCalls: ReleaseRehearsalCommandSpec[] = [];
    const devCalls: ReleaseRehearsalCommandSpec[] = [];

    try {
      const result = await runReleaseRehearsal({
        cwd: fixture.root,
        env: { INHERITED_SHELL_VALUE: 'kept' },
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
      expect(result.summary.closeoutJsonPath).toBe(
        path.join(fixture.root, 'docs', 'release-audit', 'claude-release-rehearsal-rr-20260322-183045-ab12.json'),
      );
      expect(fs.existsSync(result.summary.closeoutJsonPath)).toBe(true);
      expect(fs.existsSync(result.summary.closeoutMarkdownPath)).toBe(true);

      const expectedPrefix = result.summary.envOverrides.DISCOCLAW_TASKS_PREFIX;
      expect(expectedPrefix).toBe('rr183045ab12');

      for (const spec of [...commandCalls, ...devCalls]) {
        expect(spec.cwd).toBe(fixture.root);
        expect(spec.env.DISCOCLAW_DATA_DIR).toContain(path.join('discoclaw-release-rehearsal', result.summary.slug, 'data'));
        expect(spec.env.WORKSPACE_CWD).toContain(path.join('discoclaw-release-rehearsal', result.summary.slug, 'workspace'));
        expect(spec.env.GROUPS_DIR).toContain(path.join('discoclaw-release-rehearsal', result.summary.slug, 'workspace', 'groups'));
        expect(spec.env.BEADS_DIR).toContain(path.join('discoclaw-release-rehearsal', result.summary.slug, 'workspace', '.beads'));
        expect(spec.env.DISCOCLAW_TASKS_PREFIX).toBe(expectedPrefix);
        expect(spec.env.INHERITED_SHELL_VALUE).toBe('kept');
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('uses the per-run slug in rehearsal task titles and cron names', async () => {
    const fixture = makeSourceCheckoutFixture();

    try {
      const result = await runReleaseRehearsal({
        cwd: fixture.root,
        env: {},
        deps: {
          now: () => new Date('2026-03-22T18:30:45.000Z'),
          randomSuffix: () => 'slug',
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

      expect(result.summary.slug).toBe('rr-20260322-183045-slug');
      expect(result.summary.artifacts.taskTitle).toBe('Release rehearsal rr-20260322-183045-slug task');
      expect(result.summary.artifacts.cronName).toBe('Release rehearsal rr-20260322-183045-slug cron');
    } finally {
      fixture.cleanup();
    }
  });

  it('treats unresolved cleanup leftovers as a blocked verdict', async () => {
    const fixture = makeSourceCheckoutFixture();

    try {
      const result = await runReleaseRehearsal({
        cwd: fixture.root,
        env: {},
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
});

describe('release-rehearsal helpers', () => {
  it('builds stable rehearsal slugs from the provided timestamp and suffix', () => {
    expect(buildReleaseRehearsalSlug(new Date('2026-03-22T18:30:45.000Z'), 'ab12'))
      .toBe('rr-20260322-183045-ab12');
  });
});
