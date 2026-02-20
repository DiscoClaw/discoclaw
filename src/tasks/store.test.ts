import { beforeEach, describe, expect, it } from 'vitest';
import { TaskStore } from './store.js';
import type { TaskData } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore(prefix = 'ws'): TaskStore {
  return new TaskStore({ prefix });
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

describe('TaskStore — ID generation', () => {
  it('generates sequential IDs with the given prefix', () => {
    const store = makeStore();
    const a = store.create({ title: 'First' });
    const b = store.create({ title: 'Second' });
    expect(a.id).toBe('ws-001');
    expect(b.id).toBe('ws-002');
  });

  it('pads counter to at least 3 digits', () => {
    const store = makeStore();
    const t = store.create({ title: 'T' });
    expect(t.id).toMatch(/^ws-\d{3}$/);
  });

  it('uses default prefix "t" when none provided', () => {
    const store = new TaskStore();
    const t = store.create({ title: 'T' });
    expect(t.id).toMatch(/^t-\d{3}$/);
  });
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe('TaskStore — create', () => {
  let store: TaskStore;
  beforeEach(() => { store = makeStore(); });

  it('stores the task with status "open"', () => {
    const t = store.create({ title: 'My task' });
    expect(t.status).toBe('open');
    expect(store.get(t.id)).toBe(t);
  });

  it('stores optional fields', () => {
    const t = store.create({
      title: 'T',
      description: 'desc',
      priority: 1,
      issueType: 'bug',
      owner: 'alice',
      labels: ['tag:feature'],
    });
    expect(t.description).toBe('desc');
    expect(t.priority).toBe(1);
    expect(t.issue_type).toBe('bug');
    expect(t.owner).toBe('alice');
    expect(t.labels).toEqual(['tag:feature']);
  });

  it('sets created_at and updated_at', () => {
    const t = store.create({ title: 'T' });
    expect(t.created_at).toBeDefined();
    expect(t.updated_at).toBeDefined();
  });

  it('emits "created" event synchronously', () => {
    const emitted: TaskData[] = [];
    store.on('created', (b) => emitted.push(b));
    const t = store.create({ title: 'T' });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toBe(t);
  });

  it('does not share labels array with caller', () => {
    const labels = ['a', 'b'];
    const t = store.create({ title: 'T', labels });
    labels.push('c');
    expect(t.labels).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

describe('TaskStore — get', () => {
  it('returns undefined for unknown id', () => {
    const store = makeStore();
    expect(store.get('ws-999')).toBeUndefined();
  });

  it('returns the stored task', () => {
    const store = makeStore();
    const t = store.create({ title: 'T' });
    expect(store.get(t.id)).toBe(t);
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe('TaskStore — list', () => {
  let store: TaskStore;

  beforeEach(() => {
    store = makeStore();
    store.create({ title: 'Open A' });
    store.create({ title: 'Open B' });
    const c = store.create({ title: 'Closed C' });
    store.close(c.id);
  });

  it('excludes closed tasks by default', () => {
    const results = store.list();
    expect(results).toHaveLength(2);
    expect(results.every((b) => b.status !== 'closed')).toBe(true);
  });

  it('includes all tasks when status is "all"', () => {
    const results = store.list({ status: 'all' });
    expect(results).toHaveLength(3);
  });

  it('filters by status', () => {
    const t = store.create({ title: 'IP' });
    store.update(t.id, { status: 'in_progress' });
    const results = store.list({ status: 'in_progress' });
    expect(results.every((b) => b.status === 'in_progress')).toBe(true);
  });

  it('filters by label', () => {
    const t = store.create({ title: 'Labeled' });
    store.addLabel(t.id, 'plan');
    const results = store.list({ label: 'plan' });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(t.id);
  });

  it('respects limit', () => {
    const results = store.list({ limit: 1 });
    expect(results).toHaveLength(1);
  });

  it('limit 0 means no cap', () => {
    const results = store.list({ limit: 0 });
    expect(results).toHaveLength(2); // the two open tasks
  });
});

// ---------------------------------------------------------------------------
// findByTitle
// ---------------------------------------------------------------------------

describe('TaskStore — findByTitle', () => {
  let store: TaskStore;
  beforeEach(() => { store = makeStore(); });

  it('returns matching non-closed task (case-insensitive, trimmed)', () => {
    const t = store.create({ title: '  Fix The Bug  ' });
    const found = store.findByTitle('fix the bug');
    expect(found?.id).toBe(t.id);
  });

  it('returns null when no title matches', () => {
    store.create({ title: 'Something else' });
    expect(store.findByTitle('Fix the bug')).toBeNull();
  });

  it('skips closed tasks', () => {
    const t = store.create({ title: 'Fix the bug' });
    store.close(t.id);
    expect(store.findByTitle('Fix the bug')).toBeNull();
  });

  it('returns null for empty or whitespace-only title', () => {
    expect(store.findByTitle('')).toBeNull();
    expect(store.findByTitle('   ')).toBeNull();
  });

  it('filters by label when provided', () => {
    const a = store.create({ title: 'Shared title' });
    store.addLabel(a.id, 'plan');
    const b = store.create({ title: 'Shared title' });

    // Without label filter — first match (insertion order)
    expect(store.findByTitle('Shared title')?.id).toBe(a.id);
    // With label filter — only the labelled one matches
    expect(store.findByTitle('Shared title', { label: 'plan' })?.id).toBe(a.id);
    // Label filter excludes the unlabelled task
    expect(store.findByTitle('Shared title', { label: 'nope' })).toBeNull();
    void b; // suppress unused-variable warning
  });

  it('returns first match when multiple tasks have the same title', () => {
    const a = store.create({ title: 'Dup' });
    store.create({ title: 'Dup' });
    expect(store.findByTitle('Dup')?.id).toBe(a.id);
  });
});

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

describe('TaskStore — update', () => {
  let store: TaskStore;
  beforeEach(() => { store = makeStore(); });

  it('updates fields and reflects them in the store', () => {
    const t = store.create({ title: 'Old title' });
    const updated = store.update(t.id, { title: 'New title', priority: 1 });
    expect(updated.title).toBe('New title');
    expect(updated.priority).toBe(1);
    expect(store.get(t.id)?.title).toBe('New title');
  });

  it('sets updated_at', () => {
    const t = store.create({ title: 'T' });
    const updated = store.update(t.id, { title: 'New' });
    expect(updated.updated_at).toBeDefined();
  });

  it('emits "updated" with next bead and previous bead', () => {
    const t = store.create({ title: 'T' });
    const events: Array<[TaskData, TaskData]> = [];
    store.on('updated', (b, prev) => events.push([b, prev]));
    store.update(t.id, { title: 'Updated' });
    expect(events).toHaveLength(1);
    expect(events[0][0].title).toBe('Updated');
    expect(events[0][1].title).toBe('T');
  });

  it('does not mutate the previous snapshot passed to the event', () => {
    const t = store.create({ title: 'T' });
    let capturedPrev: TaskData | undefined;
    store.on('updated', (_, prev) => { capturedPrev = prev; });
    store.update(t.id, { title: 'Updated' });
    expect(capturedPrev?.title).toBe('T');
  });

  it('throws for unknown id', () => {
    expect(() => store.update('ws-999', { title: 'x' })).toThrow('task not found');
  });

  it('updates externalRef', () => {
    const t = store.create({ title: 'T' });
    const updated = store.update(t.id, { externalRef: 'discord:123' });
    expect(updated.external_ref).toBe('discord:123');
  });
});

// ---------------------------------------------------------------------------
// close
// ---------------------------------------------------------------------------

describe('TaskStore — close', () => {
  let store: TaskStore;
  beforeEach(() => { store = makeStore(); });

  it('sets status to "closed" and records closed_at', () => {
    const t = store.create({ title: 'T' });
    const closed = store.close(t.id);
    expect(closed.status).toBe('closed');
    expect(closed.closed_at).toBeDefined();
  });

  it('records close_reason when provided', () => {
    const t = store.create({ title: 'T' });
    const closed = store.close(t.id, 'done');
    expect(closed.close_reason).toBe('done');
  });

  it('omits close_reason when not provided', () => {
    const t = store.create({ title: 'T' });
    const closed = store.close(t.id);
    expect(closed.close_reason).toBeUndefined();
  });

  it('emits "closed" event synchronously', () => {
    const t = store.create({ title: 'T' });
    const events: TaskData[] = [];
    store.on('closed', (b) => events.push(b));
    store.close(t.id);
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('closed');
  });

  it('reflects closed status in subsequent list calls', () => {
    const t = store.create({ title: 'T' });
    store.close(t.id);
    expect(store.list().find((b) => b.id === t.id)).toBeUndefined();
    expect(store.list({ status: 'all' }).find((b) => b.id === t.id)).toBeDefined();
  });

  it('throws for unknown id', () => {
    expect(() => store.close('ws-999')).toThrow('task not found');
  });
});

// ---------------------------------------------------------------------------
// addLabel
// ---------------------------------------------------------------------------

describe('TaskStore — addLabel', () => {
  let store: TaskStore;
  beforeEach(() => { store = makeStore(); });

  it('adds a label to a task', () => {
    const t = store.create({ title: 'T' });
    const updated = store.addLabel(t.id, 'plan');
    expect(updated.labels).toContain('plan');
    expect(store.get(t.id)?.labels).toContain('plan');
  });

  it('is idempotent — does not duplicate labels', () => {
    const t = store.create({ title: 'T' });
    store.addLabel(t.id, 'plan');
    const result = store.addLabel(t.id, 'plan');
    expect(result.labels?.filter((l) => l === 'plan')).toHaveLength(1);
  });

  it('returns the same reference without mutation when label already present', () => {
    const t = store.create({ title: 'T' });
    store.addLabel(t.id, 'plan');
    const after = store.get(t.id)!;
    const result = store.addLabel(t.id, 'plan');
    expect(result).toBe(after); // no copy made
  });

  it('emits "labeled" event with the bead and label', () => {
    const t = store.create({ title: 'T' });
    const events: Array<[TaskData, string]> = [];
    store.on('labeled', (b, label) => events.push([b, label]));
    store.addLabel(t.id, 'plan');
    expect(events).toHaveLength(1);
    expect(events[0][1]).toBe('plan');
    expect(events[0][0].labels).toContain('plan');
  });

  it('does not emit when label already present', () => {
    const t = store.create({ title: 'T' });
    store.addLabel(t.id, 'plan');
    const events: unknown[] = [];
    store.on('labeled', () => events.push(null));
    store.addLabel(t.id, 'plan');
    expect(events).toHaveLength(0);
  });

  it('throws for unknown id', () => {
    expect(() => store.addLabel('ws-999', 'plan')).toThrow('task not found');
  });
});

// ---------------------------------------------------------------------------
// removeLabel
// ---------------------------------------------------------------------------

describe('TaskStore — removeLabel', () => {
  let store: TaskStore;
  beforeEach(() => { store = makeStore(); });

  it('removes an existing label', () => {
    const t = store.create({ title: 'T', labels: ['plan', 'bug'] });
    const updated = store.removeLabel(t.id, 'plan');
    expect(updated.labels).not.toContain('plan');
    expect(updated.labels).toContain('bug');
  });

  it('is a no-op and returns the same reference when label is absent', () => {
    const t = store.create({ title: 'T', labels: ['bug'] });
    const result = store.removeLabel(t.id, 'plan');
    expect(result).toBe(t);
  });

  it('emits "updated" when a label is removed', () => {
    const t = store.create({ title: 'T', labels: ['plan'] });
    const events: Array<[TaskData, TaskData]> = [];
    store.on('updated', (b, prev) => events.push([b, prev]));
    store.removeLabel(t.id, 'plan');
    expect(events).toHaveLength(1);
    expect(events[0][1].labels).toContain('plan');
    expect(events[0][0].labels).not.toContain('plan');
  });

  it('does not emit when label is absent', () => {
    const t = store.create({ title: 'T' });
    const events: unknown[] = [];
    store.on('updated', () => events.push(null));
    store.removeLabel(t.id, 'plan');
    expect(events).toHaveLength(0);
  });

  it('throws for unknown id', () => {
    expect(() => store.removeLabel('ws-999', 'plan')).toThrow('task not found');
  });
});

// ---------------------------------------------------------------------------
// size
// ---------------------------------------------------------------------------

describe('TaskStore — size', () => {
  it('returns 0 for an empty store', () => {
    const store = makeStore();
    expect(store.size()).toBe(0);
  });

  it('counts all tasks including closed ones', () => {
    const store = makeStore();
    store.create({ title: 'A' });
    const b = store.create({ title: 'B' });
    store.close(b.id);
    expect(store.size()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Persistence (JSONL)
// ---------------------------------------------------------------------------

describe('TaskStore — persistence', () => {
  it('saves and loads tasks from a JSONL file', async () => {
    const fsp = await import('node:fs/promises');
    const path = '/tmp/discoclaw-test-store.jsonl';
    await fsp.default.unlink(path).catch(() => {});

    const store1 = new TaskStore({ prefix: 'ws', persistPath: path });
    store1.create({ title: 'Alpha' });
    store1.create({ title: 'Beta' });
    await store1.flush();

    const store2 = new TaskStore({ prefix: 'ws', persistPath: path });
    await store2.load();
    expect(store2.size()).toBe(2);
    expect(store2.list({ status: 'all' }).map((b) => b.title).sort()).toEqual(['Alpha', 'Beta']);

    await fsp.default.unlink(path).catch(() => {});
  });

  it('resumes the ID counter from the highest loaded ID', async () => {
    const fsp = await import('node:fs/promises');
    const path = '/tmp/discoclaw-test-store-counter.jsonl';
    await fsp.default.unlink(path).catch(() => {});

    const store1 = new TaskStore({ prefix: 'ws', persistPath: path });
    store1.create({ title: 'A' }); // ws-001
    store1.create({ title: 'B' }); // ws-002
    await store1.flush();

    const store2 = new TaskStore({ prefix: 'ws', persistPath: path });
    await store2.load();
    const c = store2.create({ title: 'C' });
    expect(c.id).toBe('ws-003');

    await fsp.default.unlink(path).catch(() => {});
  });

  it('handles a missing file gracefully (ENOENT)', async () => {
    const store = new TaskStore({ prefix: 'ws', persistPath: '/tmp/no-such-file-99999.jsonl' });
    await expect(store.load()).resolves.toBeUndefined();
    expect(store.size()).toBe(0);
  });

  it('persists updates and closes', async () => {
    const fsp = await import('node:fs/promises');
    const path = '/tmp/discoclaw-test-store-updates.jsonl';
    await fsp.default.unlink(path).catch(() => {});

    const store1 = new TaskStore({ prefix: 'ws', persistPath: path });
    const t = store1.create({ title: 'T' });
    store1.update(t.id, { title: 'Updated T' });
    store1.close(t.id, 'done');
    await store1.flush();

    const store2 = new TaskStore({ prefix: 'ws', persistPath: path });
    await store2.load();
    const loaded = store2.get(t.id)!;
    expect(loaded.status).toBe('closed');
    expect(loaded.title).toBe('Updated T');
    expect(loaded.close_reason).toBe('done');

    await fsp.default.unlink(path).catch(() => {});
  });

  it('is a no-op when no persistPath is configured', async () => {
    const store = new TaskStore({ prefix: 'ws' });
    store.create({ title: 'T' });
    await expect(store.flush()).resolves.toBeUndefined();
    await expect(store.load()).resolves.toBeUndefined();
  });
});
