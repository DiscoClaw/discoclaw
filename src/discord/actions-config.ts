import { inspectWorkspaceBootstrapWarningsSync } from '../workspace-bootstrap.js';
import type { DiscordActionResult } from './actions.js';
import type { RuntimeAdapter } from '../runtime/types.js';
import type { RuntimeRegistry } from '../runtime/registry.js';
import { resolveModel, findRuntimeForModel, resolveReasoningEffort } from '../runtime/model-tiers.js';
import {
  canonicalizeRuntimePathName,
  getRuntimePathDefinition,
  getRuntimePlacementDefinition,
  isRuntimeNameSupportedInPlacement,
  listCanonicalRuntimeNames,
  parseRuntimeNameForPlacement,
  type RuntimePathCanonicalName,
  type RuntimePathPlacement,
} from '../runtime/runtime-path-contract.js';
import type { ImagegenContext } from './actions-imagegen.js';
import { resolveDefaultModel, resolveProvider } from './actions-imagegen.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { ModelRole } from '../model-config.js';
import type { ModelRole } from '../model-config.js';

export type ConfigActionRequest =
  | { type: 'modelSet'; role: ModelRole; model: string }
  | { type: 'modelReset'; role?: ModelRole }
  | { type: 'modelShow' }
  | { type: 'workspaceWarnings' };

const CONFIG_TYPE_MAP: Record<ConfigActionRequest['type'], true> = {
  modelSet: true,
  modelReset: true,
  modelShow: true,
  workspaceWarnings: true,
};
export const CONFIG_ACTION_TYPES = new Set<string>(Object.keys(CONFIG_TYPE_MAP));

/**
 * Config action types that mutate bot state and require requester authorization
 * against DISCORD_ALLOW_USER_IDS. Read-only queries (modelShow, workspaceWarnings)
 * are intentionally excluded.
 *
 * All role-scoped mutations — chat, voice, imagegen, fast, cron, forge-drafter,
 * forge-auditor, plan-run, summary, cron-exec — flow through modelSet/modelReset,
 * so this set covers every config-mutation path.
 */
export const CONFIG_MUTATING_ACTION_TYPES: ReadonlySet<string> = new Set<string>([
  'modelSet',
  'modelReset',
]);

export type ConfigContext = {
  /** The live botParams object — mutating fields takes effect next invocation. */
  botParams: ConfigMutableParams;
  /** Workspace directory used for current-file inspection actions. */
  workspaceCwd: string;
  /** The primary runtime, for resolveModel display. */
  runtime: RuntimeAdapter;
  /** Registry of all available runtime adapters. When set, modelSet chat can swap runtimes. */
  runtimeRegistry?: RuntimeRegistry;
  /** Human-readable name of the active runtime (e.g. 'claude_code', 'openrouter'). */
  runtimeName?: string;
  /** Human-readable name of the voice runtime when it differs from chat (read-only display). */
  voiceRuntimeName?: string;
  /** Human-readable name of the fast-tier runtime (read-only display). */
  fastRuntimeName?: string;
  /** Callback to persist a model override to models.json. Wired in index.ts. */
  persistOverride?: (role: ModelRole, model: string) => void;
  /** Callback to clear model overrides from models.json. Pass undefined role to clear all. Wired in index.ts. */
  clearOverride?: (role?: ModelRole) => void;
  /** Callback to persist the voice runtime name to overrides. */
  persistVoiceRuntime?: (runtimeName: string) => void;
  /** Callback to clear the voice runtime override. */
  clearVoiceRuntime?: () => void;
  /** Callback to persist the fast-tier runtime name to overrides. */
  persistFastRuntime?: (runtimeName: string) => void;
  /** Callback to clear the fast-tier runtime override. */
  clearFastRuntime?: () => void;
  /** Env-default model string for each role, used by modelReset to revert live state. */
  envDefaults?: Partial<Record<ModelRole, string>>;
  /** Tracks which roles have active models.json overrides. */
  overrideSources?: Partial<Record<ModelRole, boolean>>;
};

