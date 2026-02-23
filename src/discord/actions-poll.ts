import type { DiscordActionResult, ActionContext } from './actions.js';
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

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export async function executePollAction(
  action: PollActionRequest,
  ctx: ActionContext,
): Promise<DiscordActionResult> {
  const { guild } = ctx;

  const channel = resolveChannel(guild, action.channel);
  if (!channel) return { ok: false, error: `Channel "${action.channel}" not found` };
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
