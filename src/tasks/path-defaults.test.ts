import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import os from 'node:os';
import {
  migrateLegacyTaskDataFile,
  resolveLegacyTaskDataPath,
  resolveTaskDataLoadPath,
  resolveTaskDataPath,
} from './path-defaults.js';

describe('resolveTaskDataPath', () => {
  it('returns undefined when dataDir is not provided', () => {
    expect(resolveTaskDataPath(undefined, 'tasks.jsonl')).toBeUndefined();
  });

  it('returns canonical path for tasks.jsonl', () => {
    const dataDir = '/tmp/discoclaw-data';
    const result = resolveTaskDataPath(dataDir, 'tasks.jsonl');
    expect(result).toBe(path.join(dataDir, 'tasks', 'tasks.jsonl'));
  });

  it('returns canonical path for tag-map.json', () => {
    const dataDir = '/tmp/discoclaw-data';
    const canonical = path.join(dataDir, 'tasks', 'tag-map.json');
    const result = resolveTaskDataPath(dataDir, 'tag-map.json');
    expect(result).toBe(canonical);
  });
});

describe('resolveLegacyTaskDataPath', () => {
  it('returns undefined when dataDir is not provided', () => {
    expect(resolveLegacyTaskDataPath(undefined, 'tasks.jsonl')).toBeUndefined();
  });

  it('returns legacy path for tasks.jsonl', () => {
    const dataDir = '/tmp/discoclaw-data';
    const result = resolveLegacyTaskDataPath(dataDir, 'tasks.jsonl');
    expect(result).toBe(path.join(dataDir, 'beads', 'tasks.jsonl'));
  });
});

describe('resolveTaskDataLoadPath', () => {
  it('prefers legacy path when canonical is missing', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'discoclaw-path-'));
    const legacyPath = path.join(dataDir, 'beads', 'tasks.jsonl');
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(legacyPath, '{"id":"dev-001"}\n', 'utf8');

    const resolved = await resolveTaskDataLoadPath(dataDir, 'tasks.jsonl');
    expect(resolved).toBe(legacyPath);
  });

  it('returns canonical path when neither file exists yet', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'discoclaw-path-'));
    const resolved = await resolveTaskDataLoadPath(dataDir, 'tasks.jsonl');
    expect(resolved).toBe(path.join(dataDir, 'tasks', 'tasks.jsonl'));
  });
});

describe('migrateLegacyTaskDataFile', () => {
  it('copies legacy tasks file to canonical location when missing', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'discoclaw-migrate-'));
    const fromPath = path.join(dataDir, 'beads', 'tasks.jsonl');
    const toPath = path.join(dataDir, 'tasks', 'tasks.jsonl');
    const payload = '{"id":"dev-5ayj","status":"closed"}\n';

    await fs.mkdir(path.dirname(fromPath), { recursive: true });
    await fs.writeFile(fromPath, payload, 'utf8');

    const result = await migrateLegacyTaskDataFile(dataDir, 'tasks.jsonl');
    const copied = await fs.readFile(toPath, 'utf8');

    expect(result).toEqual({ migrated: true, fromPath, toPath });
    expect(copied).toBe(payload);
  });

  it('does nothing when canonical file already exists', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'discoclaw-migrate-'));
    const toPath = path.join(dataDir, 'tasks', 'tasks.jsonl');
    const fromPath = path.join(dataDir, 'beads', 'tasks.jsonl');

    await fs.mkdir(path.dirname(toPath), { recursive: true });
    await fs.mkdir(path.dirname(fromPath), { recursive: true });
    await fs.writeFile(toPath, '{"id":"ws-001"}\n', 'utf8');
    await fs.writeFile(fromPath, '{"id":"dev-001"}\n', 'utf8');

    const result = await migrateLegacyTaskDataFile(dataDir, 'tasks.jsonl');
    const existing = await fs.readFile(toPath, 'utf8');

    expect(result).toEqual({ migrated: false });
    expect(existing).toBe('{"id":"ws-001"}\n');
  });
});
