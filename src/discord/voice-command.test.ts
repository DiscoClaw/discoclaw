import { describe, it, expect, vi } from 'vitest';
import { parseVoiceCommand, handleVoiceCommand } from './voice-command.js';
import type { VoiceCommandOpts } from './voice-command.js';
import * as voiceStatusCommand from './voice-status-command.js';
import type { VoiceStatusSnapshot } from './voice-status-command.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSnapshot(overrides: Partial<VoiceStatusSnapshot> = {}): VoiceStatusSnapshot {
  return {
    enabled: true,
    sttProvider: 'deepgram',
    ttsProvider: 'deepgram',
    homeChannel: 'voice-home',
    deepgramKeySet: true,
    cartesiaKeySet: false,
    autoJoin: false,
    actionsEnabled: true,
    connections: [],
    deepgramTtsVoice: 'aura-2-asteria-en',
    ...overrides,
  };
}

function makeOpts(overrides: Partial<VoiceCommandOpts> = {}): VoiceCommandOpts {
  return {
    voiceEnabled: true,
    ttsProvider: 'deepgram',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseVoiceCommand
// ---------------------------------------------------------------------------

describe('parseVoiceCommand', () => {
  // Bare command
  it('returns status for bare !voice', () => {
    expect(parseVoiceCommand('!voice')).toEqual({ action: 'status' });
  });

  // status subcommand
  it('returns status for !voice status', () => {
    expect(parseVoiceCommand('!voice status')).toEqual({ action: 'status' });
  });

  // set subcommand
  it('returns set for !voice set <name>', () => {
    expect(parseVoiceCommand('!voice set aura-2-luna-en')).toEqual({
      action: 'set',
      voice: 'aura-2-luna-en',
    });
  });

  // help subcommand
  it('returns help for !voice help', () => {
    expect(parseVoiceCommand('!voice help')).toEqual({ action: 'help' });
  });

  // Case insensitivity — command and subcommand
  it('is case-insensitive for the command token', () => {
    expect(parseVoiceCommand('!VOICE')).toEqual({ action: 'status' });
    expect(parseVoiceCommand('!Voice')).toEqual({ action: 'status' });
  });

  it('is case-insensitive for the status subcommand', () => {
    expect(parseVoiceCommand('!VOICE STATUS')).toEqual({ action: 'status' });
    expect(parseVoiceCommand('!Voice Status')).toEqual({ action: 'status' });
  });

  it('is case-insensitive for the set subcommand keyword', () => {
    expect(parseVoiceCommand('!VOICE SET aura-2-luna-en')).toEqual({
      action: 'set',
      voice: 'aura-2-luna-en',
    });
  });

  it('is case-insensitive for the help subcommand', () => {
    expect(parseVoiceCommand('!VOICE HELP')).toEqual({ action: 'help' });
  });

  // Preserves original case for voice names
  it('preserves original case for the voice name', () => {
    expect(parseVoiceCommand('!voice set AURA-2-LUNA-EN')).toEqual({
      action: 'set',
      voice: 'AURA-2-LUNA-EN',
    });
    expect(parseVoiceCommand('!VOICE SET Aura-2-Asteria-EN')).toEqual({
      action: 'set',
      voice: 'Aura-2-Asteria-EN',
    });
  });

  // Whitespace handling
  it('trims surrounding whitespace', () => {
    expect(parseVoiceCommand('  !voice  ')).toEqual({ action: 'status' });
    expect(parseVoiceCommand('  !voice status  ')).toEqual({ action: 'status' });
  });

  it('collapses extra internal whitespace', () => {
    expect(parseVoiceCommand('!voice  status')).toEqual({ action: 'status' });
    expect(parseVoiceCommand('!voice   set   aura-2-luna-en')).toEqual({
      action: 'set',
      voice: 'aura-2-luna-en',
    });
  });

  // Rejection of invalid input
  it('returns null when !voice set has no voice name', () => {
    expect(parseVoiceCommand('!voice set')).toBeNull();
  });

  it('returns null when !voice set has extra tokens', () => {
    expect(parseVoiceCommand('!voice set aura-2-luna-en extra')).toBeNull();
  });

  it('returns null for !voice status with extra tokens', () => {
    expect(parseVoiceCommand('!voice status extra')).toBeNull();
  });

  it('returns null for !voice help with extra tokens', () => {
    expect(parseVoiceCommand('!voice help extra')).toBeNull();
  });

  it('returns null for unknown subcommands', () => {
    expect(parseVoiceCommand('!voice bogus')).toBeNull();
    expect(parseVoiceCommand('!voice join')).toBeNull();
    expect(parseVoiceCommand('!voice leave')).toBeNull();
  });

  it('returns null for non-voice commands', () => {
    expect(parseVoiceCommand('!health')).toBeNull();
    expect(parseVoiceCommand('!status')).toBeNull();
    expect(parseVoiceCommand('!models')).toBeNull();
    expect(parseVoiceCommand('!voicex')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(parseVoiceCommand('')).toBeNull();
    expect(parseVoiceCommand('   ')).toBeNull();
  });

  it('handles non-string input gracefully', () => {
    expect(parseVoiceCommand(undefined as unknown as string)).toBeNull();
    expect(parseVoiceCommand(null as unknown as string)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// handleVoiceCommand
// ---------------------------------------------------------------------------

describe('handleVoiceCommand', () => {
  // Voice-disabled guard
  describe('voice-disabled guard', () => {
    it('returns disabled message for status when voice is off', async () => {
      const result = await handleVoiceCommand({ action: 'status' }, makeOpts({ voiceEnabled: false }));
      expect(result).toContain('disabled');
      expect(result).toContain('DISCOCLAW_VOICE_ENABLED');
    });

    it('returns disabled message for set when voice is off', async () => {
      const result = await handleVoiceCommand(
        { action: 'set', voice: 'aura-2-luna-en' },
        makeOpts({ voiceEnabled: false }),
      );
      expect(result).toContain('disabled');
    });

    it('returns disabled message for help when voice is off', async () => {
      const result = await handleVoiceCommand({ action: 'help' }, makeOpts({ voiceEnabled: false }));
      expect(result).toContain('disabled');
    });
  });

  // Status delegation
  describe('status', () => {
    it('delegates to renderVoiceStatusReport with the provided snapshot', async () => {
      const snapshot = makeSnapshot();
      const spy = vi.spyOn(voiceStatusCommand, 'renderVoiceStatusReport').mockReturnValue('```text\nstatus\n```');

      const result = await handleVoiceCommand({ action: 'status' }, makeOpts({ statusSnapshot: snapshot }));

      expect(spy).toHaveBeenCalledWith(snapshot, undefined);
      expect(result).toBe('```text\nstatus\n```');
      spy.mockRestore();
    });

    it('passes botDisplayName to renderVoiceStatusReport', async () => {
      const snapshot = makeSnapshot();
      const spy = vi.spyOn(voiceStatusCommand, 'renderVoiceStatusReport').mockReturnValue('```text\nok\n```');

      await handleVoiceCommand({ action: 'status' }, makeOpts({ statusSnapshot: snapshot, botDisplayName: 'MyBot' }));

      expect(spy).toHaveBeenCalledWith(snapshot, 'MyBot');
      spy.mockRestore();
    });

    it('returns unavailable message when statusSnapshot is not provided', async () => {
      const result = await handleVoiceCommand({ action: 'status' }, makeOpts({ statusSnapshot: undefined }));
      expect(result).toContain('unavailable');
    });
  });

  // Set — no active pipelines
  describe('set — no active pipelines', () => {
    it('updates deepgramTtsVoice in voiceConfig', async () => {
      const voiceConfig = { deepgramTtsVoice: 'aura-2-asteria-en' };
      await handleVoiceCommand(
        { action: 'set', voice: 'aura-2-luna-en' },
        makeOpts({ voiceConfig, activePipelineCount: 0 }),
      );
      expect(voiceConfig.deepgramTtsVoice).toBe('aura-2-luna-en');
    });

    it('does not call restartPipelines when activePipelineCount is 0', async () => {
      const restartPipelines = vi.fn().mockResolvedValue(undefined);
      await handleVoiceCommand(
        { action: 'set', voice: 'aura-2-luna-en' },
        makeOpts({ voiceConfig: {}, activePipelineCount: 0, restartPipelines }),
      );
      expect(restartPipelines).not.toHaveBeenCalled();
    });

    it('does not call restartPipelines when activePipelineCount is absent', async () => {
      const restartPipelines = vi.fn().mockResolvedValue(undefined);
      await handleVoiceCommand(
        { action: 'set', voice: 'aura-2-luna-en' },
        makeOpts({ voiceConfig: {}, restartPipelines }),
      );
      expect(restartPipelines).not.toHaveBeenCalled();
    });

    it('returns "will take effect on next pipeline start" message', async () => {
      const result = await handleVoiceCommand(
        { action: 'set', voice: 'aura-2-luna-en' },
        makeOpts({ voiceConfig: {}, activePipelineCount: 0 }),
      );
      expect(result).toContain('aura-2-luna-en');
      expect(result).toContain('next pipeline start');
    });
  });

  // Set — with active pipelines
  describe('set — with active pipelines', () => {
    it('calls restartPipelines when there is 1 active pipeline', async () => {
      const restartPipelines = vi.fn().mockResolvedValue(undefined);
      const voiceConfig = { deepgramTtsVoice: 'aura-2-asteria-en' };
      await handleVoiceCommand(
        { action: 'set', voice: 'aura-2-luna-en' },
        makeOpts({ voiceConfig, activePipelineCount: 1, restartPipelines }),
      );
      expect(restartPipelines).toHaveBeenCalledOnce();
    });

    it('returns "1 active pipeline restarted" message for a single pipeline', async () => {
      const restartPipelines = vi.fn().mockResolvedValue(undefined);
      const result = await handleVoiceCommand(
        { action: 'set', voice: 'aura-2-luna-en' },
        makeOpts({ voiceConfig: {}, activePipelineCount: 1, restartPipelines }),
      );
      expect(result).toContain('aura-2-luna-en');
      expect(result).toContain('1 active pipeline');
      expect(result).toContain('restarted');
    });

    it('returns "N active pipelines restarted" for multiple pipelines', async () => {
      const restartPipelines = vi.fn().mockResolvedValue(undefined);
      const result = await handleVoiceCommand(
        { action: 'set', voice: 'aura-2-luna-en' },
        makeOpts({ voiceConfig: {}, activePipelineCount: 3, restartPipelines }),
      );
      expect(result).toContain('3 active pipelines');
      expect(result).toContain('restarted');
    });

    it('still updates voiceConfig before restarting pipelines', async () => {
      const voiceConfig = { deepgramTtsVoice: 'aura-2-asteria-en' };
      const restartPipelines = vi.fn().mockResolvedValue(undefined);
      await handleVoiceCommand(
        { action: 'set', voice: 'aura-2-luna-en' },
        makeOpts({ voiceConfig, activePipelineCount: 2, restartPipelines }),
      );
      expect(voiceConfig.deepgramTtsVoice).toBe('aura-2-luna-en');
    });
  });

  // Set — non-deepgram provider
  describe('set — non-deepgram TTS provider', () => {
    it('returns error message naming the current provider', async () => {
      const result = await handleVoiceCommand(
        { action: 'set', voice: 'some-voice' },
        makeOpts({ ttsProvider: 'cartesia' }),
      );
      expect(result).toContain('deepgram');
      expect(result).toContain('cartesia');
    });

    it('does not modify voiceConfig when provider is not deepgram', async () => {
      const voiceConfig = { deepgramTtsVoice: 'original' };
      await handleVoiceCommand(
        { action: 'set', voice: 'new-voice' },
        makeOpts({ ttsProvider: 'openai', voiceConfig }),
      );
      expect(voiceConfig.deepgramTtsVoice).toBe('original');
    });
  });

  // Help
  describe('help', () => {
    it('returns help text mentioning all subcommands', async () => {
      const result = await handleVoiceCommand({ action: 'help' }, makeOpts());
      expect(result).toContain('!voice');
      expect(result).toContain('status');
      expect(result).toContain('set');
      expect(result).toContain('help');
    });

    it('includes example voice names', async () => {
      const result = await handleVoiceCommand({ action: 'help' }, makeOpts());
      expect(result).toContain('aura-2-asteria-en');
    });

    it('mentions the Deepgram provider requirement', async () => {
      const result = await handleVoiceCommand({ action: 'help' }, makeOpts());
      expect(result).toContain('Deepgram');
    });
  });
});
