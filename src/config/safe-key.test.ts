import { describe, expect, it } from 'vitest';
import { isUnsafeKey, safeGet, stripUnsafeKeys } from './safe-key.js';

describe('isUnsafeKey', () => {
  it.each(['__proto__', 'constructor', 'prototype'])('returns true for %s', (key) => {
    expect(isUnsafeKey(key)).toBe(true);
  });

  it.each(['github', 'alerts', '', 'proto', '__proto', 'CONSTRUCTOR'])('returns false for %s', (key) => {
    expect(isUnsafeKey(key)).toBe(false);
  });
});

describe('safeGet', () => {
  const obj: Record<string, number> = { a: 1, b: 2 };

  it('returns the value for a safe, present key', () => {
    expect(safeGet(obj, 'a')).toBe(1);
  });

  it('returns undefined for a safe but missing key', () => {
    expect(safeGet(obj, 'z')).toBeUndefined();
  });

  it('returns undefined for __proto__ even when set as own property', () => {
    const withProto: Record<string, number> = Object.create(null);
    withProto['__proto__'] = 42;
    expect(safeGet(withProto, '__proto__')).toBeUndefined();
  });

  it('returns undefined for constructor', () => {
    expect(safeGet(obj, 'constructor')).toBeUndefined();
  });

  it('returns undefined for prototype', () => {
    expect(safeGet(obj, 'prototype')).toBeUndefined();
  });

  it('does not walk the prototype chain', () => {
    const parent = { inherited: 99 };
    const child = Object.create(parent) as Record<string, number>;
    expect(safeGet(child, 'inherited')).toBeUndefined();
  });
});

describe('stripUnsafeKeys', () => {
  it('removes __proto__, constructor, and prototype keys', () => {
    const input: Record<string, string> = {
      github: 'ok',
      __proto__: 'bad',
      constructor: 'bad',
      prototype: 'bad',
      alerts: 'ok',
    };
    // JSON.parse puts __proto__ as own property; replicate with Object.defineProperty
    Object.defineProperty(input, '__proto__', { value: 'bad', enumerable: true, configurable: true });

    const result = stripUnsafeKeys(input);
    expect(Object.keys(result)).toEqual(['github', 'alerts']);
    expect(result['github']).toBe('ok');
    expect(result['alerts']).toBe('ok');
  });

  it('returns a null-prototype object', () => {
    const result = stripUnsafeKeys({ a: 1 });
    expect(Object.getPrototypeOf(result)).toBeNull();
  });

  it('handles an empty object', () => {
    const result = stripUnsafeKeys({});
    expect(Object.keys(result)).toEqual([]);
  });
});