/** The subset of BotParams fields that modelSet/modelShow reads and mutates. */
export type ConfigMutableParams = {
  runtimeModel: string;
  planRunModel?: string;
  summaryModel: string;
  runtime?: RuntimeAdapter;
  fastRuntime?: RuntimeAdapter;
  forgeDrafterModel?: string;
  forgeAuditorModel?: string;
  cronCtx?: {
    autoTagModel: string;
    runtime?: RuntimeAdapter;
    syncCoordinator?: { setAutoTagModel(model: string): void; setRuntime?(runtime: RuntimeAdapter): void };
    executorCtx?: { model: string; cronExecModel?: string; runtime?: RuntimeAdapter };
  };
  taskCtx?: { autoTagModel: string; runtime?: { id: string } };
  planCtx?: { model?: string; runtime?: RuntimeAdapter };
  deferOpts?: { runtime: RuntimeAdapter };
  imagegenCtx?: ImagegenContext;
  voiceModelCtx?: { model: string; runtime?: RuntimeAdapter; runtimeName?: string };
};

// ---------------------------------------------------------------------------
// Role → field mapping
// ---------------------------------------------------------------------------

const ROLE_DESCRIPTIONS: Record<ModelRole, string> = {
  chat: 'Discord messages, deferred runs, forge fallback',
  'plan-run': 'Plan phase execution',
  fast: 'All small/fast tasks (summary, cron, cron auto-tag, tasks auto-tag)',
  'forge-drafter': 'Forge plan drafting/revision',
  'forge-auditor': 'Forge plan auditing',
  summary: 'Rolling summaries only',
  cron: 'Cron auto-tagging and model classification',
  'cron-exec': 'Default model for cron job execution (overridden by per-job settings)',
  voice: 'Voice channel AI responses',
  imagegen: 'Default model for image generation',
};

function canonicalizeRuntimeSwitchName(name: string): string {
  return canonicalizeRuntimePathName(name) ?? name.trim().toLowerCase();
}

function describeRuntimePlacement(placement: RuntimePathPlacement): string {
  switch (placement) {
    case 'live:chat':
      return 'the chat role';
    case 'live:voice':
      return 'the voice role';
    case 'runtime-overrides:fastRuntime':
      return 'the fast runtime override';
    case 'runtime-overrides:voiceRuntime':
      return 'the voice runtime override';
    default:
      return placement;
  }
}

function formatUnsupportedRuntimeSelection(
  runtimeName: RuntimePathCanonicalName,
  placement: RuntimePathPlacement,
): string {
  if (
    isRuntimeNameSupportedInPlacement(runtimeName, 'live:voice')
    && !isRuntimeNameSupportedInPlacement(runtimeName, 'live:chat')
    && placement === 'live:chat'
  ) {
    return `Runtime "${runtimeName}" is voice-only; use it with the voice role`;
  }

  const supported = getRuntimePlacementDefinition(placement).supportedRuntimeNames.join(', ');
  return `Runtime "${runtimeName}" is not supported for ${describeRuntimePlacement(placement)}. Supported runtime names: ${supported}`;
}

function formatPromptRuntimeNames(placement: RuntimePathPlacement): string {
  return listCanonicalRuntimeNames(placement).map((name) => `\`${name}\``).join(', ');
}

function formatPromptCompatibilityAliases(): string {
  const aliases = listCanonicalRuntimeNames('live:voice')
    .flatMap((name) => (getRuntimePathDefinition(name)?.acceptedAliases ?? []).filter((alias) => alias !== name))
    .filter((alias, index, values) => values.indexOf(alias) === index);

  return aliases.map((alias) => `\`${alias}\``).join(', ');
}

function formatPromptRoleDescriptions(): string {
  return Object.entries(ROLE_DESCRIPTIONS)
    .map(([role, description]) => `- \`${role}\` | ${description}`)
    .join('\n');
}

type RuntimeSwitchResolution =
  | { kind: 'switch'; runtime: RuntimeAdapter; runtimeName: RuntimePathCanonicalName }
  | { kind: 'error'; error: string }
  | { kind: 'none' };

