import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildEnvContent, backupFileName } from './setup-lib.js';

const setupSource = fs.readFileSync(new URL('./setup.ts', import.meta.url), 'utf8');

describe('setup: backup file naming', () => {
  it('produces .env.backup.YYYYMMDDTHHMMSS format', () => {
    const name = backupFileName();
    expect(name).toMatch(/^\.env\.backup\.\d{8}T\d{6}$/);
  });

  it('uses the provided date', () => {
    const name = backupFileName(new Date('2026-02-11T14:30:22.000Z'));
    expect(name).toBe('.env.backup.20260211T143022');
  });
});

describe('setup: .env content generation', () => {
  it('includes required values and explicit forum overrides', () => {
    const content = buildEnvContent({
      DISCORD_TOKEN: 'abc.def.ghi',
      DISCORD_ALLOW_USER_IDS: '12345678901234567',
      DISCOCLAW_TASKS_FORUM: '111111111111111111',
      DISCOCLAW_CRON_FORUM: '222222222222222222',
    });
    expect(content).toContain('DISCORD_TOKEN=abc.def.ghi');
    expect(content).toContain('DISCORD_ALLOW_USER_IDS=12345678901234567');
    expect(content).toContain('DISCOCLAW_TASKS_MENTION_USER=12345678901234567');
    expect(content).toContain('# AUTO-DETECTED');
    expect(content).toContain('DISCOCLAW_TASKS_FORUM=111111111111111111');
    expect(content).toContain('DISCOCLAW_CRON_FORUM=222222222222222222');
  });

  it('omits forum placeholders when the wizard relies on bootstrap detection', () => {
    const content = buildEnvContent({
      DISCORD_TOKEN: 'abc.def.ghi',
      DISCORD_ALLOW_USER_IDS: '12345678901234567',
    });
    expect(content).not.toContain('DISCOCLAW_TASKS_FORUM=');
    expect(content).not.toContain('DISCOCLAW_CRON_FORUM=');
    expect(content).not.toContain('# AUTO-DETECTED');
  });

  it('defaults DISCOCLAW_TASKS_MENTION_USER to the first allowlisted user', () => {
    const content = buildEnvContent({
      DISCORD_TOKEN: 'abc.def.ghi',
      DISCORD_ALLOW_USER_IDS: '12345678901234567, 23456789012345678',
    });
    expect(content).toContain('DISCOCLAW_TASKS_MENTION_USER=12345678901234567');
  });

  it('preserves explicit DISCOCLAW_TASKS_MENTION_USER when provided', () => {
    const content = buildEnvContent({
      DISCORD_TOKEN: 'abc.def.ghi',
      DISCORD_ALLOW_USER_IDS: '12345678901234567, 23456789012345678',
      DISCOCLAW_TASKS_MENTION_USER: '23456789012345678',
    });
    expect(content).toContain('DISCOCLAW_TASKS_MENTION_USER=23456789012345678');
  });

  it('includes core values when provided (backward-compat: no PRIMARY_RUNTIME)', () => {
    const content = buildEnvContent({
      DISCORD_TOKEN: 'abc.def.ghi',
      DISCORD_ALLOW_USER_IDS: '12345678901234567',
      DISCORD_GUILD_ID: '98765432109876543',
      CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS: '1',
      CLAUDE_OUTPUT_FORMAT: 'stream-json',
    });
    expect(content).toContain('DISCORD_GUILD_ID=98765432109876543');
    expect(content).toContain('CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS=1');
    expect(content).toContain('CLAUDE_OUTPUT_FORMAT=stream-json');
    expect(content).toContain('# CORE');
    expect(content).not.toContain('# PROVIDER');
  });

  it('Claude provider path places PRIMARY_RUNTIME and Claude vars in # PROVIDER, not # CORE', () => {
    const content = buildEnvContent({
      DISCORD_TOKEN: 'abc.def.ghi',
      DISCORD_ALLOW_USER_IDS: '12345678901234567',
      PRIMARY_RUNTIME: 'claude',
      CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS: '1',
      CLAUDE_OUTPUT_FORMAT: 'stream-json',
    });
    expect(content).toContain('PRIMARY_RUNTIME=claude');
    expect(content).toContain('CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS=1');
    expect(content).toContain('CLAUDE_OUTPUT_FORMAT=stream-json');
    expect(content).toContain('# PROVIDER');
    expect(content).not.toContain('# CORE');
  });

  it('includes optional values when provided', () => {
    const content = buildEnvContent({
      DISCORD_TOKEN: 'abc.def.ghi',
      DISCORD_ALLOW_USER_IDS: '12345678901234567',
      DISCOCLAW_TASKS_FORUM: '111111111111111111',
      DISCOCLAW_CRON_FORUM: '222222222222222222',
      DISCOCLAW_DISCORD_ACTIONS: '1',
      DISCOCLAW_STATUS_CHANNEL: 'status',
    });
    expect(content).toContain('DISCOCLAW_DISCORD_ACTIONS=1');
    expect(content).toContain('DISCOCLAW_STATUS_CHANNEL=status');
  });

  it('omits optional section when no optional values', () => {
    const content = buildEnvContent({
      DISCORD_TOKEN: 'abc.def.ghi',
      DISCORD_ALLOW_USER_IDS: '12345678901234567',
    });
    expect(content).not.toContain('# OPTIONAL');
  });

  it('includes reference to .env.example.full', () => {
    const content = buildEnvContent({
      DISCORD_TOKEN: 'abc.def.ghi',
      DISCORD_ALLOW_USER_IDS: '12345678901234567',
    });
    expect(content).toContain('.env.example.full');
  });

  it('includes generated-by header and timestamp', () => {
    const ts = new Date('2026-02-11T12:00:00.000Z');
    const content = buildEnvContent({
      DISCORD_TOKEN: 'abc.def.ghi',
      DISCORD_ALLOW_USER_IDS: '12345678901234567',
    }, ts);
    expect(content).toContain('generated by pnpm run setup');
    expect(content).toContain('Created: 2026-02-11T12:00:00.000Z');
  });

  it('omits core section when no core values are set', () => {
    const content = buildEnvContent({
      DISCORD_TOKEN: 'abc.def.ghi',
      DISCORD_ALLOW_USER_IDS: '12345678901234567',
    });
    expect(content).not.toContain('# CORE');
  });

  it('includes PRIMARY_RUNTIME and Gemini values when provided', () => {
    const content = buildEnvContent({
      DISCORD_TOKEN: 'abc.def.ghi',
      DISCORD_ALLOW_USER_IDS: '12345678901234567',
      PRIMARY_RUNTIME: 'gemini',
      GEMINI_BIN: 'gemini',
      GEMINI_MODEL: 'gemini-2.5-pro',
    });
    expect(content).toContain('PRIMARY_RUNTIME=gemini');
    expect(content).toContain('GEMINI_BIN=gemini');
    expect(content).toContain('GEMINI_MODEL=gemini-2.5-pro');
  });

  it('includes PRIMARY_RUNTIME and OpenAI key when provided', () => {
    const content = buildEnvContent({
      DISCORD_TOKEN: 'abc.def.ghi',
      DISCORD_ALLOW_USER_IDS: '12345678901234567',
      PRIMARY_RUNTIME: 'openai',
      OPENAI_API_KEY: 'sk-test-key',
    });
    expect(content).toContain('PRIMARY_RUNTIME=openai');
    expect(content).toContain('OPENAI_API_KEY=sk-test-key');
  });

  it('includes PRIMARY_RUNTIME and OpenRouter values when provided', () => {
    const content = buildEnvContent({
      DISCORD_TOKEN: 'abc.def.ghi',
      DISCORD_ALLOW_USER_IDS: '12345678901234567',
      PRIMARY_RUNTIME: 'openrouter',
      OPENROUTER_API_KEY: 'sk-or-test',
      OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
      OPENROUTER_MODEL: 'anthropic/claude-sonnet-4-20250514',
    });
    expect(content).toContain('PRIMARY_RUNTIME=openrouter');
    expect(content).toContain('OPENROUTER_API_KEY=sk-or-test');
    expect(content).toContain('OPENROUTER_BASE_URL=https://openrouter.ai/api/v1');
    expect(content).toContain('OPENROUTER_MODEL=anthropic/claude-sonnet-4-20250514');
  });

  it('includes PRIMARY_RUNTIME and Codex values when provided', () => {
    const content = buildEnvContent({
      DISCORD_TOKEN: 'abc.def.ghi',
      DISCORD_ALLOW_USER_IDS: '12345678901234567',
      PRIMARY_RUNTIME: 'codex',
      CODEX_BIN: '/usr/local/bin/codex',
      CODEX_MODEL: 'codex-latest',
      CODEX_DANGEROUSLY_BYPASS_APPROVALS_AND_SANDBOX: '1',
    });
    expect(content).toContain('PRIMARY_RUNTIME=codex');
    expect(content).toContain('CODEX_BIN=/usr/local/bin/codex');
    expect(content).toContain('CODEX_MODEL=codex-latest');
    expect(content).toContain('CODEX_DANGEROUSLY_BYPASS_APPROVALS_AND_SANDBOX=1');
  });

  it('includes fast-runtime split values for codex+openai when provided', () => {
    const content = buildEnvContent({
      DISCORD_TOKEN: 'abc.def.ghi',
      DISCORD_ALLOW_USER_IDS: '12345678901234567',
      PRIMARY_RUNTIME: 'codex',
      OPENAI_API_KEY: 'sk-fast',
      DISCOCLAW_FAST_RUNTIME: 'openai',
      DISCOCLAW_TIER_OPENAI_FAST: 'gpt-5-mini',
    });
    expect(content).toContain('PRIMARY_RUNTIME=codex');
    expect(content).toContain('OPENAI_API_KEY=sk-fast');
    expect(content).toContain('DISCOCLAW_FAST_RUNTIME=openai');
    expect(content).toContain('DISCOCLAW_TIER_OPENAI_FAST=gpt-5-mini');
  });
});

