/**
 * Guards against prototype-pollution via dynamic property names.
 *
 * Any code path that uses an external string (route param, JSON key, etc.)
 * as a plain-object property name should reject these values first.
 */

const PROTO_POLLUTION_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/** Returns `true` when `key` is a prototype-pollution property name. */
export function isUnsafeKey(key: string): boolean {
  return PROTO_POLLUTION_KEYS.has(key);
}

/**
 * Look up `key` on `obj` only when the key is safe and is an own property.
 * Returns `undefined` for unsafe keys or missing properties — never walks
 * the prototype chain.
 */
export function safeGet<V>(obj: Record<string, V>, key: string): V | undefined {
  if (isUnsafeKey(key)) return undefined;
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

/**
 * Return a shallow copy of `obj` with any prototype-pollution keys removed.
 * Useful for sanitising parsed JSON before it becomes a lookup table.
 */
export function stripUnsafeKeys<V>(obj: Record<string, V>): Record<string, V> {
  const clean: Record<string, V> = Object.create(null);
  for (const key of Object.keys(obj)) {
    if (!isUnsafeKey(key)) {
      clean[key] = obj[key];
    }
  }
  return clean;
}
