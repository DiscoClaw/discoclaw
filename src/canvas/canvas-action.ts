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
import { buildCanvasSetupWalkthrough, type CanvasLocalReadiness, type CanvasServer } from './server.js';
import { ArtifactStore } from './artifact-store.js';
import type { CanvasBuiltinApps } from './apps.js';
import { CanvasFileExport } from './file-export.js';
import { LaunchStore } from './launch-store.js';
import { respondWithLaunchActivity } from '../discord/activity-launch.js';
import type { LoggerLike } from '../logging/logger-like.js';

const CANVAS_HTML_DOC_RE = /<(?:!doctype\s+html|html)\b/i;
const CANVAS_INTENT_RE = /\b(canvas|artifact|activity|interactive|dashboard|chart|graph|diff|visuali[sz]ation|calculator|viewer)\b/i;
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
      'Enable Activities on the Discord application in the Developer Portal (Application → Activities → Enable).',
      'Add a URL Mapping in the Developer Portal pointing / to the public HTTPS canvas endpoint (e.g. your Tailscale Funnel or ngrok URL).',
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
  return customId.slice(CANVAS_LAUNCH_COMPONENT_PREFIX.length) || null;
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
      '<discord-action>{"type":"launchCanvas","title":"Tax Calculator","content":"<!doctype html><html><head><meta charset=\\"utf-8\\" /><meta name=\\"viewport\\" content=\\"width=device-width,initial-scale=1\\" /><style>body{font-family:sans-serif;padding:16px}</style></head><body><h1>Tax Calculator</h1><script>console.log(\'canvas\')</script></body></html>"}</discord-action>',
      '<discord-action>{"type":"launchCanvas","title":"Dashboard","app":"dashboard"}</discord-action>',
      '```',
      '- `title` (required): Human-readable label for the launch button.',
      '- `content` (artifact mode): Self-contained HTML document with all CSS and JS inline.',
      '- `app` (built-in mode): Named built-in Activity app such as `dashboard`.',
      '- Use canvas only when interactivity materially improves the result over plain text.',
      '- No external scripts, stylesheets, fonts, images, or nested iframes in generated artifacts.',
      '- Generated artifacts run inside a sandboxed iframe and cannot call backend routes directly.',
      '- Artifacts are stored under a cap-based LRU policy; they are not time-expired in v1.',
      '{{CANVAS_SAVE_BRIDGE_GUIDANCE}}',
    ].join('\n');
  }
  return cachedCanvasPromptTemplate;
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
    customId = `${CANVAS_LAUNCH_COMPONENT_PREFIX}${canvasCtx.launchStore.createAppLaunchRef(appName)}`;
    messageBody = 'Open this live canvas app in Discord Activity.';
  } else {
    if (!content) return { ok: false, error: 'launchCanvas requires non-empty HTML content or a built-in app' };
    if (!isFullHtmlDocument(content)) {
      return { ok: false, error: 'launchCanvas content must be a full self-contained HTML document' };
    }
    const meta = await canvasCtx.artifactStore.createArtifact({ title, content });
    customId = `${CANVAS_LAUNCH_COMPONENT_PREFIX}${canvasCtx.launchStore.createArtifactLaunchRef(meta.id)}`;
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

  const launchRef = parseCanvasLaunchCustomId(customId);
  const parsed = launchRef ? canvasCtx.launchStore.parseLaunchRef(launchRef) : null;
  if (!parsed) {
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
    const setupHint = [
      'Discord rejected the Activity launch request. This usually means Activities are not enabled on the Discord application.',
      '',
      'To fix this, go to the Discord Developer Portal:',
      '1. Open your application → Activities → Enable Activities.',
      '2. Add a URL Mapping pointing / to your public HTTPS canvas endpoint (Tailscale Funnel, ngrok, etc.).',
      '',
      'See docs/discord-bot-setup.md § Canvas Activities for the full walkthrough.',
    ].join('\n');
    await interaction.reply({
      content: setupHint,
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
