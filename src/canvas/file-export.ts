import fs from 'node:fs/promises';
import path from 'node:path';

const MIME_EXTENSION_MAP: Record<string, string> = {
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/html': 'html',
  'application/json': 'json',
  'text/csv': 'csv',
};

export const ALLOWED_CANVAS_EXPORT_MIME_TYPES = new Set(Object.keys(MIME_EXTENSION_MAP));

export type CanvasExportRequest = {
  suggestedName?: string;
  mimeType: string;
  encoding: 'utf8' | 'base64';
  content: string;
};

export type CanvasExportResult = {
  absolutePath: string;
  relativePath: string;
  fileName: string;
  bytes: number;
  mimeType: string;
};

export type FileExportOptions = {
  rootDir: string;
  maxBytes: number;
};

export class CanvasFileExport {
  private readonly rootDir: string;
  private readonly maxBytes: number;
  private ready = false;

  constructor(opts: FileExportOptions) {
    this.rootDir = path.resolve(opts.rootDir);
    this.maxBytes = opts.maxBytes;
  }

  async ensureReady(): Promise<void> {
    if (this.ready) return;
    await fs.mkdir(this.rootDir, { recursive: true });
    this.ready = true;
  }

  rootPath(): string {
    return this.rootDir;
  }

  maxAllowedBytes(): number {
    return this.maxBytes;
  }

  async saveExport(req: CanvasExportRequest): Promise<CanvasExportResult> {
    await this.ensureReady();

    if (!ALLOWED_CANVAS_EXPORT_MIME_TYPES.has(req.mimeType)) {
      throw new Error(`Unsupported export MIME type: ${req.mimeType}`);
    }

    const buffer = this.decodeContent(req.encoding, req.content);
    if (buffer.byteLength > this.maxBytes) {
      throw new Error(`Export exceeds ${this.maxBytes} byte limit`);
    }

    const fileName = this.sanitizeFileName(req.suggestedName, req.mimeType);
    const absolutePath = await this.writeUniqueFile(fileName, buffer);

    const relativePath = path.relative(this.rootDir, absolutePath).replaceAll(path.sep, '/');
    return {
      absolutePath,
      relativePath,
      fileName: path.basename(absolutePath),
      bytes: buffer.byteLength,
      mimeType: req.mimeType,
    };
  }

  private decodeContent(encoding: CanvasExportRequest['encoding'], content: string): Buffer {
    if (encoding === 'utf8') return Buffer.from(content, 'utf8');
    if (encoding === 'base64') return Buffer.from(content, 'base64');
    throw new Error(`Unsupported export encoding: ${String(encoding)}`);
  }

  private sanitizeFileName(suggestedName: string | undefined, mimeType: string): string {
    const extension = MIME_EXTENSION_MAP[mimeType];
    const raw = String(suggestedName ?? '').trim();
    if (raw.includes('/') || raw.includes('\\') || raw.includes('..') || path.isAbsolute(raw)) {
      throw new Error('Suggested export filename must not contain directories or traversal markers');
    }
    const baseNameOnly = raw.split(/[\\/]+/).pop() ?? '';
    const extname = path.extname(baseNameOnly).replace(/^\./, '').toLowerCase();
    const stem = (extname ? baseNameOnly.slice(0, -(extname.length + 1)) : baseNameOnly)
      .replace(/[^a-zA-Z0-9._ -]+/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-. ]+|[-. ]+$/g, '')
      .slice(0, 80);

    const safeStem = stem || 'canvas-export';
    const safeExt = extname === extension ? extension : extension;
    return `${safeStem}.${safeExt}`;
  }

  private async writeUniqueFile(fileName: string, buffer: Buffer): Promise<string> {
    const base = path.basename(fileName);
    const ext = path.extname(base);
    const stem = ext ? base.slice(0, -ext.length) : base;
    const root = this.rootDir;

    for (let index = 0; index < 10_000; index++) {
      const candidateName = index === 0 ? base : `${stem}-${index + 1}${ext}`;
      const candidatePath = path.resolve(root, candidateName);
      if (candidatePath !== path.join(root, candidateName)) {
        throw new Error('Resolved export path escapes the export root');
      }
      try {
        await fs.writeFile(candidatePath, buffer, { flag: 'wx' });
        return candidatePath;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') continue;
        throw err;
      }
    }

    throw new Error('Failed to allocate a unique export path');
  }
}
