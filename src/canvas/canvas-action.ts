import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  type GuildTextBasedChannel,
} from 'discord.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ActionContext, DiscordActionResult } from '../discord/actions.js';
import { NO_MENTIONS } from '../discord/allowed-mentions.js';
import { LaunchActivityError, respondWithLaunchActivity } from '../discord/activity-launch.js';
import { buildCanvasSetupWalkthrough, type CanvasLocalReadiness, type CanvasServer } from './server.js';
import { ArtifactStore } from './artifact-store.js';
import type { CanvasBuiltinApps } from './apps.js';
import { CanvasFileExport } from './file-export.js';
import { LaunchStore } from './launch-store.js';
import type { LoggerLike } from '../logging/logger-like.js';

const CANVAS_HTML_DOC_RE = /<(?:!doctype\s+html|html)\b/i;
const CANVAS_INTENT_RE = /\b(canvas|artifact|activity|interactive|dashboard|chart|graph|diff|visuali[sz]ation|calculator|viewer)\b/i;
const CANVAS_SCRIPT_RE = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
const CANVAS_VOID_ELEMENT_TAG_RE = /<(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CANVAS_PROMPT_TEMPLATE_PATH = path.resolve(__dirname, '..', '..', 'templates', 'instructions', 'canvas.md');
const DEFAULT_SAVE_BRIDGE_GUIDANCE = [
  '- Save-file export is available through the trusted shell bridge when enabled.',
  '- To export a file from inside the artifact, post a message to the parent shell:',
  '  `window.parent.postMessage({ type: "canvas.saveFile", suggestedName: "report.md", mimeType: "text/markdown", encoding: "utf8", content: "# Report" }, "*")`',
].join('\n');

let cachedCanvasPromptTemplate: string | null = null;

export const CANVAS_ACTION_TYPES: ReadonlySet<string> = new Set(['launchCanvas']);
export const CANVAS_LAUNCH_COMPONENT_PREFIX = 'canvas:launch:';
const CANVAS_LAUNCH_COMPONENT_SEPARATOR = ':';

export type LaunchCanvasActionRequest = {
  type: 'launchCanvas';
  title: string;
  content?: string;
  app?: string;
};

export type CanvasContext = {
  enabled: boolean;
  discordClientId?: string;
  writeBridgeEnabled: boolean;
  artifactStore: ArtifactStore;
  launchStore: LaunchStore;
  fileExport: CanvasFileExport;
  builtinApps: CanvasBuiltinApps;
  server: CanvasServer | null;
  getLocalReadiness(): CanvasLocalReadiness;
  isLocallyReady(): boolean;
};

const EMPTY_CANVAS_APPS: CanvasBuiltinApps = {
  hasApp: ((_name: string): _name is never => false) as CanvasBuiltinApps['hasApp'],
  getAppTitle: () => null,
  renderApp: async () => null,
  getAppData: async () => null,
};

export function createCanvasContext(input: {
  enabled: boolean;
  discordClientId?: string;
  writeBridgeEnabled: boolean;
  artifactStore: ArtifactStore;
  launchStore: LaunchStore;
  fileExport: CanvasFileExport;
  builtinApps?: CanvasBuiltinApps;
  getLocalReadiness: () => CanvasLocalReadiness;
}): CanvasContext {
  const ctx: CanvasContext = {
    enabled: input.enabled,
    discordClientId: input.discordClientId,
    writeBridgeEnabled: input.writeBridgeEnabled,
    artifactStore: input.artifactStore,
    launchStore: input.launchStore,
    fileExport: input.fileExport,
    builtinApps: input.builtinApps ?? EMPTY_CANVAS_APPS,
    server: null,
    getLocalReadiness: input.getLocalReadiness,
    isLocallyReady(): boolean {
      return ctx.enabled && ctx.getLocalReadiness().ready && ctx.server?.isListening() === true;
    },
  };
  return ctx;
}

export function buildCanvasSetupRequiredStub(canvasCtx?: CanvasContext): string {
  const readiness = canvasCtx?.getLocalReadiness() ?? {
    ready: false,
    missingChecks: ['Canvas subsystem is not initialized in this process.'],
    externalChecks: [
      'Add a URL Mapping in the Developer Portal pointing / to the public HTTPS canvas endpoint (e.g. your Tailscale Funnel or ngrok URL).',
      'Enable Activities on the Discord application in the Developer Portal (Application → Activities → Enable). Requires the URL Mapping first.',
    ],
  };
  return buildCanvasSetupWalkthrough(readiness);
}

export function shouldCanvasPromptBeSurfaced(canvasCtx: CanvasContext | undefined, userText?: string): boolean {
  if (!canvasCtx?.enabled) return false;
  if (canvasCtx.isLocallyReady()) return true;
  return CANVAS_INTENT_RE.test(userText ?? '');
}

export function isCanvasPromptRequested(userText?: string): boolean {
  return CANVAS_INTENT_RE.test(userText ?? '');
}

export function isLaunchCanvasActionRequest(input: unknown): input is LaunchCanvasActionRequest {
  if (!input || typeof input !== 'object') return false;
  const candidate = input as Partial<LaunchCanvasActionRequest>;
  return candidate.type === 'launchCanvas';
}

export function parseCanvasLaunchCustomId(customId: string): string | null {
  if (!customId.startsWith(CANVAS_LAUNCH_COMPONENT_PREFIX)) return null;
  const payload = customId.slice(CANVAS_LAUNCH_COMPONENT_PREFIX.length);
  return payload || null;
}

function buildCanvasLaunchCustomId(canvasCtx: CanvasContext, launchRef: string): string {
  return `${CANVAS_LAUNCH_COMPONENT_PREFIX}${canvasCtx.launchStore.instanceTag()}${CANVAS_LAUNCH_COMPONENT_SEPARATOR}${launchRef}`;
}

function parseScopedCanvasLaunchCustomId(customId: string): { instanceTag: string | null; launchRef: string } | null {
  const payload = parseCanvasLaunchCustomId(customId);
  if (!payload) return null;

  const separatorIndex = payload.indexOf(CANVAS_LAUNCH_COMPONENT_SEPARATOR);
  if (separatorIndex <= 0) {
    return { instanceTag: null, launchRef: payload };
  }

  return {
    instanceTag: payload.slice(0, separatorIndex),
    launchRef: payload.slice(separatorIndex + 1),
  };
}

function normalizeCanvasTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim();
}

