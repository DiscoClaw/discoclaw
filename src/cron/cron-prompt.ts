// ---------------------------------------------------------------------------
// Cron system prompt builder
// ---------------------------------------------------------------------------
// Composable function that assembles the cron-specific prompt body from
// per-job config flags. Callers prepend ROOT_POLICY + PA file context via
// buildPromptPreamble() from prompt-common.ts before passing to the runtime.
// ---------------------------------------------------------------------------

export type CronRoutingMode = 'json';

export type CronPromptInput = {
  jobName: string;
  /** Raw prompt text — may contain {{channel}} and {{channelId}} placeholders. */
  promptTemplate: string;
  /** Target channel name (e.g. "general"). */
  channel: string;
  /** Target channel snowflake ID — substituted for {{channelId}} placeholders. */
  channelId?: string;
  /** When true, append a sentinel instruction so the AI signals idle runs. */
  silent?: boolean;
  /**
   * When 'json', instruct the AI to return a JSON array of {channel, content}
   * objects instead of prose or discord-action XML.
   */
  routingMode?: CronRoutingMode;
  /** Additional channels the AI may route to in json routing mode. */
  availableChannels?: Array<{ name: string; id: string }>;
  /** Persistent key-value state from the previous run. */
  state?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Placeholder expansion
// ---------------------------------------------------------------------------

/**
 * Expand {{channel}} and {{channelId}} placeholders in a cron prompt template.
 * All occurrences are replaced; unrecognized placeholders are left intact.
 */
export function expandCronPlaceholders(
  text: string,
  channel: string,
  channelId: string,
  state?: Record<string, unknown>,
): string {
  const stateJson = JSON.stringify(state ?? {});
  return text
    .replaceAll('{{channel}}', channel)
    .replaceAll('{{channelId}}', channelId)
    .replaceAll('{{state}}', stateJson);
}

// ---------------------------------------------------------------------------
// Prompt body builder
// ---------------------------------------------------------------------------

/**
 * Build the cron-specific prompt body — everything that follows ROOT_POLICY
 * and the inlined PA / context files.
 *
 * Handles:
 *  - {{channel}} / {{channelId}} placeholder expansion in promptTemplate
 *  - Routing mode format instructions (default prose vs. JSON array)
 *  - Channel metadata injection for json routing mode
 *  - Silent-mode sentinel instruction
 */
export function buildCronPromptBody(input: CronPromptInput): string {
  const {
    jobName,
    promptTemplate,
    channel,
    channelId = '',
    silent,
    routingMode,
    availableChannels,
    state,
  } = input;

  const expandedPrompt = expandCronPlaceholders(promptTemplate, channel, channelId, state);

  const segments: string[] = [
    `You are executing a scheduled cron job named "${jobName}".`,
    `Instruction: ${expandedPrompt}`,
  ];

  if (routingMode === 'json') {
    segments.push(buildJsonRoutingSection(channel, channelId || undefined, availableChannels));
    if (silent) {
      segments.push(
        'IMPORTANT: If there is nothing actionable to report, respond with exactly `[]` and nothing else.',
      );
    }
  } else {
    segments.push(
      `Your output will be posted automatically to the Discord channel #${channel}. ` +
        `Do NOT explain how to post or suggest using bots/webhooks — just write the message content directly. ` +
        `Keep your response concise and focused on the instruction above.`,
    );
    if (silent) {
      segments.push(
        'IMPORTANT: If there is nothing actionable to report, respond with exactly `HEARTBEAT_OK` and nothing else.',
      );
    }
  }

  // Inject persistent state section when state is present and non-empty.
  if (state && Object.keys(state).length > 0) {
    const STATE_CHAR_LIMIT = 4000;
    let serialized = JSON.stringify(state, null, 2);
    if (serialized.length > STATE_CHAR_LIMIT) {
      serialized = serialized.slice(0, STATE_CHAR_LIMIT) + '\n... (state truncated)';
    }
    segments.push(
      [
        '## Persistent State',
        '',
        'The following state was persisted from your previous run:',
        '```json',
        serialized,
        '```',
        'If you need to update the persisted state for the next run, emit a `<cron-state>{...}</cron-state>` block ' +
          'containing a JSON object with the full updated state. The emitted object fully replaces the existing state — include all keys you want to keep. Only emit this block if the state needs to change.',
      ].join('\n'),
    );
  }

  return segments.join('\n\n');
}

// ---------------------------------------------------------------------------
// JSON routing section
// ---------------------------------------------------------------------------

function buildJsonRoutingSection(
  channel: string,
  channelId: string | undefined,
  availableChannels?: Array<{ name: string; id: string }>,
): string {
  const defaultEntry = channelId ? `#${channel} (ID: ${channelId})` : `#${channel}`;

  const extraEntries = (availableChannels ?? [])
    .filter((c) => c.name !== channel)
    .map((c) => `#${c.name} (ID: ${c.id})`);

  const channelList = [defaultEntry, ...extraEntries].join(', ');

  return [
    'Respond with a JSON array of routing objects. Each object must have:',
    '  "channel": target channel name or ID (string)',
    '  "content": message text to post (string)',
    '',
    `Available channels: ${channelList}`,
    '',
    'Return [] if there is nothing to post. Do NOT wrap the JSON in code fences.',
  ].join('\n');
}
