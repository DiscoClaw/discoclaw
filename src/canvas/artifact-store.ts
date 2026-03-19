import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const SAFE_ARTIFACT_ID_RE = /^[a-z0-9_-]+$/i;

export type CanvasArtifactMeta = {
  id: string;
  title: string;
  createdAt: string;
  lastAccessedAt: string;
  sizeBytes: number;
};

export type CanvasArtifactRecord = CanvasArtifactMeta & {
  content: string;
};

export type ArtifactStoreOptions = {
  rootDir: string;
  maxArtifacts: number;
  now?: () => number;
  idFactory?: () => string;
};

export class ArtifactStore {
  private readonly rootDir: string;
  private readonly maxArtifacts: number;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private ready = false;

  constructor(opts: ArtifactStoreOptions) {
    this.rootDir = path.resolve(opts.rootDir);
    this.maxArtifacts = opts.maxArtifacts;
    this.now = opts.now ?? (() => Date.now());
    this.idFactory = opts.idFactory ?? (() => crypto.randomUUID().replace(/-/g, '').slice(0, 16));
  }

  async ensureReady(): Promise<void> {
    if (this.ready) return;
    await fs.mkdir(this.rootDir, { recursive: true });
    this.ready = true;
  }

  rootPath(): string {
    return this.rootDir;
  }

  async createArtifact(input: { title: string; content: string }): Promise<CanvasArtifactMeta> {
    await this.ensureReady();
    await this.evictIfNeeded();

    const id = this.idFactory();
    if (!SAFE_ARTIFACT_ID_RE.test(id)) {
      throw new Error(`Artifact idFactory produced an unsafe ID: ${id}`);
    }

    const nowIso = new Date(this.now()).toISOString();
    const sizeBytes = Buffer.byteLength(input.content, 'utf8');
    const meta: CanvasArtifactMeta = {
      id,
      title: input.title.trim(),
      createdAt: nowIso,
      lastAccessedAt: nowIso,
      sizeBytes,
    };

    await fs.writeFile(this.contentPath(id), input.content, 'utf8');
    await fs.writeFile(this.metaPath(id), JSON.stringify(meta, null, 2) + '\n', 'utf8');
    return meta;
  }

  async getArtifactMeta(id: string): Promise<CanvasArtifactMeta | null> {
    await this.ensureReady();
    return this.readMeta(id);
  }

  async getArtifact(id: string): Promise<CanvasArtifactRecord | null> {
    await this.ensureReady();
    const meta = await this.readMeta(id);
    if (!meta) return null;

    let content: string;
    try {
      content = await fs.readFile(this.contentPath(id), 'utf8');
    } catch {
      return null;
    }

    const nextMeta: CanvasArtifactMeta = {
      ...meta,
      lastAccessedAt: new Date(this.now()).toISOString(),
    };
    await fs.writeFile(this.metaPath(id), JSON.stringify(nextMeta, null, 2) + '\n', 'utf8');

    return {
      ...nextMeta,
      content,
    };
  }

  async listArtifactMetas(): Promise<CanvasArtifactMeta[]> {
    await this.ensureReady();
    return this.readAllMetas();
  }

  private contentPath(id: string): string {
    return path.join(this.rootDir, `${id}.html`);
  }

  private metaPath(id: string): string {
    return path.join(this.rootDir, `${id}.meta.json`);
  }

  private async readMeta(id: string): Promise<CanvasArtifactMeta | null> {
    if (!SAFE_ARTIFACT_ID_RE.test(id)) return null;
    try {
      const raw = await fs.readFile(this.metaPath(id), 'utf8');
      const parsed = JSON.parse(raw) as Partial<CanvasArtifactMeta>;
      if (
        typeof parsed.id !== 'string'
        || typeof parsed.title !== 'string'
        || typeof parsed.createdAt !== 'string'
        || typeof parsed.lastAccessedAt !== 'string'
        || typeof parsed.sizeBytes !== 'number'
      ) {
        return null;
      }
      return {
        id: parsed.id,
        title: parsed.title,
        createdAt: parsed.createdAt,
        lastAccessedAt: parsed.lastAccessedAt,
        sizeBytes: parsed.sizeBytes,
      };
    } catch {
      return null;
    }
  }

  private async readAllMetas(): Promise<CanvasArtifactMeta[]> {
    const entries = await fs.readdir(this.rootDir, { withFileTypes: true }).catch(() => []);
    const metas = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.meta.json'))
        .map((entry) => this.readMeta(entry.name.slice(0, -'.meta.json'.length))),
    );
    return metas.filter((meta): meta is CanvasArtifactMeta => meta !== null);
  }

  private async evictIfNeeded(): Promise<void> {
    const metas = await this.readAllMetas();
    if (metas.length < this.maxArtifacts) return;

    const sorted = metas
      .slice()
      .sort((a, b) =>
        a.lastAccessedAt.localeCompare(b.lastAccessedAt)
        || a.createdAt.localeCompare(b.createdAt)
        || a.id.localeCompare(b.id));

    const toEvict = metas.length - this.maxArtifacts + 1;
    for (const meta of sorted.slice(0, toEvict)) {
      await Promise.allSettled([
        fs.unlink(this.contentPath(meta.id)),
        fs.unlink(this.metaPath(meta.id)),
      ]);
    }
  }
}
