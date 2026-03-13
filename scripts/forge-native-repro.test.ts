import { describe, expect, it } from 'vitest';
import { derivePlanReplaySeed, parseForgeNativeReproArgs } from './forge-native-repro.js';

describe('parseForgeNativeReproArgs', () => {
  it('parses inline and positional flag values', () => {
    const parsed = parseForgeNativeReproArgs([
      '--from-plan=plan-502',
      '--task-id',
      'ws-1223',
      '--context-file',
      'tmp/context.md',
      '--out-dir',
      '/tmp/out',
      '--trace-notifications',
      '--trace-cli-stdio',
      '--dry-run',
    ]);

    expect(parsed).toEqual({
      fromPlan: 'plan-502',
      taskId: 'ws-1223',
      contextFile: 'tmp/context.md',
      outDir: '/tmp/out',
      dryRun: true,
      traceNotifications: true,
      traceCliStdio: true,
      help: false,
    });
  });

  it('supports direct descriptions', () => {
    const parsed = parseForgeNativeReproArgs(['--description', 'Restore forge auditor to Codex']);
    expect(parsed).toEqual({
      description: 'Restore forge auditor to Codex',
      dryRun: false,
      traceNotifications: false,
      traceCliStdio: false,
      help: false,
    });
  });

  it('ignores a standalone pnpm argument separator', () => {
    const parsed = parseForgeNativeReproArgs(['--', '--from-plan', 'plan-502']);
    expect(parsed).toEqual({
      fromPlan: 'plan-502',
      dryRun: false,
      traceNotifications: false,
      traceCliStdio: false,
      help: false,
    });
  });

  it('throws on unknown arguments', () => {
    expect(() => parseForgeNativeReproArgs(['--bogus'])).toThrow('Unknown argument: --bogus');
  });
});

describe('derivePlanReplaySeed', () => {
  it('extracts title, task id, and context from a plan file', () => {
    const seed = derivePlanReplaySeed(`
# Plan: Restore forge auditor to Codex
**ID:** plan-502
**Task:** ws-1223
**Status:** CANCELLED
---

## Objective
Get forge healthy again.

## Context
Native forge started and then went quiet after first progress.
`);

    expect(seed).toEqual({
      description: 'Restore forge auditor to Codex',
      taskId: 'ws-1223',
      context: 'Native forge started and then went quiet after first progress.',
    });
  });

  it('throws when the plan file has no title', () => {
    expect(() => derivePlanReplaySeed('**ID:** plan-502\n---\n\n## Context\nctx')).toThrow(
      'Plan is missing a `# Plan:` title',
    );
  });
});
