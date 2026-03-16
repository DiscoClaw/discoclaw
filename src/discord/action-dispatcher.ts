import { isConfigAuthorized } from './allowlist.js';
import { CONFIG_UNAUTHORIZED_ERROR } from './replies.js';
import type { DiscordActionResult } from './actions.js';

/** Config action types that mutate state and require authorization. */
const CONFIG_MUTATING_TYPES: ReadonlySet<string> = new Set([
  'modelSet',
  'modelReset',
]);

/**
 * Fail-fast authorization check for config-mutating actions.
 *
 * Returns an error result when the requester is not authorized;
 * returns null when the action is allowed (either non-config or authorized).
 * Missing requester identity denies by default.
 */
export function checkConfigAuthorization(
  actionType: string,
  requesterId: string | undefined,
  allowUserIds: Set<string> | undefined,
): DiscordActionResult | null {
  if (!CONFIG_MUTATING_TYPES.has(actionType)) return null;
  if (isConfigAuthorized(allowUserIds, requesterId)) return null;
  return { ok: false, error: CONFIG_UNAUTHORIZED_ERROR };
}
