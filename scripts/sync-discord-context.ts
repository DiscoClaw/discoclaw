import 'dotenv/config';

import path from 'node:path';
import process from 'node:process';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { ensureIndexedDiscordChannelContext, loadDiscordChannelContext } from '../src/discord/channel-context.js';

const __filename_sync = fileURLToPath(import.meta.url);
const __dirname_sync = path.dirname(__filename_sync);

function getArgValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function parseAddChannelArgs(argv: string[]): Array<{ channelId: string; channelName?: string }> {
  const out: Array<{ channelId: string; channelName?: string }> = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--add-channel') continue;
    const v = argv[i + 1] ?? '';
    if (!v) continue;
    const [id, ...rest] = v.split(':');
    const channelId = String(id ?? '').trim();
    const channelName = rest.join(':').trim() || undefined;
    if (!/^\d{17,20}$/.test(channelId)) continue;
    out.push({ channelId, channelName });
  }
  return out;
}

async function rewriteIndex(indexPath: string, ctx: Awaited<ReturnType<typeof loadDiscordChannelContext>>) {
  const entries = Array.from(ctx.byChannelId.values()).sort((a, b) => a.channelName.localeCompare(b.channelName));
  const lines: string[] = [];
  lines.push('# DISCORD.md - Channel Context Index');
  lines.push('');
  lines.push('| Channel | ID | Context File | Purpose |');
  lines.push('|---------|----|--------------|---------|');
  for (const e of entries) {
    const file = `discord/channels/${path.basename(e.contextPath)}`;
    lines.push(`| #${e.channelName} | ${e.channelId} | \`${file}\` | — |`);
  }
  lines.push('');

  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await fs.writeFile(indexPath, lines.join('\n'), 'utf8');
}

async function main() {
  const dataDir = (process.env.DISCOCLAW_DATA_DIR ?? '').trim();
  const contentDir =
    (getArgValue('--content-dir') ?? '').trim() ||
    (process.env.DISCOCLAW_CONTENT_DIR ?? '').trim() ||
    (dataDir ? path.join(dataDir, 'content') : path.join(process.cwd(), 'content'));

  const log = {
    info: (obj: unknown, msg?: string) => console.log(msg ?? '', obj ?? ''),
    warn: (obj: unknown, msg?: string) => console.warn(msg ?? '', obj ?? ''),
    error: (obj: unknown, msg?: string) => console.error(msg ?? '', obj ?? ''),
  };

  const contextModulesDir = path.join(__dirname_sync, '..', '.context');
  const ctx = await loadDiscordChannelContext({ contentDir, contextModulesDir, log });

  const adds = parseAddChannelArgs(process.argv);
  for (const a of adds) {
    await ensureIndexedDiscordChannelContext({
      ctx,
      channelId: a.channelId,
      channelName: a.channelName,
      log,
    });
  }

  if (hasFlag('--rewrite-index')) {
    await rewriteIndex(ctx.indexPath, ctx);
    log.info({ indexPath: ctx.indexPath }, 'rewrite-index: done');
  }

  // Strip stale "Includes" blocks from channel files.
  const channelsDir = ctx.channelsDir;
  try {
    const channelFiles = await fs.readdir(channelsDir);
    for (const f of channelFiles) {
      if (!f.endsWith('.md')) continue;
      const p = path.join(channelsDir, f);
      const body = await fs.readFile(p, 'utf8');
      // Match "Includes (read these first):" followed by lines starting with "- ../base/"
      const cleaned = body.replace(/\nIncludes \(read these first\):\n(?:- \.\.\/base\/\S+\n)+\n?/g, '\n');
      if (cleaned !== body) {
        await fs.writeFile(p, cleaned, 'utf8');
        log.info({ file: f }, 'sync: stripped stale Includes block');
      }
    }
  } catch (err) {
    log.warn({ err }, 'sync: failed to clean stale Includes blocks');
  }

  log.info(
    {
      contentDir,
      indexPath: ctx.indexPath,
      channelsDir: ctx.channelsDir,
      channelsCount: ctx.byChannelId.size,
      createdBase: ctx.paContextFiles,
    },
    'sync: done',
  );
}

await main();

