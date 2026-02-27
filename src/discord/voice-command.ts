import { renderVoiceStatusReport } from './voice-status-command.js';
import type { VoiceStatusSnapshot } from './voice-status-command.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VoiceCommand =
  | { action: 'status' }
  | { action: 'set'; voice: string }
  | { action: 'help' };

export type MutableVoiceConfig = {
  deepgramTtsVoice?: string;
};

export type VoiceCommandOpts = {
  voiceEnabled: boolean;
  ttsProvider: string;
  /** Pre-built snapshot for the status subcommand. */
  statusSnapshot?: VoiceStatusSnapshot;
  /** Mutable config updated by the set subcommand. */
  voiceConfig?: MutableVoiceConfig;
  /** Number of currently active audio pipelines. */
  activePipelineCount?: number;
  /** Callback to restart all active pipelines (called when activePipelineCount > 0). */
  restartPipelines?: () => Promise<void>;
  /**
   * Pipeline-level setter — updates the voice config and restarts all active
   * pipelines in one step. When provided, preferred over voiceConfig +
   * restartPipelines. Returns the number of pipelines restarted.
   * Persistence to runtime-overrides.json is handled internally by this callback.
   */
  setTtsVoice?: (voice: string) => Promise<number>;
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
  // Preserve original case for voice names (e.g. "aura-2-asteria-en").
  if (sub === 'set' && tokens.length === 3) return { action: 'set', voice: tokens[2]! };

  return null;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

const HELP_TEXT = [
  '**!voice commands:**',
  '- `!voice` — show voice subsystem status',
  '- `!voice status` — same as above',
  '- `!voice set <name>` — switch the Deepgram TTS voice at runtime',
  '- `!voice help` — this message',
  '',
  '**Examples:**',
  '- `!voice set aura-2-asteria-en`',
  '- `!voice set aura-2-luna-en`',
  '',
  '**Note:** Voice name switching requires the Deepgram TTS provider (`DISCOCLAW_TTS_PROVIDER=deepgram`).',
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

    case 'set': {
      if (opts.ttsProvider !== 'deepgram') {
        return `Voice name switching requires \`deepgram\` TTS provider (current: \`${opts.ttsProvider}\`).`;
      }
      if (opts.setTtsVoice) {
        const restarted = await opts.setTtsVoice(cmd.voice);
        const pipelineLabel = restarted === 1 ? '1 active pipeline' : `${restarted} active pipelines`;
        return restarted > 0
          ? `Voice set to \`${cmd.voice}\`. ${pipelineLabel} restarted.`
          : `Voice set to \`${cmd.voice}\`. Will take effect on the next pipeline start.`;
      }
      if (opts.voiceConfig) {
        opts.voiceConfig.deepgramTtsVoice = cmd.voice;
      }
      const pipelineCount = opts.activePipelineCount ?? 0;
      if (pipelineCount > 0 && opts.restartPipelines) {
        await opts.restartPipelines();
        const pipelineLabel = pipelineCount === 1 ? '1 active pipeline' : `${pipelineCount} active pipelines`;
        return `Voice set to \`${cmd.voice}\`. ${pipelineLabel} restarted.`;
      }
      return `Voice set to \`${cmd.voice}\`. Will take effect on the next pipeline start.`;
    }

    case 'help': {
      return HELP_TEXT;
    }
  }
}
