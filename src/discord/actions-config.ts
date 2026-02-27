import type { DiscordActionResult } from './actions.js';
import type { RuntimeAdapter } from '../runtime/types.js';
import type { RuntimeRegistry } from '../runtime/registry.js';
import { resolveModel } from '../runtime/model-tiers.js';
import type { ImagegenContext } from './actions-imagegen.js';
import { resolveDefaultModel, resolveProvider } from './actions-imagegen.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModelRole = 'chat' | 'fast' | 'forge-drafter' | 'forge-auditor' | 'summary' | 'cron' | 'cron-exec' | 'voice';

export type ConfigActionRequest =
  | { type: 'modelSet'; role: ModelRole; model: string }
  | { type: 'modelReset'; role?: ModelRole }
  | { type: 'modelShow' };

const CONFIG_TYPE_MAP: Record<ConfigActionRequest['type'], true> = {
  modelSet: true,
  modelReset: true,
  modelShow: true,
};
export const CONFIG_ACTION_TYPES = new Set<string>(Object.keys(CONFIG_TYPE_MAP));

export type ConfigContext = {
  /** The live botParams object — mutating fields takes effect next invocation. */
  botParams: ConfigMutableParams;
  /** The primary runtime, for resolveModel display. */
  runtime: RuntimeAdapter;
  /** Registry of all available runtime adapters. When set, modelSet chat can swap runtimes. */
  runtimeRegistry?: RuntimeRegistry;
  /** Human-readable name of the active runtime (e.g. 'claude_code', 'openrouter'). */
  runtimeName?: string;
  /** Callback to persist a model override to the overrides file. Wired in index.ts. */
  persistOverride?: (role: ModelRole, model: string) => void;
  /** Callback to clear model overrides from the overrides file. Pass undefined role to clear all. Wired in index.ts. */
  clearOverride?: (role?: ModelRole) => void;
  /** Env-default model string for each role, used by modelReset to revert live state. */
  envDefaults?: Partial<Record<ModelRole, string>>;
  /** Tracks which roles have active overrides (loaded from the overrides file). */
  overrideSources?: Partial<Record<ModelRole, boolean>>;
};

/** The subset of BotParams fields that modelSet/modelShow reads and mutates. */
export type ConfigMutableParams = {
  runtimeModel: string;
  summaryModel: string;
  runtime?: RuntimeAdapter;
  forgeDrafterModel?: string;
  forgeAuditorModel?: string;
  cronCtx?: {
    autoTagModel: string;
    runtime?: RuntimeAdapter;
    syncCoordinator?: { setAutoTagModel(model: string): void; setRuntime?(runtime: RuntimeAdapter): void };
    executorCtx?: { model: string; cronExecModel?: string; runtime?: RuntimeAdapter };
  };
  taskCtx?: { autoTagModel: string };
  planCtx?: { model?: string; runtime?: RuntimeAdapter };
  deferOpts?: { runtime: RuntimeAdapter };
  imagegenCtx?: ImagegenContext;
  voiceModelCtx?: { model: string };
};

// ---------------------------------------------------------------------------
// Role → field mapping
// ---------------------------------------------------------------------------

