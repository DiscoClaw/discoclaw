/**
 * completeOnboarding — single owner of post-onboarding logic.
 *
 * Writes workspace files, optionally dispatches a morning check-in cron job,
 * and sends the outcome message to the user.
 */

import type { OnboardingValues } from '../onboarding/onboarding-flow.js';
import { writeWorkspaceFiles } from '../onboarding/onboarding-writer.js';
import type { WriteResult } from '../onboarding/onboarding-writer.js';
import { executeCronAction } from './actions-crons.js';
import type { CronContext } from './actions-crons.js';
import type { ActionContext, DiscordActionResult } from './actions.js';
import type { LoggerLike } from '../logging/logger-like.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal send interface — matches both DM User and guild TextBasedChannel. */
export type SendTarget = {
  send(options: { content: string; allowedMentions?: { parse: string[] } }): Promise<unknown>;
};

/** Config required to dispatch the morning check-in cron after onboarding. */
export type CronDispatchConfig = {
  cronCtx: CronContext;
  actionCtx: ActionContext;
  log?: LoggerLike;
};

export type CompleteOnboardingResult = {
  writeResult: WriteResult;
  cronResult?: DiscordActionResult;
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const NO_MENTIONS = { parse: [] as string[] };

/**
 * Complete the onboarding flow: write workspace files, optionally create the
 * morning check-in cron, and send a summary message to the user.
 *
 * Cron dispatch failure is logged but does not fail onboarding.
 */
export async function completeOnboarding(
  values: OnboardingValues,
  workspaceCwd: string,
  sendTarget: SendTarget,
  cronDispatch?: CronDispatchConfig,
): Promise<CompleteOnboardingResult> {
  const writeResult = await writeWorkspaceFiles(values, workspaceCwd);

  if (writeResult.errors.length > 0) {
    const errorSummary = writeResult.errors.join('; ');
    await sendTarget.send({
      content:
        `Something went wrong writing your files: ${errorSummary}\n` +
        `Type **retry** to try again, pick a number to edit a field, or \`!cancel\` to give up.`,
      allowedMentions: NO_MENTIONS,
    });
    return { writeResult };
  }

  let cronResult: DiscordActionResult | undefined;

  if (values.morningCheckin && cronDispatch) {
    try {
      cronResult = await executeCronAction(
        {
          type: 'cronCreate',
          name: 'Morning Check-in',
          schedule: '0 8 * * *',
          timezone: values.timezone,
          channel: cronDispatch.actionCtx.channelId,
          prompt: 'Good morning! Time for your daily check-in.',
        },
        cronDispatch.actionCtx,
        cronDispatch.cronCtx,
      );
    } catch (err) {
      cronDispatch.log?.warn({ err }, 'onboarding:cron-dispatch failed');
      cronResult = { ok: false, error: String(err) };
    }
  }

  const warnings = writeResult.warnings.length > 0
    ? `\n\n${writeResult.warnings.join('\n')}`
    : '';

  await sendTarget.send({
    content: `All set! I've written your **IDENTITY.md** and **USER.md**. I'm ready to go.${warnings}`,
    allowedMentions: NO_MENTIONS,
  });

  return { writeResult, cronResult };
}
