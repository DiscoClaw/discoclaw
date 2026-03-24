import type { ImagegenContext } from '../discord/actions-imagegen.js';
import { resolveDefaultModel, resolveProvider } from '../discord/actions-imagegen.js';

/**
 * Runtime state that the live bot exposes to the dashboard.
 * Populated from mutable botParams / configCtx — not from on-disk config.
 */
export type LiveRuntimeSnapshot = {
  chatRuntime: string | undefined;
  chatModel: string | undefined;
  chatThinking: string | undefined;
  availableRuntimes: string[];
  pendingRestart: boolean;
  imagegenProvider: string | undefined;
  imagegenModel: string | undefined;
  imagegenOptions: string[];
};

/**
 * A callback wired from index.ts that reads mutable runtime state.
 * Returns undefined when the bot is not fully initialized.
 */
export type LiveSnapshotProvider = () => LiveRuntimeSnapshot | undefined;

// ---------------------------------------------------------------------------
// Known imagegen model families — used to populate the dashboard selector.
// ---------------------------------------------------------------------------

const OPENAI_IMAGEGEN_MODELS = ['dall-e-3', 'gpt-image-1'];
const GEMINI_IMAGEGEN_MODELS = [
  'gemini-3.1-flash-image-preview',
  'gemini-3-pro-image-preview',
  'imagen-4.0-generate-001',
  'imagen-4.0-fast-generate-001',
  'imagen-4.0-ultra-generate-001',
];

/**
 * Build the list of selectable imagegen models based on which provider keys
 * are available.
 */
export function buildImagegenOptions(ctx: ImagegenContext): string[] {
  const options: string[] = [];
  if (ctx.apiKey) options.push(...OPENAI_IMAGEGEN_MODELS);
  if (ctx.geminiApiKey) options.push(...GEMINI_IMAGEGEN_MODELS);
  if (ctx.defaultModel && !options.includes(ctx.defaultModel)) {
    options.unshift(ctx.defaultModel);
  }
  return options;
}

/**
 * Collect the live runtime snapshot from mutable bot state.
 *
 * This is called by the provider closure wired in index.ts; it reads from
 * references that the bot mutates at runtime (configCtx, imagegenCtx, etc.).
 */
export function collectLiveSnapshot(state: {
  runtimeName?: string;
  runtimeModel?: string;
  chatThinking?: string;
  availableRuntimes: string[];
  pendingRestart: boolean;
  imagegenCtx?: ImagegenContext;
}): LiveRuntimeSnapshot {
  const imagegenCtx = state.imagegenCtx;
  let imagegenModel: string | undefined;
  let imagegenProvider: string | undefined;
  let imagegenOptions: string[] = [];

  if (imagegenCtx) {
    imagegenModel = resolveDefaultModel(imagegenCtx);
    imagegenProvider = resolveProvider(imagegenModel);
    imagegenOptions = buildImagegenOptions(imagegenCtx);
  }

  return {
    chatRuntime: state.runtimeName,
    chatModel: state.runtimeModel,
    chatThinking: state.chatThinking,
    availableRuntimes: state.availableRuntimes,
    pendingRestart: state.pendingRestart,
    imagegenProvider,
    imagegenModel,
    imagegenOptions,
  };
}