function resolveRuntimeSwitch(
  runtimeRegistry: RuntimeRegistry | undefined,
  name: string,
  placement: RuntimePathPlacement,
): RuntimeSwitchResolution {
  const canonicalName = canonicalizeRuntimePathName(name);
  if (!canonicalName) return { kind: 'none' };

  const placementName = parseRuntimeNameForPlacement(name, placement);
  if (!placementName) {
    return { kind: 'error', error: formatUnsupportedRuntimeSelection(canonicalName, placement) };
  }

  const definition = getRuntimePathDefinition(placementName);
  if (!definition) {
    return { kind: 'error', error: `Runtime "${placementName}" is not configured in the registry` };
  }

  for (const registryKey of definition.registryKeys) {
    const runtime = runtimeRegistry?.get(registryKey);
    if (runtime) {
      return { kind: 'switch', runtime, runtimeName: definition.canonicalName };
    }
  }

  return { kind: 'error', error: `Runtime "${placementName}" is not configured in the registry` };
}

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
      // Runtime swaps (chat role with a runtime name) are ephemeral — not written to the override file.
      let skipPersist = false;

      switch (action.role) {
        case 'chat': {
          // Check if the model string is actually a runtime name.
          const runtimeSwitch = resolveRuntimeSwitch(configCtx.runtimeRegistry, model, 'live:chat');
          if (runtimeSwitch.kind === 'switch') {
            skipPersist = true; // Don't persist runtime swaps; persisting the runtime name as a model string would break on reload.
            // Swap runtime across all invocation paths.
            const { runtime: newRuntime, runtimeName } = runtimeSwitch;
            const runtimeModel = newRuntime.defaultModel ?? '';
            const effectiveFastRuntime = bp.fastRuntime ?? newRuntime;
            bp.runtime = newRuntime;
            bp.runtimeModel = runtimeModel;
            configCtx.runtime = newRuntime;
            configCtx.runtimeName = runtimeName;
            if (bp.cronCtx) {
              bp.cronCtx.runtime = effectiveFastRuntime;
              bp.cronCtx.syncCoordinator?.setRuntime?.(effectiveFastRuntime);
              if (bp.cronCtx.executorCtx) {
                bp.cronCtx.executorCtx.runtime = newRuntime;
                bp.cronCtx.executorCtx.model = runtimeModel;
              }
            }
            if (bp.planCtx) {
              bp.planCtx.runtime = newRuntime;
            }
            if (bp.deferOpts) bp.deferOpts.runtime = newRuntime;
            changes.push(`runtime → ${runtimeName}`);
            if (runtimeModel) changes.push(`chat → ${runtimeModel} (adapter default)`);
          } else if (runtimeSwitch.kind === 'error') {
            return { ok: false, error: runtimeSwitch.error };
          } else {
            bp.runtimeModel = model;
            if (bp.cronCtx?.executorCtx) bp.cronCtx.executorCtx.model = model;
            changes.push(`chat → ${model}`);
          }
          break;
        }
        case 'plan-run':
          bp.planRunModel = model;
          if (bp.planCtx) bp.planCtx.model = model;
          changes.push(`plan-run → ${model}`);
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

          // Auto-switch fast runtime if the model belongs to a different provider.
          if (configCtx.runtimeRegistry) {
            const owningRuntimeId = findRuntimeForModel(model);
            const currentFastRuntimeId = bp.fastRuntime?.id ?? configCtx.runtime.id;
            if (owningRuntimeId && owningRuntimeId !== currentFastRuntimeId) {
              let matchedKey: string | undefined;
              let matchedAdapter: RuntimeAdapter | undefined;
              for (const registryKey of configCtx.runtimeRegistry.list()) {
                const adapter = configCtx.runtimeRegistry.get(registryKey);
                if (adapter && adapter.id === owningRuntimeId) {
                  matchedKey = registryKey;
                  matchedAdapter = adapter;
                  break;
                }
              }
              if (matchedAdapter && matchedKey) {
                bp.fastRuntime = matchedAdapter;
                configCtx.fastRuntimeName = matchedKey;
                if (bp.cronCtx) {
                  bp.cronCtx.runtime = matchedAdapter;
                  bp.cronCtx.syncCoordinator?.setRuntime?.(matchedAdapter);
                }
                if (bp.taskCtx) bp.taskCtx.runtime = matchedAdapter;
                configCtx.persistFastRuntime?.(matchedKey);
                changes.push(`fast runtime → ${matchedKey} (auto-switched)`);
              } else {
                return { ok: false, error: `Model "${model}" belongs to runtime "${owningRuntimeId}" which is not configured in the registry` };
              }
            }
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
              const envDefault = configCtx.envDefaults?.['cron-exec'];
              bp.cronCtx.executorCtx.cronExecModel = envDefault || undefined;
              changes.push(`cron-exec → ${envDefault || '(follows chat)'}`);
              skipPersist = true;
              configCtx.clearOverride?.('cron-exec');
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
            // Check if the model string is actually a runtime name.
            const runtimeSwitch = resolveRuntimeSwitch(configCtx.runtimeRegistry, model, 'live:voice');
            if (runtimeSwitch.kind === 'switch') {
              skipPersist = true;
              const { runtime: voiceNewRuntime, runtimeName } = runtimeSwitch;
              const voiceRuntimeModel = voiceNewRuntime.defaultModel ?? '';
              bp.voiceModelCtx.runtime = voiceNewRuntime;
              bp.voiceModelCtx.runtimeName = runtimeName;
              bp.voiceModelCtx.model = voiceRuntimeModel;
              configCtx.voiceRuntimeName = runtimeName;
              configCtx.persistVoiceRuntime?.(runtimeName);
              changes.push(`voice runtime → ${runtimeName}`);
              if (voiceRuntimeModel) changes.push(`voice → ${voiceRuntimeModel} (adapter default)`);
            } else if (runtimeSwitch.kind === 'error') {
              return { ok: false, error: runtimeSwitch.error };
            } else {
              bp.voiceModelCtx.model = model;
              changes.push(`voice → ${model}`);

              // Auto-switch voice runtime if the model belongs to a different provider.
              if (configCtx.runtimeRegistry) {
                const owningRuntimeId = findRuntimeForModel(model);
                const currentVoiceRuntimeId = bp.voiceModelCtx.runtime?.id ?? configCtx.runtime.id;
                if (owningRuntimeId && owningRuntimeId !== currentVoiceRuntimeId) {
                  // Tier-map keys (e.g. 'claude_code') may differ from registry keys (e.g. 'claude').
                  // Scan registry entries by adapter.id to find the matching key.
                  let matchedKey: string | undefined;
                  let matchedAdapter: RuntimeAdapter | undefined;
                  for (const registryKey of configCtx.runtimeRegistry.list()) {
                    const adapter = configCtx.runtimeRegistry.get(registryKey);
                    if (adapter && adapter.id === owningRuntimeId) {
                      matchedKey = registryKey;
                      matchedAdapter = adapter;
                      break;
                    }
                  }
                  if (matchedAdapter && matchedKey) {
                    bp.voiceModelCtx.runtime = matchedAdapter;
                    bp.voiceModelCtx.runtimeName = matchedKey;
                    configCtx.voiceRuntimeName = matchedKey;
                    configCtx.persistVoiceRuntime?.(matchedKey);
                    changes.push(`voice runtime → ${matchedKey} (auto-switched)`);
                  } else {
                    return { ok: false, error: `Model "${model}" belongs to runtime "${owningRuntimeId}" which is not configured in the registry` };
                  }
                }
              }
            }
          } else {
            return { ok: false, error: 'Voice subsystem not configured' };
          }
          break;
        case 'imagegen':
          if (bp.imagegenCtx) {
            bp.imagegenCtx.defaultModel = model;
            changes.push(`imagegen → ${model}`);
          } else {
            return { ok: false, error: 'Imagegen subsystem not configured' };
          }
          break;
        default:
          return { ok: false, error: `Unknown role: ${String((action as { role: unknown }).role)}` };
      }

      if (!skipPersist) {
        configCtx.persistOverride?.(action.role, model);
        if (configCtx.overrideSources) {
          configCtx.overrideSources[action.role] = true;
        }
      }

      const resolveRid = action.role === 'voice' && bp.voiceModelCtx?.runtime
        ? bp.voiceModelCtx.runtime.id
        : (action.role === 'fast' || action.role === 'summary' || action.role === 'cron')
          ? (bp.fastRuntime?.id ?? configCtx.runtime.id)
          : configCtx.runtime.id;
      const resolvedDisplay = resolveModel(model, resolveRid);
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
        // Apply env-default model to live botParams. Some roles intentionally
        // allow an undefined default, meaning "follow chat".
        switch (role) {
          case 'chat':
            if (defaultModel === undefined) break;
            bp.runtimeModel = defaultModel;
            if (bp.cronCtx?.executorCtx) bp.cronCtx.executorCtx.model = defaultModel;
            resetChanges.push(`chat → ${defaultModel}`);
            break;
          case 'plan-run':
            bp.planRunModel = defaultModel;
            if (bp.planCtx) bp.planCtx.model = defaultModel;
            resetChanges.push(`plan-run → ${defaultModel ?? '(unset)'}`);
            break;
          case 'fast':
            if (defaultModel === undefined) break;
            bp.summaryModel = defaultModel;
            if (bp.cronCtx) {
              bp.cronCtx.autoTagModel = defaultModel;
              bp.cronCtx.syncCoordinator?.setAutoTagModel(defaultModel);
              bp.cronCtx.runtime = configCtx.runtime;
              bp.cronCtx.syncCoordinator?.setRuntime?.(configCtx.runtime);
            }
            if (bp.taskCtx) {
              bp.taskCtx.autoTagModel = defaultModel;
              bp.taskCtx.runtime = configCtx.runtime;
            }
            bp.fastRuntime = configCtx.runtime;
            configCtx.fastRuntimeName = undefined;
            configCtx.clearFastRuntime?.();
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
            if (defaultModel === undefined) break;
            bp.summaryModel = defaultModel;
            resetChanges.push(`summary → ${defaultModel}`);
            break;
          case 'cron':
            if (defaultModel === undefined) break;
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
              if (defaultModel !== undefined) {
                bp.voiceModelCtx.model = defaultModel;
              }
              bp.voiceModelCtx.runtime = undefined;
              bp.voiceModelCtx.runtimeName = undefined;
              configCtx.voiceRuntimeName = undefined;
              configCtx.clearVoiceRuntime?.();
              if (defaultModel !== undefined) {
                resetChanges.push(`voice → ${defaultModel}`);
              } else {
                resetChanges.push('voice → (follows chat)');
              }
            }
            break;
          case 'imagegen':
            if (bp.imagegenCtx) {
              // Restore the fallback-resolved default (env setting or provider-based fallback).
              const igEnvDefault = defaults['imagegen'];
              if (igEnvDefault) {
                bp.imagegenCtx.defaultModel = igEnvDefault;
              } else {
                // Clear override so resolveDefaultModel falls back to provider detection.
                bp.imagegenCtx.defaultModel = undefined;
              }
              const resolvedIg = resolveDefaultModel(bp.imagegenCtx);
              resetChanges.push(`imagegen → ${resolvedIg}`);
            }
            break;
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

      const runtimeName = configCtx.runtimeName
        ? canonicalizeRuntimeSwitchName(configCtx.runtimeName)
        : rid;
      const planRunDisplay = bp.planRunModel
        || bp.planCtx?.model
        || '(unset)';
      const rows: [string, string, string, string][] = [
        ['runtime', runtimeName, `Active runtime adapter (${rid})`, ovr('chat')],
        ['chat', bp.runtimeModel, ROLE_DESCRIPTIONS.chat, ovr('chat')],
        ['plan-run', planRunDisplay, ROLE_DESCRIPTIONS['plan-run'], ovr('plan-run')],
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
        rows.push(['imagegen', igModel, `Image generation (${igProvider})`, ovr('imagegen')]);
      } else {
        rows.push(['imagegen', 'setup-required', 'Image generation (setup required)', '']);
      }

      const adapterDefault = configCtx.runtime.defaultModel;
      const fastRid = bp.fastRuntime?.id ?? rid;
      const lines = rows.map(([role, model, desc, overrideMarker]) => {
        const useFastRuntime = role === 'summary' || role === 'cron-auto-tag' || role === 'tasks-auto-tag';
        const roleRid = useFastRuntime ? fastRid : rid;
        const resolved = resolveModel(model, roleRid);
        const runtimeNote = useFastRuntime && fastRid !== rid ? ` [runtime: ${fastRid}]` : '';
        const effort = resolveReasoningEffort(model, roleRid);
        const effortNote = effort ? ` [effort: ${effort}]` : '';
        let display: string;
        if (model) {
          display = resolved && resolved !== model ? `${model} → ${resolved}` : model;
        } else {
          display = adapterDefault || '(adapter default)';
        }
        return `**${role}**: \`${display}\`${overrideMarker}${runtimeNote}${effortNote} — ${desc}`;
      });

      if (bp.voiceModelCtx) {
        const voiceRid = bp.voiceModelCtx.runtime?.id ?? rid;
        const voiceModel = bp.voiceModelCtx.model || `${bp.runtimeModel} (follows chat)`;
        const voiceRuntimeName = bp.voiceModelCtx.runtimeName
          ? canonicalizeRuntimeSwitchName(bp.voiceModelCtx.runtimeName)
          : undefined;
        const voiceRtLabel = voiceRuntimeName && voiceRuntimeName !== runtimeName
          ? ` [runtime: ${voiceRuntimeName}]`
          : '';
        // Voice row uses its own runtime ID for tier resolution.
        const voiceResolved = resolveModel(voiceModel, voiceRid);
        let voiceDisplay: string;
        if (voiceModel) {
          voiceDisplay = voiceResolved && voiceResolved !== voiceModel ? `${voiceModel} → ${voiceResolved}` : voiceModel;
        } else {
          const voiceAdapterDefault = bp.voiceModelCtx.runtime?.defaultModel ?? adapterDefault;
          voiceDisplay = voiceAdapterDefault || '(adapter default)';
        }
        const voiceEffort = resolveReasoningEffort(voiceModel, voiceRid);
        const voiceEffortNote = voiceEffort ? ` [effort: ${voiceEffort}]` : '';
        lines.push(`**voice**: \`${voiceDisplay}\`${ovr('voice')}${voiceRtLabel}${voiceEffortNote} — ${ROLE_DESCRIPTIONS.voice}`);
      }

      return { ok: true, summary: lines.join('\n') };
    }

    case 'workspaceWarnings': {
      const warnings = inspectWorkspaceBootstrapWarningsSync(configCtx.workspaceCwd);
      const observedAt = new Date().toISOString();
      const lines = [
        'Workspace warnings live check',
        `source: live_check`,
        `observedAt: ${observedAt}`,
        `workspace: ${configCtx.workspaceCwd}`,
      ];

      if (warnings.length === 0) {
        lines.push('No live bootstrap cleanup warnings detected for AGENTS.md, DISCOCLAW.md, or TOOLS.md.');
      } else {
        for (const warning of warnings) {
          const markerNote = warning.matchedMarkers?.length
            ? ` (matched markers: ${warning.matchedMarkers.join(', ')})`
            : '';
          lines.push(`[warn] ${warning.file}: ${warning.message}${markerNote}`);
          lines.push(`recommendation: ${warning.recommendation}`);
        }
      }

      return { ok: true, summary: lines.join('\n') };
    }
  }
}