const ROLE_DESCRIPTIONS: Record<ModelRole, string> = {
  chat: 'Discord messages, plan runs, deferred runs, forge fallback',
  fast: 'All small/fast tasks (summary, cron, cron auto-tag, tasks auto-tag)',
  'forge-drafter': 'Forge plan drafting/revision',
  'forge-auditor': 'Forge plan auditing',
  summary: 'Rolling summaries only',
  cron: 'Cron auto-tagging and model classification',
  'cron-exec': 'Default model for cron job execution (overridden by per-job settings)',
  voice: 'Voice channel AI responses',
};

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export function executeConfigAction(
  action: ConfigActionRequest,
  configCtx: ConfigContext,
): DiscordActionResult {
  switch (action.type) {
    case 'modelSet': {
      if (!action.role || !action.model) {
        return { ok: false, error: 'modelSet requires role and model' };
      }

      const model = action.model.trim();
      if (!model || /\s/.test(model)) {
        return { ok: false, error: `Invalid model string: "${action.model}"` };
      }

      // Validate the model string resolves (non-empty result from resolveModel).
      const resolved = resolveModel(model, configCtx.runtime.id);
      if (resolved === '' && model !== '') {
        // Tier name that doesn't map for this runtime — warn but allow.
      }

      const bp = configCtx.botParams;
      const changes: string[] = [];

      switch (action.role) {
        case 'chat': {
          // Check if the model string is actually a runtime name.
          const normalized = model.toLowerCase();
          const newRuntime = configCtx.runtimeRegistry?.get(normalized);
          if (newRuntime) {
            // Swap runtime across all invocation paths.
            const runtimeModel = newRuntime.defaultModel ?? '';
            bp.runtime = newRuntime;
            bp.runtimeModel = runtimeModel;
            configCtx.runtime = newRuntime;
            configCtx.runtimeName = normalized;
            if (bp.cronCtx) {
              bp.cronCtx.runtime = newRuntime;
              bp.cronCtx.syncCoordinator?.setRuntime?.(newRuntime);
              if (bp.cronCtx.executorCtx) {
                bp.cronCtx.executorCtx.runtime = newRuntime;
                bp.cronCtx.executorCtx.model = runtimeModel;
              }
            }
            if (bp.planCtx) {
              bp.planCtx.runtime = newRuntime;
              bp.planCtx.model = runtimeModel;
            }
            if (bp.deferOpts) bp.deferOpts.runtime = newRuntime;
            changes.push(`runtime → ${normalized}`);
            if (runtimeModel) changes.push(`chat → ${runtimeModel} (adapter default)`);
          } else {
            bp.runtimeModel = model;
            if (bp.planCtx) bp.planCtx.model = model;
            if (bp.cronCtx?.executorCtx) bp.cronCtx.executorCtx.model = model;
            changes.push(`chat → ${model}`);
          }
          break;
        }
        case 'fast':
          bp.summaryModel = model;
          changes.push(`summary → ${model}`);
          if (bp.cronCtx) {
            bp.cronCtx.autoTagModel = model;
            bp.cronCtx.syncCoordinator?.setAutoTagModel(model);
            changes.push(`cron-auto-tag → ${model}`);
          }
          if (bp.taskCtx) {
            bp.taskCtx.autoTagModel = model;
            changes.push(`tasks-auto-tag → ${model}`);
          }
          break;
        case 'forge-drafter':
          bp.forgeDrafterModel = model;
          changes.push(`forge-drafter → ${model}`);
          break;
        case 'forge-auditor':
          bp.forgeAuditorModel = model;
          changes.push(`forge-auditor → ${model}`);
          break;
        case 'summary':
          bp.summaryModel = model;
          changes.push(`summary → ${model}`);
          break;
        case 'cron':
          if (bp.cronCtx) {
            bp.cronCtx.autoTagModel = model;
            bp.cronCtx.syncCoordinator?.setAutoTagModel(model);
            changes.push(`cron → ${model}`);
          } else {
            return { ok: false, error: 'Cron subsystem not configured' };
          }
          break;
        case 'cron-exec':
          if (bp.cronCtx?.executorCtx) {
            if (model === 'default') {
              bp.cronCtx.executorCtx.cronExecModel = undefined;
              changes.push(`cron-exec → (follows chat)`);
            } else {
              bp.cronCtx.executorCtx.cronExecModel = model;
              changes.push(`cron-exec → ${model}`);
            }
          } else {
            return { ok: false, error: 'Cron subsystem not configured' };
          }
          break;
        case 'voice':
          if (bp.voiceModelCtx) {
            bp.voiceModelCtx.model = model;
            changes.push(`voice → ${model}`);
          } else {
            return { ok: false, error: 'Voice subsystem not configured' };
          }
          break;
        default:
          return { ok: false, error: `Unknown role: ${String((action as { role: unknown }).role)}` };
      }

      configCtx.persistOverride?.(action.role, model);
      if (configCtx.overrideSources) {
        configCtx.overrideSources[action.role] = true;
      }

      const resolvedDisplay = resolveModel(model, configCtx.runtime.id);
      const resolvedNote = resolvedDisplay && resolvedDisplay !== model ? ` (resolves to ${resolvedDisplay})` : '';
      return { ok: true, summary: `Model updated: ${changes.join(', ')}${resolvedNote}` };
    }

    case 'modelReset': {
      const bp = configCtx.botParams;
      const defaults = configCtx.envDefaults ?? {};
      const rolesToReset: ModelRole[] = action.role
        ? [action.role]
        : (Object.keys(ROLE_DESCRIPTIONS) as ModelRole[]);

      const resetChanges: string[] = [];

      for (const role of rolesToReset) {
        const defaultModel = defaults[role];

        if (defaultModel !== undefined) {
          // Apply the env-default model to live botParams.
          switch (role) {
            case 'chat':
              bp.runtimeModel = defaultModel;
              if (bp.planCtx) bp.planCtx.model = defaultModel;
              if (bp.cronCtx?.executorCtx) bp.cronCtx.executorCtx.model = defaultModel;
              resetChanges.push(`chat → ${defaultModel}`);
              break;
            case 'fast':
              bp.summaryModel = defaultModel;
              if (bp.cronCtx) {
                bp.cronCtx.autoTagModel = defaultModel;
                bp.cronCtx.syncCoordinator?.setAutoTagModel(defaultModel);
              }
              if (bp.taskCtx) bp.taskCtx.autoTagModel = defaultModel;
              resetChanges.push(`fast → ${defaultModel}`);
              break;
            case 'forge-drafter':
              bp.forgeDrafterModel = defaultModel || undefined;
              resetChanges.push(`forge-drafter → ${defaultModel || '(follows chat)'}`);
              break;
            case 'forge-auditor':
              bp.forgeAuditorModel = defaultModel || undefined;
              resetChanges.push(`forge-auditor → ${defaultModel || '(follows chat)'}`);
              break;
            case 'summary':
              bp.summaryModel = defaultModel;
              resetChanges.push(`summary → ${defaultModel}`);
              break;
            case 'cron':
              if (bp.cronCtx) {
                bp.cronCtx.autoTagModel = defaultModel;
                bp.cronCtx.syncCoordinator?.setAutoTagModel(defaultModel);
                resetChanges.push(`cron → ${defaultModel}`);
              }
              break;
            case 'cron-exec':
              if (bp.cronCtx?.executorCtx) {
                bp.cronCtx.executorCtx.cronExecModel = defaultModel || undefined;
                resetChanges.push(`cron-exec → ${defaultModel || '(follows chat)'}`);
              }
              break;
            case 'voice':
              if (bp.voiceModelCtx) {
                bp.voiceModelCtx.model = defaultModel;
                resetChanges.push(`voice → ${defaultModel}`);
              }
              break;
          }
        }

        // Clear the override marker regardless of whether we had a default.
        if (configCtx.overrideSources) {
          delete configCtx.overrideSources[role];
        }
      }

      configCtx.clearOverride?.(action.role);

      return {
        ok: true,
        summary: resetChanges.length > 0
          ? `Reset to env defaults: ${resetChanges.join(', ')}`
          : 'Nothing to reset — no env defaults configured for the specified roles',
      };
    }

    case 'modelShow': {
      const bp = configCtx.botParams;
      const rid = configCtx.runtime.id;
      const overrides = configCtx.overrideSources ?? {};

      // Returns '*(override)*' suffix when the role has an active file override.
      const ovr = (role: ModelRole) => (overrides[role] ? ' *(override)*' : '');

      const runtimeName = configCtx.runtimeName ?? rid;
      const rows: [string, string, string, string][] = [
        ['runtime', runtimeName, `Active runtime adapter (${rid})`, ovr('chat')],
        ['chat', bp.runtimeModel, ROLE_DESCRIPTIONS.chat, ovr('chat')],
        ['summary', bp.summaryModel, ROLE_DESCRIPTIONS.summary, ovr('summary') || ovr('fast')],
        ['forge-drafter', bp.forgeDrafterModel ?? `${bp.runtimeModel} (follows chat)`, ROLE_DESCRIPTIONS['forge-drafter'], ovr('forge-drafter')],
        ['forge-auditor', bp.forgeAuditorModel ?? `${bp.runtimeModel} (follows chat)`, ROLE_DESCRIPTIONS['forge-auditor'], ovr('forge-auditor')],
      ];

      if (bp.cronCtx) {
        const cronExecModel = bp.cronCtx.executorCtx?.cronExecModel;
        rows.push(['cron-exec', cronExecModel || `${bp.runtimeModel} (follows chat)`, ROLE_DESCRIPTIONS['cron-exec'], ovr('cron-exec')]);
        rows.push(['cron-auto-tag', bp.cronCtx.autoTagModel, ROLE_DESCRIPTIONS.cron, ovr('cron') || ovr('fast')]);
      }
      const taskAutoTagModel = bp.taskCtx?.autoTagModel;
      if (taskAutoTagModel) {
        rows.push(['tasks-auto-tag', taskAutoTagModel, 'Tasks auto-tagging', ovr('fast')]);
      }

      if (bp.imagegenCtx) {
        const igModel = resolveDefaultModel(bp.imagegenCtx);
        const igProvider = resolveProvider(igModel);
        rows.push(['imagegen', igModel, `Image generation (${igProvider})`, '']);
      }

      if (bp.voiceModelCtx) {
        rows.push(['voice', bp.voiceModelCtx.model || `${bp.runtimeModel} (follows chat)`, ROLE_DESCRIPTIONS.voice, ovr('voice')]);
      }

      const adapterDefault = configCtx.runtime.defaultModel;
      const lines = rows.map(([role, model, desc, overrideMarker]) => {
        const resolved = resolveModel(model, rid);
        let display: string;
        if (model) {
          display = resolved && resolved !== model ? `${model} → ${resolved}` : model;
        } else {
          display = adapterDefault || '(adapter default)';
        }
        return `**${role}**: \`${display}\`${overrideMarker} — ${desc}`;
      });

      return { ok: true, summary: lines.join('\n') };
    }
  }
}

