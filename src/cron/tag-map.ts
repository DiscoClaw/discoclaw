import fs from 'node:fs/promises';
import type { TagMap } from './discord-sync.js';

/**
 * Strict tag-map loader for the cron subsystem.
 * Unlike the permissive beads loadTagMap(), this throws on any failure
 * (read error, invalid JSON, wrong shape) so callers can handle it explicitly.
 */
export async function loadCronTagMapStrict(tagMapPath: string): Promise<TagMap> {
  const raw = await fs.readFile(tagMapPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`tag-map.json must be a JSON object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`);
  }
  const map: TagMap = {};
  for (const [key, val] of Object.entries(parsed)) {
    if (typeof val !== 'string') {
      throw new Error(`tag-map.json value for "${key}" must be a string, got ${typeof val}`);
    }
    map[key] = val;
  }
  return map;
}

/**
 * Reload tag-map.json and mutate the existing TagMap in-place.
 * Same validate-then-mutate pattern as beads reloadTagMapInPlace:
 * only mutates after full validation, throws on any failure so callers
 * can catch and preserve the existing cached map.
 * Returns the new tag count.
 */
export async function reloadCronTagMapInPlace(tagMapPath: string, tagMap: TagMap): Promise<number> {
  const raw = await fs.readFile(tagMapPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`tag-map.json must be a JSON object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`);
  }
  const newMap: TagMap = {};
  for (const [key, val] of Object.entries(parsed)) {
    if (typeof val !== 'string') {
      throw new Error(`tag-map.json value for "${key}" must be a string, got ${typeof val}`);
    }
    newMap[key] = val;
  }
  // Only mutate after full validation
  for (const key of Object.keys(tagMap)) delete tagMap[key];
  Object.assign(tagMap, newMap);
  return Object.keys(tagMap).length;
}
