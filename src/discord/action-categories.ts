// Action types that return data Claude likely wants to process (read-only queries).
// When any of these succeed, the auto-follow-up loop re-invokes Claude with the results.
export const QUERY_ACTION_TYPES: ReadonlySet<string> = new Set([
  // Channels
  'channelList',
  'channelInfo',
  'threadListArchived',
  'forumTagList',
  // Messaging
  'readMessages',
  'fetchMessage',
  'listPins',
  // Guild
  'memberInfo',
  'roleInfo',
  'searchMessages',
  'eventList',
  // Tasks
  'taskList',
  'taskShow',
  // Crons
  'cronList',
  'cronShow',
  // Plans
  'planList',
  'planShow',
  // Memory
  'memoryShow',
  // Config
  'modelShow',
  // Forge
  'forgeStatus',
  // Voice
  'voiceStatus',
  // Spawn
  'spawnAgent',
]);

export function hasQueryAction(actionTypes: string[]): boolean {
  return actionTypes.some((t) => QUERY_ACTION_TYPES.has(t));
}

/**
 * Returns true when a follow-up AI invocation should be triggered:
 * - any query action succeeded (to process returned data), OR
 * - any non-query action failed (so the bot can explain the failure).
 *
 * Query action failures are excluded because there is no useful result data
 * to analyse.
 */
export function shouldTriggerFollowUp(
  actions: { type: string }[],
  results: { ok: boolean }[],
): boolean {
  const anyQuerySucceeded = actions.some(
    (a, i) => QUERY_ACTION_TYPES.has(a.type) && results[i]?.ok,
  );
  if (anyQuerySucceeded) return true;

  const anyNonQueryActionFailed = results.some(
    (r, i) => r && !r.ok && !QUERY_ACTION_TYPES.has(actions[i]?.type ?? ''),
  );
  return anyNonQueryActionFailed;
}

/**
 * Returns true when the follow-up was triggered exclusively by a non-query
 * action failure — i.e. no query action succeeded in this round.
 *
 * Use this to select a failure-specific placeholder message and prompt suffix
 * rather than the generic "following up..." variants.
 */
export function isFailureFollowUp(
  actions: { type: string }[],
  results: { ok: boolean }[],
): boolean {
  const anyQuerySucceeded = actions.some(
    (a, i) => QUERY_ACTION_TYPES.has(a.type) && results[i]?.ok,
  );
  if (anyQuerySucceeded) return false;
  return results.some(
    (r, i) => r && !r.ok && !QUERY_ACTION_TYPES.has(actions[i]?.type ?? ''),
  );
}

/**
 * Returns the follow-up prompt suffix to append to the [Auto-follow-up] message.
 *
 * For failure follow-ups, instructs the AI to report the outcome explicitly
 * so the user always learns whether the retry succeeded or failed.
 * For query follow-ups, prompts continued analysis of the returned data.
 */
export function followUpPromptSuffix(isFailure: boolean): string {
  if (isFailure) {
    return `One or more actions failed. If you retry, explicitly tell the user what failed and whether the retry succeeded or failed. Do not announce success before the action confirms it.`;
  }
  return `Continue your analysis based on these results. If you need additional information, you may emit further query actions.`;
}
