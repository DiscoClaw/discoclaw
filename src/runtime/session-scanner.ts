import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { EngineEvent } from './types.js';
import { toolActivityLabel } from './tool-labels.js';

export type SessionScannerOpts = {
  sessionId: string;
  cwd: string;
  log?: { debug(...args: unknown[]): void };
};

export type SessionScannerCallbacks = {
  onEvent: (evt: EngineEvent) => void;
};

/**
 * Escape a CWD path for Claude's session directory naming.
 * `/home/user/code/proj` → `-home-user-code-proj`
 */
function escapeCwd(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

function sessionFilePath(sessionId: string, cwd: string): string {
  const home = process.env.HOME ?? '/tmp';
  const escaped = escapeCwd(cwd);
  return path.join(home, '.claude', 'projects', escaped, `${sessionId}.jsonl`);
}

type ActiveTool = { name: string; blockId: string };

export class SessionFileScanner {
  private readonly filePath: string;
  private readonly callbacks: SessionScannerCallbacks;
  private readonly log?: SessionScannerOpts['log'];

  private offset = 0;
  private lineBuf = '';
  private activeTools = new Map<string, ActiveTool>();
  private watcher: fs.FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private reading = false;

  constructor(opts: SessionScannerOpts, callbacks: SessionScannerCallbacks) {
    this.filePath = sessionFilePath(opts.sessionId, opts.cwd);
    this.callbacks = callbacks;
    this.log = opts.log;
  }

  async start(): Promise<void> {
    // Wait for the file to appear (poll with backoff, max ~10s).
    const existed = await this.waitForFile();
    if (!existed || this.stopped) return;

    // Record initial file size so we skip pre-existing content.
    try {
      const stat = await fsp.stat(this.filePath);
      this.offset = stat.size;
    } catch {
      return;
    }

    if (this.stopped) return;

    // Start watching for changes.
    try {
      this.watcher = fs.watch(this.filePath, () => {
        this.readNewBytes();
      });
      this.watcher.on('error', () => {
        // Degrade gracefully — polling fallback continues.
      });
    } catch {
      // fs.watch not available — polling alone.
    }

    // Polling fallback every 2s (fs.watch isn't reliable on all platforms).
    this.pollTimer = setInterval(() => {
      this.readNewBytes();
    }, 2000);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;

    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    // Emit tool_end for any still-active tools.
    for (const tool of this.activeTools.values()) {
      this.callbacks.onEvent({
        type: 'tool_end',
        name: tool.name,
        ok: true,
      });
    }
    this.activeTools.clear();
  }

  private async waitForFile(): Promise<boolean> {
    const delays = [100, 200, 500, 1000, 2000, 3000, 3200];
    for (const delay of delays) {
      if (this.stopped) return false;
      try {
        await fsp.access(this.filePath);
        return true;
      } catch {
        await new Promise<void>((r) => setTimeout(r, delay));
      }
    }
    this.log?.debug('session-scanner: file never appeared, degrading gracefully');
    return false;
  }

  private readNewBytes(): void {
    if (this.stopped || this.reading) return;
    this.reading = true;

    let fd: number | null = null;
    try {
      fd = fs.openSync(this.filePath, 'r');
      const stat = fs.fstatSync(fd);
      if (stat.size <= this.offset) {
        fs.closeSync(fd);
        return;
      }

      const bytesToRead = stat.size - this.offset;
      const buf = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buf, 0, bytesToRead, this.offset);
      fs.closeSync(fd);
      fd = null;
      this.offset = stat.size;

      this.lineBuf += buf.toString('utf8');
      const lines = this.lineBuf.split('\n');
      // Keep the last element as the incomplete line buffer.
      this.lineBuf = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.processLine(trimmed);
      }
    } catch {
      // Degrade gracefully on read errors.
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
    } finally {
      this.reading = false;
    }
  }

  private processLine(line: string): void {
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.log?.debug('session-scanner: parse error', line.slice(0, 200));
      return;
    }

    // Tool use: assistant message with tool_use content blocks
    if (parsed?.type === 'assistant' && Array.isArray(parsed?.message?.content)) {
      for (const block of parsed.message.content) {
        if (block?.type === 'tool_use' && typeof block.name === 'string') {
          const blockId = String(block.id ?? '');
          this.activeTools.set(blockId, { name: block.name, blockId });
          this.callbacks.onEvent({
            type: 'tool_start',
            name: block.name,
            input: block.input,
          });
        }
      }
    }

    // Tool result: user message with tool_result content blocks
    if (parsed?.type === 'user' && Array.isArray(parsed?.message?.content)) {
      for (const block of parsed.message.content) {
        if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          const toolUseId = block.tool_use_id;
          const active = this.activeTools.get(toolUseId);
          if (active) {
            this.activeTools.delete(toolUseId);
            this.callbacks.onEvent({
              type: 'tool_end',
              name: active.name,
              ok: !block.is_error,
            });
          }
        }
      }
    }
  }
}
