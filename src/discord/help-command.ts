export function parseHelpCommand(content: string): true | null {
  const normalized = String(content ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (normalized !== '!help') return null;
  return true;
}

export function handleHelpCommand(): string {
  return [
    '**Discoclaw commands:**',
    '',
    '- `!forge <task>` — start a forge run (AI-drafted + audited plan); `!forge help` for details',
    '- `!plan <task>` — create and manage phased plans; `!plan help` for details',
    '- `!memory` — view or edit durable memory; `!memory help` for details',
    '- `!secret` — manage API keys and secrets via DM; `!secret help` for details',
    '- `!models` — show or change model assignments; `!models help` for details',
    '- `!health` — show bot health and metrics; `!health verbose` for full config',
    '- `!status` — show live runtime status (uptime, crons, memory, API connectivity)',
    '- `!update` — check for or apply code updates; `!update help` for details',
    '- `!restart` — restart the discoclaw service; `!restart help` for details',
    '- `!stop` — abort all active AI streams and cancel any running forge',
    '- `!voice status` — show voice subsystem status (STT/TTS providers, connections)',
    '- `!help` — this message',
  ].join('\n');
}
