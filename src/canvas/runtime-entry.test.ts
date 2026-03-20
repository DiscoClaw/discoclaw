import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const PREACT_HOOK_EXPORTS = [
  'useCallback',
  'useContext',
  'useDebugValue',
  'useEffect',
  'useErrorBoundary',
  'useId',
  'useImperativeHandle',
  'useLayoutEffect',
  'useMemo',
  'useReducer',
  'useRef',
  'useState',
] as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('canvas runtime entry', () => {
  it('assigns window.canvasRuntime with the installed preact/hooks surface', async () => {
    vi.stubGlobal('window', {});

    const runtimeEntryUrl = `${pathToFileURL(path.resolve(process.cwd(), 'vendor', 'canvas-runtime', 'index.mjs')).href}?t=${Date.now()}-${Math.random()}`;
    await import(runtimeEntryUrl);

    const runtime = (
      globalThis as typeof globalThis & { window?: { canvasRuntime?: Record<string, unknown> } }
    ).window?.canvasRuntime;
    expect(runtime).toBeDefined();
    expect(Object.isFrozen(runtime)).toBe(true);
    expect(typeof runtime?.html).toBe('function');
    expect(typeof runtime?.render).toBe('function');

    for (const hookName of PREACT_HOOK_EXPORTS) {
      expect(typeof runtime?.[hookName]).toBe('function');
    }
  });
});
