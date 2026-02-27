// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VoiceConnectionEntry = {
  guildId: string;
  channelId: string;
  state: string;
  selfMute: boolean;
  selfDeaf: boolean;
};

export type VoiceStatusSnapshot = {
  enabled: boolean;
  sttProvider: string;
  ttsProvider: string;
  homeChannel?: string;
  deepgramKeySet: boolean;
  cartesiaKeySet: boolean;
  autoJoin: boolean;
  actionsEnabled: boolean;
  connections: VoiceConnectionEntry[];
};

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export function parseVoiceStatusCommand(content: string): true | null {
  const normalized = String(content ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (normalized === '!voice status') return true;
  return null;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export function renderVoiceStatusReport(
  snapshot: VoiceStatusSnapshot,
  botDisplayName = 'Discoclaw',
): string {
  const lines: string[] = [];

  lines.push(`${botDisplayName} Voice Status`);
  lines.push(`Voice: ${snapshot.enabled ? 'enabled' : 'disabled'}`);

  // STT
  if (snapshot.sttProvider === 'deepgram') {
    const keyLabel = snapshot.deepgramKeySet ? 'key: set' : 'key: MISSING';
    lines.push(`STT: ${snapshot.sttProvider} (${keyLabel})`);
  } else {
    lines.push(`STT: ${snapshot.sttProvider}`);
  }

  // TTS
  if (snapshot.ttsProvider === 'deepgram') {
    const keyLabel = snapshot.deepgramKeySet ? 'key: set' : 'key: MISSING';
    lines.push(`TTS: ${snapshot.ttsProvider} (${keyLabel})`);
  } else if (snapshot.ttsProvider === 'cartesia') {
    const keyLabel = snapshot.cartesiaKeySet ? 'key: set' : 'key: MISSING';
    lines.push(`TTS: ${snapshot.ttsProvider} (${keyLabel})`);
  } else {
    lines.push(`TTS: ${snapshot.ttsProvider}`);
  }

  lines.push(`Home channel: ${snapshot.homeChannel ?? '(not set)'}`);
  lines.push(`Auto-join: ${snapshot.autoJoin ? 'on' : 'off'}`);
  lines.push(`Actions: ${snapshot.actionsEnabled ? 'enabled' : 'disabled'}`);

  // Connections
  if (snapshot.connections.length === 0) {
    lines.push('Connections: none');
  } else {
    lines.push(`Connections (${snapshot.connections.length}):`);
    for (const conn of snapshot.connections) {
      lines.push(
        `  guild=${conn.guildId}: channel=${conn.channelId}, state=${conn.state}, mute=${conn.selfMute}, deaf=${conn.selfDeaf}`,
      );
    }
  }

  return `\`\`\`text\n${lines.join('\n')}\n\`\`\``;
}
