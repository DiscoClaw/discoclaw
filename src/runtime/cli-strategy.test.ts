import { describe, expect, it } from 'vitest';
import { resolveForgeCliRoute } from './cli-strategy.js';
import type { ForgePhaseGuardrails } from './types.js';

describe('resolveForgeCliRoute', () => {
  it('re-enters research when final candidate paths drift outside the allowlist', () => {
    const guardrails: ForgePhaseGuardrails = {
      phase: 'revision_artifact',
      turnKind: 'final',
      candidateBoundPolicy: {
        scope: 'allowlist',
        candidatePaths: [
          'src/runtime/cli-strategy.ts',
          'src/runtime/codex-cli.ts',
        ],
        allowlistPaths: ['src/runtime/cli-strategy.ts'],
      },
      fallbackPolicy: {
        onOutOfBounds: 're_research',
        reResearchPhase: 'revision_research',
        noWidening: true,
      },
      phaseState: {
        researchComplete: true,
      },
    };

    const decision = resolveForgeCliRoute(guardrails);

    expect(decision.status).toBe('re_research');
    expect(decision.nextPhase).toBe('revision_research');
    expect(decision.route).toBe('native');
    expect(decision.reason).toContain('outside the bounded allowlist');
  });

  it('allows final-phase routing when every candidate path stays inside the allowlist', () => {
    const guardrails: ForgePhaseGuardrails = {
      phase: 'revision_artifact',
      turnKind: 'final',
      candidateBoundPolicy: {
        scope: 'allowlist',
        candidatePaths: ['src/runtime/cli-strategy.ts'],
        allowlistPaths: ['src/runtime/cli-strategy.ts'],
      },
      fallbackPolicy: {
        onOutOfBounds: 're_research',
        reResearchPhase: 'revision_research',
        noWidening: true,
      },
      phaseState: {
        researchComplete: true,
      },
    };

    const decision = resolveForgeCliRoute(guardrails);

    expect(decision.status).toBe('allow');
    expect(decision.route).toBe('cli');
    expect(decision.fallbackRoute).toBeNull();
  });
});
