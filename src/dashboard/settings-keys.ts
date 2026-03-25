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

  // Discord Behavior
  { key: 'DISCORD_REQUIRE_CHANNEL_CONTEXT', category: 'Discord Behavior', label: 'Require channel context', type: 'boolean', default: true },
  { key: 'DISCORD_AUTO_INDEX_CHANNEL_CONTEXT', category: 'Discord Behavior', label: 'Auto-index channel context', type: 'boolean', default: true },
  { key: 'DISCORD_AUTO_JOIN_THREADS', category: 'Discord Behavior', label: 'Auto-join threads', type: 'boolean', default: true },

  // Canvas
  { key: 'DISCOCLAW_CANVAS_ENABLED', category: 'Canvas', label: 'Canvas', type: 'boolean', default: false },
  { key: 'DISCOCLAW_CANVAS_WRITE_BRIDGE_ENABLED', category: 'Canvas', label: 'Canvas write bridge', type: 'boolean', default: true },
  { key: 'DISCOCLAW_CANVAS_PORT', category: 'Canvas', label: 'Canvas port', type: 'number', default: 9402 },
  { key: 'DISCOCLAW_CANVAS_MAX_ARTIFACTS', category: 'Canvas', label: 'Canvas max artifacts', type: 'number', default: 1000 },
  { key: 'DISCOCLAW_CANVAS_PENDING_LAUNCH_TTL_SECONDS', category: 'Canvas', label: 'Canvas pending launch TTL (s)', type: 'number', default: 120 },
  { key: 'DISCOCLAW_CANVAS_EXPORT_MAX_BYTES', category: 'Canvas', label: 'Canvas export max bytes', type: 'number', default: 5242880 },

  // Voice
  { key: 'DISCOCLAW_VOICE_ENABLED', category: 'Voice', label: 'Voice', type: 'boolean', default: false },
  { key: 'DISCOCLAW_VOICE_AUTO_JOIN', category: 'Voice', label: 'Voice auto-join', type: 'boolean', default: false },

  // Discord Action Limits
  { key: 'DISCOCLAW_DISCORD_ACTIONS_DEFER_MAX_DELAY_SECONDS', category: 'Discord Action Limits', label: 'Defer max delay (s)', type: 'number', default: 1800 },
  { key: 'DISCOCLAW_DISCORD_ACTIONS_DEFER_MAX_CONCURRENT', category: 'Discord Action Limits', label: 'Defer max concurrent', type: 'number', default: 5 },
  { key: 'DISCOCLAW_DISCORD_ACTIONS_DEFER_MAX_DEPTH', category: 'Discord Action Limits', label: 'Defer max depth', type: 'number', default: 4 },
  { key: 'DISCOCLAW_DISCORD_ACTIONS_LOOP_MIN_INTERVAL_SECONDS', category: 'Discord Action Limits', label: 'Loop min interval (s)', type: 'number', default: 60 },
  { key: 'DISCOCLAW_DISCORD_ACTIONS_LOOP_MAX_INTERVAL_SECONDS', category: 'Discord Action Limits', label: 'Loop max interval (s)', type: 'number', default: 86400 },
  { key: 'DISCOCLAW_DISCORD_ACTIONS_LOOP_MAX_CONCURRENT', category: 'Discord Action Limits', label: 'Loop max concurrent', type: 'number', default: 5 },
  { key: 'DISCOCLAW_DISCORD_ACTIONS_SPAWN_MAX_CONCURRENT', category: 'Discord Action Limits', label: 'Spawn max concurrent', type: 'number', default: 4 },

  // Tasks Tuning
  { key: 'DISCOCLAW_TASKS_SIDEBAR', category: 'Tasks Tuning', label: 'Tasks sidebar', type: 'boolean', default: true },
  { key: 'DISCOCLAW_TASKS_AUTO_TAG', category: 'Tasks Tuning', label: 'Tasks auto-tag', type: 'boolean', default: true },
  { key: 'DISCOCLAW_TASKS_SYNC_SKIP_PHASE5', category: 'Tasks Tuning', label: 'Tasks sync skip phase 5', type: 'boolean', default: false },
  { key: 'DISCOCLAW_TASKS_SYNC_FAILURE_RETRY_ENABLED', category: 'Tasks Tuning', label: 'Tasks sync failure retry', type: 'boolean', default: true },
  { key: 'DISCOCLAW_TASKS_SYNC_FAILURE_RETRY_DELAY_MS', category: 'Tasks Tuning', label: 'Tasks sync failure retry delay (ms)', type: 'number', default: 30000 },
  { key: 'DISCOCLAW_TASKS_SYNC_DEFERRED_RETRY_DELAY_MS', category: 'Tasks Tuning', label: 'Tasks sync deferred retry delay (ms)', type: 'number', default: 30000 },

  // Cron Tuning
  { key: 'DISCOCLAW_CRON_AUTO_TAG', category: 'Cron Tuning', label: 'Cron auto-tag', type: 'boolean', default: true },

  // Webhook Tuning
  { key: 'DISCOCLAW_WEBHOOK_PORT', category: 'Webhook Tuning', label: 'Webhook port', type: 'number', default: 9400 },

  // Workflow Tuning
  { key: 'PLAN_PHASE_MAX_CONTEXT_FILES', category: 'Workflow Tuning', label: 'Plan phase max context files', type: 'number', default: 5 },
  { key: 'PLAN_PHASE_TIMEOUT_MS', category: 'Workflow Tuning', label: 'Plan phase timeout (ms)', type: 'number', default: 1800000 },
  { key: 'PLAN_PHASE_AUDIT_FIX_MAX', category: 'Workflow Tuning', label: 'Plan phase audit fix max', type: 'number', default: 3 },
  { key: 'PLAN_FORGE_HEARTBEAT_INTERVAL_MS', category: 'Workflow Tuning', label: 'Plan forge heartbeat (ms)', type: 'number', default: 45000 },
  { key: 'FORGE_MAX_AUDIT_ROUNDS', category: 'Workflow Tuning', label: 'Forge max audit rounds', type: 'number', default: 5 },
  { key: 'FORGE_TIMEOUT_MS', category: 'Workflow Tuning', label: 'Forge timeout (ms)', type: 'number', default: 1800000 },
  { key: 'FORGE_PROGRESS_THROTTLE_MS', category: 'Workflow Tuning', label: 'Forge progress throttle (ms)', type: 'number', default: 3000 },

  // Memory Tuning
  { key: 'DISCOCLAW_SUMMARY_MAX_CHARS', category: 'Memory Tuning', label: 'Summary max chars', type: 'number', default: 2000 },
  { key: 'DISCOCLAW_SUMMARY_EVERY_N_TURNS', category: 'Memory Tuning', label: 'Summary every N turns', type: 'number', default: 5 },
  { key: 'DISCOCLAW_SUMMARY_MAX_TOKENS', category: 'Memory Tuning', label: 'Summary max tokens', type: 'number', default: 1500 },
  { key: 'DISCOCLAW_DURABLE_INJECT_MAX_CHARS', category: 'Memory Tuning', label: 'Durable inject max chars', type: 'number', default: 2000 },
  { key: 'DISCOCLAW_DURABLE_MAX_ITEMS', category: 'Memory Tuning', label: 'Durable max items', type: 'number', default: 200 },
  { key: 'DISCOCLAW_DURABLE_SUPERSESSION_SHADOW', category: 'Memory Tuning', label: 'Durable supersession shadow', type: 'boolean', default: false },
  { key: 'DISCOCLAW_MEMORY_CONSOLIDATION_THRESHOLD', category: 'Memory Tuning', label: 'Memory consolidation threshold', type: 'number', default: 50 },
  { key: 'DISCOCLAW_SHORTTERM_MAX_ENTRIES', category: 'Memory Tuning', label: 'Short-term max entries', type: 'number', default: 20 },
  { key: 'DISCOCLAW_SHORTTERM_MAX_AGE_HOURS', category: 'Memory Tuning', label: 'Short-term max age (hours)', type: 'number', default: 6 },
  { key: 'DISCOCLAW_SHORTTERM_INJECT_MAX_CHARS', category: 'Memory Tuning', label: 'Short-term inject max chars', type: 'number', default: 1000 },
  { key: 'DISCOCLAW_COLD_STORAGE_INJECT_MAX_CHARS', category: 'Memory Tuning', label: 'Cold storage inject max chars', type: 'number', default: 1500 },
  { key: 'DISCOCLAW_COLD_STORAGE_SEARCH_LIMIT', category: 'Memory Tuning', label: 'Cold storage search limit', type: 'number', default: 10 },

  // Behavior Tuning
  { key: 'DISCOCLAW_STREAM_PREVIEW_RAW', category: 'Behavior Tuning', label: 'Stream preview raw', type: 'boolean', default: false },
  { key: 'DISCOCLAW_COMPLETION_NOTIFY_THRESHOLD_MS', category: 'Behavior Tuning', label: 'Completion notify threshold (ms)', type: 'number', default: 30000 },
  { key: 'DISCOCLAW_ACTION_FOLLOWUP_TIMEOUT_MS', category: 'Behavior Tuning', label: 'Action followup timeout (ms)', type: 'number', default: 30000 },
  { key: 'DISCOCLAW_MULTI_TURN_HANG_TIMEOUT_MS', category: 'Behavior Tuning', label: 'Multi-turn hang timeout (ms)', type: 'number', default: 60000 },
  { key: 'DISCOCLAW_MULTI_TURN_IDLE_TIMEOUT_MS', category: 'Behavior Tuning', label: 'Multi-turn idle timeout (ms)', type: 'number', default: 300000 },
  { key: 'DISCOCLAW_STREAM_STALL_TIMEOUT_MS', category: 'Behavior Tuning', label: 'Stream stall timeout (ms)', type: 'number', default: 1800000 },
  { key: 'DISCOCLAW_PROGRESS_STALL_TIMEOUT_MS', category: 'Behavior Tuning', label: 'Progress stall timeout (ms)', type: 'number', default: 1800000 },
  { key: 'DISCOCLAW_STREAM_STALL_WARNING_MS', category: 'Behavior Tuning', label: 'Stream stall warning (ms)', type: 'number', default: 300000 },

  // Supervisor
  { key: 'DISCOCLAW_GLOBAL_SUPERVISOR_MAX_CYCLES', category: 'Supervisor', label: 'Supervisor max cycles', type: 'number', default: 3 },
  { key: 'DISCOCLAW_GLOBAL_SUPERVISOR_MAX_RETRIES', category: 'Supervisor', label: 'Supervisor max retries', type: 'number', default: 2 },
  { key: 'DISCOCLAW_GLOBAL_SUPERVISOR_MAX_ESCALATION_LEVEL', category: 'Supervisor', label: 'Supervisor max escalation level', type: 'number', default: 2 },
  { key: 'DISCOCLAW_GLOBAL_SUPERVISOR_MAX_TOTAL_EVENTS', category: 'Supervisor', label: 'Supervisor max total events', type: 'number', default: 5000 },
  { key: 'DISCOCLAW_GLOBAL_SUPERVISOR_MAX_WALL_TIME_MS', category: 'Supervisor', label: 'Supervisor max wall time (ms)', type: 'number', default: 0 },

  // OpenAI Compat
  { key: 'OPENAI_COMPAT_TOOLS_ENABLED', category: 'OpenAI Compat', label: 'OpenAI-compat tools', type: 'boolean', default: false },
  { key: 'OPENAI_COMPAT_HYBRID_PIPELINE_ENABLED', category: 'OpenAI Compat', label: 'OpenAI-compat hybrid pipeline', type: 'boolean', default: false },
] as const;

export const ALLOWED_SETTING_KEYS: Set<string> = new Set(
  SETTING_DEFINITIONS.map((d) => d.key),
);
