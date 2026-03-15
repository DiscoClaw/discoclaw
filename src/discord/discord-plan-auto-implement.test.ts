import { describe, expect, it } from 'vitest';
import {
  buildPlanImplementationMessage,
  legacyPlanImplementationCta,
} from './forge-commands.js';

describe('buildPlanImplementationMessage', () => {
  const planId = 'plan-123';

  it('returns only the CTA when there is no skip reason', () => {
    expect(buildPlanImplementationMessage(undefined, planId)).toBe(legacyPlanImplementationCta(planId));
  });

  it('appends the CTA when the skip reason does not already include it', () => {
    const reason = 'Skipped auto-implementation because severity warnings remain.';
    const message = buildPlanImplementationMessage(reason, planId);

    expect(message).toBe(`${reason}\n\n${legacyPlanImplementationCta(planId)}`);
  });

  it('does not duplicate the CTA when the skip reason already contains it', () => {
    const cta = legacyPlanImplementationCta(planId);
    const reason = `Auto-implementation skipped.\n\n${cta}`;

    expect(buildPlanImplementationMessage(reason, planId)).toBe(reason);
  });
});
