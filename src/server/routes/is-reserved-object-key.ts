/**
 * Guards against prototype-pollution via dynamic route parameters.
 *
 * When a URL segment (e.g. `/webhook/:source`) is used as a plain-object
 * property name, reserved keys like `__proto__` can trigger prototype
 * pollution or uncaught exceptions.  Call this before any object lookup
 * keyed by a route parameter.
 */

const RESERVED: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/** Returns `true` when `key` is a reserved Object property name. */
export function isReservedObjectKey(key: string): boolean {
  return RESERVED.has(key);
}
