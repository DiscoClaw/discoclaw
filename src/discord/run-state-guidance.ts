import { isRunActiveInChannel } from './forge-plan-registry.js';

const NO_ACTIVE_RUN_GUIDANCE =
  'Tracked forge/plan run state: there is no active forge or plan run in this channel right now. ' +
  'Treat earlier progress messages as historical. Do not claim that work is currently running, auditing, being handled, or still in progress. ' +
  'If you are not emitting a Discord action or starting a tracked run in this response, do not say you are proceeding now, already handling it, or taking the next pass now. Say clearly that you have not started yet. ' +
  'If the user is asking for status, say the last run already ended, summarize the recorded result visible in the thread, or ask them to explicitly resume.';

const ACTIVE_RUN_GUIDANCE =
  'Tracked forge/plan run state: a forge or plan run is currently active in this channel. ' +
  'Only describe live work when it matches the visible thread context, and do not invent progress details.';

export function buildRunStateGuidance(channelId: string): string {
  return isRunActiveInChannel(channelId)
    ? ACTIVE_RUN_GUIDANCE
    : NO_ACTIVE_RUN_GUIDANCE;
}
