import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LEGACY_GUARD_RULES,
  collectGuardTargetFiles,
  runLegacyTokenGuard,
  scanFileContent,
  type GuardRule,
} from './legacy-token-guard.js';

describe('legacy-token-guard: unit', () => {
  it('detects blocked legacy tokens', () => {
    const input = [
      "const x = process.env.DISCOCLAW_BEADS_FORUM;",
      "const mod = './actions-beads.js';",
      'const beadCtx = {};',
      "import { runBeadSync } from '../beads/bead-sync.js';",
      "const seed = 'scripts/beads/tag-map.json';",
      "const db = '/tmp/.beads/beads.db';",
    ].join('\n');

    const matches = scanFileContent('src/example.ts', input, DEFAULT_LEGACY_GUARD_RULES);
    expect(matches.length).toBeGreaterThanOrEqual(6);
    expect(matches.some((m) => m.ruleId === 'legacy-env-beads')).toBe(true);
    expect(matches.some((m) => m.ruleId === 'legacy-action-module')).toBe(true);
    expect(matches.some((m) => m.ruleId === 'legacy-bead-context')).toBe(true);
    expect(matches.some((m) => m.ruleId === 'legacy-beads-import-path')).toBe(true);
    expect(matches.some((m) => m.ruleId === 'legacy-beads-script-path')).toBe(true);
    expect(matches.some((m) => m.ruleId === 'legacy-beads-db-path')).toBe(true);
  });

  it('respects per-rule allowlist globs', () => {
    const rules: GuardRule[] = [
      {
        id: 'legacy-bead-context',
        pattern: /\bbeadCtx\b/g,
        message: 'Use taskCtx naming.',
        allowIn: ['src/allowed/**'],
      },
    ];

    const allowedMatches = scanFileContent('src/allowed/bridge.ts', 'const beadCtx = {};', rules);
    expect(allowedMatches).toEqual([]);

    const blockedMatches = scanFileContent('src/runtime/main.ts', 'const beadCtx = {};', rules);
    expect(blockedMatches).toHaveLength(1);
    expect(blockedMatches[0]?.ruleId).toBe('legacy-bead-context');
  });

  it('blocks beads import-path references everywhere after shim retirement', () => {
    const input = "export * from '../beads/bead-sync.js';";
    const matches = scanFileContent('src/beads/compat-shim.ts', input, DEFAULT_LEGACY_GUARD_RULES);
    expect(matches.some((m) => m.ruleId === 'legacy-beads-import-path')).toBe(true);
  });

  it('blocks scripts/beads references everywhere after script hard-cut', () => {
    const input = "const seed = 'scripts/beads/tag-map.json';";
    const blocked = scanFileContent('src/index.ts', input, DEFAULT_LEGACY_GUARD_RULES);
    const blockedInScripts = scanFileContent('scripts/tasks/task-wrapper.sh', input, DEFAULT_LEGACY_GUARD_RULES);

    expect(blocked.some((m) => m.ruleId === 'legacy-beads-script-path')).toBe(true);
    expect(blockedInScripts.some((m) => m.ruleId === 'legacy-beads-script-path')).toBe(true);
  });

  it('allows legacy bd DB path only in migration adapter', () => {
    const input = "const dbPath = '/tmp/.beads/beads.db';";
    const allowed = scanFileContent('src/tasks/bd-cli.ts', input, DEFAULT_LEGACY_GUARD_RULES);
    const blocked = scanFileContent('src/index.ts', input, DEFAULT_LEGACY_GUARD_RULES);

    expect(allowed.some((m) => m.ruleId === 'legacy-beads-db-path')).toBe(false);
    expect(blocked.some((m) => m.ruleId === 'legacy-beads-db-path')).toBe(true);
  });

  it('blocks legacy plan header/token compatibility everywhere after hard-cut', () => {
    const input = ['**Bead:** ws-001', '{{BEAD_ID}}'].join('\n');
    const blocked = scanFileContent('src/discord/plan-commands.ts', input, DEFAULT_LEGACY_GUARD_RULES);

    expect(blocked.some((m) => m.ruleId === 'legacy-plan-header-bead')).toBe(true);
    expect(blocked.some((m) => m.ruleId === 'legacy-plan-template-bead-id')).toBe(true);
  });
});

describe('legacy-token-guard: repository gate', () => {
  it('scans the expected runtime target set', async () => {
    const files = await collectGuardTargetFiles(process.cwd());
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.startsWith('src/'))).toBe(true);
    expect(files.some((f) => f.startsWith('scripts/'))).toBe(true);
    expect(files.some((f) => f.endsWith('.test.ts'))).toBe(false);
  });

  it('reports zero legacy-token violations in tracked runtime files', async () => {
    const report = await runLegacyTokenGuard({ rootDir: process.cwd() });
    expect(report.scannedFiles).toBeGreaterThan(0);
    expect(report.matches).toEqual([]);
  });
});
