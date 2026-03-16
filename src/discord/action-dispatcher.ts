import { isConfigAuthorized } from './allowlist.js';
import { CONFIG_UNAUTHORIZED_ERROR } from './replies.js';
import { CONFIG_MUTATING_ACTION_TYPES } from './actions-config.js';
import type { DiscordActionResult } from './actions.js';

/**
 * Fail-fast authorization check for config-mutating actions.
 *
 * Returns an error result when the requester is not authorized;
 * returns null when the action is allowed (either non-config or authorized).
 * Missing requester identity denies by default.
 *
 * The protected action set is defined in actions-config.ts
 * (CONFIG_MUTATING_ACTION_TYPES) so coverage is co-located with action definitions.
 */
export function checkConfigAuthorization(
  actionType: string,
  requesterId: string | undefined,
  allowUserIds: Set<string> | undefined,
): DiscordActionResult | null {
  if (!CONFIG_MUTATING_ACTION_TYPES.has(actionType)) return null;
  if (isConfigAuthorized(allowUserIds, requesterId)) return null;
  return { ok: false, error: CONFIG_UNAUTHORIZED_ERROR };
}
