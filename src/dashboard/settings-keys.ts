export type SettingType = 'boolean' | 'number';

export type SettingDefinition = {
  key: string;
  category: string;
  label: string;
  type: SettingType;
  default: boolean | number;
};

export const SETTING_DEFINITIONS: readonly SettingDefinition[] = [
  // Core Features
  { key: 'DISCOCLAW_CRON_ENABLED', category: 'Core Features', label: 'Cron scheduler', type: 'boolean', default: true },
  { key: 'DISCOCLAW_TASKS_ENABLED', category: 'Core Features', label: 'Task system', type: 'boolean', default: true },
  { key: 'DISCOCLAW_WEBHOOK_ENABLED', category: 'Core Features', label: 'Webhook server', type: 'boolean', default: false },
  { key: 'DISCOCLAW_MEMORY_COMMANDS_ENABLED', category: 'Core Features', label: 'Memory commands', type: 'boolean', default: true },
  { key: 'DISCOCLAW_HEALTH_COMMANDS_ENABLED', category: 'Core Features', label: 'Health commands', type: 'boolean', default: true },
  { key: 'DISCOCLAW_REACTION_HANDLER', category: 'Core Features', label: 'Reaction handler', type: 'boolean', default: true },
  { key: 'DISCOCLAW_REACTION_REMOVE_HANDLER', category: 'Core Features', label: 'Reaction remove handler', type: 'boolean', default: false },
  { key: 'DISCOCLAW_COMPLETION_NOTIFY', category: 'Core Features', label: 'Completion notifications', type: 'boolean', default: true },

  // Discord Actions
  { key: 'DISCOCLAW_DISCORD_ACTIONS', category: 'Discord Actions', label: 'Actions (master)', type: 'boolean', default: true },
  { key: 'DISCOCLAW_DISCORD_ACTIONS_CHANNELS', category: 'Discord Actions', label: 'Channels', type: 'boolean', default: true },
  { key: 'DISCOCLAW_DISCORD_ACTIONS_MESSAGING', category: 'Discord Actions', label: 'Messaging', type: 'boolean', default: true },
  { key: 'DISCOCLAW_DISCORD_ACTIONS_GUILD', category: 'Discord Actions', label: 'Guild', type: 'boolean', default: true },
  { key: 'DISCOCLAW_DISCORD_ACTIONS_MODERATION', category: 'Discord Actions', label: 'Moderation', type: 'boolean', default: false },
  { key: 'DISCOCLAW_DISCORD_ACTIONS_POLLS', category: 'Discord Actions', label: 'Polls', type: 'boolean', default: true },
  { key: 'DISCOCLAW_DISCORD_ACTIONS_TASKS', category: 'Discord Actions', label: 'Tasks', type: 'boolean', default: true },
  { key: 'DISCOCLAW_DISCORD_ACTIONS_CRONS', category: 'Discord Actions', label: 'Crons', type: 'boolean', default: true },
  { key: 'DISCOCLAW_DISCORD_ACTIONS_BOT_PROFILE', category: 'Discord Actions', label: 'Bot profile', type: 'boolean', default: true },
  { key: 'DISCOCLAW_DISCORD_ACTIONS_FORGE', category: 'Discord Actions', label: 'Forge', type: 'boolean', default: false },
  { key: 'DISCOCLAW_DISCORD_ACTIONS_PLAN', category: 'Discord Actions', label: 'Plan', type: 'boolean', default: false },
  { key: 'DISCOCLAW_DISCORD_ACTIONS_MEMORY', category: 'Discord Actions', label: 'Memory', type: 'boolean', default: true },
  { key: 'DISCOCLAW_DISCORD_ACTIONS_DEFER', category: 'Discord Actions', label: 'Defer', type: 'boolean', default: true },
  { key: 'DISCOCLAW_DISCORD_ACTIONS_LOOP', category: 'Discord Actions', label: 'Loop', type: 'boolean', default: true },
  { key: 'DISCOCLAW_DISCORD_ACTIONS_IMAGEGEN', category: 'Discord Actions', label: 'Image generation', type: 'boolean', default: false },
  { key: 'DISCOCLAW_DISCORD_ACTIONS_VOICE', category: 'Discord Actions', label: 'Voice', type: 'boolean', default: false },
  { key: 'DISCOCLAW_DISCORD_ACTIONS_SPAWN', category: 'Discord Actions', label: 'Spawn', type: 'boolean', default: true },
  { key: 'DISCOCLAW_DISCORD_ACTIONS_ARCHIVE', category: 'Discord Actions', label: 'Archive', type: 'boolean', default: false },

  // Workflow
  { key: 'DISCOCLAW_PLAN_COMMANDS_ENABLED', category: 'Workflow', label: 'Plan commands', type: 'boolean', default: false },
  { key: 'DISCOCLAW_FORGE_COMMANDS_ENABLED', category: 'Workflow', label: 'Forge commands', type: 'boolean', default: false },
  { key: 'PLAN_PHASES_ENABLED', category: 'Workflow', label: 'Plan phases', type: 'boolean', default: false },
  { key: 'FORGE_AUTO_IMPLEMENT', category: 'Workflow', label: 'Forge auto-implement', type: 'boolean', default: false },

  // Memory
  { key: 'DISCOCLAW_SUMMARY_ENABLED', category: 'Memory', label: 'Summaries', type: 'boolean', default: true },
  { key: 'DISCOCLAW_DURABLE_MEMORY_ENABLED', category: 'Memory', label: 'Durable memory', type: 'boolean', default: true },
  { key: 'DISCOCLAW_SHORTTERM_MEMORY_ENABLED', category: 'Memory', label: 'Short-term memory', type: 'boolean', default: true },
  { key: 'DISCOCLAW_SUMMARY_TO_DURABLE_ENABLED', category: 'Memory', label: 'Summary-to-durable', type: 'boolean', default: true },
  { key: 'DISCOCLAW_COLD_STORAGE_ENABLED', category: 'Memory', label: 'Cold storage', type: 'boolean', default: false },
  { key: 'DISCOCLAW_BOT_MESSAGE_MEMORY_WRITE', category: 'Memory', label: 'Bot message memory write', type: 'boolean', default: false },

  // Behavior
  { key: 'DISCOCLAW_MULTI_TURN', category: 'Behavior', label: 'Multi-turn', type: 'boolean', default: true },
  { key: 'DISCOCLAW_TOOL_AWARE_STREAMING', category: 'Behavior', label: 'Tool-aware streaming', type: 'boolean', default: true },
  { key: 'DISCOCLAW_SESSION_SCANNING', category: 'Behavior', label: 'Session scanning', type: 'boolean', default: true },
  { key: 'DISCOCLAW_RUNTIME_SESSIONS', category: 'Behavior', label: 'Runtime sessions', type: 'boolean', default: true },
  { key: 'DISCOCLAW_GLOBAL_SUPERVISOR_ENABLED', category: 'Behavior', label: 'Global supervisor', type: 'boolean', default: false },

  // Numeric
  { key: 'DISCOCLAW_MESSAGE_HISTORY_BUDGET', category: 'Numeric', label: 'Message history budget', type: 'number', default: 3000 },
  { key: 'DISCOCLAW_MULTI_TURN_MAX_PROCESSES', category: 'Numeric', label: 'Multi-turn max processes', type: 'number', default: 5 },
  { key: 'DISCOCLAW_MAX_CONCURRENT_INVOCATIONS', category: 'Numeric', label: 'Max concurrent invocations', type: 'number', default: 0 },
  { key: 'DISCOCLAW_ACTION_FOLLOWUP_DEPTH', category: 'Numeric', label: 'Action followup depth', type: 'number', default: 2 },
  { key: 'DISCOCLAW_REACTION_MAX_AGE_HOURS', category: 'Numeric', label: 'Reaction max age (hours)', type: 'number', default: 24 },
] as const;

export const ALLOWED_SETTING_KEYS: Set<string> = new Set(
  SETTING_DEFINITIONS.map((d) => d.key),
);
