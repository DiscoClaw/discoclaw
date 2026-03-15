import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OPENAI_TOOL_EXEC_CONTRACT,
  createAdvertisedOpenAIToolExecContracts,
  type OpenAIToolExecContractId,
} from '../runtime/openai-tool-exec.js';
import { buildToolSchemas } from '../runtime/openai-tool-schemas.js';
import type { RuntimeCapability, RuntimeId } from '../runtime/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const TRACKED_TOOLS_DIR = 'instructions';
export const TRACKED_TOOLS_FILE_NAME = 'TOOLS.md';
export const TRACKED_TOOLS_SECTION_LABEL = 'TOOLS.md (tracked tools)';

let cachedPath: string | null = null;
let cachedContent: string | null = null;

type MarkdownSection = {
  heading: string;
  lines: string[];
};

export type TrackedToolsRuntimeContext = {
  runtimeId?: RuntimeId;
  runtimeCapabilities?: Iterable<RuntimeCapability>;
  runtimeTools?: Iterable<string>;
  enableHybridPipeline?: boolean;
};

const DROPPED_TOP_LEVEL_SECTIONS = new Set([
  'Browser Automation (agent-browser)',
  'Service Operations (discoclaw)',
]);

const WEBHOOK_TOOL_ACCESS_SENTENCE = 'webhook jobs run without Discord action permissions or tool access.';
const AUDITED_RUNTIME_TOOL_GUARANTEES_HEADING = 'Audited Runtime Tool Guarantees';
const OPENAI_TOOL_RUNTIME_IDS = new Set<RuntimeId>(['openai', 'openrouter']);

function splitTopLevelSections(content: string): { prelude: string[]; sections: MarkdownSection[] } {
  const prelude: string[] = [];
  const sections: MarkdownSection[] = [];
  let current: MarkdownSection | null = null;

  for (const line of content.trimEnd().split('\n')) {
    if (line.startsWith('## ')) {
      current = { heading: line.slice(3).trim(), lines: [line] };
      sections.push(current);
      continue;
    }

    if (current) {
      current.lines.push(line);
    } else {
      prelude.push(line);
    }
  }

  return { prelude, sections };
}

function joinTrackedToolsContent(parts: string[]): string {
  return parts
    .map((part) => part.trimEnd())
    .filter((part) => part.length > 0)
    .join('\n\n')
    .trimEnd();
}

function buildAdvertisedOpenAIToolSchemaNames(
  runtimeTools: Iterable<string>,
  enableHybridPipeline?: boolean,
): string[] {
  const tools = Array.from(new Set(runtimeTools));
  const eligibleTools = enableHybridPipeline === false
    ? tools.filter((tool) =>
      tool !== 'Pipeline'
      && tool !== 'Step'
      && !tool.startsWith('pipeline.')
      && !tool.startsWith('step.'))
    : tools;

  return buildToolSchemas(eligibleTools).map((schema) => schema.function.name);
}

function shouldAdvertiseOpenAIToolContracts(ctx?: TrackedToolsRuntimeContext): boolean {
  if (!ctx?.runtimeId || !OPENAI_TOOL_RUNTIME_IDS.has(ctx.runtimeId)) return false;
  if (!ctx.runtimeCapabilities || !ctx.runtimeTools) return false;

  const capabilities = ctx.runtimeCapabilities instanceof Set
    ? ctx.runtimeCapabilities
    : new Set(ctx.runtimeCapabilities);

  if (capabilities.has('tools_exec') || capabilities.has('tools_fs')) return true;

  return Array.from(ctx.runtimeTools).some((tool) =>
    tool === 'Pipeline'
    || tool === 'Step'
    || tool.startsWith('pipeline.')
    || tool.startsWith('step.'));
}

export function collectAdvertisedTrackedToolContracts(
  ctx?: TrackedToolsRuntimeContext,
): OpenAIToolExecContractId[] {
  if (!shouldAdvertiseOpenAIToolContracts(ctx)) return [];

  const schemaNames = buildAdvertisedOpenAIToolSchemaNames(
    ctx!.runtimeTools!,
    ctx?.enableHybridPipeline,
  );
  if (schemaNames.length === 0) return [];

  return Array.from(
    createAdvertisedOpenAIToolExecContracts(
      new Set(schemaNames),
      { enableHybridPipeline: ctx?.enableHybridPipeline },
    ),
  );
}

export function collectAdvertisedTrackedToolGuarantees(
  ctx?: TrackedToolsRuntimeContext,
): string[] {
  return collectAdvertisedTrackedToolContracts(ctx)
    .map((contractId) => OPENAI_TOOL_EXEC_CONTRACT[contractId].runtimeWording);
}

