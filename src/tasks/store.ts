import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import type { TaskData, TaskCreateParams, TaskUpdateParams, TaskListParams } from './types.js';

// ---------------------------------------------------------------------------
// Event map
// ---------------------------------------------------------------------------

type TaskStoreEventMap = {
  created: [task: TaskData];
  updated: [task: TaskData, prev: TaskData];
  closed: [task: TaskData];
  labeled: [task: TaskData, label: string];
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type TaskStoreOptions = {
  /** Short prefix for generated IDs, e.g. "ws". Default: "t". */
  prefix?: string;
  /** Absolute path to a JSONL file for persistence. Optional. */
  persistPath?: string;
};

// ---------------------------------------------------------------------------
// TaskStore
// ---------------------------------------------------------------------------

/**
 * In-process task store — an EventEmitter-backed Map that owns the read/write
 * path for task data. Replaces the external `bd` CLI dependency.
 *
 * All mutations are synchronous on the in-memory store and emit typed events
 * immediately. Persistence to a JSONL file (if configured) is fire-and-forget;
 * call `flush()` to await the latest write.
 */
export class TaskStore extends EventEmitter<TaskStoreEventMap> {
  private readonly tasks = new Map<string, TaskData>();
  private counter = 0;
  private readonly prefix: string;
  private readonly persistPath: string | undefined;
  private persistPromise: Promise<void> | null = null;

  constructor(opts: TaskStoreOptions = {}) {
    super();
    this.prefix = opts.prefix ?? 't';
    this.persistPath = opts.persistPath;
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  /**
   * Load tasks from the configured JSONL file. No-op if no persistPath was
   * given. Silently succeeds if the file does not exist yet.
   */
  async load(): Promise<void> {
    if (!this.persistPath) return;
    let content: string;
    try {
      content = await fs.readFile(this.persistPath, 'utf8');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const bead = JSON.parse(trimmed) as TaskData;
      this.tasks.set(bead.id, bead);
      // Advance the counter to be ≥ the highest numeric suffix seen,
      // but only for IDs that share our prefix to avoid contamination
      // from migrated tasks with different prefixes (e.g. dev-899 → ws-900).
      const match = new RegExp(`^${this.prefix}-(\\d+)$`).exec(bead.id);
      if (match) {
        const n = parseInt(match[1], 10);
        if (n > this.counter) this.counter = n;
      }
    }
  }

  /** Await the most recently scheduled persist, if any. */
  async flush(): Promise<void> {
    await this.persistPromise;
  }

  private schedulePersist(): void {
    if (!this.persistPath) return;
    this.persistPromise = (this.persistPromise ?? Promise.resolve())
      .then(() => this.writeToDisk())
      .catch(() => {
        // Persist errors are non-fatal; in-memory state remains authoritative.
      });
  }

  private async writeToDisk(): Promise<void> {
    if (!this.persistPath) return;
    const lines = [...this.tasks.values()].map((b) => JSON.stringify(b)).join('\n');
    await fs.writeFile(this.persistPath, lines ? lines + '\n' : '', 'utf8');
  }

  // ---------------------------------------------------------------------------
  // ID generation
  // ---------------------------------------------------------------------------

  private generateId(): string {
    this.counter++;
    return `${this.prefix}-${String(this.counter).padStart(3, '0')}`;
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /** Return the task with the given ID, or `undefined` if not found. */
  get(id: string): TaskData | undefined {
    return this.tasks.get(id);
  }

  /**
   * List tasks matching the given filters.
   *
   * - Default (no `status`): excludes closed tasks.
   * - `status: 'all'`: returns all tasks regardless of status.
   * - `status: <value>`: returns only tasks with that status.
   * - `label`: further filter by a label string.
   * - `limit`: cap the number of results (0 or omitted = no cap).
   */
  list(params: TaskListParams = {}): TaskData[] {
    let results = [...this.tasks.values()];

    if (params.status === 'all') {
      // no status filter
    } else if (params.status) {
      results = results.filter((b) => b.status === params.status);
    } else {
      results = results.filter((b) => b.status !== 'closed');
    }

    if (params.label) {
      const label = params.label;
      results = results.filter((b) => b.labels?.includes(label));
    }

    if (params.limit != null && params.limit > 0) {
      results = results.slice(0, params.limit);
    }

    return results;
  }

  /**
   * Find a non-closed task whose title matches the given string
   * (case-insensitive, trimmed). Optionally filter by label.
   * Returns the first match, or null if none found.
   */
  findByTitle(title: string, opts?: { label?: string }): TaskData | null {
    const normalized = title.trim().toLowerCase();
    if (!normalized) return null;

    const candidates = opts?.label ? this.list({ label: opts.label }) : this.list();
    const match = candidates.find(
      (b) => b.status !== 'closed' && b.title.trim().toLowerCase() === normalized,
    );
    return match ?? null;
  }

  /** Total number of tasks in the store (all statuses). */
  size(): number {
    return this.tasks.size;
  }

  // ---------------------------------------------------------------------------
  // Writes (synchronous in-memory; async persist)
  // ---------------------------------------------------------------------------

  /** Create a new task. Emits `"created"` synchronously. */
  create(params: TaskCreateParams): TaskData {
    const now = new Date().toISOString();
    const bead: TaskData = {
      id: this.generateId(),
      title: params.title,
      status: 'open',
      ...(params.description !== undefined && { description: params.description }),
      ...(params.priority !== undefined && { priority: params.priority }),
      ...(params.issueType !== undefined && { issue_type: params.issueType }),
      ...(params.owner !== undefined && { owner: params.owner }),
      ...(params.labels?.length && { labels: [...params.labels] }),
      created_at: now,
      updated_at: now,
    };
    this.tasks.set(bead.id, bead);
    this.emit('created', bead);
    this.schedulePersist();
    return bead;
  }

  /** Update fields on an existing task. Emits `"updated"` synchronously. */
  update(id: string, params: TaskUpdateParams): TaskData {
    const prev = this.tasks.get(id);
    if (!prev) throw new Error(`task not found: ${id}`);
    const now = new Date().toISOString();
    const updated: TaskData = {
      ...prev,
      ...(params.title !== undefined && { title: params.title }),
      ...(params.description !== undefined && { description: params.description }),
      ...(params.priority !== undefined && { priority: params.priority }),
      ...(params.status !== undefined && { status: params.status }),
      ...(params.owner !== undefined && { owner: params.owner }),
      ...(params.externalRef !== undefined && { external_ref: params.externalRef }),
      updated_at: now,
    };
    this.tasks.set(id, updated);
    this.emit('updated', updated, prev);
    this.schedulePersist();
    return updated;
  }

  /** Close a task. Emits `"closed"` synchronously. */
  close(id: string, reason?: string): TaskData {
    const prev = this.tasks.get(id);
    if (!prev) throw new Error(`task not found: ${id}`);
    const now = new Date().toISOString();
    const closed: TaskData = {
      ...prev,
      status: 'closed',
      closed_at: now,
      updated_at: now,
      ...(reason !== undefined && { close_reason: reason }),
    };
    this.tasks.set(id, closed);
    this.emit('closed', closed);
    this.schedulePersist();
    return closed;
  }

  /** Add a label to a task. No-op (returns existing task) if already present. Emits `"labeled"` synchronously. */
  addLabel(id: string, label: string): TaskData {
    const prev = this.tasks.get(id);
    if (!prev) throw new Error(`task not found: ${id}`);
    if (prev.labels?.includes(label)) return prev;
    const now = new Date().toISOString();
    const updated: TaskData = {
      ...prev,
      labels: [...(prev.labels ?? []), label],
      updated_at: now,
    };
    this.tasks.set(id, updated);
    this.emit('labeled', updated, label);
    this.schedulePersist();
    return updated;
  }

  /** Remove a label from a task. No-op (returns existing task) if label is absent. Emits `"updated"` synchronously. */
  removeLabel(id: string, label: string): TaskData {
    const prev = this.tasks.get(id);
    if (!prev) throw new Error(`task not found: ${id}`);
    if (!prev.labels?.includes(label)) return prev;
    const now = new Date().toISOString();
    const updated: TaskData = {
      ...prev,
      labels: prev.labels.filter((l) => l !== label),
      updated_at: now,
    };
    this.tasks.set(id, updated);
    this.emit('updated', updated, prev);
    this.schedulePersist();
    return updated;
  }
}
