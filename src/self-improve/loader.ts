// ── Frozen test-case loader ─────────────────────────────────────────
//
// Loads FrozenTestCase arrays from JSON files on disk.
// Each JSON file is an array of test-case objects.
// The loader validates shape and deduplicates IDs.

import { readFile, readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import type { FrozenTestCase, FrozenTestCaseRaw } from './types.js';

// ── Validation ──────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateRaw(raw: unknown, file: string, index: number): FrozenTestCaseRaw {
  if (!isPlainObject(raw)) {
    throw new Error(`${file}[${index}]: entry must be an object`);
  }
  if (typeof raw.id !== 'string' || raw.id.length === 0) {
    throw new Error(`${file}[${index}]: "id" must be a non-empty string`);
  }
  if (typeof raw.prompt !== 'string' || raw.prompt.length === 0) {
    throw new Error(`${file}[${index}]: "prompt" must be a non-empty string`);
  }
  if (!Array.isArray(raw.expectedActions)) {
    throw new Error(`${file}[${index}]: "expectedActions" must be an array`);
  }
  // expectedActions can be empty only if forbiddenActions is present (negative-only test case).
  if (raw.expectedActions.length === 0 && (!Array.isArray(raw.forbiddenActions) || raw.forbiddenActions.length === 0)) {
    throw new Error(`${file}[${index}]: "expectedActions" must be non-empty (or provide "forbiddenActions" for negative-only cases)`);
  }
  for (let i = 0; i < raw.expectedActions.length; i++) {
    const ea = raw.expectedActions[i];
    if (!isPlainObject(ea) || typeof ea.type !== 'string' || ea.type.length === 0) {
      throw new Error(`${file}[${index}].expectedActions[${i}]: must have a non-empty "type" string`);
    }
    if (ea.params !== undefined && !isPlainObject(ea.params)) {
      throw new Error(`${file}[${index}].expectedActions[${i}]: "params" must be an object if present`);
    }
  }
  if (raw.forbiddenActions !== undefined) {
    if (!Array.isArray(raw.forbiddenActions) || !raw.forbiddenActions.every((t: unknown) => typeof t === 'string' && t.length > 0)) {
      throw new Error(`${file}[${index}]: "forbiddenActions" must be an array of non-empty strings if present`);
    }
  }
  if (raw.tags !== undefined) {
    if (!Array.isArray(raw.tags) || !raw.tags.every((t: unknown) => typeof t === 'string')) {
      throw new Error(`${file}[${index}]: "tags" must be an array of strings if present`);
    }
  }
  return raw as unknown as FrozenTestCaseRaw;
}

function rawToTestCase(raw: FrozenTestCaseRaw): FrozenTestCase {
  return {
    id: raw.id,
    prompt: raw.prompt,
    expectedActions: raw.expectedActions.map((ea) => ({
      type: ea.type,
      ...(ea.params ? { params: ea.params } : {}),
    })),
    ...(raw.forbiddenActions ? { forbiddenActions: raw.forbiddenActions } : {}),
    ...(raw.tags ? { tags: raw.tags } : {}),
  };
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Load frozen test cases from a single JSON file.
 * The file must contain a JSON array of test-case objects.
 */
export async function loadTestCasesFromFile(filePath: string): Promise<FrozenTestCase[]> {
  const text = await readFile(filePath, 'utf-8');
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error(`${filePath}: expected a JSON array at top level`);
  }
  return parsed.map((entry, i) => rawToTestCase(validateRaw(entry, filePath, i)));
}

/**
 * Load all frozen test cases from every `.json` file in a directory.
 * Validates uniqueness of IDs across all files.
 */
export async function loadTestCasesFromDir(dirPath: string): Promise<FrozenTestCase[]> {
  const entries = await readdir(dirPath);
  const jsonFiles = entries.filter((e) => extname(e) === '.json').sort();
  if (jsonFiles.length === 0) {
    return [];
  }

  const all: FrozenTestCase[] = [];
  for (const file of jsonFiles) {
    const cases = await loadTestCasesFromFile(join(dirPath, file));
    all.push(...cases);
  }

  // Deduplicate check
  const seen = new Set<string>();
  for (const tc of all) {
    if (seen.has(tc.id)) {
      throw new Error(`Duplicate test-case ID: "${tc.id}"`);
    }
    seen.add(tc.id);
  }

  return all;
}

/**
 * Filter test cases by tag.
 * Returns cases that have at least one of the specified tags.
 */
export function filterByTags(cases: FrozenTestCase[], tags: string[]): FrozenTestCase[] {
  const tagSet = new Set(tags);
  return cases.filter((tc) => tc.tags?.some((t) => tagSet.has(t)));
}
