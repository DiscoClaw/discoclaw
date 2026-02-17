import type { DiscordActionResult } from './actions.js';
import type { RuntimeAdapter } from '../runtime/types.js';
import { resolveModel } from '../runtime/model-tiers.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModelRole = 'chat' | 'fast' | 'forge-drafter' | 'forge-auditor' | 'summary' | 'cron';

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
  cronCtx?: { autoTagModel: string };
  beadCtx?: { autoTagModel: string };
};

// ---------------------------------------------------------------------------
// Role → field mapping
// ---------------------------------------------------------------------------

const ROLE_DESCRIPTIONS: Record<ModelRole, string> = {
  chat: 'Discord messages, plan runs, deferred runs, forge fallback',
  fast: 'All small/fast tasks (summary, cron, cron auto-tag, beads auto-tag)',
  'forge-drafter': 'Forge plan drafting/revision',
  'forge-auditor': 'Forge plan auditing',
  summary: 'Rolling summaries only',
  cron: 'Cron auto-tagging and model classification',
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
          changes.push(`chat → ${model}`);
          break;
        case 'fast':
          bp.summaryModel = model;
          changes.push(`summary → ${model}`);
          if (bp.cronCtx) {
            bp.cronCtx.autoTagModel = model;
            changes.push(`cron-auto-tag → ${model}`);
          }
          if (bp.beadCtx) {
            bp.beadCtx.autoTagModel = model;
            changes.push(`beads-auto-tag → ${model}`);
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
            changes.push(`cron → ${model}`);
          } else {
            return { ok: false, error: 'Cron subsystem not configured' };
          }
          break;
        default:
          return { ok: false, error: `Unknown role: ${(action as any).role}` };
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
        rows.push(['cron-auto-tag', bp.cronCtx.autoTagModel, ROLE_DESCRIPTIONS.cron]);
      }
      if (bp.beadCtx) {
        rows.push(['beads-auto-tag', bp.beadCtx.autoTagModel, 'Beads auto-tagging']);
      }

      const lines = rows.map(([role, model, desc]) => {
        const resolved = resolveModel(model, rid);
        const resolvedNote = resolved && resolved !== model ? ` → ${resolved}` : '';
        return `**${role}**: \`${model}\`${resolvedNote} — ${desc}`;
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
- \`role\` (required): One of \`chat\`, \`fast\`, \`forge-drafter\`, \`forge-auditor\`, \`summary\`, \`cron\`.
- \`model\` (required): Model tier (\`fast\`, \`capable\`) or concrete model name (\`haiku\`, \`sonnet\`, \`opus\`).

**Roles:**
| Role | What it controls |
|------|-----------------|
| \`chat\` | Discord messages, plan runs, deferred runs, forge fallback |
| \`fast\` | All small/fast tasks (summary, cron auto-tag, beads auto-tag) |
| \`forge-drafter\` | Forge plan drafting/revision |
| \`forge-auditor\` | Forge plan auditing |
| \`summary\` | Rolling summaries only (overrides fast) |
| \`cron\` | Cron auto-tagging and model classification (overrides fast) |

Changes are **ephemeral** — they take effect immediately but revert on restart. Use env vars for persistent configuration.

Note: Individual cron execution models are per-job (set via \`cronUpdate\`). The \`cron\` role here controls auto-tagging only. The cron execution fallback follows the \`chat\` model.`;
}
