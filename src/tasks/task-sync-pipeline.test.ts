import { describe, expect, it } from 'vitest';
import type { TaskData } from './types.js';
import {
  buildTasksByShortIdMap,
  buildTasksByThreadIdMap,
  ingestTaskThreadSnapshots,
  ingestTaskSyncSnapshot,
  planTaskSyncApplyExecution,
  planTaskReconcileFromThreadSources,
  planTaskReconcileFromSnapshots,
  planTaskReconcileOperations,
  planTaskApplyPhases,
  type TaskSyncOperation,
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

  it('operationTaskIdList preserves in-plan order for the selected phase', () => {
    const operations: TaskSyncOperation[] = [
      { phase: 'phase2', taskId: 'ws-010', key: 'task-sync:phase2:ws-010' },
      { phase: 'phase1', taskId: 'ws-001', key: 'task-sync:phase1:ws-001' },
      { phase: 'phase3', taskId: 'ws-020', key: 'task-sync:phase3:ws-020' },
      { phase: 'phase1', taskId: 'ws-002', key: 'task-sync:phase1:ws-002' },
    ];

    expect(operationTaskIdList(operations, 'phase1')).toEqual(['ws-001', 'ws-002']);
  });

  it('builds ordered apply-phase plans from the diff operation list', () => {
    const operations: TaskSyncOperation[] = [
      { phase: 'phase3', taskId: 'ws-020', key: 'task-sync:phase3:ws-020' },
      { phase: 'phase1', taskId: 'ws-001', key: 'task-sync:phase1:ws-001' },
      { phase: 'phase4', taskId: 'ws-030', key: 'task-sync:phase4:ws-030' },
      { phase: 'phase1', taskId: 'ws-002', key: 'task-sync:phase1:ws-002' },
    ];

    const phasePlans = planTaskApplyPhases(operations);
    expect(phasePlans).toEqual([
      { phase: 'phase1', taskIds: ['ws-001', 'ws-002'] },
      { phase: 'phase2', taskIds: [] },
      { phase: 'phase3', taskIds: ['ws-020'] },
      { phase: 'phase4', taskIds: ['ws-030'] },
    ]);
  });

  it('composes stage2-4 apply execution plan from a task snapshot', () => {
    const allTasks = [
      task({ id: 'ws-001', title: 'Missing ref', status: 'open' }),
      task({ id: 'ws-003', title: 'Blocked label', status: 'open', labels: ['blocked-api'] }),
      task({ id: 'ws-004', title: 'Has ref', status: 'in_progress', external_ref: 'discord:123' }),
      task({ id: 'ws-005', title: 'Closed ref', status: 'closed', external_ref: 'discord:124' }),
    ];

    const plan = planTaskSyncApplyExecution(allTasks);
    expect(plan.operations.map((op) => op.key)).toEqual([
      'task-sync:phase1:ws-001',
      'task-sync:phase1:ws-003',
      'task-sync:phase2:ws-003',
      'task-sync:phase3:ws-004',
      'task-sync:phase4:ws-005',
    ]);
    expect(plan.phasePlans).toEqual([
      { phase: 'phase1', taskIds: ['ws-001', 'ws-003'] },
      { phase: 'phase2', taskIds: ['ws-003'] },
      { phase: 'phase3', taskIds: ['ws-004'] },
      { phase: 'phase4', taskIds: ['ws-005'] },
    ]);
    expect(plan.tasksById.get('ws-004')).toBe(allTasks[2]);
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

  it('builds a thread-id lookup map for reconciliation', () => {
    const map = buildTasksByThreadIdMap(
      [
        task({ id: 'ws-001', title: 'A', status: 'closed', external_ref: 'discord:thread-1' }),
        task({ id: 'ws-002', title: 'B', status: 'open', external_ref: 'discord:thread-2' }),
        task({ id: 'ws-003', title: 'C', status: 'open' }),
      ],
      (t) => {
        const ref = t.external_ref ?? '';
        return ref.startsWith('discord:') ? ref.slice('discord:'.length) : null;
      },
    );

    expect(map.get('thread-1')?.map((t) => t.id)).toEqual(['ws-001']);
    expect(map.get('thread-2')?.map((t) => t.id)).toEqual(['ws-002']);
    expect(map.get('thread-3')).toBeUndefined();
  });

  it('normalizes and merges phase5 thread snapshots with active-over-archived precedence', () => {
    const snapshots = ingestTaskThreadSnapshots(
      [
        { id: 'thread-1', name: 'Archived One', archived: true },
        { id: 'shared', name: 'Archived Shared', archived: true },
      ],
      [
        { id: 'shared', name: 'Active Shared', archived: false },
        { id: 2, name: null, archived: null },
      ],
    );

    expect(snapshots).toEqual([
      { id: 'thread-1', name: 'Archived One', archived: true },
      { id: 'shared', name: 'Active Shared', archived: false },
      { id: '2', name: '', archived: false },
    ]);
  });

  it('plans phase5 reconcile operations from thread snapshots', () => {
    const tasksByShortId = buildTasksByShortIdMap(
      [
        task({ id: 'ws-001', title: 'Closed A', status: 'closed', external_ref: 'discord:thread-001' }),
        task({ id: 'ws-002', title: 'Closed B', status: 'closed' }),
        task({ id: 'ws-777', title: 'Collision A', status: 'open' }),
        task({ id: 'dev-777', title: 'Collision B', status: 'open' }),
      ],
      (id) => id.split('-')[1] ?? id,
    );

    const ops = planTaskReconcileOperations({
      threads: [
        { id: 'thread-orphan', name: '🟢 [999] Orphan', archived: false },
        { id: 'thread-collision', name: '🟢 [777] Collision', archived: false },
        { id: 'thread-mismatch', name: '🟢 [001] Mismatch', archived: false },
        { id: 'thread-archive', name: '🟢 [002] Closed active', archived: false },
        { id: 'thread-reconcile', name: '☑️ [002] Closed archived', archived: true },
      ],
      tasksByShortId,
      shortIdFromThreadName: (name) => {
        const match = name.match(/\[(\d+)\]/);
        return match ? match[1] : null;
      },
      threadIdFromTask: (t) => {
        const ref = t.external_ref ?? '';
        return ref.startsWith('discord:') ? ref.slice('discord:'.length) : null;
      },
    });

    expect(ops.map((op) => op.action)).toEqual([
      'orphan',
      'collision',
      'skip_external_ref_mismatch',
      'archive_active_closed',
      'reconcile_archived_closed',
    ]);
  });

  it('plans phase5 reconcile operations directly from task and thread snapshots', () => {
    const ops = planTaskReconcileFromSnapshots({
      tasks: [
        task({ id: 'ws-001', title: 'Closed A', status: 'closed', external_ref: 'discord:thread-001' }),
        task({ id: 'ws-002', title: 'Closed B', status: 'closed' }),
        task({ id: 'ws-777', title: 'Collision A', status: 'open' }),
        task({ id: 'dev-777', title: 'Collision B', status: 'open' }),
      ],
      threads: [
        { id: 'thread-orphan', name: '🟢 [999] Orphan', archived: false },
        { id: 'thread-collision', name: '🟢 [777] Collision', archived: false },
        { id: 'thread-mismatch', name: '🟢 [001] Mismatch', archived: false },
        { id: 'thread-archive', name: '🟢 [002] Closed active', archived: false },
        { id: 'thread-reconcile', name: '☑️ [002] Closed archived', archived: true },
      ],
      shortIdOfTaskId: (id) => id.split('-')[1] ?? id,
      shortIdFromThreadName: (name) => {
        const match = name.match(/\[(\d+)\]/);
        return match ? match[1] : null;
      },
      threadIdFromTask: (t) => {
        const ref = t.external_ref ?? '';
        return ref.startsWith('discord:') ? ref.slice('discord:'.length) : null;
      },
    });

    expect(ops.map((op) => op.action)).toEqual([
      'orphan',
      'collision',
      'skip_external_ref_mismatch',
      'archive_active_closed',
      'reconcile_archived_closed',
    ]);
  });

  it('prefers thread-id mapping before thread-name parsing in reconcile planning', () => {
    const ops = planTaskReconcileFromSnapshots({
      tasks: [
        task({ id: 'ws-010', title: 'Closed mapped', status: 'closed', external_ref: 'discord:thread-linked' }),
      ],
      threads: [
        { id: 'thread-linked', name: 'General thread without token', archived: false },
      ],
      shortIdOfTaskId: (id) => id.split('-')[1] ?? id,
      shortIdFromThreadName: () => null,
      threadIdFromTask: (t) => {
        const ref = t.external_ref ?? '';
        return ref.startsWith('discord:') ? ref.slice('discord:'.length) : null;
      },
    });

    expect(ops.map((op) => op.action)).toEqual(['archive_active_closed']);
    expect(ops[0]?.task?.id).toBe('ws-010');
  });

  it('plans phase5 reconcile operations directly from archived and active thread sources', () => {
    const ops = planTaskReconcileFromThreadSources({
      tasks: [
        task({ id: 'ws-001', title: 'Closed A', status: 'closed', external_ref: 'discord:thread-001' }),
        task({ id: 'ws-002', title: 'Closed B', status: 'closed' }),
        task({ id: 'ws-777', title: 'Collision A', status: 'open' }),
        task({ id: 'dev-777', title: 'Collision B', status: 'open' }),
      ],
      archivedThreads: [
        { id: 'thread-reconcile', name: '☑️ [002] Closed archived', archived: true },
      ],
      activeThreads: [
        { id: 'thread-orphan', name: '🟢 [999] Orphan', archived: false },
        { id: 'thread-collision', name: '🟢 [777] Collision', archived: false },
        { id: 'thread-mismatch', name: '🟢 [001] Mismatch', archived: false },
        { id: 'thread-archive', name: '🟢 [002] Closed active', archived: false },
      ],
      shortIdOfTaskId: (id) => id.split('-')[1] ?? id,
      shortIdFromThreadName: (name) => {
        const match = name.match(/\[(\d+)\]/);
        return match ? match[1] : null;
      },
      threadIdFromTask: (t) => {
        const ref = t.external_ref ?? '';
        return ref.startsWith('discord:') ? ref.slice('discord:'.length) : null;
      },
    });

    expect(ops.map((op) => op.action)).toEqual([
      'reconcile_archived_closed',
      'orphan',
      'collision',
      'skip_external_ref_mismatch',
      'archive_active_closed',
    ]);
  });
});
