import type { ButtonInteraction } from 'discord.js';

// Discord interaction callback type 12 launches the app's associated Activity.
const INTERACTION_CALLBACK_TYPE_LAUNCH_ACTIVITY = 12;

type DiscordApiErrorBody = {
  message?: unknown;
  code?: unknown;
};

export class LaunchActivityError extends Error {
  readonly status: number;
  readonly bodyText: string;
  readonly discordCode: number | null;
  readonly discordMessage: string | null;

  constructor(input: { status: number; bodyText: string; statusText: string }) {
    const parsed = parseDiscordApiError(input.bodyText);
    const details = parsed.message ?? (input.bodyText || input.statusText);
    super(`LAUNCH_ACTIVITY callback failed (${input.status}): ${details}`);
    this.name = 'LaunchActivityError';
    this.status = input.status;
    this.bodyText = input.bodyText;
    this.discordCode = parsed.code;
    this.discordMessage = parsed.message;
  }
}

function parseDiscordApiError(bodyText: string): { code: number | null; message: string | null } {
  if (!bodyText) return { code: null, message: null };
  try {
    const parsed = JSON.parse(bodyText) as DiscordApiErrorBody;
    return {
      code: typeof parsed.code === 'number' ? parsed.code : null,
      message: typeof parsed.message === 'string' ? parsed.message : null,
    };
  } catch {
    return { code: null, message: null };
  }
}

export async function respondWithLaunchActivity(
  interaction: Pick<ButtonInteraction, 'id' | 'token'>,
): Promise<void> {
  const response = await fetch(
    `https://discord.com/api/v10/interactions/${interaction.id}/${interaction.token}/callback`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type: INTERACTION_CALLBACK_TYPE_LAUNCH_ACTIVITY }),
    },
  );

  if (response.ok) return;

  const body = await response.text().catch(() => '');
  throw new LaunchActivityError({
    status: response.status,
    bodyText: body,
    statusText: response.statusText,
  });
}
