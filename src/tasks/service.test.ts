import { describe, expect, it, vi } from 'vitest';
import { createTaskService } from './service.js';
import { TaskStore } from './store.js';

describe('createTaskService', () => {
  it('delegates reads and writes to TaskStore', () => {
    const store = new TaskStore({ prefix: 'ws' });
    const service = createTaskService(store);

    const created = service.create({ title: 'Service task', labels: ['plan'] });
    expect(service.get(created.id)?.title).toBe('Service task');
    expect(service.list({ status: 'all' }).map((t) => t.id)).toContain(created.id);
    expect(service.findByTitle('service task')?.id).toBe(created.id);

    service.update(created.id, { status: 'in_progress' });
    expect(service.get(created.id)?.status).toBe('in_progress');

    service.addLabel(created.id, 'tag:feature');
    expect(service.get(created.id)?.labels).toContain('tag:feature');

    service.removeLabel(created.id, 'tag:feature');
    expect(service.get(created.id)?.labels).not.toContain('tag:feature');

    service.close(created.id, 'done');
    expect(service.get(created.id)?.status).toBe('closed');
  });

  it('preserves TaskStore event semantics through service writes', () => {
    const store = new TaskStore({ prefix: 'ws' });
    const service = createTaskService(store);
    const events: string[] = [];
    store.on('created', () => events.push('created'));
    store.on('updated', () => events.push('updated'));
    store.on('labeled', () => events.push('labeled'));
    store.on('closed', () => events.push('closed'));

    const task = service.create({ title: 'Event task' });
    service.update(task.id, { title: 'Event task v2' });
    service.addLabel(task.id, 'plan');
    service.removeLabel(task.id, 'plan');
    service.close(task.id);

    expect(events).toEqual(['created', 'updated', 'labeled', 'updated', 'closed']);
  });

  it('can be passed a mocked store contract for isolated callers', () => {
    const store = {
      get: vi.fn(),
      list: vi.fn(() => []),
      findByTitle: vi.fn(() => null),
      create: vi.fn((params: any) => ({ id: 'ws-001', ...params, status: 'open' })),
      update: vi.fn(),
      close: vi.fn(),
      addLabel: vi.fn(),
      removeLabel: vi.fn(),
    } as any;

    const service = createTaskService(store);
    service.create({ title: 'mocked' });
    expect(store.create).toHaveBeenCalledWith({ title: 'mocked' });
  });
});
