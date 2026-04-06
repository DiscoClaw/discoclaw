import { describe, expect, it } from 'vitest';
import { handleVoiceCommand, parseVoiceCommand } from './voice-command.js';
import type { VoiceCommandOpts } from './voice-command.js';
import type { VoiceStatusSnapshot } from './voice-status-command.js';

function makeSnapshot(overrides: Partial<VoiceStatusSnapshot> = {}): VoiceStatusSnapshot {
  return {
    enabled: true,
    provider: 'gemini-live',
    geminiKeySet: true,
    model: 'gemini-2.5-pro',
    homeChannel: 'voice-home',
    autoJoin: false,
    actionsEnabled: true,
    connections: [],
    ...overrides,
  };
}

function makeOpts(overrides: Partial<VoiceCommandOpts> = {}): VoiceCommandOpts {
  return {
    voiceEnabled: true,
    statusSnapshot: makeSnapshot(),
    ...overrides,
  };
}

describe('parseVoiceCommand', () => {
  it('supports bare, status, and help forms', () => {
    expect(parseVoiceCommand('!voice')).toEqual({ action: 'status' });
    expect(parseVoiceCommand('!voice status')).toEqual({ action: 'status' });
    expect(parseVoiceCommand('!voice help')).toEqual({ action: 'help' });
  });

  it('rejects removed set subcommand', () => {
    expect(parseVoiceCommand('!voice set aura-2-luna-en')).toBeNull();
  });
});

describe('handleVoiceCommand', () => {
  it('returns disabled message when voice is off', async () => {
    const result = await handleVoiceCommand({ action: 'status' }, makeOpts({ voiceEnabled: false }));
    expect(result).toContain('Voice is disabled');
  });

  it('renders status when snapshot is present', async () => {
    const result = await handleVoiceCommand({ action: 'status' }, makeOpts());
    expect(result).toContain('Provider: gemini-live');
  });

  it('returns Gemini-only help text', async () => {
    const result = await handleVoiceCommand({ action: 'help' }, makeOpts());
    expect(result).toContain('Gemini Live only');
    expect(result).not.toContain('!voice set');
  });
});
