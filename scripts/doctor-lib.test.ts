import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkRequiredForums, checkRuntimeBinaries } from './doctor-lib.js';

describe('doctor-lib: required forums', () => {
  it('passes blank-machine first connect when DISCORD_GUILD_ID is set', () => {
    const checks = checkRequiredForums({
      DISCORD_GUILD_ID: '1000000000000000000',
    });
    expect(checks.some((c) => c.ok && c.label.includes('DISCOCLAW_CRON_FORUM can be auto-created'))).toBe(true);
    expect(checks.some((c) => c.ok && c.label.includes('DISCOCLAW_TASKS_FORUM can be auto-created'))).toBe(true);
  });

  it('fails when forums are missing and DISCORD_GUILD_ID is absent', () => {
    const checks = checkRequiredForums({ DISCOCLAW_DATA_DIR: '/tmp/doctor-lib-test-nonexistent' });
    expect(checks.some((c) => !c.ok && c.label.includes('DISCOCLAW_CRON_FORUM is required'))).toBe(true);
    expect(checks.some((c) => !c.ok && c.label.includes('DISCOCLAW_TASKS_FORUM is required'))).toBe(true);
  });

  it('passes when both required forums are valid snowflakes', () => {
    const checks = checkRequiredForums({
      DISCOCLAW_CRON_FORUM: '1000000000000000001',
      DISCOCLAW_TASKS_FORUM: '1000000000000000002',
    });
    expect(checks.some((c) => c.ok && c.label.includes('DISCOCLAW_CRON_FORUM is set and valid'))).toBe(true);
    expect(checks.some((c) => c.ok && c.label.includes('DISCOCLAW_TASKS_FORUM is set and valid'))).toBe(true);
  });

  it('passes when missing forums are already persisted in scaffold state', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-lib-test-'));
    const scaffoldStatePath = path.join(dataDir, 'system-scaffold.json');
    fs.writeFileSync(scaffoldStatePath, JSON.stringify({
      guildId: '1000000000000000000',
      cronsForumId: '1000000000000000001',
      tasksForumId: '1000000000000000002',
    }));

    const checks = checkRequiredForums({
      DISCOCLAW_DATA_DIR: dataDir,
    });
    expect(checks.some((c) => c.ok && c.label.includes('DISCOCLAW_CRON_FORUM resolved from persisted scaffold state'))).toBe(true);
    expect(checks.some((c) => c.ok && c.label.includes('DISCOCLAW_TASKS_FORUM resolved from persisted scaffold state'))).toBe(true);

    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('does not require cron forum when cron is disabled', () => {
    const checks = checkRequiredForums({
      DISCOCLAW_CRON_ENABLED: '0',
      DISCOCLAW_TASKS_FORUM: '1000000000000000002',
    });
    expect(checks.some((c) => c.label.includes('DISCOCLAW_CRON_FORUM'))).toBe(false);
  });

  it('does not require tasks forum when tasks are disabled', () => {
    const checks = checkRequiredForums({
      DISCOCLAW_TASKS_ENABLED: '0',
      DISCOCLAW_CRON_FORUM: '1000000000000000001',
    });
    expect(checks.some((c) => c.label.includes('DISCOCLAW_TASKS_FORUM'))).toBe(false);
  });

  it('fails invalid boolean toggles with actionable error', () => {
    const checks = checkRequiredForums({
      DISCOCLAW_CRON_ENABLED: 'yes',
      DISCOCLAW_TASKS_ENABLED: 'nope',
    });
    expect(checks.some((c) => !c.ok && c.label.includes('DISCOCLAW_CRON_ENABLED must'))).toBe(true);
    expect(checks.some((c) => !c.ok && c.label.includes('DISCOCLAW_TASKS_ENABLED must'))).toBe(true);
  });
});

describe('doctor-lib: checkRuntimeBinaries', () => {
  const notFound = (_bin: string): string | null => null;
  const foundAll = (bin: string): string | null => `/usr/local/bin/${bin}`;

  it('fails when claude is needed by default and binary is missing', () => {
    const checks = checkRuntimeBinaries({}, notFound);
    const c = checks.find((r) => r.label.includes('Claude CLI'));
    expect(c?.ok).toBe(false);
    expect(c?.info).toBeFalsy();
  });

  it('passes when claude is needed by default and binary is present', () => {
    const checks = checkRuntimeBinaries({}, (bin) => bin === 'claude' ? '/usr/bin/claude' : null);
    const c = checks.find((r) => r.label.includes('Claude CLI'));
    expect(c?.ok).toBe(true);
    expect(c?.info).toBeFalsy();
  });

  it('reports gemini as info when claude is primary and gemini is absent', () => {
    const checks = checkRuntimeBinaries({}, (bin) => bin === 'claude' ? '/usr/bin/claude' : null);
    const c = checks.find((r) => r.label.includes('Gemini CLI'));
    expect(c?.ok).toBe(true);
    expect(c?.info).toBe(true);
  });

  it('fails when PRIMARY_RUNTIME=gemini and gemini binary is missing', () => {
    const checks = checkRuntimeBinaries({ PRIMARY_RUNTIME: 'gemini' }, notFound);
    const c = checks.find((r) => r.label.includes('Gemini CLI'));
    expect(c?.ok).toBe(false);
    expect(c?.info).toBeFalsy();
  });

  it('passes when PRIMARY_RUNTIME=gemini and gemini binary is present', () => {
    const checks = checkRuntimeBinaries({ PRIMARY_RUNTIME: 'gemini' }, (bin) => bin === 'gemini' ? '/usr/bin/gemini' : null);
    const c = checks.find((r) => r.label.includes('Gemini CLI'));
    expect(c?.ok).toBe(true);
    expect(c?.info).toBeFalsy();
  });

  it('reports claude as info when PRIMARY_RUNTIME=gemini and claude is absent', () => {
    const checks = checkRuntimeBinaries({ PRIMARY_RUNTIME: 'gemini' }, (bin) => bin === 'gemini' ? '/usr/bin/gemini' : null);
    const c = checks.find((r) => r.label.includes('Claude CLI'));
    expect(c?.ok).toBe(true);
    expect(c?.info).toBe(true);
  });

  it('requires gemini binary when FORGE_DRAFTER_RUNTIME=gemini', () => {
    const checks = checkRuntimeBinaries({ FORGE_DRAFTER_RUNTIME: 'gemini' }, notFound);
    const c = checks.find((r) => r.label.includes('Gemini CLI'));
    expect(c?.ok).toBe(false);
    expect(c?.info).toBeFalsy();
  });

  it('requires gemini binary when FORGE_AUDITOR_RUNTIME=gemini', () => {
    const checks = checkRuntimeBinaries({ FORGE_AUDITOR_RUNTIME: 'gemini' }, notFound);
    const c = checks.find((r) => r.label.includes('Gemini CLI'));
    expect(c?.ok).toBe(false);
    expect(c?.info).toBeFalsy();
  });

  it('requires codex binary when FORGE_AUDITOR_RUNTIME=codex', () => {
    const checks = checkRuntimeBinaries({ FORGE_AUDITOR_RUNTIME: 'codex' }, notFound);
    const c = checks.find((r) => r.label.includes('Codex CLI'));
    expect(c?.ok).toBe(false);
    expect(c?.info).toBeFalsy();
  });

  it('normalizes PRIMARY_RUNTIME=claude_code to claude', () => {
    const checks = checkRuntimeBinaries({ PRIMARY_RUNTIME: 'claude_code' }, (bin) => bin === 'claude' ? '/usr/bin/claude' : null);
    const c = checks.find((r) => r.label.includes('Claude CLI'));
    expect(c?.ok).toBe(true);
    expect(c?.info).toBeFalsy();
  });

  it('normalizes PRIMARY_RUNTIME with mixed case (GEMINI)', () => {
    const checks = checkRuntimeBinaries({ PRIMARY_RUNTIME: 'GEMINI' }, (bin) => bin === 'gemini' ? '/usr/bin/gemini' : null);
    const c = checks.find((r) => r.label.includes('Gemini CLI'));
    expect(c?.ok).toBe(true);
    expect(c?.info).toBeFalsy();
  });

  it('uses CLAUDE_BIN env var for claude binary lookup', () => {
    const checks = checkRuntimeBinaries({ CLAUDE_BIN: 'claude-custom' }, (bin) => bin === 'claude-custom' ? '/usr/bin/claude-custom' : null);
    const c = checks.find((r) => r.label.includes('Claude CLI'));
    expect(c?.ok).toBe(true);
    expect(c?.info).toBeFalsy();
  });

  it('uses GEMINI_BIN env var for gemini binary lookup', () => {
    const checks = checkRuntimeBinaries(
      { PRIMARY_RUNTIME: 'gemini', GEMINI_BIN: 'gemini-custom' },
      (bin) => bin === 'gemini-custom' ? '/usr/bin/gemini-custom' : null,
    );
    const c = checks.find((r) => r.label.includes('Gemini CLI'));
    expect(c?.ok).toBe(true);
    expect(c?.info).toBeFalsy();
  });

  it('returns ok for both when all binaries are found', () => {
    const checks = checkRuntimeBinaries({ PRIMARY_RUNTIME: 'claude', FORGE_DRAFTER_RUNTIME: 'gemini' }, foundAll);
    const claudeCheck = checks.find((r) => r.label.includes('Claude CLI'));
    const geminiCheck = checks.find((r) => r.label.includes('Gemini CLI'));
    expect(claudeCheck?.ok).toBe(true);
    expect(claudeCheck?.info).toBeFalsy();
    expect(geminiCheck?.ok).toBe(true);
    expect(geminiCheck?.info).toBeFalsy();
  });

  it('reports codex as info when claude is primary and codex is absent', () => {
    const checks = checkRuntimeBinaries({}, (bin) => bin === 'claude' ? '/usr/bin/claude' : null);
    const c = checks.find((r) => r.label.includes('Codex CLI'));
    expect(c?.ok).toBe(true);
    expect(c?.info).toBe(true);
  });

  it('fails when PRIMARY_RUNTIME=codex and codex binary is missing', () => {
    const checks = checkRuntimeBinaries({ PRIMARY_RUNTIME: 'codex' }, notFound);
    const c = checks.find((r) => r.label.includes('Codex CLI'));
    expect(c?.ok).toBe(false);
    expect(c?.info).toBeFalsy();
  });

  it('passes when PRIMARY_RUNTIME=codex and codex binary is present', () => {
    const checks = checkRuntimeBinaries({ PRIMARY_RUNTIME: 'codex' }, (bin) => bin === 'codex' ? '/usr/bin/codex' : null);
    const c = checks.find((r) => r.label.includes('Codex CLI'));
    expect(c?.ok).toBe(true);
    expect(c?.info).toBeFalsy();
  });

  it('requires codex binary when FORGE_DRAFTER_RUNTIME=codex', () => {
    const checks = checkRuntimeBinaries({ FORGE_DRAFTER_RUNTIME: 'codex' }, notFound);
    const c = checks.find((r) => r.label.includes('Codex CLI'));
    expect(c?.ok).toBe(false);
    expect(c?.info).toBeFalsy();
  });

  it('uses CODEX_BIN env var for codex binary lookup', () => {
    const checks = checkRuntimeBinaries(
      { PRIMARY_RUNTIME: 'codex', CODEX_BIN: 'codex-custom' },
      (bin) => bin === 'codex-custom' ? '/usr/bin/codex-custom' : null,
    );
    const c = checks.find((r) => r.label.includes('Codex CLI'));
    expect(c?.ok).toBe(true);
    expect(c?.info).toBeFalsy();
  });

  it('reports OPENAI_API_KEY as info when openai is not a needed runtime', () => {
    const checks = checkRuntimeBinaries({}, notFound);
    const c = checks.find((r) => r.label.includes('OPENAI_API_KEY'));
    expect(c?.ok).toBe(true);
    expect(c?.info).toBe(true);
  });

  it('fails when PRIMARY_RUNTIME=openai and OPENAI_API_KEY is absent', () => {
    const checks = checkRuntimeBinaries({ PRIMARY_RUNTIME: 'openai' }, notFound);
    const c = checks.find((r) => r.label.includes('OPENAI_API_KEY'));
    expect(c?.ok).toBe(false);
    expect(c?.info).toBeFalsy();
  });

  it('passes when PRIMARY_RUNTIME=openai and OPENAI_API_KEY is set', () => {
    const checks = checkRuntimeBinaries({ PRIMARY_RUNTIME: 'openai', OPENAI_API_KEY: 'sk-test' }, notFound);
    const c = checks.find((r) => r.label.includes('OPENAI_API_KEY'));
    expect(c?.ok).toBe(true);
    expect(c?.info).toBeFalsy();
  });

  it('treats whitespace-only OPENAI_API_KEY as absent', () => {
    const checks = checkRuntimeBinaries({ PRIMARY_RUNTIME: 'openai', OPENAI_API_KEY: '   ' }, notFound);
    const c = checks.find((r) => r.label.includes('OPENAI_API_KEY'));
    expect(c?.ok).toBe(false);
    expect(c?.info).toBeFalsy();
  });

  it('requires OPENAI_API_KEY when FORGE_DRAFTER_RUNTIME=openai', () => {
    const checks = checkRuntimeBinaries({ FORGE_DRAFTER_RUNTIME: 'openai' }, notFound);
    const c = checks.find((r) => r.label.includes('OPENAI_API_KEY'));
    expect(c?.ok).toBe(false);
    expect(c?.info).toBeFalsy();
  });

  it('requires OPENAI_API_KEY when FORGE_AUDITOR_RUNTIME=openai', () => {
    const checks = checkRuntimeBinaries({ FORGE_AUDITOR_RUNTIME: 'openai' }, notFound);
    const c = checks.find((r) => r.label.includes('OPENAI_API_KEY'));
    expect(c?.ok).toBe(false);
    expect(c?.info).toBeFalsy();
  });

  it('requires OPENAI_API_KEY when DISCOCLAW_FAST_RUNTIME=openai', () => {
    const checks = checkRuntimeBinaries({ DISCOCLAW_FAST_RUNTIME: 'openai' }, notFound);
    const c = checks.find((r) => r.label.includes('OPENAI_API_KEY'));
    expect(c?.ok).toBe(false);
    expect(c?.info).toBeFalsy();
  });

  it('reports OPENROUTER_API_KEY as info when openrouter is not a needed runtime', () => {
    const checks = checkRuntimeBinaries({}, notFound);
    const c = checks.find((r) => r.label.includes('OPENROUTER_API_KEY'));
    expect(c?.ok).toBe(true);
    expect(c?.info).toBe(true);
  });

  it('fails when PRIMARY_RUNTIME=openrouter and OPENROUTER_API_KEY is absent', () => {
    const checks = checkRuntimeBinaries({ PRIMARY_RUNTIME: 'openrouter' }, notFound);
    const c = checks.find((r) => r.label.includes('OPENROUTER_API_KEY'));
    expect(c?.ok).toBe(false);
    expect(c?.info).toBeFalsy();
  });

  it('passes when PRIMARY_RUNTIME=openrouter and OPENROUTER_API_KEY is set', () => {
    const checks = checkRuntimeBinaries({ PRIMARY_RUNTIME: 'openrouter', OPENROUTER_API_KEY: 'sk-or-test' }, notFound);
    const c = checks.find((r) => r.label.includes('OPENROUTER_API_KEY'));
    expect(c?.ok).toBe(true);
    expect(c?.info).toBeFalsy();
  });

  it('treats whitespace-only OPENROUTER_API_KEY as absent', () => {
    const checks = checkRuntimeBinaries({ PRIMARY_RUNTIME: 'openrouter', OPENROUTER_API_KEY: '   ' }, notFound);
    const c = checks.find((r) => r.label.includes('OPENROUTER_API_KEY'));
    expect(c?.ok).toBe(false);
    expect(c?.info).toBeFalsy();
  });

  it('requires OPENROUTER_API_KEY when DISCOCLAW_FAST_RUNTIME=openrouter', () => {
    const checks = checkRuntimeBinaries({ DISCOCLAW_FAST_RUNTIME: 'openrouter' }, notFound);
    const c = checks.find((r) => r.label.includes('OPENROUTER_API_KEY'));
    expect(c?.ok).toBe(false);
    expect(c?.info).toBeFalsy();
  });

  it('requires OPENROUTER_API_KEY when FORGE_DRAFTER_RUNTIME=openrouter', () => {
    const checks = checkRuntimeBinaries({ FORGE_DRAFTER_RUNTIME: 'openrouter' }, notFound);
    const c = checks.find((r) => r.label.includes('OPENROUTER_API_KEY'));
    expect(c?.ok).toBe(false);
    expect(c?.info).toBeFalsy();
  });

  it('requires OPENROUTER_API_KEY when FORGE_AUDITOR_RUNTIME=openrouter', () => {
    const checks = checkRuntimeBinaries({ FORGE_AUDITOR_RUNTIME: 'openrouter' }, notFound);
    const c = checks.find((r) => r.label.includes('OPENROUTER_API_KEY'));
    expect(c?.ok).toBe(false);
    expect(c?.info).toBeFalsy();
  });
});
