import { describe, expect, it } from 'vitest';
import { parseVoiceStatusCommand, renderVoiceStatusReport } from './voice-status-command.js';
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

describe('parseVoiceStatusCommand', () => {
  it('parses !voice status case-insensitively', () => {
    expect(parseVoiceStatusCommand('!voice status')).toBe(true);
    expect(parseVoiceStatusCommand('!VOICE STATUS')).toBe(true);
  });

  it('rejects non-status commands', () => {
    expect(parseVoiceStatusCommand('!voice')).toBeNull();
    expect(parseVoiceStatusCommand('!health')).toBeNull();
  });
});

describe('renderVoiceStatusReport', () => {
  it('renders Gemini Live provider details', () => {
    const out = renderVoiceStatusReport(makeSnapshot());
    expect(out).toContain('Provider: gemini-live (key: set, model: gemini-2.5-pro)');
    expect(out).toContain('Home channel: voice-home');
  });

  it('renders missing Gemini key and active connections', () => {
    const out = renderVoiceStatusReport(makeSnapshot({
      geminiKeySet: false,
      connections: [{ guildId: 'g1', channelId: 'vc1', state: 'ready', selfMute: false, selfDeaf: false }],
    }));
    expect(out).toContain('Provider: gemini-live (key: MISSING');
    expect(out).toContain('Connections (1):');
    expect(out).toContain('guild=g1: channel=vc1, state=ready, mute=false, deaf=false');
  });
});
