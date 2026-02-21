import fs from 'node:fs/promises';
import path from 'node:path';
import type { LoggerLike } from '../logging/logger-like.js';

const PA_CONTEXT_MODULES = ['pa.md', 'pa-safety.md'] as const;

export type ChannelContextEntry = {
  channelId: string;
  channelName: string;
  // Absolute path to the per-channel context file.
  contextPath: string;
};

export type DiscordChannelContext = {
  contentDir: string;
  indexPath: string;
  paContextFiles: string[];
  channelsDir: string;
  byChannelId: Map<string, ChannelContextEntry>;
  dmContextPath: string;
};

function parseChannelIndexMarkdown(md: string, channelsDir: string): Map<string, ChannelContextEntry> {
  // Parse rows like:
  // | #gallery | 1234567890123456789 | `discord/gallery.md` | ... |
  // We only need channel name + id + context file hint.
  const out = new Map<string, ChannelContextEntry>();

  const lines = md.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed
      .split('|')
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    if (cells.length < 2) continue;

    const chanCell = cells[0] ?? '';
    const idCell = cells[1] ?? '';
    if (!chanCell.startsWith('#')) continue;
    if (!/^\d{17,20}$/.test(idCell)) continue;

    const channelName = chanCell.replace(/^#+/, '').trim();
    const channelId = idCell;

    let contextPath = path.join(channelsDir, `${channelName}.md`);
    const ctxCell = cells[2] ?? '';
    // Prefer explicit context file mapping when present.
    if (ctxCell && ctxCell !== '—' && ctxCell !== '-') {
      const unquoted = ctxCell.replace(/`/g, '').trim();
      const base = path.basename(unquoted);
      if (base && base.toLowerCase().endsWith('.md')) {
        contextPath = path.join(channelsDir, base);
      }
    }

    out.set(channelId, { channelId, channelName, contextPath });
  }

  return out;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false;
    throw err;
  }
}

async function writeFileIfMissing(p: string, body: string): Promise<boolean> {
  if (await fileExists(p)) return false;
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, body, 'utf8');
  return true;
}

function channelFileNameFromName(name: string): string {
  const safe = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return (safe || 'channel') + '.md';
}

function channelContextTemplate(args: {
  channelName: string;
  channelId: string;
}): string {
  return [
    `# #${args.channelName} Context`,
    `Channel ID: ${args.channelId}`,
    '',
    'Channel-specific notes:',
    '-',
    '',
  ].join('\n');
}

async function ensureDiscordIndexExists(indexPath: string): Promise<void> {
  if (await fileExists(indexPath)) return;
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  const body = [
    '# DISCORD.md - Channel Context Index',
    '',
    '| Channel | ID | Context File | Purpose |',
    '|---------|----|--------------|---------|',
    '',
  ].join('\n');
  await fs.writeFile(indexPath, body, 'utf8');
}

export async function ensureIndexedDiscordChannelContext(args: {
  ctx: DiscordChannelContext;
  channelId: string;
  // Best-effort. If empty, a stable placeholder name is used.
  channelName?: string;
  log?: LoggerLike;
}): Promise<ChannelContextEntry> {
  const existing = args.ctx.byChannelId.get(args.channelId);
  if (existing) return existing;

  const channelName = (args.channelName ?? '').trim() || `channel-${args.channelId}`;
  const fileName = channelFileNameFromName(channelName === `channel-${args.channelId}`
    ? `channel-${args.channelId}`
    : channelName);
  const contextPath = path.join(args.ctx.channelsDir, fileName);

  await ensureDiscordIndexExists(args.ctx.indexPath);
  const row = `| #${channelName} | ${args.channelId} | \`discord/channels/${fileName}\` | — |`;
  await fs.appendFile(args.ctx.indexPath, row + '\n', 'utf8');

  const entry: ChannelContextEntry = { channelId: args.channelId, channelName, contextPath };
  args.ctx.byChannelId.set(args.channelId, entry);

  const didCreate = await writeFileIfMissing(
    contextPath,
    channelContextTemplate({
      channelName,
      channelId: args.channelId,
    }),
  );
  if (didCreate) {
    args.log?.info({ channelId: args.channelId, contextPath }, 'discord:context created placeholder for new channel');
  }

  return entry;
}

export async function validatePaContextModules(contextModulesDir: string): Promise<void> {
  for (const mod of PA_CONTEXT_MODULES) {
    const p = path.join(contextModulesDir, mod);
    try {
      await fs.access(p);
    } catch {
      throw new Error(
        `Required PA context module not found: ${p}. ` +
        `Ensure .context/${mod} exists in the repo root.`,
      );
    }
  }
}

export async function loadDiscordChannelContext(opts: {
  contentDir: string;
  contextModulesDir: string;
  log?: LoggerLike;
}): Promise<DiscordChannelContext> {
  const contentDir = opts.contentDir;
  const indexPath = path.join(contentDir, 'discord', 'DISCORD.md');
  const channelsDir = path.join(contentDir, 'discord', 'channels');
  const dmContextPath = path.join(channelsDir, 'dm.md');

  const paContextFiles = PA_CONTEXT_MODULES.map((f) => path.join(opts.contextModulesDir, f));

  await writeFileIfMissing(
    dmContextPath,
    channelContextTemplate({
      channelName: 'dm',
      channelId: 'dm',
    }),
  );

  let md = '';
  try {
    md = await fs.readFile(indexPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw err;
    opts.log?.warn({ indexPath }, 'discord:context index missing; using fallback only');
    md = '';
  }

  const byChannelId = md ? parseChannelIndexMarkdown(md, channelsDir) : new Map<string, ChannelContextEntry>();

  // Guarantee that every indexed channel has a context file (create placeholders for missing).
  let created = 0;
  for (const entry of byChannelId.values()) {
    const didCreate = await writeFileIfMissing(
      entry.contextPath,
      channelContextTemplate({
        channelName: entry.channelName,
        channelId: entry.channelId,
      }),
    );
    if (didCreate) created++;
  }
  if (created > 0) {
    opts.log?.info({ created, channelsDir }, 'discord:context bootstrapped missing channel context files');
  }

  return {
    contentDir,
    indexPath,
    paContextFiles,
    channelsDir,
    byChannelId,
    dmContextPath,
  };
}

export function resolveDiscordChannelContext(args: {
  ctx: DiscordChannelContext | undefined;
  isDm: boolean;
  channelId: string;
  threadParentId?: string | null;
}): { channelId: string; channelName?: string; contextPath?: string } {
  const ctx = args.ctx;
  if (!ctx) return { channelId: args.channelId };

  if (args.isDm) {
    return { channelId: args.channelId, channelName: 'dm', contextPath: ctx.dmContextPath };
  }

  const id = (args.threadParentId && args.threadParentId.trim()) ? args.threadParentId : args.channelId;
  const hit = ctx.byChannelId.get(id);
  if (hit) return { channelId: id, channelName: hit.channelName, contextPath: hit.contextPath };
  return { channelId: id, channelName: 'unknown' };
}
