import { describe, expect, it } from 'vitest';
import type { TaskData } from './types.js';
import {
  buildTasksByShortIdMap,
  ingestTaskSyncSnapshot,
  operationTaskIdList,
  normalizeTaskSyncBuckets,
  operationTaskIdSet,
  planTaskSyncOperations,
} from './task-sync-pipeline.js';

function task(overrides: Partial<TaskData> & Pick<TaskData, 'id' | 'title' | 'status'>): TaskData {
  return {
    id: overrides.id,
    title: overrides.title,
    status: overrides.status,
    labels: overrides.labels ?? [],
    external_ref: overrides.external_ref,
  };
}

describe('task-sync pipeline helpers', () => {
  it('ingest copies list shape without cloning task objects', () => {
    const originalTask = task({ id: 'ws-001', title: 'A', status: 'open' });
    const input = [originalTask];
    const snapshot = ingestTaskSyncSnapshot(input);

    expect(snapshot).not.toBe(input);
    expect(snapshot[0]).toBe(originalTask);
  });

  it('normalizes tasks into expected phase buckets', () => {
    const allTasks = [
      task({ id: 'ws-001', title: 'Missing ref', status: 'open' }),
      task({ id: 'ws-002', title: 'No thread', status: 'open', labels: ['no-thread'] }),
      task({ id: 'ws-003', title: 'Blocked label', status: 'open', labels: ['blocked-api'] }),
      task({ id: 'ws-004', title: 'Has ref', status: 'in_progress', external_ref: 'discord:123' }),
      task({ id: 'ws-005', title: 'Closed ref', status: 'closed', external_ref: 'discord:124' }),
    ];

    const buckets = normalizeTaskSyncBuckets(allTasks);
    expect(buckets.tasksMissingRef.map((t) => t.id)).toEqual(['ws-001', 'ws-003']);
    expect(buckets.needsBlockedTasks.map((t) => t.id)).toEqual(['ws-003']);
    expect(buckets.tasksWithRef.map((t) => t.id)).toEqual(['ws-004']);
    expect(buckets.closedTasks.map((t) => t.id)).toEqual(['ws-005']);
  });

  it('builds deterministic idempotent operation plans and phase id sets', () => {
    const buckets = {
      tasksMissingRef: [
        task({ id: 'ws-001', title: 'A', status: 'open' }),
        task({ id: 'ws-002', title: 'B', status: 'open' }),
      ],
      needsBlockedTasks: [
        task({ id: 'ws-003', title: 'C', status: 'open', labels: ['blocked-db'] }),
      ],
      tasksWithRef: [
        task({ id: 'ws-004', title: 'D', status: 'in_progress', external_ref: 'discord:11' }),
      ],
      closedTasks: [
        task({ id: 'ws-005', title: 'E', status: 'closed', external_ref: 'discord:12' }),
      ],
    };

    const operations = planTaskSyncOperations(buckets);
    expect(operations.map((op) => op.key)).toEqual([
      'task-sync:phase1:ws-001',
      'task-sync:phase1:ws-002',
      'task-sync:phase2:ws-003',
      'task-sync:phase3:ws-004',
      'task-sync:phase4:ws-005',
    ]);
    expect(operationTaskIdSet(operations, 'phase1')).toEqual(new Set(['ws-001', 'ws-002']));
    expect(operationTaskIdSet(operations, 'phase4')).toEqual(new Set(['ws-005']));
    expect(operationTaskIdList(operations, 'phase1')).toEqual(['ws-001', 'ws-002']);
    expect(operationTaskIdList(operations, 'phase3')).toEqual(['ws-004']);
  });

  it('builds a short-id lookup map for reconciliation', () => {
    const map = buildTasksByShortIdMap(
      [
        task({ id: 'ws-001', title: 'A', status: 'open' }),
        task({ id: 'dev-001', title: 'B', status: 'open' }),
        task({ id: 'ws-002', title: 'C', status: 'closed' }),
      ],
      (id) => id.split('-')[1] ?? id,
    );

    expect(map.get('001')?.map((t) => t.id)).toEqual(['ws-001', 'dev-001']);
    expect(map.get('002')?.map((t) => t.id)).toEqual(['ws-002']);
  });
});