describe('setup: atomic write design', () => {
  it('buildEnvContent produces valid .env syntax (KEY=VALUE per line)', () => {
    const content = buildEnvContent({
      DISCORD_TOKEN: 'abc.def.ghi',
      DISCORD_ALLOW_USER_IDS: '12345678901234567',
    });
    const dataLines = content.split('\n').filter((l) => l && !l.startsWith('#'));
    for (const line of dataLines) {
      expect(line).toMatch(/^[A-Z_]+=.*/);
    }
  });
});

describe('setup: wizard copy contract', () => {
  it('describes guild bootstrap instead of requiring forum IDs up front', () => {
    expect(setupSource).toContain('and at least one allowed Discord user ID.');
    expect(setupSource).toContain('If you set DISCORD_GUILD_ID, Discoclaw can auto-create the Tasks/Automations forums on first connect.');
    expect(setupSource).toContain('If you leave DISCORD_GUILD_ID empty, you need existing scaffold state or explicit forum IDs later.');
    expect(setupSource).toContain('leave empty only if you already have scaffold/forum state another way');
    expect(setupSource).not.toContain('and your Tasks/Cron forum channel IDs from Discord.');
    expect(setupSource).not.toContain('Tasks forum channel ID (required): ');
    expect(setupSource).not.toContain('Automations forum channel ID (required): ');
  });

  it('only shows the manual Claude smoke steps after automated preflight passes', () => {
    expect(setupSource).toContain('Automated checks passed. Claude auth still needs a manual smoke test.');
    expect(setupSource).toContain('Before logging in, run `pnpm claude:auth-smoke`.');
    expect(setupSource).toContain('On a fresh machine, the expected result is `Claude CLI appears installed but not authenticated.`');
    expect(setupSource).toContain('Log in with `claude`.');
    expect(setupSource).toContain('Repeat `pnpm claude:auth-smoke`.');
    expect(setupSource).toContain('After login, the expected result is `Claude CLI answered the minimal prompt.`');
    expect(setupSource).toContain('Fix the preflight issues above.');
    expect(setupSource).toContain('Re-run `pnpm preflight:blank-machine` until the automated checks pass.');
    expect(setupSource).toContain('Only after that should you run `pnpm claude:auth-smoke` for the manual Claude auth check.');
    expect(setupSource).not.toContain('claude -p -- "Reply with OK"');
  });

  it('uses explicit source-checkout proof gates for OpenAI and Codex instead of install-only placeholders', () => {
    expect(setupSource).toContain('`OPENAI_API_KEY` auth is a separate source-checkout proof gate; setup only wrote the config.');
    expect(setupSource).toContain('Run `OPENAI_SMOKE_TEST_TIERS=fast pnpm test` and confirm the `openai / fast` smoke passes.');
    expect(setupSource).toContain('If you need exact model evidence instead of the fast-tier check, replace `fast` with your intended tier or model ID.');
    expect(setupSource).toContain('Codex CLI session auth is a separate source-checkout proof gate; setup only wrote the config.');
    expect(setupSource).toContain("const codexBin = values.CODEX_BIN || 'codex';");
    expect(setupSource).toContain("const codexModel = values.CODEX_MODEL || 'gpt-5.4';");
    expect(setupSource).toContain('--skip-git-repo-check --ephemeral -s read-only -- "Reply with OK"');
    expect(setupSource).toContain('confirm it returns normal text.');
    expect(setupSource).toContain('The optional OpenAI fast-tier path needs separate `OPENAI_API_KEY` evidence.');
    expect(setupSource).not.toContain('Verify your OPENAI_API_KEY is correct.');
    expect(setupSource).not.toContain('Ensure the Codex binary is installed and accessible.');
  });

  it('adds OpenRouter as a first-class provider and points source checkouts at preflight plus live proof', () => {
    expect(setupSource).toContain("console.log('  5) OpenRouter');");
    expect(setupSource).toContain("'Provider [1-5]: '");
    expect(setupSource).toContain("values.PRIMARY_RUNTIME = 'openrouter';");
    expect(setupSource).toContain("values.OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';");
    expect(setupSource).toContain("values.OPENROUTER_MODEL = 'anthropic/claude-sonnet-4-20250514';");
    expect(setupSource).toContain('Run `pnpm preflight:blank-machine` and fix any config issues it reports.');
    expect(setupSource).toContain('Start discoclaw with `pnpm dev` and confirm `!status` (or the startup credential report) shows `openrouter-key: ok` for the active OpenRouter path.');
    expect(setupSource).toContain('Treat that `openrouter-key: ok` signal as proof only for the shipped `OPENROUTER_API_KEY` path, not broader OpenRouter parity.');
  });
});