function stripUnsupportedWebhookGuarantee(section: MarkdownSection): MarkdownSection {
  if (section.heading !== 'Webhook Server') return section;

  return {
    ...section,
    lines: section.lines.flatMap((line) => {
      if (!line.includes(WEBHOOK_TOOL_ACCESS_SENTENCE)) return [line];

      const withoutToolAccessGuarantee = line
        .replace(`; ${WEBHOOK_TOOL_ACCESS_SENTENCE}`, '.')
        .trimEnd();
      return withoutToolAccessGuarantee ? [withoutToolAccessGuarantee] : [];
    }),
  };
}

function buildAuditedRuntimeToolGuaranteesSection(ctx?: TrackedToolsRuntimeContext): MarkdownSection | null {
  const guarantees = collectAdvertisedTrackedToolGuarantees(ctx);
  if (guarantees.length === 0) return null;

  return {
    heading: AUDITED_RUNTIME_TOOL_GUARANTEES_HEADING,
    lines: [
      `## ${AUDITED_RUNTIME_TOOL_GUARANTEES_HEADING}`,
      '',
      'Only these runtime tool guarantees are retained because each maps to a named enforcement gate in code:',
      '',
      ...guarantees.map((line) => `- ${line}`),
    ],
  };
}

export function buildPromptSafeTrackedToolsContent(
  content: string,
  ctx?: TrackedToolsRuntimeContext,
): string {
  const { prelude, sections } = splitTopLevelSections(content);
  const filteredSections = sections
    .filter((section) => !DROPPED_TOP_LEVEL_SECTIONS.has(section.heading))
    .map(stripUnsupportedWebhookGuarantee);

  const auditedGuarantees = buildAuditedRuntimeToolGuaranteesSection(ctx);
  if (auditedGuarantees) {
    const precedenceIndex = filteredSections.findIndex((section) => section.heading === 'Runtime Instruction Precedence');
    if (precedenceIndex === -1) {
      filteredSections.unshift(auditedGuarantees);
    } else {
      filteredSections.splice(precedenceIndex + 1, 0, auditedGuarantees);
    }
  }

  return joinTrackedToolsContent([
    prelude.join('\n'),
    ...filteredSections.map((section) => section.lines.join('\n')),
  ]);
}

/**
 * Resolve the tracked TOOLS.md path from this module's location.
 * Works in both src/* and dist/* layouts.
 */
export function resolveTrackedToolsPath(baseDir: string = __dirname): string {
  return path.resolve(baseDir, '..', '..', 'templates', TRACKED_TOOLS_DIR, TRACKED_TOOLS_FILE_NAME);
}

/** Render tracked tools in the canonical prompt section format. */
export function renderTrackedToolsSection(content: string): string {
  const trimmed = content.trimEnd();
  if (!trimmed) return '';
  return `--- ${TRACKED_TOOLS_SECTION_LABEL} ---\n${trimmed}`;
}

/**
 * Load tracked tools from disk with memoization.
 * Missing/unreadable files return an explicit warning section so the
 * tracked-tools prompt tier is never silently dropped. This loader only
 * handles the repository-tracked base layer; workspace/TOOLS.md, when
 * present, is loaded later as the user override layer in prompt assembly.
 */
export function loadTrackedToolsPreamble(opts?: {
  trackedToolsPath?: string;
  forceReload?: boolean;
  runtimeId?: RuntimeId;
  runtimeCapabilities?: Iterable<RuntimeCapability>;
  runtimeTools?: Iterable<string>;
  enableHybridPipeline?: boolean;
}): string {
  const trackedToolsPath = opts?.trackedToolsPath ?? resolveTrackedToolsPath();
  const forceReload = opts?.forceReload === true;
  if (!forceReload && cachedPath === trackedToolsPath && cachedContent !== null) {
    return renderTrackedToolsSection(buildPromptSafeTrackedToolsContent(cachedContent, opts));
  }

  let content = '';
  try {
    content = fsSync.readFileSync(trackedToolsPath, 'utf-8');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    content = `[tracked tools unavailable: failed to read ${trackedToolsPath}: ${message}]`;
    console.warn(
      `instructions:tracked-tools failed to read ${trackedToolsPath}; injecting fallback section (${message})`,
    );
  }

  cachedPath = trackedToolsPath;
  cachedContent = content;
  return renderTrackedToolsSection(buildPromptSafeTrackedToolsContent(content, opts));
}

/** Cached tracked tools preamble used by prompt assembly. */
export function getTrackedToolsPreamble(opts?: TrackedToolsRuntimeContext): string {
  return loadTrackedToolsPreamble(opts);
}

export function _resetTrackedToolsCacheForTests(): void {
  cachedPath = null;
  cachedContent = null;
}
