import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CanvasFileExport } from './file-export.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('CanvasFileExport', () => {
  it('saves allowed exports and auto-suffixes conflicting names', async () => {
    const dir = await makeTempDir('discoclaw-canvas-export-');
    const exporter = new CanvasFileExport({ rootDir: dir, maxBytes: 1024 });

    const first = await exporter.saveExport({
      suggestedName: 'report.md',
      mimeType: 'text/markdown',
      encoding: 'utf8',
      content: '# First',
    });
    const second = await exporter.saveExport({
      suggestedName: 'report.md',
      mimeType: 'text/markdown',
      encoding: 'utf8',
      content: '# Second',
    });

    expect(first.fileName).toBe('report.md');
    expect(second.fileName).toBe('report-2.md');
    expect(await fs.readFile(path.join(dir, second.fileName), 'utf8')).toBe('# Second');
  });

  it('rejects suggested filenames with path traversal markers', async () => {
    const dir = await makeTempDir('discoclaw-canvas-export-');
    const exporter = new CanvasFileExport({ rootDir: dir, maxBytes: 1024 });

    await expect(exporter.saveExport({
      suggestedName: '../report.md',
      mimeType: 'text/markdown',
      encoding: 'utf8',
      content: '# Nope',
    })).rejects.toThrow(/must not contain directories or traversal markers/);
  });

  it('allocates unique filenames under concurrent writes for the same suggestion', async () => {
    const dir = await makeTempDir('discoclaw-canvas-export-');
    const exporter = new CanvasFileExport({ rootDir: dir, maxBytes: 1024 });

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) => exporter.saveExport({
        suggestedName: 'chart.png',
        mimeType: 'image/png',
        encoding: 'base64',
        content: Buffer.from(`png-${index}`, 'utf8').toString('base64'),
      })),
    );

    expect(new Set(results.map((result) => result.fileName)).size).toBe(6);
    const savedFiles = await fs.readdir(dir);
    expect(savedFiles.filter((name) => name.endsWith('.png')).length).toBe(6);
  });

  it('rejects unsupported MIME types and oversize payloads', async () => {
    const dir = await makeTempDir('discoclaw-canvas-export-');
    const exporter = new CanvasFileExport({ rootDir: dir, maxBytes: 4 });

    await expect(exporter.saveExport({
      suggestedName: 'archive.zip',
      mimeType: 'application/zip',
      encoding: 'utf8',
      content: 'zip',
    })).rejects.toThrow(/Unsupported export MIME type/);

    await expect(exporter.saveExport({
      suggestedName: 'big.txt',
      mimeType: 'text/plain',
      encoding: 'utf8',
      content: '12345',
    })).rejects.toThrow(/exceeds 4 byte limit/);
  });
});
