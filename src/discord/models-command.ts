import type { ConfigContext, ModelRole } from './actions-config.js';
import { executeConfigAction } from './actions-config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModelsCommand =
  | { action: 'show' }
  | { action: 'set'; role: ModelRole; model: string }
  | { action: 'reset'; role?: ModelRole }
  | { action: 'help' };

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const VALID_ROLES = new Set<string>(['chat', 'fast', 'forge-drafter', 'forge-auditor', 'summary', 'cron', 'cron-exec', 'voice']);

export function parseModelsCommand(content: string): ModelsCommand | null {
  const tokens = String(content ?? '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  if (tokens[0]!.toLowerCase() !== '!models') return null;

  if (tokens.length === 1) return { action: 'show' };

  const subcommand = tokens[1]!.toLowerCase();
  if (subcommand === 'show' && tokens.length === 2) return { action: 'show' };
  if (subcommand === 'help' && tokens.length === 2) return { action: 'help' };

  if (subcommand === 'reset') {
    if (tokens.length === 2) return { action: 'reset' };
    if (tokens.length === 3) {
      const role = tokens[2]!.toLowerCase();
      if (!VALID_ROLES.has(role)) return null;
      return { action: 'reset', role: role as ModelRole };
    }
    return null;
  }

  if (subcommand !== 'set' || tokens.length !== 4) return null;

  const role = tokens[2]!.toLowerCase();
  if (!VALID_ROLES.has(role)) return null;

  // Preserve original case for model IDs.
  return { action: 'set', role: role as ModelRole, model: tokens[3]! };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export type ModelsCommandOpts = {
  configCtx: ConfigContext | undefined;
  configEnabled: boolean;
};

export function handleModelsCommand(cmd: ModelsCommand, opts: ModelsCommandOpts): string {
  const { configCtx, configEnabled } = opts;
  if (!configCtx) {
    return configEnabled
      ? 'Model configuration is not yet available — the bot is still starting up. Try again in a moment.'
      : 'Model configuration is disabled.';
  }

  if (cmd.action === 'help') {
    return [
      '**!models commands:**',
      '- `!models` — show current model assignments for all roles',
      '- `!models show` — same as above',
      '- `!models set <role> <model>` — change the model for a role at runtime (persisted)',
      '- `!models reset` — revert all roles to env-var defaults',
      '- `!models reset <role>` — revert a specific role to its env-var default',
      '- `!models help` — this message',
      '',
      '**Roles:** `chat`, `fast`, `forge-drafter`, `forge-auditor`, `summary`, `cron`, `cron-exec`, `voice`',
      '',
      '**Runtime switching (chat and voice roles):**',
      'Setting the `chat` or `voice` role to a runtime name (`openrouter`, `openai`, `gemini`, `codex`, `claude`) switches the active runtime adapter so invocations route through that provider.',
      '',
      '**Examples:**',
      '- `!models set chat sonnet`',
      '- `!models set chat openrouter` — switch chat to the OpenRouter runtime',
      '- `!models set chat gemini` — switch chat to the Gemini runtime',
      '- `!models set fast haiku`',
      '- `!models set forge-drafter opus`',
      '- `!models set cron-exec haiku` — run crons on a cheaper model',
      '- `!models set cron-exec default` — revert to env default (Sonnet by default)',
      '- `!models set voice gemini` — switch voice to the Gemini runtime',
      '- `!models set voice sonnet` — use a specific model for voice responses',
      '- `!models reset` — clear all overrides and revert to env defaults',
      '- `!models reset chat` — revert only the chat model to its env default',
      '',
      '**Note:** Image generation (imagegen) configuration is shown automatically in `!models` when enabled, but is not switchable via `!models set` — configure it via environment variables instead.',
      '',
      '**TTS voice:** Use `!voice set <name>` to switch the Deepgram TTS voice at runtime (e.g. `!voice set aura-2-luna-en`). See `!voice help` for details.',
    ].join('\n');
  }

  if (cmd.action === 'show') {
    const result = executeConfigAction({ type: 'modelShow' }, configCtx);
    return result.ok ? result.summary : `Error: ${result.error}`;
  }

  if (cmd.action === 'reset') {
    const result = executeConfigAction({ type: 'modelReset', role: cmd.role }, configCtx);
    return result.ok ? result.summary : `Error: ${result.error}`;
  }

  // action === 'set'
  const result = executeConfigAction({ type: 'modelSet', role: cmd.role, model: cmd.model }, configCtx);
  return result.ok ? result.summary : `Error: ${result.error}`;
}
