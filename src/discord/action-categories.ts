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
