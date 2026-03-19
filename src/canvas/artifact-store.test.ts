import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ArtifactStore } from './artifact-store.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('ArtifactStore', () => {
  it('creates and reads artifacts while updating lastAccessedAt', async () => {
    let now = Date.parse('2026-03-18T12:00:00Z');
    const dir = await makeTempDir('discoclaw-artifact-store-');
    const store = new ArtifactStore({
      rootDir: dir,
      maxArtifacts: 10,
      now: () => now,
      idFactory: () => 'artifact-1',
    });

    const created = await store.createArtifact({
      title: 'Demo',
      content: '<!doctype html><html><body>Hello</body></html>',
    });
    expect(created.id).toBe('artifact-1');
    expect(created.lastAccessedAt).toBe('2026-03-18T12:00:00.000Z');

    now += 5_000;
    const fetched = await store.getArtifact('artifact-1');
    expect(fetched?.content).toContain('Hello');
    expect(fetched?.lastAccessedAt).toBe('2026-03-18T12:00:05.000Z');
  });

  it('evicts the least recently used artifact when the cap is exceeded', async () => {
    let now = Date.parse('2026-03-18T12:00:00Z');
    const ids = ['artifact-a', 'artifact-b', 'artifact-c'];
    const dir = await makeTempDir('discoclaw-artifact-store-');
    const store = new ArtifactStore({
      rootDir: dir,
      maxArtifacts: 2,
      now: () => now,
      idFactory: () => ids.shift()!,
    });

    await store.createArtifact({ title: 'A', content: '<!doctype html><html><body>A</body></html>' });
    now += 1_000;
    await store.createArtifact({ title: 'B', content: '<!doctype html><html><body>B</body></html>' });
    now += 1_000;
    await store.getArtifact('artifact-a');
    now += 1_000;
    await store.createArtifact({ title: 'C', content: '<!doctype html><html><body>C</body></html>' });

    expect(await store.getArtifactMeta('artifact-a')).not.toBeNull();
    expect(await store.getArtifactMeta('artifact-b')).toBeNull();
    expect(await store.getArtifactMeta('artifact-c')).not.toBeNull();
  });
});
