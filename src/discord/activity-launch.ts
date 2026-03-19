import type { ButtonInteraction } from 'discord.js';

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
      body: JSON.stringify({ type: 12 }),
    },
  );

  if (response.ok) return;

  const body = await response.text().catch(() => '');
  throw new Error(`LAUNCH_ACTIVITY callback failed (${response.status}): ${body || response.statusText}`);
}
