import { describe, expect, it } from 'vitest';
import { MetricsRegistry } from '../observability/metrics.js';
import { parseHealthCommand, renderHealthReport, renderHealthToolsReport } from './health-command.js';

describe('parseHealthCommand', () => {
  it('parses supported command forms', () => {
    expect(parseHealthCommand('!health')).toBe('basic');
    expect(parseHealthCommand('  !health   verbose ')).toBe('verbose');
    expect(parseHealthCommand('!health tools')).toBe('tools');
    expect(parseHealthCommand('!memory show')).toBeNull();
  });
});

describe('renderHealthReport', () => {
  it('renders basic and verbose reports without secrets', () => {
    const metrics = new MetricsRegistry();
    metrics.increment('discord.message.received');
    metrics.recordInvokeStart('message');
    metrics.recordInvokeResult('message', 120, false, 'timed out');

    const baseConfig = {
      runtimeModel: 'opus',
      runtimeTimeoutMs: 60000,
      runtimeTools: ['Read', 'Edit'],
      useRuntimeSessions: true,
      toolAwareStreaming: true,
      maxConcurrentInvocations: 3,
      discordActionsEnabled: true,
      summaryEnabled: true,
      durableMemoryEnabled: true,
      messageHistoryBudget: 3000,
      reactionHandlerEnabled: false,
      reactionRemoveHandlerEnabled: false,
      cronEnabled: true,
      tasksEnabled: false,
      tasksActive: false,
      tasksSyncFailureRetryEnabled: true,
      tasksSyncFailureRetryDelayMs: 30000,
      tasksSyncDeferredRetryDelayMs: 30000,
      requireChannelContext: true,
      autoIndexChannelContext: true,
    } as const;

    const base = {
      metrics,
      queueDepth: 2,
      config: baseConfig,
    };

    const basic = renderHealthReport({ ...base, mode: 'basic' });
    expect(basic).toContain('Discoclaw Health');
    expect(basic).toContain('Queue depth: 2');
    expect(basic).not.toContain('Config (safe)');

    const verbose = renderHealthReport({ ...base, mode: 'verbose' });
    expect(verbose).toContain('Config (safe)');
    expect(verbose).toContain('runtimeModel=opus');
    expect(verbose).toContain('Error classes:');
  });

  it('shows tasks=active when tasksActive is true', () => {
    const metrics = new MetricsRegistry();
    const verbose = renderHealthReport({
      metrics,
      queueDepth: 0,
      config: {
        runtimeModel: 'opus', runtimeTimeoutMs: 60000, runtimeTools: ['Read'],
        useRuntimeSessions: true, toolAwareStreaming: false, maxConcurrentInvocations: 0,
        discordActionsEnabled: false, summaryEnabled: true, durableMemoryEnabled: true,
        messageHistoryBudget: 3000, reactionHandlerEnabled: false, reactionRemoveHandlerEnabled: false,
        cronEnabled: true, tasksEnabled: true, tasksActive: true,
        tasksSyncFailureRetryEnabled: true, tasksSyncFailureRetryDelayMs: 30000, tasksSyncDeferredRetryDelayMs: 30000,
        requireChannelContext: true, autoIndexChannelContext: true,
      },
      mode: 'verbose',
    });
    expect(verbose).toContain('tasks=active');
  });

  it('shows tasks=degraded when enabled but not active', () => {
    const metrics = new MetricsRegistry();
    const verbose = renderHealthReport({
      metrics,
      queueDepth: 0,
      config: {
        runtimeModel: 'opus', runtimeTimeoutMs: 60000, runtimeTools: ['Read'],
        useRuntimeSessions: true, toolAwareStreaming: false, maxConcurrentInvocations: 0,
        discordActionsEnabled: false, summaryEnabled: true, durableMemoryEnabled: true,
        messageHistoryBudget: 3000, reactionHandlerEnabled: false, reactionRemoveHandlerEnabled: false,
        cronEnabled: true, tasksEnabled: true, tasksActive: false,
        tasksSyncFailureRetryEnabled: true, tasksSyncFailureRetryDelayMs: 30000, tasksSyncDeferredRetryDelayMs: 30000,
        requireChannelContext: true, autoIndexChannelContext: true,
      },
      mode: 'verbose',
    });
    expect(verbose).toContain('tasks=degraded');
  });

  it('shows tasks=off when explicitly disabled', () => {
    const metrics = new MetricsRegistry();
    const verbose = renderHealthReport({
      metrics,
      queueDepth: 0,
      config: {
        runtimeModel: 'opus', runtimeTimeoutMs: 60000, runtimeTools: ['Read'],
        useRuntimeSessions: true, toolAwareStreaming: false, maxConcurrentInvocations: 0,
        discordActionsEnabled: false, summaryEnabled: true, durableMemoryEnabled: true,
        messageHistoryBudget: 3000, reactionHandlerEnabled: false, reactionRemoveHandlerEnabled: false,
        cronEnabled: true, tasksEnabled: false, tasksActive: false,
        tasksSyncFailureRetryEnabled: true, tasksSyncFailureRetryDelayMs: 30000, tasksSyncDeferredRetryDelayMs: 30000,
        requireChannelContext: true, autoIndexChannelContext: true,
      },
      mode: 'verbose',
    });
    expect(verbose).toContain('tasks=off');
  });

  it('shows task sync no-runs message in verbose mode before first sync', () => {
    const metrics = new MetricsRegistry();
    const verbose = renderHealthReport({
      metrics,
      queueDepth: 0,
      config: {
        runtimeModel: 'opus', runtimeTimeoutMs: 60000, runtimeTools: ['Read'],
        useRuntimeSessions: true, toolAwareStreaming: false, maxConcurrentInvocations: 0,
        discordActionsEnabled: false, summaryEnabled: true, durableMemoryEnabled: true,
        messageHistoryBudget: 3000, reactionHandlerEnabled: false, reactionRemoveHandlerEnabled: false,
        cronEnabled: true, tasksEnabled: true, tasksActive: true,
        tasksSyncFailureRetryEnabled: true, tasksSyncFailureRetryDelayMs: 30000, tasksSyncDeferredRetryDelayMs: 30000,
        requireChannelContext: true, autoIndexChannelContext: true,
      },
      mode: 'verbose',
    });
    expect(verbose).toContain('Task sync: no runs yet');
  });

  it('shows task sync lifecycle, transition, and retry metrics in verbose mode', () => {
    const metrics = new MetricsRegistry();
    metrics.increment('tasks.sync.started', 4);
    metrics.increment('tasks.sync.succeeded', 3);
    metrics.increment('tasks.sync.failed', 1);
    metrics.increment('tasks.sync.coalesced', 2);
    metrics.increment('tasks.sync.duration_ms.total', 1100);
    metrics.increment('tasks.sync.duration_ms.samples', 4);
    metrics.increment('tasks.sync.transition.threads_created', 5);
    metrics.increment('tasks.sync.transition.thread_names_updated', 11);
    metrics.increment('tasks.sync.transition.starter_messages_updated', 12);
    metrics.increment('tasks.sync.transition.statuses_updated', 13);
    metrics.increment('tasks.sync.transition.tags_updated', 14);
    metrics.increment('tasks.sync.transition.threads_archived', 6);
    metrics.increment('tasks.sync.transition.threads_reconciled', 7);
    metrics.increment('tasks.sync.transition.orphan_threads_found', 8);
    metrics.increment('tasks.sync.transition.closes_deferred', 9);
    metrics.increment('tasks.sync.transition.warnings', 10);
    metrics.increment('tasks.sync.follow_up.scheduled', 2);
    metrics.increment('tasks.sync.follow_up.triggered', 2);
    metrics.increment('tasks.sync.follow_up.succeeded', 1);
    metrics.increment('tasks.sync.follow_up.failed', 1);
    metrics.increment('tasks.sync.follow_up.error_class.other', 1);
    metrics.increment('tasks.sync.retry.scheduled', 3);
    metrics.increment('tasks.sync.retry.triggered', 2);
    metrics.increment('tasks.sync.retry.failed', 1);
    metrics.increment('tasks.sync.retry.coalesced', 5);
    metrics.increment('tasks.sync.retry.canceled', 2);
    metrics.increment('tasks.sync.failure_retry.scheduled', 4);
    metrics.increment('tasks.sync.failure_retry.triggered', 3);
    metrics.increment('tasks.sync.failure_retry.failed', 2);
    metrics.increment('tasks.sync.failure_retry.coalesced', 6);
    metrics.increment('tasks.sync.failure_retry.canceled', 1);
    metrics.increment('tasks.sync.failure_retry.disabled', 7);

    const verbose = renderHealthReport({
      metrics,
      queueDepth: 0,
      config: {
        runtimeModel: 'opus', runtimeTimeoutMs: 60000, runtimeTools: ['Read'],
        useRuntimeSessions: true, toolAwareStreaming: false, maxConcurrentInvocations: 0,
        discordActionsEnabled: false, summaryEnabled: true, durableMemoryEnabled: true,
        messageHistoryBudget: 3000, reactionHandlerEnabled: false, reactionRemoveHandlerEnabled: false,
        cronEnabled: true, tasksEnabled: true, tasksActive: true,
        tasksSyncFailureRetryEnabled: false, tasksSyncFailureRetryDelayMs: 12000, tasksSyncDeferredRetryDelayMs: 18000,
        requireChannelContext: true, autoIndexChannelContext: true,
      },
      mode: 'verbose',
    });

    expect(verbose).toContain('Task sync: started=4 ok=3 failed=1 coalesced=2 avgMs=275');
    expect(verbose).toContain('Task sync transitions: created=5 renamed=11 starter=12 statuses=13 tags=14 archived=6 reconciled=7 orphans=8 deferred=9 warnings=10');
    expect(verbose).toContain('taskSyncPolicy: failureRetry=off failureDelayMs=12000 deferredDelayMs=18000');
    expect(verbose).toContain('Task sync follow-up/retry: followUp=2/2/1/1 retry=3/2/1 (coalesced=5 canceled=2) failureRetry=4/3/2 (coalesced=6 canceled=1 disabled=7)');
    expect(verbose).toContain('- tasks.sync.follow_up.error_class.other=1');
  });

  it('renders tools report', () => {
    const out = renderHealthToolsReport({
      permissionTier: 'standard',
      effectiveTools: ['Read', 'Edit'],
      configuredRuntimeTools: ['Read', 'Edit', 'WebSearch'],
    });
    expect(out).toContain('Discoclaw Tools');
    expect(out).toContain('Permission tier: standard');
    expect(out).toContain('Effective tools: Read, Edit');
    expect(out).toContain('Configured runtime tools: Read, Edit, WebSearch');
  });
});
