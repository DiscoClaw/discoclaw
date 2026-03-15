export const FORGE_TURN_PHASES = [
  'draft_research',
  'draft_artifact',
  'audit',
  'revision_research',
  'revision_artifact',
] as const;

export type ForgeTurnPhase = (typeof FORGE_TURN_PHASES)[number];

export type ForgeTurnKind = 'research' | 'final';

export type ForgeTurnRoute = 'native' | 'hybrid' | 'cli';

const FORGE_TURN_PHASE_SET = new Set<ForgeTurnPhase>(FORGE_TURN_PHASES);

export function isForgeTurnPhase(value: unknown): value is ForgeTurnPhase {
  return typeof value === 'string' && FORGE_TURN_PHASE_SET.has(value as ForgeTurnPhase);
}

export function isForgeResearchPhase(phase: ForgeTurnPhase): boolean {
  return phase === 'draft_research' || phase === 'revision_research';
}

export function isForgeFinalArtifactPhase(phase: ForgeTurnPhase): boolean {
  return !isForgeResearchPhase(phase);
}

export function resolveForgeTurnKind(phase: ForgeTurnPhase): ForgeTurnKind {
  return isForgeResearchPhase(phase) ? 'research' : 'final';
}

export function resolveForgeTurnRoute(phase: ForgeTurnPhase): ForgeTurnRoute {
  if (isForgeResearchPhase(phase)) return 'native';
  if (phase === 'audit') return 'hybrid';
  return 'cli';
}

export function resolveForgeReResearchPhase(phase: ForgeTurnPhase): ForgeTurnPhase | null {
  switch (phase) {
    case 'draft_artifact':
      return 'draft_research';
    case 'audit':
    case 'revision_artifact':
      return 'revision_research';
    default:
      return null;
  }
}
