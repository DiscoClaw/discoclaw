import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLAUDE_BLANK_MACHINE_AUDIT_DOC, CONFIGURATION_DOC, runDoctor } from './doctor.js';

const VALID_TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OQ.G1x2y3.abcdefghijklmnopqrstuvwxyz1234567890AB';
const VALID_USER_ID = '292029371241537536';
const VALID_GUILD_ID = '1000000000000000000';

type DoctorFixtureOptions = {
  env?: NodeJS.ProcessEnv;
  fileEnv?: Record<string, string | undefined>;
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
  const fileEnv = {
    DISCORD_TOKEN: VALID_TOKEN,
    DISCORD_ALLOW_USER_IDS: VALID_USER_ID,
    DISCORD_GUILD_ID: VALID_GUILD_ID,
    ...options.fileEnv,
  };

  fs.writeFileSync(
    envPath,
    Object.entries(fileEnv)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n'),
  );
  fs.writeFileSync(envExamplePath, [
    'DISCORD_TOKEN=',
    'DISCORD_ALLOW_USER_IDS=',
    'DISCORD_GUILD_ID=',
  ].join('\n'));

  const env: NodeJS.ProcessEnv = {
    DISCORD_TOKEN: VALID_TOKEN,
    DISCORD_ALLOW_USER_IDS: VALID_USER_ID,
    DISCORD_GUILD_ID: VALID_GUILD_ID,
    ...fileEnv,
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
      whichFn: (bin) => {
        if (bin === 'claude') return '/usr/bin/claude';
        if (bin === 'codex') return '/usr/bin/codex';
        return null;
      },
      versionOfFn: (bin) => {
        if (bin === 'pnpm') return '10.28.2';
        if (bin === 'claude') return '2.1.5';
        if (bin === 'codex') return '1.0.0';
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

async function runDoctorForTestWithArgs(env: NodeJS.ProcessEnv, cwd: string, args: string[]) {
  const lines: string[] = [];

  const exitCode = await runDoctor({
    cwd,
    env,
    argv: ['node', 'scripts/doctor.ts', ...args],
    deps: {
      log: (line) => {
        lines.push(line);
      },
      whichFn: (bin) => {
        if (bin === 'claude') return '/usr/bin/claude';
        if (bin === 'codex') return '/usr/bin/codex';
        return null;
      },
      versionOfFn: (bin) => {
        if (bin === 'pnpm') return '10.28.2';
        if (bin === 'claude') return '2.1.5';
        if (bin === 'codex') return '1.0.0';
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
  it('prints source-checkout Claude proof-gate guidance instead of claiming full readiness', async () => {
    const fixture = makeDoctorFixture();

    try {
      const result = await runDoctorForTest(fixture.env, fixture.cwd);

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('This source-checkout preflight only reports config/bootstrap prerequisites Discoclaw can verify locally today.');
      expect(result.output).toContain('It does not prove provider auth, live runtime credential probes, or end-to-end workload success.');
      expect(result.output).toContain(`This \`pnpm preflight*\` surface is source-checkout evidence only. For npm/global installs, use \`discoclaw doctor\` and the install-mode guidance in ${CONFIGURATION_DOC}.`);
      expect(result.output).toContain('Claude source auth is a separate proof gate: run `pnpm claude:auth-smoke` after this check.');
      expect(result.output).toContain(`This command does not auto-run Claude auth validation; follow the pre-login and post-login validation in ${CLAUDE_BLANK_MACHINE_AUDIT_DOC}.`);
      expect(result.output).toContain('All automated checks passed.');
      expect(result.output).toContain(`Next proof gate: run \`pnpm claude:auth-smoke\` for the source-checkout Claude auth check. See ${CLAUDE_BLANK_MACHINE_AUDIT_DOC}.`);
      expect(result.output).not.toContain('Discoclaw Claude auth smoke');
      expect(result.output).not.toContain('Running claude -p -- "Reply with OK"');
      expect(result.output).not.toContain('All checks passed.');
    } finally {
      fixture.cleanup();
    }
  });

  it('prints Codex and OpenAI proof-gate wording when runtime routing uses those paths', async () => {
    const fixture = makeDoctorFixture({
      fileEnv: {
        PRIMARY_RUNTIME: 'codex',
        DISCOCLAW_FAST_RUNTIME: 'openai',
        OPENAI_API_KEY: 'sk-fast-key',
      },
    });

    try {
      const result = await runDoctorForTest(fixture.env, fixture.cwd);

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Codex CLI session auth is a separate proof gate: this check only verifies Codex binary/version/config prerequisites.');
      expect(result.output).toContain('Preflight does not invoke Codex CLI or prove the current Codex session can authenticate.');
      expect(result.output).toContain('OpenAI runtime auth is a separate proof gate: this check only verifies whether `OPENAI_API_KEY` is present when current runtime routing requires it.');
      expect(result.output).toContain('Preflight does not invoke the OpenAI fast/alternate runtime path or prove API auth.');
      expect(result.output).toContain('Next proof gate: capture separate evidence that the source-checkout Codex CLI session is authenticated; preflight does not invoke `codex`.');
      expect(result.output).toContain('Next proof gate: capture separate evidence that the required `OPENAI_API_KEY` path can authenticate; preflight only proves config presence.');
      expect(result.output).not.toContain('Claude source auth is a separate proof gate');
      expect(result.output).not.toContain('pnpm claude:auth-smoke');
    } finally {
      fixture.cleanup();
    }
  });

  it('prints OpenRouter proof-gate wording when runtime routing uses that path', async () => {
    const fixture = makeDoctorFixture({
      fileEnv: {
        PRIMARY_RUNTIME: 'openrouter',
        OPENROUTER_API_KEY: 'sk-or-key',
      },
    });

    try {
      const result = await runDoctorForTest(fixture.env, fixture.cwd);

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('OpenRouter runtime proof is a separate gate: this check only verifies whether `OPENROUTER_API_KEY` is present when current runtime routing requires it.');
      expect(result.output).toContain('Preflight does not start discoclaw or prove the running process can complete the shipped OpenRouter `GET /models` credential probe.');
      expect(result.output).toContain('Next proof gate: start discoclaw and confirm `!status` (or the startup credential report) shows `openrouter-key: ok` for the active OpenRouter path.');
      expect(result.output).not.toContain('Claude source auth is a separate proof gate');
      expect(result.output).not.toContain('OpenAI runtime auth is a separate proof gate');
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

  it('supports a blank-machine mode that ignores inherited shell env', async () => {
    const fixture = makeDoctorFixture({
      env: {
        DISCOCLAW_CRON_FORUM: '1000000000000000001',
        DISCOCLAW_TASKS_FORUM: '1000000000000000002',
      },
    });

    try {
      const result = await runDoctorForTestWithArgs(fixture.env, fixture.cwd, ['--blank-machine']);

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Blank-machine mode is active: ignoring inherited shell env and reading only the current .env values.');
      expect(result.output).toContain('DISCOCLAW_CRON_FORUM can be auto-created on first connect via DISCORD_GUILD_ID');
      expect(result.output).toContain('DISCOCLAW_TASKS_FORUM can be auto-created on first connect via DISCORD_GUILD_ID');
      expect(result.output).not.toContain('DISCOCLAW_CRON_FORUM is set and valid');
      expect(result.output).not.toContain('DISCOCLAW_TASKS_FORUM is set and valid');
    } finally {
      fixture.cleanup();
    }
  });

  it('keeps blank-machine proof gates tied to the written .env instead of inherited shell runtime auth', async () => {
    const fixture = makeDoctorFixture({
      env: {
        PRIMARY_RUNTIME: 'codex',
        DISCOCLAW_FAST_RUNTIME: 'openai',
        OPENAI_API_KEY: 'sk-fast-key',
      },
    });

    try {
      const result = await runDoctorForTestWithArgs(fixture.env, fixture.cwd, ['--blank-machine']);

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Blank-machine mode is active: ignoring inherited shell env and reading only the current .env values.');
      expect(result.output).toContain('Claude source auth is a separate proof gate: run `pnpm claude:auth-smoke` after this check.');
      expect(result.output).not.toContain('Codex CLI session auth is a separate proof gate');
      expect(result.output).not.toContain('OpenAI runtime auth is a separate proof gate');
      expect(result.output).not.toContain('OpenRouter runtime proof is a separate gate');
      expect(result.output).not.toContain('Next proof gate: capture separate evidence that the source-checkout Codex CLI session is authenticated; preflight does not invoke `codex`.');
      expect(result.output).not.toContain('Next proof gate: capture separate evidence that the required `OPENAI_API_KEY` path can authenticate; preflight only proves config presence.');
    } finally {
      fixture.cleanup();
    }
  });
});
