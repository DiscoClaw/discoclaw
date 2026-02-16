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
  // Beads
  'beadList',
  'beadShow',
  // Crons
  'cronList',
  'cronShow',
  // Forge
  'forgeStatus',
  // Plans
  'planList',
  'planShow',
  // Memory
  'memoryShow',
]);

export function hasQueryAction(actionTypes: string[]): boolean {
  return actionTypes.some((t) => QUERY_ACTION_TYPES.has(t));
}
