import fs from 'node:fs/promises';
import path from 'node:path';
import type { DiscordChannelContext } from './channel-context.js';
import { formatDurableSection, loadDurableMemory, selectItemsForInjection } from './durable-memory.js';
import { loadWorkspacePermissions, resolveTools } from '../workspace-permissions.js';
import type { LoggerLike } from './action-types.js';

export async function loadWorkspacePaFiles(workspaceCwd: string): Promise<string[]> {
  const paFileNames = ['SOUL.md', 'IDENTITY.md', 'USER.md', 'TOOLS.md'];
  const bootstrapPath = path.join(workspaceCwd, 'BOOTSTRAP.md');
  const paFiles: string[] = [];
  try { await fs.access(bootstrapPath); paFiles.push(bootstrapPath); } catch { /* ignore */ }
  for (const f of paFileNames) {
    const p = path.join(workspaceCwd, f);
    try { await fs.access(p); paFiles.push(p); } catch { /* ignore */ }
  }
  return paFiles;
}

/** Returns workspace/MEMORY.md path if it exists, null otherwise. */
export async function loadWorkspaceMemoryFile(workspaceCwd: string): Promise<string | null> {
  const p = path.join(workspaceCwd, 'MEMORY.md');
  try { await fs.access(p); return p; } catch { return null; }
}

/** Returns paths for today + yesterday daily logs that exist. */
export async function loadDailyLogFiles(workspaceCwd: string): Promise<string[]> {
  const files: string[] = [];
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  for (const d of [today, yesterday]) {
    const name = d.toISOString().slice(0, 10) + '.md';
    const p = path.join(workspaceCwd, 'memory', name);
    try { await fs.access(p); files.push(p); } catch { /* ignore */ }
  }
  return files;
}

export function buildContextFiles(
  paFiles: string[],
  discordChannelContext: DiscordChannelContext | undefined,
  channelContextPath: string | null | undefined,
): string[] {
  const contextFiles: string[] = [...paFiles];
  if (discordChannelContext) {
    contextFiles.push(...discordChannelContext.baseFiles);
  }
  if (channelContextPath) contextFiles.push(channelContextPath);
  return contextFiles;
}

export async function buildDurableMemorySection(opts: {
  enabled: boolean;
  durableDataDir: string;
  userId: string;
  durableInjectMaxChars: number;
  log?: LoggerLike;
}): Promise<string> {
  if (!opts.enabled) return '';
  try {
    const store = await loadDurableMemory(opts.durableDataDir, opts.userId);
    if (!store) return '';
    const items = selectItemsForInjection(store, opts.durableInjectMaxChars);
    if (items.length === 0) return '';
    return formatDurableSection(items);
  } catch (err) {
    opts.log?.warn({ err, userId: opts.userId }, 'durable memory load failed');
    return '';
  }
}

export async function resolveEffectiveTools(opts: {
  workspaceCwd: string;
  runtimeTools: string[];
  log?: LoggerLike;
}): Promise<{ effectiveTools: string[]; permissionTier: string; permissionNote?: string }> {
  const permissions = await loadWorkspacePermissions(opts.workspaceCwd, opts.log);
  const effectiveTools = resolveTools(permissions, opts.runtimeTools);
  return {
    effectiveTools,
    permissionTier: permissions?.tier ?? 'env',
    permissionNote: permissions?.note,
  };
}
