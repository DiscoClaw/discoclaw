import { describe, expect, it } from 'vitest';
import {
  parseVoiceStatusCommand,
  renderVoiceStatusReport,
} from './voice-status-command.js';
import type { VoiceStatusSnapshot } from './voice-status-command.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSnapshot(overrides: Partial<VoiceStatusSnapshot> = {}): VoiceStatusSnapshot {
  return {
    enabled: true,
    sttProvider: 'deepgram',
    ttsProvider: 'cartesia',
    homeChannel: 'voice-home',
    deepgramKeySet: true,
    cartesiaKeySet: true,
    autoJoin: false,
    actionsEnabled: true,
    connections: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseVoiceStatusCommand
// ---------------------------------------------------------------------------

describe('parseVoiceStatusCommand', () => {
  it('returns true for !voice status', () => {
    expect(parseVoiceStatusCommand('!voice status')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(parseVoiceStatusCommand('!VOICE STATUS')).toBe(true);
    expect(parseVoiceStatusCommand('!Voice Status')).toBe(true);
  });

  it('trims surrounding whitespace', () => {
    expect(parseVoiceStatusCommand('  !voice status  ')).toBe(true);
  });

  it('collapses extra internal whitespace', () => {
    expect(parseVoiceStatusCommand('!voice  status')).toBe(true);
  });

  it('returns null for non-matching commands', () => {
    expect(parseVoiceStatusCommand('!voice')).toBeNull();
    expect(parseVoiceStatusCommand('!voice join')).toBeNull();
    expect(parseVoiceStatusCommand('!status')).toBeNull();
    expect(parseVoiceStatusCommand('!health')).toBeNull();
    expect(parseVoiceStatusCommand('')).toBeNull();
  });

  it('handles non-string input gracefully', () => {
    expect(parseVoiceStatusCommand(undefined as any)).toBeNull();
    expect(parseVoiceStatusCommand(null as any)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// renderVoiceStatusReport
// ---------------------------------------------------------------------------

describe('renderVoiceStatusReport', () => {
  it('renders voice enabled', () => {
    const out = renderVoiceStatusReport(makeSnapshot({ enabled: true }));
    expect(out).toContain('Voice: enabled');
  });

  it('renders voice disabled', () => {
    const out = renderVoiceStatusReport(makeSnapshot({ enabled: false }));
    expect(out).toContain('Voice: disabled');
  });

  it('renders STT deepgram with key set', () => {
    const out = renderVoiceStatusReport(makeSnapshot({ sttProvider: 'deepgram', deepgramKeySet: true }));
    expect(out).toContain('STT: deepgram (key: set)');
  });

  it('renders STT deepgram with missing key', () => {
    const out = renderVoiceStatusReport(makeSnapshot({ sttProvider: 'deepgram', deepgramKeySet: false }));
    expect(out).toContain('STT: deepgram (key: MISSING)');
  });

  it('renders STT non-deepgram provider without key info', () => {
    const out = renderVoiceStatusReport(makeSnapshot({ sttProvider: 'openai' }));
    expect(out).toContain('STT: openai');
    expect(out).not.toContain('STT: openai (');
  });

  it('renders TTS cartesia with key set', () => {
    const out = renderVoiceStatusReport(makeSnapshot({ ttsProvider: 'cartesia', cartesiaKeySet: true }));
    expect(out).toContain('TTS: cartesia (key: set)');
  });

  it('renders TTS cartesia with missing key', () => {
    const out = renderVoiceStatusReport(makeSnapshot({ ttsProvider: 'cartesia', cartesiaKeySet: false }));
    expect(out).toContain('TTS: cartesia (key: MISSING)');
  });

  it('renders TTS deepgram with key set', () => {
    const out = renderVoiceStatusReport(makeSnapshot({ ttsProvider: 'deepgram', deepgramKeySet: true }));
    expect(out).toContain('TTS: deepgram (key: set)');
  });

  it('renders TTS deepgram with missing key', () => {
    const out = renderVoiceStatusReport(makeSnapshot({ ttsProvider: 'deepgram', deepgramKeySet: false }));
    expect(out).toContain('TTS: deepgram (key: MISSING)');
  });

  it('renders TTS non-cartesia non-deepgram provider without key info', () => {
    const out = renderVoiceStatusReport(makeSnapshot({ ttsProvider: 'openai' }));
    expect(out).toContain('TTS: openai');
    expect(out).not.toContain('TTS: openai (');
  });

  it('renders home channel when set', () => {
    const out = renderVoiceStatusReport(makeSnapshot({ homeChannel: 'voice-home' }));
    expect(out).toContain('Home channel: voice-home');
  });

  it('renders home channel as (not set) when absent', () => {
    const out = renderVoiceStatusReport(makeSnapshot({ homeChannel: undefined }));
    expect(out).toContain('Home channel: (not set)');
  });

  it('renders auto-join on', () => {
    const out = renderVoiceStatusReport(makeSnapshot({ autoJoin: true }));
    expect(out).toContain('Auto-join: on');
  });

  it('renders auto-join off', () => {
    const out = renderVoiceStatusReport(makeSnapshot({ autoJoin: false }));
    expect(out).toContain('Auto-join: off');
  });

  it('renders actions enabled', () => {
    const out = renderVoiceStatusReport(makeSnapshot({ actionsEnabled: true }));
    expect(out).toContain('Actions: enabled');
  });

  it('renders actions disabled', () => {
    const out = renderVoiceStatusReport(makeSnapshot({ actionsEnabled: false }));
    expect(out).toContain('Actions: disabled');
  });

  it('renders Connections: none when no active connections', () => {
    const out = renderVoiceStatusReport(makeSnapshot({ connections: [] }));
    expect(out).toContain('Connections: none');
  });

  it('renders connection list with count and details', () => {
    const snap = makeSnapshot({
      connections: [
        { guildId: 'g1', channelId: 'vc1', state: 'ready', selfMute: false, selfDeaf: false },
        { guildId: 'g2', channelId: 'vc2', state: 'connecting', selfMute: true, selfDeaf: true },
      ],
    });
    const out = renderVoiceStatusReport(snap);
    expect(out).toContain('Connections (2):');
    expect(out).toContain('guild=g1: channel=vc1, state=ready, mute=false, deaf=false');
    expect(out).toContain('guild=g2: channel=vc2, state=connecting, mute=true, deaf=true');
  });

  it('uses custom bot display name', () => {
    const out = renderVoiceStatusReport(makeSnapshot(), 'MyBot');
    expect(out).toContain('MyBot Voice Status');
    expect(out).not.toContain('Discoclaw Voice Status');
  });

  it('defaults to Discoclaw when no name provided', () => {
    const out = renderVoiceStatusReport(makeSnapshot());
    expect(out).toContain('Discoclaw Voice Status');
  });

  it('wraps output in a fenced text code block', () => {
    const out = renderVoiceStatusReport(makeSnapshot());
    expect(out).toMatch(/^```text\n/);
    expect(out).toMatch(/\n```$/);
  });
});
