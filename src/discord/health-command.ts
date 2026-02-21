import type { MetricsRegistry } from '../observability/metrics.js';
import { renderMemoryLine } from '../observability/memory-sampler.js';

export type HealthCommandMode = 'basic' | 'verbose' | 'tools';

export type HealthConfigSnapshot = {
  runtimeModel: string;
  runtimeTimeoutMs: number;
  runtimeTools: readonly string[];
  useRuntimeSessions: boolean;
  toolAwareStreaming: boolean;
  maxConcurrentInvocations: number;
  discordActionsEnabled: boolean;
  summaryEnabled: boolean;
  durableMemoryEnabled: boolean;
  messageHistoryBudget: number;
  reactionHandlerEnabled: boolean;
  reactionRemoveHandlerEnabled: boolean;
  cronEnabled: boolean;
  tasksEnabled: boolean;
  tasksActive: boolean;
  requireChannelContext: boolean;
  autoIndexChannelContext: boolean;
};

export function parseHealthCommand(content: string): HealthCommandMode | null {
  const normalized = String(content ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (normalized === '!health') return 'basic';
  if (normalized === '!health verbose') return 'verbose';
  if (normalized === '!health tools') return 'tools';
  return null;
}

function formatUptime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
}

function asCount(counters: Record<string, number>, name: string): number {
  return Number(counters[name] ?? 0);
}

function formatTaskSyncVerboseLines(counters: Record<string, number>): string[] {
  const started = asCount(counters, 'tasks.sync.started');
  const succeeded = asCount(counters, 'tasks.sync.succeeded');
  const failed = asCount(counters, 'tasks.sync.failed');
  const coalesced = asCount(counters, 'tasks.sync.coalesced');
  const durationTotalMs = asCount(counters, 'tasks.sync.duration_ms.total');
  const durationSamples = asCount(counters, 'tasks.sync.duration_ms.samples');
  const avgMs = durationSamples > 0
    ? Math.round((durationTotalMs / durationSamples) * 100) / 100
    : 0;

  if (started === 0 && coalesced === 0) {
    return ['Task sync: no runs yet'];
  }

  const lines: string[] = [];
  lines.push(
    `Task sync: started=${started} ok=${succeeded} failed=${failed} coalesced=${coalesced} avgMs=${avgMs}`,
  );
  lines.push(
    `Task sync transitions: created=${asCount(counters, 'tasks.sync.transition.threads_created')} archived=${asCount(counters, 'tasks.sync.transition.threads_archived')} reconciled=${asCount(counters, 'tasks.sync.transition.threads_reconciled')} orphans=${asCount(counters, 'tasks.sync.transition.orphan_threads_found')} deferred=${asCount(counters, 'tasks.sync.transition.closes_deferred')} warnings=${asCount(counters, 'tasks.sync.transition.warnings')}`,
  );
  lines.push(
    `Task sync follow-up/retry: followUp=${asCount(counters, 'tasks.sync.follow_up.scheduled')}/${asCount(counters, 'tasks.sync.follow_up.failed')} retry=${asCount(counters, 'tasks.sync.retry.scheduled')}/${asCount(counters, 'tasks.sync.retry.failed')} (coalesced=${asCount(counters, 'tasks.sync.retry.coalesced')}) failureRetry=${asCount(counters, 'tasks.sync.failure_retry.scheduled')}/${asCount(counters, 'tasks.sync.failure_retry.failed')} (coalesced=${asCount(counters, 'tasks.sync.failure_retry.coalesced')})`,
  );
  return lines;
}

