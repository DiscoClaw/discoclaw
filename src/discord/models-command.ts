import type { ConfigContext, ModelRole } from './actions-config.js';
import { executeConfigAction } from './actions-config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModelsCommand =
  | { action: 'show' }
  | { action: 'set'; role: ModelRole; model: string }
  | { action: 'reset'; role?: ModelRole }
  | { action: 'help' }
  | { action: 'error'; message: string };

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const VALID_ROLES = new Set<string>(['chat', 'plan-run', 'fast', 'forge-drafter', 'forge-auditor', 'summary', 'cron', 'cron-exec', 'voice', 'imagegen']);

/** Aliases that map user-friendly names to canonical roles. */
const ROLE_ALIASES: Record<string, string> = {
  runtime: 'chat',
};

function resolveRole(raw: string): string {
  const lower = raw.toLowerCase();
  return ROLE_ALIASES[lower] ?? lower;
}

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
      const role = resolveRole(tokens[2]!);
      if (!VALID_ROLES.has(role)) {
        return { action: 'error', message: `Unknown role "${tokens[2]}". Valid roles: ${[...VALID_ROLES].join(', ')}` };
      }
      return { action: 'reset', role: role as ModelRole };
    }
    return null;
  }

  if (subcommand !== 'set' || tokens.length !== 4) return null;

  const role = resolveRole(tokens[2]!);
  if (!VALID_ROLES.has(role)) {
    return { action: 'error', message: `Unknown role "${tokens[2]}". Valid roles: ${[...VALID_ROLES].join(', ')}` };
  }

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

function isOpenRouterActive(configCtx: ConfigContext): boolean {
  const activeRuntimeName = configCtx.runtimeName ?? configCtx.runtime.id;
  const voiceRuntimeName = configCtx.voiceRuntimeName
    ?? configCtx.botParams.voiceModelCtx?.runtimeName
    ?? configCtx.botParams.voiceModelCtx?.runtime?.id;
  return activeRuntimeName === 'openrouter' || voiceRuntimeName === 'openrouter';
}

function formatOpenRouterBoundaryNote(): string {
  return [
    '**OpenRouter path:**',
    'When OpenRouter is configured, `!models set chat openrouter` or `!models set voice openrouter` uses the existing `OPENROUTER_API_KEY` env-key path.',
    'That switch is a routing/proof boundary only; it does not prove broader OpenRouter readiness.',
    'Verify the shipped runtime path with `!status` (or the startup credential report) and confirm `openrouter-key: ok`.',
  ].join('\n');
}

function appendOpenRouterRuntimeNote(summary: string, configCtx: ConfigContext): string {
  if (!isOpenRouterActive(configCtx)) {
    return summary;
  }

  return [
    summary,
    '',
    '**OpenRouter note:** Current routing uses the configured `OPENROUTER_API_KEY` env-key path when OpenRouter is registered.',
    'This `!models` view shows routing state only; it is not proof that OpenRouter transport/auth is ready. Verify live readiness with `!status` and confirm `openrouter-key: ok`.',
  ].join('\n');
}

export function handleModelsCommand(cmd: ModelsCommand, opts: ModelsCommandOpts): string {
  const { configCtx, configEnabled } = opts;
  if (!configCtx) {
    return configEnabled
      ? 'Model configuration is not yet available — the bot is still starting up. Try again in a moment.'
      : 'Model configuration is disabled.';
  }

  if (cmd.action === 'error') {
    return cmd.message;
  }

  if (cmd.action === 'help') {
    return [
      '**!models commands:**',
      '- `!models` — show current model assignments for all roles',
      '- `!models show` — same as above',
      '- `!models set <role> <model>` — change a model role or supported runtime path at runtime',
      '- `!models reset` — revert all roles to startup defaults and clear persisted fast/voice runtime overlays',
      '- `!models reset <role>` — revert a specific role to its startup default',
      '- `!models help` — this message',
      '',
      '**Roles:** `chat`, `plan-run`, `fast`, `forge-drafter`, `forge-auditor`, `summary`, `cron`, `cron-exec`, `voice`, `imagegen` (alias: `runtime` → `chat`)',
      '',
      '**Canonical runtime names:** `claude`, `codex`, `gemini-api`, `gemini-cli`, `openai`, `openrouter`',
      '`gemini` remains a compatibility alias for `gemini-api`.',
      '`anthropic` is voice-only. Use it with `!models set voice anthropic`; `chat` cannot switch to `anthropic`.',
      '',
      '**Runtime switching (chat and voice roles):**',
      'Setting the `chat` or `voice` role to one of the supported runtime names switches the active runtime adapter so invocations route through that provider when it is registered.',
      '`gemini-cli` is the limited Gemini runtime because it only advertises `streaming_text`; DiscoClaw enforces that by filtering out tools the runtime does not advertise.',
      '',
      '**Persistence and reset semantics:**',
      '- Model-role overrides persist in `models.json` and survive restart.',
      '- `chat` runtime swaps are live memory only; they reset on restart or another explicit runtime switch.',
      '- `voice` runtime swaps persist in `runtime-overrides.json` and clear with `!models reset voice`.',
      '- `fast` runtime overlays persist in `runtime-overrides.json` and clear with `!models reset fast`.',
      '- `!models reset chat` resets the chat model/default but does not persist or backfill a chat runtime overlay.',
      '',
      formatOpenRouterBoundaryNote(),
      '',
      '**Examples:**',
      '- `!models set chat sonnet`',
      '- `!models set chat openrouter` — switch chat to the OpenRouter runtime',
      '- `!models set chat gemini-api` — switch chat to the Gemini API runtime',
      '- `!models set chat gemini` — compatibility alias for `gemini-api`',
      '- `!models set voice gemini-cli` — switch voice to the limited Gemini CLI runtime',
      '- `!models set voice anthropic` — switch voice to the Anthropic voice-only runtime',
      '- `!models set plan-run capable`',
      '- `!models set fast haiku`',
      '- `!models set forge-drafter opus`',
      '- `!models set cron-exec haiku` — run crons on a cheaper model',
      '- `!models set cron-exec default` — revert to the startup default for cron execution',
      '- `!models set voice gemini-api` — switch voice to the Gemini API runtime',
      '- `!models set voice sonnet` — use a specific model for voice responses',
      '- `!models reset` — clear all overrides and revert to startup defaults',
      '- `!models reset chat` — reset the chat model/default without creating a persisted chat runtime overlay',
      '',
      '**Note:** `!models set imagegen <model>` changes the default image generation model at runtime (persisted). Use `!models reset imagegen` to revert to the env/fallback default.',
      '',
      '**TTS voice:** Use `!voice set <name>` to switch the Deepgram TTS voice at runtime (e.g. `!voice set aura-2-luna-en`). See `!voice help` for details.',
    ].join('\n');
  }

  if (cmd.action === 'show') {
    const result = executeConfigAction({ type: 'modelShow' }, configCtx);
    return result.ok ? appendOpenRouterRuntimeNote(result.summary, configCtx) : `Error: ${result.error}`;
  }

  if (cmd.action === 'reset') {
    const result = executeConfigAction({ type: 'modelReset', role: cmd.role }, configCtx);
    return result.ok ? result.summary : `Error: ${result.error}`;
  }

  // action === 'set'
  const result = executeConfigAction({ type: 'modelSet', role: cmd.role, model: cmd.model }, configCtx);
  return result.ok ? appendOpenRouterRuntimeNote(result.summary, configCtx) : `Error: ${result.error}`;
}
