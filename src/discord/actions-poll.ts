import { ChannelType, PermissionFlagsBits } from 'discord.js';
import type { DiscordActionResult, ActionContext, RequesterDenyAll, RequesterMemberContext } from './actions.js';
import { resolveChannel } from './action-utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PollActionRequest = {
  type: 'poll';
  channel: string;
  question: string;
  answers: string[];
  allowMultiselect?: boolean;
  durationHours?: number;
};

const POLL_TYPE_MAP: Record<PollActionRequest['type'], true> = { poll: true };
export const POLL_ACTION_TYPES = new Set<string>(Object.keys(POLL_TYPE_MAP));

type PollSendTarget = {
  send(payload: {
    poll: {
      question: { text: string };
      answers: Array<{ text: string }>;
      allowMultiselect: boolean;
      duration: number;
    };
  }): Promise<unknown>;
};

function isRequesterDenyAll(
  requesterMember: RequesterMemberContext,
): requesterMember is RequesterDenyAll {
  return Boolean(requesterMember && typeof requesterMember === 'object' && '__requesterDenyAll' in requesterMember);
}

function permissionDenied(): DiscordActionResult {
  return { ok: false, error: 'Permission denied for poll' };
}

function threadSendPermissionFor(channelType: ChannelType | undefined): bigint {
  return (
    channelType === ChannelType.PublicThread
    || channelType === ChannelType.PrivateThread
    || channelType === ChannelType.AnnouncementThread
  )
    ? PermissionFlagsBits.SendMessagesInThreads
    : PermissionFlagsBits.SendMessages;
}

function requesterHasChannelPermissions(
  channel: unknown,
  requesterMember: Exclude<RequesterMemberContext, RequesterDenyAll | undefined>,
  permissions: bigint,
): boolean {
  if (!channel || typeof channel !== 'object') return false;
  if (!('permissionsFor' in channel) || typeof channel.permissionsFor !== 'function') return false;
  const resolved = channel.permissionsFor(requesterMember);
  return Boolean(resolved?.has?.(permissions));
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export async function executePollAction(
  action: PollActionRequest,
  ctx: ActionContext,
  requesterMember?: RequesterMemberContext,
): Promise<DiscordActionResult> {
  const { guild } = ctx;
  if (isRequesterDenyAll(requesterMember)) {
    return permissionDenied();
  }
  const enforcingRequester = requesterMember && !isRequesterDenyAll(requesterMember)
    ? requesterMember
    : undefined;

  const channel = resolveChannel(guild, action.channel);
  if (!channel) return { ok: false, error: `Channel "${action.channel}" not found` };
  if (enforcingRequester && !requesterHasChannelPermissions(
    channel,
    enforcingRequester,
    PermissionFlagsBits.ViewChannel | threadSendPermissionFor(channel.type),
  )) {
    return permissionDenied();
  }
  const pollTarget = channel as unknown as PollSendTarget;

  const pollAnswers = action.answers.map((text) => ({ text }));

  await pollTarget.send({
    poll: {
      question: { text: action.question },
      answers: pollAnswers,
      allowMultiselect: action.allowMultiselect ?? false,
      duration: action.durationHours ?? 24,
    },
  });

  return { ok: true, summary: `Created poll "${action.question}" in #${channel.name} with ${action.answers.length} options` };
}

// ---------------------------------------------------------------------------
// Prompt section
// ---------------------------------------------------------------------------

export function pollActionsPromptSection(): string {
  return `### Polls

**poll** — Create a poll in a channel:
\`\`\`
<discord-action>{"type":"poll","channel":"#general","question":"What should we do?","answers":["Option A","Option B","Option C"],"allowMultiselect":false,"durationHours":24}</discord-action>
\`\`\`
- \`channel\` (required): Channel name or ID.
- \`question\` (required): Poll question text.
- \`answers\` (required): Array of answer strings (2–10 options).
- \`allowMultiselect\` (optional): Allow multiple selections. Default: false.
- \`durationHours\` (optional): Poll duration in hours. Default: 24.`;
}