function escapeDiscordMessageText(input: string): string {
  return input.replace(/([\\*_`~|>\[\]()])/g, '\\$1');
}

function currentTextChannel(ctx: ActionContext): GuildTextBasedChannel | null {
  const channel = ctx.guild.channels.cache.get(ctx.channelId);
  if (!channel?.isTextBased()) return null;
  return channel as GuildTextBasedChannel;
}

function buildLaunchButtonLabel(title: string): string {
  const base = `Launch ${title.trim() || 'Canvas'}`;
  return base.length <= 80 ? base : `${base.slice(0, 79)}…`;
}

function isFullHtmlDocument(content: string): boolean {
  return CANVAS_HTML_DOC_RE.test(content);
}

function skipWhitespace(source: string, start: number): number {
  let index = start;
  while (index < source.length && /\s/.test(source[index] ?? '')) index += 1;
  return index;
}

function collectHtmlTemplateChunksFromScript(source: string): string[] {
  const chunks: string[] = [];

  function scan(index: number, stopAtClosingBrace = false): number {
    let i = index;
    let braceDepth = stopAtClosingBrace ? 1 : 0;

    while (i < source.length) {
      const char = source[i] ?? '';
      const next = source[i + 1] ?? '';

      if (char === "'" || char === '"') {
        i = skipQuotedString(i, char);
        continue;
      }
      if (char === '`') {
        i = skipTemplateLiteral(i);
        continue;
      }
      if (char === '/' && next === '/') {
        i = skipLineComment(i);
        continue;
      }
      if (char === '/' && next === '*') {
        i = skipBlockComment(i);
        continue;
      }
      if (stopAtClosingBrace) {
        if (char === '{') {
          braceDepth += 1;
          i += 1;
          continue;
        }
        if (char === '}') {
          braceDepth -= 1;
          i += 1;
          if (braceDepth === 0) return i;
          continue;
        }
      }
      if (/[A-Za-z_$]/.test(char)) {
        const start = i;
        i += 1;
        while (i < source.length && /[A-Za-z0-9_$]/.test(source[i] ?? '')) i += 1;
        const ident = source.slice(start, i);
        if (ident === 'html') {
          const nextIndex = skipWhitespace(source, i);
          if ((source[nextIndex] ?? '') === '`') {
            i = collectTaggedTemplate(nextIndex);
            continue;
          }
        }
        continue;
      }
      i += 1;
    }

    return i;
  }

  function skipQuotedString(start: number, quote: string): number {
    let i = start + 1;
    while (i < source.length) {
      const char = source[i] ?? '';
      if (char === '\\') {
        i += 2;
        continue;
      }
      i += 1;
      if (char === quote) break;
    }
    return i;
  }

  function skipLineComment(start: number): number {
    let i = start + 2;
    while (i < source.length && (source[i] ?? '') !== '\n') i += 1;
    return i;
  }

  function skipBlockComment(start: number): number {
    let i = start + 2;
    while (i < source.length) {
      if ((source[i] ?? '') === '*' && (source[i + 1] ?? '') === '/') return i + 2;
      i += 1;
    }
    return i;
  }

  function skipTemplateLiteral(start: number): number {
    let i = start + 1;
    while (i < source.length) {
      const char = source[i] ?? '';
      const next = source[i + 1] ?? '';
      if (char === '\\') {
        i += 2;
        continue;
      }
      if (char === '$' && next === '{') {
        i = scan(i + 2, true);
        continue;
      }
      i += 1;
      if (char === '`') break;
    }
    return i;
  }

  function collectTaggedTemplate(backtickIndex: number): number {
    let i = backtickIndex + 1;
    let chunkStart = i;

    while (i < source.length) {
      const char = source[i] ?? '';
      const next = source[i + 1] ?? '';
      if (char === '\\') {
        i += 2;
        continue;
      }
      if (char === '$' && next === '{') {
        chunks.push(source.slice(chunkStart, i));
        i = scan(i + 2, true);
        chunkStart = i;
        continue;
      }
      if (char === '`') {
        chunks.push(source.slice(chunkStart, i));
        return i + 1;
      }
      i += 1;
    }

    chunks.push(source.slice(chunkStart));
    return i;
  }

  scan(0);
  return chunks;
}

