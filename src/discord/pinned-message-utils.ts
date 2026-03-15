function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isIterable(value: unknown): value is Iterable<unknown> {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function';
}

function collectPinnedEntries(input: unknown): unknown[] {
  if (input == null) return [];
  if (Array.isArray(input)) return input;
  if (!isRecord(input)) {
    return isIterable(input) ? Array.from(input) : [];
  }

  const items = input['items'];
  const values = input['values'];
  if (typeof values === 'function') {
    try {
      const result = values.call(input) as unknown;
      if (isIterable(result)) {
        return Array.from(result);
      }
    } catch {
      return [];
    }
  }

  if (Array.isArray(items)) {
    return items;
  }

  if (isIterable(input)) {
    return Array.from(input);
  }

  return [];
}

export function normalizePinnedMessages<T extends object>(input: unknown): T[] {
  const normalized: T[] = [];
  for (const entry of collectPinnedEntries(input)) {
    if (isRecord(entry) && isRecord(entry['message'])) {
      normalized.push(entry['message'] as T);
      continue;
    }
    if (isRecord(entry)) {
      normalized.push(entry as T);
    }
  }
  return normalized;
}

export function countPinnedMessages(input: unknown, fallbackLength = 0): number {
  if (Array.isArray(input)) {
    return input.length;
  }
  if (!isRecord(input)) {
    return fallbackLength;
  }

  const size = input['size'];
  if (typeof size === 'number' && Number.isFinite(size)) {
    return Math.max(0, Math.floor(size));
  }

  const items = input['items'];
  if (Array.isArray(items)) {
    return items.length;
  }

  return fallbackLength;
}
