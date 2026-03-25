import { describe, expect, it } from 'vitest';
import { buildPlanForgeAvailabilityNote } from './plan-forge-availability.js';

describe('buildPlanForgeAvailabilityNote', () => {
  it('returns a full-disabled note when plan and forge are fully disabled', () => {
    const note = buildPlanForgeAvailabilityNote({
      planCommandsEnabled: false,
      forgeCommandsEnabled: false,
      planActionsEnabled: false,
      forgeActionsEnabled: false,
    });

    expect(note).toContain('Plan workflows are disabled for this instance.');
    expect(note).toContain('DISCOCLAW_PLAN_COMMANDS_ENABLED=1');
    expect(note).toContain('Forge workflows are disabled for this instance.');
    expect(note).toContain('DISCOCLAW_FORGE_COMMANDS_ENABLED=1');
  });

  it('distinguishes commands-only plan availability from fully disabled plan flow', () => {
    const note = buildPlanForgeAvailabilityNote({
      planCommandsEnabled: true,
      forgeCommandsEnabled: true,
      planActionsEnabled: false,
      forgeActionsEnabled: true,
    });

    expect(note).toContain('Automatic plan routing is disabled for this instance.');
    expect(note).toContain('only use the plan workflow when the user explicitly issues `!plan`');
    expect(note).not.toContain('Plan workflows are disabled for this instance.');
  });

  it('returns empty string when plan and forge are fully available', () => {
    const note = buildPlanForgeAvailabilityNote({
      planCommandsEnabled: true,
      forgeCommandsEnabled: true,
      planActionsEnabled: true,
      forgeActionsEnabled: true,
    });

    expect(note).toBe('');
  });
});
