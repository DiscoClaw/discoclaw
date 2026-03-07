import { mapRuntimeFailureToUserMessage } from '../runtime/runtime-failure.js';

export function messageContentIntentHint(): string {
  return (
    'Discord is delivering empty message content. Enable Message Content Intent in the Discord Developer Portal ' +
    '(Application -> Bot -> Privileged Gateway Intents), then restart the bot.'
  );
}

export function mapRuntimeErrorToUserMessage(raw: string): string {
  return mapRuntimeFailureToUserMessage(raw);
}
