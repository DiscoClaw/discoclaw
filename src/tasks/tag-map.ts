import fs from 'node:fs/promises';
import type { TagMap } from './types.js';

/** Load a tag-map.json file: `{ "tag-name": "discord-tag-id", ... }`. */
export async function loadTagMap(filePath: string): Promise<TagMap> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as TagMap;
  } catch {
    return {};
  }
}

/**
 * Reload a tag-map.json file and mutate the existing TagMap object in-place.
 * Unlike loadTagMap(), this throws on read/parse/validation failure so callers
 * can catch and preserve the existing map. Only mutates after full validation.
 * Returns the new tag count.
 */
export async function reloadTagMapInPlace(tagMapPath: string, tagMap: TagMap): Promise<number> {
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
  // Only mutate after full validation.
  for (const key of Object.keys(tagMap)) delete tagMap[key];
  Object.assign(tagMap, newMap);
  return Object.keys(tagMap).length;
}
