import path from 'node:path';
import { isSnowflake } from './discord/system-bootstrap.js';

/**
 * Resolve the persistent session store path.
 * Uses the configured data dir when present, otherwise defaults to <projectRoot>/data.
 */
export function resolveSessionStorePath(dataDir: string | undefined, projectRoot: string): string {
  const configured = (dataDir ?? '').trim();
  const baseDir = configured || path.join(projectRoot, 'data');
  return path.join(baseDir, 'sessions.json');
}

/**
 * Resolve the forum ID to use for cron tag bootstrap.
 * Prefer the forum ID returned by initCronForum; if unavailable, only accept a
 * configured forum reference when it is already a snowflake.
 */
export function resolveCronTagBootstrapForumId(params: {
  resolvedForumId?: string | null;
  configuredForumRef?: string | null;
}): string | null {
  const resolved = String(params.resolvedForumId ?? '').trim();
  if (resolved) return resolved;

  const configured = String(params.configuredForumRef ?? '').trim();
  if (isSnowflake(configured)) return configured;

  return null;
}
