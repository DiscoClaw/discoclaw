import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');
const outDir = path.join(projectRoot, 'dist', 'vendor');
const outfile = path.join(outDir, 'canvas-runtime.js');

const runtimeEntry = `
  import { Fragment, createContext, h, hydrate, render as preactRender } from 'preact';
  import htm from 'htm';
  import {
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useReducer,
    useRef,
    useState,
  } from 'preact/hooks';

  const html = htm.bind(h);

  function render(component, container, props = {}) {
    if (!(container instanceof Element)) {
      throw new TypeError('canvasRuntime.render requires a DOM Element container');
    }

    const vnode = typeof component === 'function'
      ? h(component, props)
      : component;

    preactRender(vnode, container);
    return () => preactRender(null, container);
  }

  const runtime = Object.freeze({
    Fragment,
    createContext,
    h,
    html,
    hydrate,
    render,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useReducer,
    useRef,
    useState,
  });

  globalThis.canvasRuntime = runtime;
  if (typeof window !== 'undefined') {
    window.canvasRuntime = runtime;
  }
`;

try {
  await mkdir(outDir, { recursive: true });
  await build({
    stdin: {
      contents: runtimeEntry,
      resolveDir: projectRoot,
      sourcefile: 'canvas-runtime-entry.js',
      loader: 'js',
    },
    outfile,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    minify: false,
    sourcemap: false,
  });
  process.stdout.write(`Bundled canvas-runtime → ${outfile}\n`);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`esbuild failed: ${message}\n`);
  process.exit(1);
}
