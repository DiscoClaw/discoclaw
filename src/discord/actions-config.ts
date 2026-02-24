import type { DiscordActionResult } from './actions.js';
import type { RuntimeAdapter } from '../runtime/types.js';
import { resolveModel } from '../runtime/model-tiers.js';
import type { ImagegenContext } from './actions-imagegen.js';
import { resolveDefaultModel, resolveProvider } from './actions-imagegen.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModelRole = 'chat' | 'fast' | 'forge-drafter' | 'forge-auditor' | 'summary' | 'cron' | 'cron-exec';

export type ConfigActionRequest =
  | { type: 'modelSet'; role: ModelRole; model: string }
  | { type: 'modelShow' };

const CONFIG_TYPE_MAP: Record<ConfigActionRequest['type'], true> = {
  modelSet: true,
  modelShow: true,
};
export const CONFIG_ACTION_TYPES = new Set<string>(Object.keys(CONFIG_TYPE_MAP));

export type ConfigContext = {
  /** The live botParams object — mutating fields takes effect next invocation. */
  botParams: ConfigMutableParams;
  /** The primary runtime, for resolveModel display. */
  runtime: RuntimeAdapter;
};

/** The subset of BotParams fields that modelSet/modelShow reads and mutates. */
export type ConfigMutableParams = {
  runtimeModel: string;
  summaryModel: string;
  forgeDrafterModel?: string;
  forgeAuditorModel?: string;
  cronCtx?: {
    autoTagModel: string;
    syncCoordinator?: { setAutoTagModel(model: string): void };
    executorCtx?: { model: string; cronExecModel?: string };
  };
  taskCtx?: { autoTagModel: string };
  planCtx?: { model?: string };
  imagegenCtx?: ImagegenContext;
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
        case 'chat':
          bp.runtimeModel = model;
          if (bp.planCtx) bp.planCtx.model = model;
          if (bp.cronCtx?.executorCtx) bp.cronCtx.executorCtx.model = model;
          changes.push(`chat → ${model}`);
          break;
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
        default:
          return { ok: false, error: `Unknown role: ${String(action.role)}` };
      }

      const resolvedDisplay = resolveModel(model, configCtx.runtime.id);
      const resolvedNote = resolvedDisplay && resolvedDisplay !== model ? ` (resolves to ${resolvedDisplay})` : '';
      return { ok: true, summary: `Model updated: ${changes.join(', ')}${resolvedNote}` };
    }

    case 'modelShow': {
      const bp = configCtx.botParams;
      const rid = configCtx.runtime.id;

      const rows: [string, string, string][] = [
        ['chat', bp.runtimeModel, ROLE_DESCRIPTIONS.chat],
        ['summary', bp.summaryModel, ROLE_DESCRIPTIONS.summary],
        ['forge-drafter', bp.forgeDrafterModel ?? bp.runtimeModel, ROLE_DESCRIPTIONS['forge-drafter']],
        ['forge-auditor', bp.forgeAuditorModel ?? bp.runtimeModel, ROLE_DESCRIPTIONS['forge-auditor']],
      ];

      if (bp.cronCtx) {
        const cronExecModel = bp.cronCtx.executorCtx?.cronExecModel;
        rows.push(['cron-exec', cronExecModel || `${bp.runtimeModel} (follows chat)`, ROLE_DESCRIPTIONS['cron-exec']]);
        rows.push(['cron-auto-tag', bp.cronCtx.autoTagModel, ROLE_DESCRIPTIONS.cron]);
      }
      const taskAutoTagModel = bp.taskCtx?.autoTagModel;
      if (taskAutoTagModel) {
        rows.push(['tasks-auto-tag', taskAutoTagModel, 'Tasks auto-tagging']);
      }

      if (bp.imagegenCtx) {
        const igModel = resolveDefaultModel(bp.imagegenCtx);
        const igProvider = resolveProvider(igModel);
        rows.push(['imagegen', igModel, `Image generation (${igProvider})`]);
      }

      const adapterDefault = configCtx.runtime.defaultModel;
      const lines = rows.map(([role, model, desc]) => {
        const resolved = resolveModel(model, rid);
        let display: string;
        if (model) {
          display = resolved && resolved !== model ? `${model} → ${resolved}` : model;
        } else {
          display = adapterDefault || '(adapter default)';
        }
        return `**${role}**: \`${display}\` — ${desc}`;
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
- \`role\` (required): One of \`chat\`, \`fast\`, \`forge-drafter\`, \`forge-auditor\`, \`summary\`, \`cron\`, \`cron-exec\`.
- \`model\` (required): Model tier (\`fast\`, \`capable\`), concrete model name (\`haiku\`, \`sonnet\`, \`opus\`), or \`default\` (for cron-exec only, to revert to following chat).

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

Changes are **ephemeral** — they take effect immediately but revert on restart. Use env vars for persistent configuration.

**Cron model priority:** per-job override (cronUpdate) > AI-classified model > cron-exec default > chat fallback.
Set \`cron-exec\` to \`default\` to clear the override and fall back to the chat model.`;
}
