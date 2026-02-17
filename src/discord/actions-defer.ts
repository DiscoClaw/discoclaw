import type { ActionContext, DiscordActionResult } from './actions.js';

export type DeferActionRequest = {
  type: 'defer';
  channel: string;
  prompt?: string;
  delaySeconds?: number;
};

export const DEFER_ACTION_TYPES = new Set<string>(['defer']);

export async function executeDeferAction(
  _action: DeferActionRequest,
  _ctx: ActionContext,
): Promise<DiscordActionResult> {
  return { ok: false, error: 'Deferred actions are not yet implemented.' };
}
