export type PlanForgeAvailabilityInput = {
  planCommandsEnabled: boolean;
  forgeCommandsEnabled: boolean;
  planActionsEnabled: boolean;
  forgeActionsEnabled: boolean;
};

export function buildPlanForgeAvailabilityNote(input: PlanForgeAvailabilityInput): string {
  const notes: string[] = [];

  if (!input.planCommandsEnabled && !input.planActionsEnabled) {
    notes.push(
      'Plan workflows are disabled for this instance. When a user asks for a plan, respond in normal chat with an outline or next steps instead of invoking or suggesting the plan workflow. If the user explicitly says `!plan` or asks how to enable planning, mention they can enable it by setting `DISCOCLAW_PLAN_COMMANDS_ENABLED=1` in `.env` and restarting.',
    );
  } else if (input.planCommandsEnabled && !input.planActionsEnabled) {
    notes.push(
      'Automatic plan routing is disabled for this instance. Do not initiate plan actions from normal chat; only use the plan workflow when the user explicitly issues `!plan`.',
    );
  } else if (!input.planCommandsEnabled && input.planActionsEnabled) {
    notes.push(
      'The `!plan` command is disabled for this instance. Do not suggest `!plan`; only rely on plan actions when the live action inventory for this turn explicitly exposes them.',
    );
  }

  if (!input.forgeCommandsEnabled && !input.forgeActionsEnabled) {
    notes.push(
      'Forge workflows are disabled for this instance. Do not invoke or suggest the forge workflow. If the user explicitly says `!forge` or asks how to enable forging, mention they can enable it by setting `DISCOCLAW_FORGE_COMMANDS_ENABLED=1` in `.env` and restarting.',
    );
  } else if (input.forgeCommandsEnabled && !input.forgeActionsEnabled) {
    notes.push(
      'Automatic forge routing is disabled for this instance. Do not initiate forge actions from normal chat; only use the forge workflow when the user explicitly issues `!forge`.',
    );
  } else if (!input.forgeCommandsEnabled && input.forgeActionsEnabled) {
    notes.push(
      'The `!forge` command is disabled for this instance. Do not suggest `!forge`; only rely on forge actions when the live action inventory for this turn explicitly exposes them.',
    );
  }

  return notes.join(' ');
}
