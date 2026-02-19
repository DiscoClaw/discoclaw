import { describe, expect, it } from 'vitest';
import { checkRequiredForums, checkRuntimeBinaries } from './doctor-lib.js';

describe('doctor-lib: required forums', () => {
  it('fails when enabled-by-default forums are missing', () => {
    const checks = checkRequiredForums({});
    expect(checks.some((c) => !c.ok && c.label.includes('DISCOCLAW_CRON_FORUM is required'))).toBe(true);
    expect(checks.some((c) => !c.ok && c.label.includes('DISCOCLAW_BEADS_FORUM is required'))).toBe(true);
  });

  it('passes when both required forums are valid snowflakes', () => {
    const checks = checkRequiredForums({
      DISCOCLAW_CRON_FORUM: '1000000000000000001',
      DISCOCLAW_BEADS_FORUM: '1000000000000000002',
    });
    expect(checks.some((c) => c.ok && c.label.includes('DISCOCLAW_CRON_FORUM is set and valid'))).toBe(true);
    expect(checks.some((c) => c.ok && c.label.includes('DISCOCLAW_BEADS_FORUM is set and valid'))).toBe(true);
  });

  it('does not require cron forum when cron is disabled', () => {
    const checks = checkRequiredForums({
      DISCOCLAW_CRON_ENABLED: '0',
      DISCOCLAW_BEADS_FORUM: '1000000000000000002',
    });
    expect(checks.some((c) => c.label.includes('DISCOCLAW_CRON_FORUM'))).toBe(false);
  });

  it('fails invalid boolean toggles with actionable error', () => {
    const checks = checkRequiredForums({
      DISCOCLAW_CRON_ENABLED: 'yes',
      DISCOCLAW_BEADS_ENABLED: 'nope',
    });
    expect(checks.some((c) => !c.ok && c.label.includes('DISCOCLAW_CRON_ENABLED must'))).toBe(true);
    expect(checks.some((c) => !c.ok && c.label.includes('DISCOCLAW_BEADS_ENABLED must'))).toBe(true);
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
    expect(checks.find((r) => r.label.includes('Claude CLI'))?.ok).toBe(true);
    expect(checks.find((r) => r.label.includes('Gemini CLI'))?.ok).toBe(true);
    expect(checks.every((r) => !r.info)).toBe(true);
  });
});
