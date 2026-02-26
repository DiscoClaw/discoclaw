import type { ActionCategoryFlags } from '../discord/actions.js';

/**
 * Build action category flags for voice invocations.
 * Starts from a voice-specific allowlist (tasks, messaging, memory) and
 * AND-s each flag with the corresponding env config variable. Categories
 * not in the voice allowlist are hard-set to false.
 */
export function buildVoiceActionFlags(opts: {
  discordActionsMessaging: boolean;
  discordActionsTasks: boolean;
  tasksEnabled: boolean;
  taskCtxAvailable: boolean;
  discordActionsMemory: boolean;
  durableMemoryEnabled: boolean;
}): ActionCategoryFlags {
  return {
    // Voice-allowed categories — AND with env config.
    messaging: opts.discordActionsMessaging,
    tasks: opts.discordActionsTasks && opts.tasksEnabled && opts.taskCtxAvailable,
    memory: opts.discordActionsMemory && opts.durableMemoryEnabled,

    // Categories not in the voice allowlist — always disabled.
    channels: false,
    guild: false,
    moderation: false,
    polls: false,
    crons: false,
    botProfile: false,
    forge: false,
    plan: false,
    config: false,
    defer: false,
    imagegen: false,
    voice: false,
  };
}