// ---------------------------------------------------------------------------
// Prompt section
// ---------------------------------------------------------------------------

export function configActionsPromptSection(): string {
  return `### Model Configuration

**modelShow** — Show current model assignments for all roles:
\`\`\`
<discord-action>{"type":"modelShow"}</discord-action>
\`\`\`

**modelSet** — Change the model for a role at runtime:
\`\`\`
<discord-action>{"type":"modelSet","role":"chat","model":"sonnet"}</discord-action>
<discord-action>{"type":"modelSet","role":"fast","model":"haiku"}</discord-action>
\`\`\`
- \`role\` (required): One of \`chat\`, \`fast\`, \`forge-drafter\`, \`forge-auditor\`, \`summary\`, \`cron\`, \`cron-exec\`, \`voice\`.
- \`model\` (required): Model tier (\`fast\`, \`capable\`), concrete model name (\`haiku\`, \`sonnet\`, \`opus\`), runtime name (\`openrouter\`, \`gemini\` — for \`chat\` role, swaps the active runtime adapter), or \`default\` (for cron-exec only, to revert to following chat).

**Roles:**
| Role | What it controls |
|------|-----------------|
| \`chat\` | Discord messages, plan runs, deferred runs, forge fallback |
| \`fast\` | All small/fast tasks (summary, cron auto-tag, tasks auto-tag) |
| \`forge-drafter\` | Forge plan drafting/revision |
| \`forge-auditor\` | Forge plan auditing |
| \`summary\` | Rolling summaries only (overrides fast) |
| \`cron\` | Cron auto-tagging and model classification (overrides fast) |
| \`cron-exec\` | Default model for cron job execution; per-job overrides (via \`cronUpdate\`) take priority |
| \`voice\` | Voice channel AI responses |

Changes are **persisted** to \`runtime-overrides.json\` and survive restart. Use \`!models reset\` to clear overrides and revert to env-var defaults.

**modelReset** — Revert model(s) to env-var defaults and clear the override file entry:
\`\`\`
<discord-action>{\"type\":\"modelReset\"}</discord-action>
<discord-action>{\"type\":\"modelReset\",\"role\":\"chat\"}</discord-action>
\`\`\`
- Omit \`role\` to reset all roles.

**Cron model priority:** per-job override (cronUpdate) > AI-classified model > cron-exec default > chat fallback.
Set \`cron-exec\` to \`default\` to clear the override and fall back to the chat model.`;
}