export function renderHealthReport(opts: {
  metrics: MetricsRegistry;
  queueDepth: number;
  config: HealthConfigSnapshot;
  mode: HealthCommandMode;
  botDisplayName?: string;
}): string {
  const snap = opts.metrics.snapshot();
  const counters = snap.counters;
  const lines: string[] = [];

  lines.push(`${opts.botDisplayName ?? 'Discoclaw'} Health`);
  lines.push(`Uptime: ${formatUptime(Date.now() - snap.startedAt)}`);
  lines.push(`Queue depth: ${opts.queueDepth}`);
  lines.push(`Messages: ${counters['discord.message.received'] ?? 0} | Reactions: ${counters['discord.reaction.received'] ?? 0} add / ${counters['discord.reaction_remove.received'] ?? 0} remove`);
  lines.push(`Invokes: started=${(counters['invoke.message.started'] ?? 0) + (counters['invoke.reaction.started'] ?? 0) + (counters['invoke.cron.started'] ?? 0)} ` +
    `ok=${(counters['invoke.message.succeeded'] ?? 0) + (counters['invoke.reaction.succeeded'] ?? 0) + (counters['invoke.cron.succeeded'] ?? 0)} ` +
    `failed=${(counters['invoke.message.failed'] ?? 0) + (counters['invoke.reaction.failed'] ?? 0) + (counters['invoke.cron.failed'] ?? 0)}`);
  lines.push(`Actions: ok=${counters['actions.succeeded'] ?? 0} failed=${counters['actions.failed'] ?? 0}`);
  lines.push(`Cron runs: ok=${counters['cron.run.success'] ?? 0} error=${counters['cron.run.error'] ?? 0} skipped=${counters['cron.run.skipped'] ?? 0}`);

  lines.push(
    `Latency(ms): msg p50=${snap.latencies.message.p50Ms} p95=${snap.latencies.message.p95Ms}; ` +
    `reaction p50=${snap.latencies.reaction.p50Ms} p95=${snap.latencies.reaction.p95Ms}; ` +
    `cron p50=${snap.latencies.cron.p50Ms} p95=${snap.latencies.cron.p95Ms}`,
  );

  if (opts.mode === 'verbose') {
    lines.push('');
    lines.push('Config (safe)');
    lines.push(`runtimeModel=${opts.config.runtimeModel} timeoutMs=${opts.config.runtimeTimeoutMs} tools=${opts.config.runtimeTools.join(',')}`);
    lines.push(`runtimeSessions=${opts.config.useRuntimeSessions} toolAwareStreaming=${opts.config.toolAwareStreaming} maxConcurrent=${opts.config.maxConcurrentInvocations}`);
    lines.push(`actions=${opts.config.discordActionsEnabled} summary=${opts.config.summaryEnabled} durableMemory=${opts.config.durableMemoryEnabled}`);
    lines.push(`historyBudget=${opts.config.messageHistoryBudget} requireChannelContext=${opts.config.requireChannelContext} autoIndexContext=${opts.config.autoIndexChannelContext}`);
    const tasksActive = opts.config.tasksActive;
    const tasksEnabled = opts.config.tasksEnabled;
    const tasksState = tasksActive ? 'active' : tasksEnabled ? 'degraded' : 'off';
    lines.push(`reactionHandler=${opts.config.reactionHandlerEnabled} reactionRemoveHandler=${opts.config.reactionRemoveHandlerEnabled} cron=${opts.config.cronEnabled} tasks=${tasksState}`);
    lines.push(...formatTaskSyncVerboseLines(counters));

    if (snap.memory) {
      lines.push(renderMemoryLine(snap.memory));
    }

    const errorClasses = Object.keys(counters)
      .filter((k) => k.includes('.error_class.'))
      .sort();
    if (errorClasses.length > 0) {
      lines.push('Error classes:');
      for (const key of errorClasses) {
        lines.push(`- ${key}=${counters[key]}`);
      }
    }
  }

  return `\`\`\`text\n${lines.join('\n')}\n\`\`\``;
}

export function renderHealthToolsReport(opts: {
  permissionTier: string;
  effectiveTools: string[];
  configuredRuntimeTools: readonly string[];
  botDisplayName?: string;
}): string {
  const lines: string[] = [];
  lines.push(`${opts.botDisplayName ?? 'Discoclaw'} Tools`);
  lines.push(`Permission tier: ${opts.permissionTier}`);
  lines.push(`Effective tools: ${opts.effectiveTools.length > 0 ? opts.effectiveTools.join(', ') : '(none)'}`);
  lines.push(`Configured runtime tools: ${opts.configuredRuntimeTools.length > 0 ? opts.configuredRuntimeTools.join(', ') : '(none)'}`);
  return `\`\`\`text\n${lines.join('\n')}\n\`\`\``;
}
