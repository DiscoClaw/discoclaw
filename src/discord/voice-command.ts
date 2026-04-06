import { renderVoiceStatusReport } from './voice-status-command.js';
import type { VoiceStatusSnapshot } from './voice-status-command.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VoiceCommand =
  | { action: 'status' }
  | { action: 'help' };

export type VoiceCommandOpts = {
  voiceEnabled: boolean;
  /** Pre-built snapshot for the status subcommand. */
  statusSnapshot?: VoiceStatusSnapshot;
  botDisplayName?: string;
};

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export function parseVoiceCommand(content: string): VoiceCommand | null {
  const tokens = String(content ?? '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  if (tokens[0]!.toLowerCase() !== '!voice') return null;

  if (tokens.length === 1) return { action: 'status' };

  const sub = tokens[1]!.toLowerCase();

  if (sub === 'status' && tokens.length === 2) return { action: 'status' };
  if (sub === 'help' && tokens.length === 2) return { action: 'help' };

  return null;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

const HELP_TEXT = [
  '**!voice commands:**',
  '- `!voice` — show voice subsystem status',
  '- `!voice status` — same as above',
  '- `!voice help` — this message',
  '',
  'Voice now runs on Gemini Live only. The legacy STT/TTS pipeline and runtime voice switching have been removed.',
].join('\n');

export async function handleVoiceCommand(
  cmd: VoiceCommand,
  opts: VoiceCommandOpts,
): Promise<string> {
  if (!opts.voiceEnabled) {
    return 'Voice is disabled. Set `DISCOCLAW_VOICE_ENABLED=1` to enable.';
  }

  switch (cmd.action) {
    case 'status': {
      if (!opts.statusSnapshot) {
        return 'Voice status unavailable — no status context provided.';
      }
      return renderVoiceStatusReport(opts.statusSnapshot, opts.botDisplayName);
    }

    case 'help': {
      return HELP_TEXT;
    }
  }
}
