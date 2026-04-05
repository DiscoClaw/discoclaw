/**
 * Shared trace-event helpers for summarizing values before they enter trace events.
 */

export function summarizeTraceText(value: string, maxChars = 160): string | undefined {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return undefined;
  }

  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(1, maxChars - 1))}…`;
}

export function summarizeTraceValue(value: unknown, maxChars = 160): string | undefined {
  if (value == null) {
    return undefined;
  }

  if (typeof value === 'string') {
    return summarizeTraceText(value, maxChars);
  }

  try {
    const serialized = JSON.stringify(value);
    if (serialized) {
      return summarizeTraceText(serialized, maxChars);
    }
  } catch {
    // Fall through to String(value).
  }

  return summarizeTraceText(String(value), maxChars);
}