function findCanvasArtifactLintError(content: string): string | null {
  const bareVoidTags = new Set<string>();
  for (const scriptMatch of content.matchAll(CANVAS_SCRIPT_RE)) {
    const scriptContent = scriptMatch[1] ?? '';
    for (const chunk of collectHtmlTemplateChunksFromScript(scriptContent)) {
      for (const match of chunk.matchAll(CANVAS_VOID_ELEMENT_TAG_RE)) {
        const fullTag = match[0];
        const tagName = match[1]?.toLowerCase();
        if (!tagName) continue;
        if (/\s*\/>$/.test(fullTag)) continue;
        bareVoidTags.add(`<${tagName}>`);
      }
    }
  }

  if (bareVoidTags.size === 0) return null;
  return [
    `launchCanvas content uses bare void HTML elements (${Array.from(bareVoidTags).join(', ')}).`,
    'In canvas artifacts using `window.canvasRuntime`/`html`, self-close them: use `<input ... />`, `<img ... />`, `<br />`, etc.',
  ].join(' ');
}

function loadCanvasPromptTemplate(): string {
  if (cachedCanvasPromptTemplate != null) return cachedCanvasPromptTemplate;
  try {
    cachedCanvasPromptTemplate = fs.readFileSync(CANVAS_PROMPT_TEMPLATE_PATH, 'utf8').trim();
  } catch {
    cachedCanvasPromptTemplate = [
      '### Canvas Activities',
      '',
      '**launchCanvas** — Generate and serve an interactive HTML artifact or built-in app in a Discord Activity panel:',
      '```',
      '<discord-action>{"type":"launchCanvas","title":"Tax Calculator","content":"<!doctype html><html><head><meta charset=\\"utf-8\\" /><meta name=\\"viewport\\" content=\\"width=device-width,initial-scale=1\\" /><style>body{font-family:sans-serif;padding:16px}label,input{display:block;margin-top:12px}</style></head><body><div id=\\"app\\"></div><script>const { html, render, useState } = window.canvasRuntime;function TaxCalculator(){const [income,setIncome]=useState(50000);const tax=Math.round(income*0.22);return html`<main><h1>Tax Calculator</h1><label>Income <input type=\\"number\\" value=${income} onInput=${(event)=>setIncome(Number(event.currentTarget.value||0))} /></label><p>Estimated tax: $${tax.toLocaleString()}</p></main>`;}render(TaxCalculator, document.getElementById(\\"app\\"));</script></body></html>"}</discord-action>',
      '<discord-action>{"type":"launchCanvas","title":"Dashboard","app":"dashboard"}</discord-action>',
      '```',
      '- `title` (required): Human-readable label for the launch button.',
      '- `content` (artifact mode): Full self-contained HTML document with all CSS and JS inline.',
      '- `app` (built-in mode): Named built-in Activity app such as `dashboard`.',
      '- Use canvas only when interactivity materially improves the result over plain text.',
      '- Default is plain text. Do not use canvas for short answers, conversational replies, or single values.',
      '- Good fits: calculators, forms, charts, diffs, large comparison views, filterable tables, live dashboard launches.',
      '- Bad fits: simple status updates, brief explanations, or anything the user explicitly wants as plain text.',
      '- Artifact render responses inject `window.canvasRuntime`; use that built-in runtime instead of bundling React, Preact, Vue, or another UI framework.',
      '- The injected runtime exposes `html`, `render`, and the installed `preact/hooks` surface: `useState`, `useEffect`, `useLayoutEffect`, `useReducer`, `useRef`, `useMemo`, `useCallback`, `useContext`, `useImperativeHandle`, `useDebugValue`, `useErrorBoundary`, and `useId`.',
      '- Start interactive artifacts with `const { html, render, useState } = window.canvasRuntime`; keep the starter small unless the artifact actually needs more hook surface, and mount into a dedicated root node.',
      '- In `html` template literals, self-close void HTML elements: use `<input ... />`, `<img ... />`, `<br />`, etc. Bare `<input>` tags can corrupt the rendered DOM in canvas artifacts.',
      '- Generated artifacts must be a single HTML file, responsive at phone width, and keep total size under roughly 500KB.',
      '- No external scripts, stylesheets, fonts, images, or nested iframes in generated artifacts.',
      '- Generated artifacts run inside a sandboxed iframe and cannot call backend routes directly.',
      '- Artifacts are stored under a cap-based LRU policy; they are not time-expired in v1.',
      '- Include visible loading/error/fallback states when the UI depends on JavaScript.',
      '- Prefer semantic HTML, clear contrast, and obvious focus states.',
      '{{CANVAS_SAVE_BRIDGE_GUIDANCE}}',
    ].join('\n');
  }
  return cachedCanvasPromptTemplate;
}

