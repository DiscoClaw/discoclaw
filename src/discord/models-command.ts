import type { ConfigContext, ModelRole } from './actions-config.js';
import { executeConfigAction } from './actions-config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModelsCommand =
  | { action: 'show' }
  | { action: 'set'; role: ModelRole; model: string }
  | { action: 'help' };

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const VALID_ROLES = new Set<string>(['chat', 'fast', 'forge-drafter', 'forge-auditor', 'summary', 'cron']);

export function parseModelsCommand(content: string): ModelsCommand | null {
  const raw = String(content ?? '').trim().replace(/\s+/g, ' ');
  const normalized = raw.toLowerCase();
  if (normalized === '!models' || normalized === '!models show') return { action: 'show' };
  if (normalized === '!models help') return { action: 'help' };

  const setMatch = normalized.match(/^!models set (\S+) \S+$/);
  if (setMatch) {
    const role = setMatch[1];
    if (!VALID_ROLES.has(role)) return null;
    // Preserve original case for the model token — model IDs may be case-sensitive.
    const originalModel = raw.split(/\s+/)[3];
    return { action: 'set', role: role as ModelRole, model: originalModel };
  }

  // Unknown subcommand (e.g. "!models bogus") or unrelated message ("!modelsxyz")
  return null;
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
      '- `!models set <role> <model>` — change the model for a role at runtime',
      '- `!models help` — this message',
      '',
      '**Roles:** `chat`, `fast`, `forge-drafter`, `forge-auditor`, `summary`, `cron`',
      '',
      '**Examples:**',
      '- `!models set chat sonnet`',
      '- `!models set fast haiku`',
      '- `!models set forge-drafter opus`',
    ].join('\n');
  }

  if (cmd.action === 'show') {
    const result = executeConfigAction({ type: 'modelShow' }, configCtx);
    return result.ok ? result.summary : `Error: ${result.error}`;
  }

  // action === 'set'
  const result = executeConfigAction({ type: 'modelSet', role: cmd.role, model: cmd.model }, configCtx);
  return result.ok ? result.summary : `Error: ${result.error}`;
}
