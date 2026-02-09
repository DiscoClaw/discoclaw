import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

type Store = Record<string, string>; // sessionKey -> UUID

async function readJsonIfExists(filePath: string): Promise<Store> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as Store;
    return {};
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return {};
    throw err;
  }
}

async function atomicWriteJson(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, filePath);
}

export class SessionManager {
  private storePath: string;
  private store: Store | null = null;

  constructor(storePath: string) {
    this.storePath = storePath;
  }

  private async load(): Promise<Store> {
    if (this.store) return this.store;
    this.store = await readJsonIfExists(this.storePath);
    return this.store;
  }

  async getOrCreate(sessionKey: string): Promise<string> {
    const store = await this.load();
    const existing = store[sessionKey];
    if (existing) return existing;
    const id = crypto.randomUUID();
    store[sessionKey] = id;
    await atomicWriteJson(this.storePath, store);
    return id;
  }
}