function buildLaunchActivityFailureMessage(err: unknown): string {
  if (err instanceof LaunchActivityError) {
    if (err.discordCode === 50024) {
      return [
        'Discord rejected the Activity launch for this channel context.',
        '',
        'API error: `50024 Cannot execute action on this channel type`.',
        '',
        'The button itself is valid. Discord is refusing the `LAUNCH_ACTIVITY` callback here.',
      ].join('\n');
    }

    if (err.discordMessage) {
      return [
        'Discord rejected the Activity launch request.',
        '',
        `API error: \`${err.discordCode ?? err.status} ${err.discordMessage}\`.`,
      ].join('\n');
    }
  }

  return [
    'Discord rejected the Activity launch request. This usually means Activities are not enabled on the Discord application.',
    '',
    'To fix this, go to the Discord Developer Portal:',
    '1. Add a URL Mapping pointing / to your public HTTPS canvas endpoint (Tailscale Funnel, ngrok, etc.).',
    '2. Enable Activities (requires the URL Mapping first).',
    '',
    'See docs/discord-bot-setup.md § Canvas Activities for the full walkthrough.',
  ].join('\n');
}

export async function executeCanvasAction(
  action: LaunchCanvasActionRequest,
  ctx: ActionContext,
  canvasCtx: CanvasContext,
): Promise<DiscordActionResult> {
  const title = normalizeCanvasTitle(String(action.title ?? ''));
  if (!title) return { ok: false, error: 'launchCanvas requires a non-empty title' };
  if (!canvasCtx.isLocallyReady()) {
    return { ok: false, error: buildCanvasSetupRequiredStub(canvasCtx) };
  }

  const channel = currentTextChannel(ctx);
  if (!channel || typeof channel.send !== 'function') {
    return { ok: false, error: 'Current Discord channel is not sendable for canvas launch messages' };
  }

  const appName = typeof action.app === 'string' ? action.app.trim() : '';
  const content = typeof action.content === 'string' ? action.content.trim() : '';
  if (appName && content) {
    return { ok: false, error: 'launchCanvas accepts either app or content, not both' };
  }

  let customId: string;
  let messageBody = 'Open this interactive canvas in Discord Activity.';

  if (appName) {
    if (!canvasCtx.builtinApps.hasApp(appName)) {
      return { ok: false, error: `launchCanvas app "${appName}" is not available on this install` };
    }
    customId = buildCanvasLaunchCustomId(canvasCtx, canvasCtx.launchStore.createAppLaunchRef(appName));
    messageBody = 'Open this live canvas app in Discord Activity.';
  } else {
    if (!content) return { ok: false, error: 'launchCanvas requires non-empty HTML content or a built-in app' };
    if (!isFullHtmlDocument(content)) {
      return { ok: false, error: 'launchCanvas content must be a full self-contained HTML document' };
    }
    const lintError = findCanvasArtifactLintError(content);
    if (lintError) return { ok: false, error: lintError };
    const meta = await canvasCtx.artifactStore.createArtifact({ title, content });
    customId = buildCanvasLaunchCustomId(canvasCtx, canvasCtx.launchStore.createArtifactLaunchRef(meta.id));
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(customId)
      .setStyle(ButtonStyle.Primary)
      .setLabel(buildLaunchButtonLabel(title)),
  );

  await channel.send({
    content: `**${escapeDiscordMessageText(title)}**\n${messageBody}`,
    allowedMentions: NO_MENTIONS,
    components: [row],
  });

  return { ok: true, summary: `Posted canvas launch button for "${title}"` };
}

