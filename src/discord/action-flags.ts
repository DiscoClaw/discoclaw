import type { ActionCategoryFlags } from './actions.js';

/**
 * Strip action categories that require a trusted requester context.
 *
 * Used by cron executor and other automated paths where the requester
 * may not be an allowlisted user. Config is included because config
 * mutations (modelSet, modelReset) must only run for allowlisted users.
 */
export function withoutRequesterGatedActionFlags(flags: ActionCategoryFlags): ActionCategoryFlags {
  return {
    ...flags,
    channels: false,
    messaging: false,
    guild: false,
    moderation: false,
    polls: false,
    config: false,
  };
}
