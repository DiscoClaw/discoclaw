import {
  mapRuntimeFailureToUserMessage,
  normalizeRuntimeFailure,
  normalizeRuntimeFailureEvent,
  type RuntimeFailure,
  type RuntimeFailureCode,
  type RuntimeFailureEvent,
  type RuntimeFailureInputEvent,
  type RuntimeFailureMetadata,
} from '../runtime/runtime-failure.js';

export type {
  RuntimeFailure,
  RuntimeFailureCode,
  RuntimeFailureEvent,
  RuntimeFailureInputEvent,
  RuntimeFailureMetadata,
};

export function messageContentIntentHint(): string {
  return (
    'Discord is delivering empty message content. Enable Message Content Intent in the Discord Developer Portal ' +
    '(Application -> Bot -> Privileged Gateway Intents), then restart the bot.'
  );
}

export function normalizeRuntimeError(
  input: RuntimeFailure | RuntimeFailureInputEvent | string | Error,
): RuntimeFailure {
  if (typeof input === 'string' || input instanceof Error) {
    return normalizeRuntimeFailure(input);
  }

  if (input.type === 'error' || input.type === 'runtime_failure') {
    return normalizeRuntimeFailureEvent(input);
  }

  return normalizeRuntimeFailure(input);
}

export function mapRuntimeErrorToUserMessage(
  input: RuntimeFailure | RuntimeFailureInputEvent | string | Error,
): string {
  return mapRuntimeFailureToUserMessage(input);
}
