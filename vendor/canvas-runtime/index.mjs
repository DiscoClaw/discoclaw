import { Fragment, createContext, h, hydrate, render as preactRender } from 'preact';
import {
  useCallback,
  useContext,
  useDebugValue,
  useEffect,
  useErrorBoundary,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'preact/hooks';
import htm from 'htm';

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

// Keep the injected browser API intentionally small. Generated artifacts can
// author function components, compose HTML templates, mount/hydrate trees, and
// use the installed `preact/hooks` surface without bundling framework code.
const canvasRuntime = Object.freeze({
  Fragment,
  createContext,
  h,
  html,
  hydrate,
  render,
  useCallback,
  useContext,
  useDebugValue,
  useEffect,
  useErrorBoundary,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
});

if (typeof window !== 'undefined') {
  window.canvasRuntime = canvasRuntime;
}