export async function handleCanvasButtonInteraction(input: {
  interaction: ButtonInteraction;
  canvasCtx: CanvasContext;
  allowUserIds: ReadonlySet<string>;
  log?: LoggerLike;
}): Promise<boolean> {
  const { interaction, canvasCtx, allowUserIds, log } = input;
  if (!interaction.isButton()) return false;
  const customId = String(interaction.customId ?? '');
  if (!customId.startsWith(CANVAS_LAUNCH_COMPONENT_PREFIX)) return false;

  if (!allowUserIds.has(interaction.user.id)) {
    await interaction.reply({
      content: 'You are not authorized to use Canvas on this install.',
      ephemeral: true,
      allowedMentions: NO_MENTIONS,
    });
    return true;
  }

  if (!interaction.guildId) {
    await interaction.reply({
      content: 'Canvas Activities are guild-only in v1. Launch them from a server channel.',
      ephemeral: true,
      allowedMentions: NO_MENTIONS,
    });
    return true;
  }

  const scoped = parseScopedCanvasLaunchCustomId(customId);
  if (!scoped) {
    log?.warn?.({ interactionId: interaction.id, customId }, 'canvas:invalid launch button payload');
    await interaction.reply({
      content: 'That canvas launch button is invalid.',
      ephemeral: true,
      allowedMentions: NO_MENTIONS,
    });
    return true;
  }

  if (scoped.instanceTag && scoped.instanceTag !== canvasCtx.launchStore.instanceTag()) {
    log?.info?.({
      interactionId: interaction.id,
      requestedInstanceTag: scoped.instanceTag,
      currentInstanceTag: canvasCtx.launchStore.instanceTag(),
    }, 'canvas:rejecting stale launch button for different live instance');
    await interaction.reply({
      content: 'That canvas launch button belongs to an earlier bot session. Ask me to post a fresh one.',
      ephemeral: true,
      allowedMentions: NO_MENTIONS,
    });
    return true;
  }

  const parsed = canvasCtx.launchStore.parseLaunchRef(scoped.launchRef);
  if (!parsed) {
    log?.warn?.({ interactionId: interaction.id, customId, launchRef: scoped.launchRef }, 'canvas:launch ref rejected');
    await interaction.reply({
      content: 'That canvas launch button is invalid.',
      ephemeral: true,
      allowedMentions: NO_MENTIONS,
    });
    return true;
  }

  if (parsed.type === 'artifact') {
    const artifact = await canvasCtx.artifactStore.getArtifactMeta(parsed.artifactId);
    if (!artifact) {
      await interaction.reply({
        content: 'That canvas artifact is no longer available.',
        ephemeral: true,
        allowedMentions: NO_MENTIONS,
      });
      return true;
    }
  } else if (!canvasCtx.builtinApps.hasApp(parsed.appName)) {
    await interaction.reply({
      content: 'That canvas app is not available on this install.',
      ephemeral: true,
      allowedMentions: NO_MENTIONS,
    });
    return true;
  }

  canvasCtx.launchStore.registerPending(
    {
      userId: interaction.user.id,
      channelId: interaction.channelId,
      guildId: interaction.guildId,
    },
    parsed,
  );

  try {
    await respondWithLaunchActivity(interaction);
  } catch (err) {
    log?.warn({ err, interactionId: interaction.id }, 'canvas:launch activity callback failed');
    await interaction.reply({
      content: buildLaunchActivityFailureMessage(err),
      ephemeral: true,
      allowedMentions: NO_MENTIONS,
    }).catch(() => {});
  }

  return true;
}

export function canvasActionsPromptSection(opts?: { writeBridgeEnabled?: boolean }): string {
  const saveGuidance = opts?.writeBridgeEnabled === false ? '' : DEFAULT_SAVE_BRIDGE_GUIDANCE;
  return loadCanvasPromptTemplate()
    .replace('{{CANVAS_SAVE_BRIDGE_GUIDANCE}}', saveGuidance)
    .trimEnd();
}
