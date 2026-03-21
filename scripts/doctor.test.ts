import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLAUDE_BLANK_MACHINE_AUDIT_DOC, runDoctor } from './doctor.js';

const VALID_TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OQ.G1x2y3.abcdefghijklmnopqrstuvwxyz1234567890AB';
const VALID_USER_ID = '292029371241537536';
const VALID_GUILD_ID = '1000000000000000000';

type DoctorFixtureOptions = {
  env?: NodeJS.ProcessEnv;
  scaffoldState?: {
    guildId?: string;
    cronsForumId?: string;
    tasksForumId?: string;
  };
};

function makeDoctorFixture(options: DoctorFixtureOptions = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-test-'));
  const envPath = path.join(cwd, '.env');
  const envExamplePath = path.join(cwd, '.env.example');

  fs.writeFileSync(envPath, [
    `DISCORD_TOKEN=${VALID_TOKEN}`,
    `DISCORD_ALLOW_USER_IDS=${VALID_USER_ID}`,
    `DISCORD_GUILD_ID=${VALID_GUILD_ID}`,
  ].join('\n'));
  fs.writeFileSync(envExamplePath, [
    'DISCORD_TOKEN=',
    'DISCORD_ALLOW_USER_IDS=',
    'DISCORD_GUILD_ID=',
  ].join('\n'));

  const env: NodeJS.ProcessEnv = {
    DISCORD_TOKEN: VALID_TOKEN,
    DISCORD_ALLOW_USER_IDS: VALID_USER_ID,
    DISCORD_GUILD_ID: VALID_GUILD_ID,
    ...options.env,
  };

  if (options.scaffoldState) {
    const dataDir = path.join(cwd, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'system-scaffold.json'), JSON.stringify(options.scaffoldState));
    env.DISCOCLAW_DATA_DIR = dataDir;
  }

  return {
    cwd,
    env,
    cleanup() {
      fs.rmSync(cwd, { recursive: true, force: true });
    },
  };
}

async function runDoctorForTest(env: NodeJS.ProcessEnv, cwd: string) {
  const lines: string[] = [];

  const exitCode = await runDoctor({
    cwd,
    env,
    argv: ['node', 'scripts/doctor.ts'],
    deps: {
      log: (line) => {
        lines.push(line);
      },
      whichFn: (bin) => bin === 'claude' ? '/usr/bin/claude' : null,
      versionOfFn: (bin) => {
        if (bin === 'pnpm') return '10.28.2';
        if (bin === 'claude') return '2.1.5';
        return null;
      },
      inspectFn: async () => ({ findings: [] }),
      resolveHooksDir: (root) => path.join(root, '.git', 'hooks'),
    },
  });

  return {
    exitCode,
    lines,
    output: lines.join('\n'),
  };
}

describe('doctor output contract', () => {
  it('prints explicit manual Claude auth guidance instead of claiming full readiness', async () => {
    const fixture = makeDoctorFixture();

    try {
      const result = await runDoctorForTest(fixture.env, fixture.cwd);

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Claude auth is a manual validation step; this command does not auto-check Claude login state.');
      expect(result.output).toContain(`Follow the manual pre-login and post-login validation in ${CLAUDE_BLANK_MACHINE_AUDIT_DOC}.`);
      expect(result.output).toContain('All automated checks passed.');
      expect(result.output).toContain(`Claude auth still requires the manual validation in ${CLAUDE_BLANK_MACHINE_AUDIT_DOC}.`);
      expect(result.output).not.toContain('All checks passed.');
    } finally {
      fixture.cleanup();
    }
  });

  it('treats forum IDs as bootstrap-derived when DISCORD_GUILD_ID enables first-connect creation', async () => {
    const fixture = makeDoctorFixture({
      env: {
        DISCOCLAW_CRON_FORUM: '',
        DISCOCLAW_TASKS_FORUM: '',
      },
    });

    try {
      const result = await runDoctorForTest(fixture.env, fixture.cwd);

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Forum IDs may be bootstrap-derived: persisted scaffold state or first-connect creation via DISCORD_GUILD_ID can satisfy them when env vars are unset.');
      expect(result.output).toContain('DISCOCLAW_CRON_FORUM can be auto-created on first connect via DISCORD_GUILD_ID');
      expect(result.output).toContain('DISCOCLAW_TASKS_FORUM can be auto-created on first connect via DISCORD_GUILD_ID');
    } finally {
      fixture.cleanup();
    }
  });

  it('reports persisted scaffold forum IDs as satisfying the doctor checks', async () => {
    const fixture = makeDoctorFixture({
      env: {
        DISCORD_GUILD_ID: '',
        DISCOCLAW_CRON_FORUM: '',
        DISCOCLAW_TASKS_FORUM: '',
      },
      scaffoldState: {
        guildId: VALID_GUILD_ID,
        cronsForumId: '1000000000000000001',
        tasksForumId: '1000000000000000002',
      },
    });

    try {
      const result = await runDoctorForTest(fixture.env, fixture.cwd);

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('DISCOCLAW_CRON_FORUM resolved from persisted scaffold state');
      expect(result.output).toContain('DISCOCLAW_TASKS_FORUM resolved from persisted scaffold state');
    } finally {
      fixture.cleanup();
    }
  });
});
