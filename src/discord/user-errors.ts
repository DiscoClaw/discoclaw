export function messageContentIntentHint(): string {
  return (
    'Discord is delivering empty message content. Enable Message Content Intent in the Discord Developer Portal ' +
    '(Application -> Bot -> Privileged Gateway Intents), then restart the bot.'
  );
}

export function mapRuntimeErrorToUserMessage(raw: string): string {
  const msg = String(raw ?? '').trim();
  const lc = msg.toLowerCase();
  const mentionsClaude = lc.includes('claude');

  if (lc.includes('timed out')) {
    return 'The runtime timed out before finishing. Try a smaller request or increase RUNTIME_TIMEOUT_MS.';
  }

  if (lc.includes('missing permissions') || lc.includes('missing access')) {
    return (
      'Discord denied this action due to missing permissions/access. ' +
      'Update the bot role permissions in Server Settings -> Roles, then retry.'
    );
  }

  if (mentionsClaude && (lc.includes('not found') || lc.includes('enoent') || lc.includes('spawn'))) {
    return 'Claude CLI was not found. Install it and set CLAUDE_BIN (or fix PATH), then restart.';
  }

  const mentionsGemini = lc.includes('gemini');

  if (mentionsGemini && (lc.includes('not found') || lc.includes('enoent') || lc.includes('spawn'))) {
    return 'Gemini CLI was not found. Install it and set GEMINI_BIN (or fix PATH), then restart.';
  }

  if (mentionsGemini && (lc.includes('unauthorized') || lc.includes('authentication') || lc.includes('not logged in'))) {
    return 'Gemini CLI authentication is missing or expired. Re-authenticate Gemini CLI and retry.';
  }

  if (lc.includes('unauthorized') || lc.includes('authentication') || lc.includes('not logged in')) {
    return 'Claude CLI authentication is missing or expired. Re-authenticate Claude CLI and retry.';
  }

  if (lc.includes('stream stall')) {
    const msMatch = msg.match(/no output for (\d+)ms/i);
    if (msMatch) {
      const ms = parseInt(msMatch[1], 10);
      const humanDuration = ms >= 60000
        ? `${Math.round(ms / 60000)} min`
        : `${Math.round(ms / 1000)} sec`;
      return (
        `The runtime stream stalled (no output for ${ms}ms / ${humanDuration}). ` +
        `This may indicate a long-running tool or API hang. ` +
        `Ask the bot to increase DISCOCLAW_STREAM_STALL_TIMEOUT_MS to allow more time.`
      );
    }
    return 'The runtime stream stalled (no output received). This may indicate a network issue or API hang. Try again or increase DISCOCLAW_STREAM_STALL_TIMEOUT_MS.';
  }

  if (lc.includes('configuration error: missing required channel context')) {
    return (
      'This channel is missing required context. Create/index the channel context file under content/discord/channels ' +
      'or disable DISCORD_REQUIRE_CHANNEL_CONTEXT.'
    );
  }

  if (lc.includes('prompt is too long') || lc.includes('context length exceeded') || lc.includes('context_length_exceeded')) {
    return 'The conversation context exceeded the model\'s limit. Try a shorter message or start a new conversation.';
  }

  if (!msg) {
    return 'An unexpected runtime error occurred with no additional detail.';
  }

  return `Runtime error: ${msg}`;
}