// ---------------------------------------------------------------------------
// Prompt section
// ---------------------------------------------------------------------------

export function configActionsPromptSection(): string {
  const chatRuntimeNames = formatPromptRuntimeNames('live:chat');
  const voiceOnlyRuntimeNames = listCanonicalRuntimeNames('live:voice')
    .filter((name) => !isRuntimeNameSupportedInPlacement(name, 'live:chat'))
    .map((name) => `\`${name}\``)
    .join(', ');
  const compatibilityAliases = formatPromptCompatibilityAliases();

  return `### Model Configuration

**modelShow** — \`{"type":"modelShow"}\` — current model assignments for all roles.

**workspaceWarnings** — \`{"type":"workspaceWarnings"}\` — live-check workspace bootstrap warnings.

**modelSet** — \`{"type":"modelSet","role":"chat","model":"sonnet"}\`
\`role\` (required): chat, plan-run, fast, forge-drafter, forge-auditor, summary, cron, cron-exec, voice, imagegen.
\`model\` (required): tier (fast/capable/deep), name (haiku/sonnet/opus), runtime (${chatRuntimeNames}; aliases ${compatibilityAliases}; voice-only: ${voiceOnlyRuntimeNames}), or \`default\` (cron-exec only).

**Roles:** ${formatPromptRoleDescriptions()}

Persistence: model-role overrides in \`models.json\` survive restart. Fast/voice runtime overlays in \`runtime-overrides.json\`. Chat runtime swaps are live-only.

**modelReset** — \`{"type":"modelReset","role":"chat"}\` — omit \`role\` to reset all. Fast/voice resets also clear runtime overlays.

Cron model priority: per-job override > AI-classified > cron-exec default > chat fallback.`;
}
