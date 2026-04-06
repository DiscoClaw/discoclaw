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
  provider: 'gemini-live';
  geminiKeySet: boolean;
  model?: string;
  homeChannel?: string;
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
  const keyLabel = snapshot.geminiKeySet ? 'key: set' : 'key: MISSING';
  const modelLabel = snapshot.model ? `, model: ${snapshot.model}` : '';
  lines.push(`Provider: ${snapshot.provider} (${keyLabel}${modelLabel})`);
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
