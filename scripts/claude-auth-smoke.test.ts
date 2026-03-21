import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_AUTH_SMOKE_PROMPT,
  CLAUDE_AUTH_SMOKE_TIMEOUT_MS,
  classifyClaudeAuthSmokeResult,
  looksLikeClaudeAuthFailure,
  runClaudeAuthSmoke,
  type ClaudeAuthSmokeCommandResult,
} from './claude-auth-smoke.js';

const packageJson = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as {
  scripts?: Record<string, string>;
};

function makeResult(overrides: Partial<ClaudeAuthSmokeCommandResult> = {}): ClaudeAuthSmokeCommandResult {
  return {
    ok: false,
    exitCode: 1,
    stdout: '',
    stderr: '',
    failed: true,
    timedOut: false,
    ...overrides,
  };
}

describe('claude-auth-smoke', () => {
  it('exports pnpm claude:auth-smoke through the repo-owned script entrypoint', () => {
    expect(packageJson.scripts?.['claude:auth-smoke']).toBe('tsx scripts/claude-auth-smoke.ts');
  });

  it('runs the repo-owned minimal Claude prompt at the live boundary', async () => {
    const env: NodeJS.ProcessEnv = { CLAUDE_BIN: 'claude-custom' };
    const lines: string[] = [];
    const runClaudeFn = vi.fn(async () => makeResult({
      ok: true,
      exitCode: 0,
      failed: false,
      stdout: 'OK',
    }));

    const exitCode = await runClaudeAuthSmoke({
      cwd: '/repo',
      env,
      argv: ['node', 'scripts/claude-auth-smoke.ts'],
      deps: {
        log: (line) => {
          lines.push(line);
        },
        runClaudeFn,
      },
    });

    expect(exitCode).toBe(0);
    expect(runClaudeFn).toHaveBeenCalledOnce();
    expect(runClaudeFn).toHaveBeenCalledWith(
      'claude-custom',
      ['-p', '--', CLAUDE_AUTH_SMOKE_PROMPT],
      expect.objectContaining({
        cwd: '/repo',
        env,
        timeoutMs: CLAUDE_AUTH_SMOKE_TIMEOUT_MS,
      }),
    );
    expect(lines.join('\n')).toContain('Claude CLI answered the minimal prompt.');
    expect(lines.join('\n')).toContain('Output preview: OK');
  });

  it('classifies auth/login failures without pretending Claude is ready', async () => {
    const lines: string[] = [];

    const exitCode = await runClaudeAuthSmoke({
      cwd: '/repo',
      env: {},
      argv: ['node', 'scripts/claude-auth-smoke.ts'],
      deps: {
        log: (line) => {
          lines.push(line);
        },
        runClaudeFn: async () => makeResult({
          stderr: 'Authentication required. Please login with `claude` before retrying.',
        }),
      },
    });

    expect(exitCode).toBe(1);
    expect(lines.join('\n')).toContain('Claude CLI appears installed but not authenticated.');
    expect(lines.join('\n')).toContain('Run `claude` to complete login, then rerun this command.');
  });

  it('classifies missing Claude binaries separately from auth failures', async () => {
    const lines: string[] = [];

    const exitCode = await runClaudeAuthSmoke({
      cwd: '/repo',
      env: {},
      argv: ['node', 'scripts/claude-auth-smoke.ts'],
      deps: {
        log: (line) => {
          lines.push(line);
        },
        runClaudeFn: async () => makeResult({
          errorCode: 'ENOENT',
          shortMessage: 'spawn claude ENOENT',
        }),
      },
    });

    expect(exitCode).toBe(1);
    expect(lines.join('\n')).toContain('Claude CLI not found (looked for "claude").');
    expect(lines.join('\n')).toContain('Install Claude Code or set CLAUDE_BIN to the correct binary');
  });

  it('keeps unexpected subprocess failures distinct from auth failures', () => {
    const status = classifyClaudeAuthSmokeResult(makeResult({
      stderr: 'Gateway timeout while contacting remote service.',
      timedOut: true,
    }), 'claude');

    expect(status).toBe('failed');
  });

  it('recognizes common auth failure text patterns', () => {
    expect(looksLikeClaudeAuthFailure('Please log in to Claude Code first.')).toBe(true);
    expect(looksLikeClaudeAuthFailure('Not authenticated: credentials expired.')).toBe(true);
    expect(looksLikeClaudeAuthFailure('OK')).toBe(false);
  });
});
