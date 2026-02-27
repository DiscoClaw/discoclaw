import { ChannelType } from 'discord.js';
import type { Guild, GuildBasedChannel } from 'discord.js';
import type { DiscordActionResult, ActionContext } from './actions.js';
import type { VoiceConnectionManager } from '../voice/connection-manager.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VoiceActionRequest =
  | { type: 'voiceJoin'; channel: string }
  | { type: 'voiceLeave'; guildId?: string }
  | { type: 'voiceStatus' }
  | { type: 'voiceMute'; mute: boolean }
  | { type: 'voiceDeafen'; deafen: boolean };

const VOICE_TYPE_MAP: Record<VoiceActionRequest['type'], true> = {
  voiceJoin: true, voiceLeave: true, voiceStatus: true,
  voiceMute: true, voiceDeafen: true,
};
export const VOICE_ACTION_TYPES = new Set<string>(Object.keys(VOICE_TYPE_MAP));

export type VoiceContext = {
  voiceManager: VoiceConnectionManager;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isVoiceChannel(ch: GuildBasedChannel): boolean {
  return ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice;
}

/**
 * Resolve a voice channel by name or ID. Accepts GuildVoice and GuildStageVoice.
 */
export function resolveVoiceChannel(guild: Guild, ref: string): GuildBasedChannel | undefined {
  const cleaned = ref.replace(/^#/, '').trim();
  if (!cleaned) return undefined;

  // Try by ID first.
  const byId = guild.channels.cache.get(cleaned);
  if (byId) {
    return isVoiceChannel(byId) ? byId : undefined;
  }

  // Try by name (case-insensitive).
  return guild.channels.cache.find(
    (ch) => isVoiceChannel(ch) && ch.name.toLowerCase() === cleaned.toLowerCase(),
  );
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export async function executeVoiceAction(
  action: VoiceActionRequest,
  ctx: ActionContext,
  voiceCtx: VoiceContext,
): Promise<DiscordActionResult> {
  const { guild } = ctx;
  const { voiceManager } = voiceCtx;

  switch (action.type) {
    case 'voiceJoin': {
      const channel = resolveVoiceChannel(guild, action.channel);
      if (!channel) {
        return { ok: false, error: `Voice channel "${action.channel}" not found` };
      }

      voiceManager.join({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
      });

      return { ok: true, summary: `Joined voice channel #${channel.name}` };
    }

    case 'voiceLeave': {
      const guildId = action.guildId ?? guild.id;
      const state = voiceManager.getState(guildId);
      if (!state) {
        return { ok: true, summary: 'No active voice connection to leave' };
      }

      voiceManager.leave(guildId);
      return { ok: true, summary: `Left voice channel in guild ${guildId}` };
    }

    case 'voiceStatus': {
      const state = voiceManager.getState(guild.id);
      if (!state) {
        return { ok: true, summary: 'No active voice connections' };
      }

      const connection = voiceManager.getConnection(guild.id);
      const channelId = connection?.joinConfig?.channelId ?? 'unknown';
      return {
        ok: true,
        summary: `Voice connection: channel=${channelId}, state=${state}`,
      };
    }

    case 'voiceMute': {
      const connection = voiceManager.getConnection(guild.id);
      if (!connection) {
        return { ok: false, error: 'No active voice connection — join a channel first' };
      }

      const config = connection.joinConfig;
      connection.rejoin({
        ...config,
        channelId: config.channelId!,
        selfMute: action.mute,
      });

      return { ok: true, summary: `${action.mute ? 'Muted' : 'Unmuted'} in voice channel` };
    }

    case 'voiceDeafen': {
      const connection = voiceManager.getConnection(guild.id);
      if (!connection) {
        return { ok: false, error: 'No active voice connection — join a channel first' };
      }

      const config = connection.joinConfig;
      connection.rejoin({
        ...config,
        channelId: config.channelId!,
        selfDeaf: action.deafen,
      });

      return { ok: true, summary: `${action.deafen ? 'Deafened' : 'Undeafened'} in voice channel` };
    }
  }
}

// ---------------------------------------------------------------------------
// Prompt section
// ---------------------------------------------------------------------------

export function voiceActionsPromptSection(): string {
  return `### Voice Session Control

**voiceJoin** — Join a voice channel:
\`\`\`
<discord-action>{"type":"voiceJoin","channel":"voice-chat"}</discord-action>
\`\`\`
- \`channel\` (required): Voice channel name or ID. Accepts voice and stage channels.

**voiceLeave** — Leave the current voice channel:
\`\`\`
<discord-action>{"type":"voiceLeave"}</discord-action>
\`\`\`
- \`guildId\` (optional): Guild to leave. Defaults to the current guild.

**voiceStatus** — Check current voice connection status:
\`\`\`
<discord-action>{"type":"voiceStatus"}</discord-action>
\`\`\`

**voiceMute** — Mute or unmute the bot in voice:
\`\`\`
<discord-action>{"type":"voiceMute","mute":true}</discord-action>
\`\`\`
- \`mute\` (required): \`true\` to mute, \`false\` to unmute.

**voiceDeafen** — Deafen or undeafen the bot in voice:
\`\`\`
<discord-action>{"type":"voiceDeafen","deafen":true}</discord-action>
\`\`\`
- \`deafen\` (required): \`true\` to deafen, \`false\` to undeafen.`;
}
