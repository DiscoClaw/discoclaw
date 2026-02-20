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
      beadsEnabled: false,
      beadsActive: false,
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

  it('shows tasks=active when beadsActive is true', () => {
    const metrics = new MetricsRegistry();
    const verbose = renderHealthReport({
      metrics,
      queueDepth: 0,
      config: {
        runtimeModel: 'opus', runtimeTimeoutMs: 60000, runtimeTools: ['Read'],
        useRuntimeSessions: true, toolAwareStreaming: false, maxConcurrentInvocations: 0,
        discordActionsEnabled: false, summaryEnabled: true, durableMemoryEnabled: true,
        messageHistoryBudget: 3000, reactionHandlerEnabled: false, reactionRemoveHandlerEnabled: false,
        cronEnabled: true, beadsEnabled: true, beadsActive: true,
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
        cronEnabled: true, beadsEnabled: true, beadsActive: false,
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
        cronEnabled: true, beadsEnabled: false, beadsActive: false,
        requireChannelContext: true, autoIndexChannelContext: true,
      },
      mode: 'verbose',
    });
    expect(verbose).toContain('tasks=off');
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
