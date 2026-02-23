import fs from 'node:fs/promises';
import path from 'node:path';
import type { LoggerLike } from './logging/logger-like.js';
import type { TaskStore } from './tasks/store.js';
import { cleanupOrphanedReplies } from './discord/inflight-replies.js';
import type { StatusPoster } from './discord/status-channel.js';
import type { StartupContext } from './discord/shutdown-context.js';
import { runCredentialChecks, formatCredentialReport, type CredentialCheckReport } from './health/credential-check.js';
import { healStaleTaskThreadRefs } from './health/startup-healing.js';
import type { PermissionProbeResult } from './workspace-permissions.js';

type PostConnectSystemState = {
  guildId?: string;
  systemCategoryId?: string;
  cronsForumId?: string;
  tasksForumId?: string;
  statusChannelId?: string;
} | null;

type PostConnectStartupOptions = {
  system: PostConnectSystemState;
  guildId?: string;
  scaffoldStatePath: string;
  client: Parameters<typeof cleanupOrphanedReplies>[0]['client'];
  pidLockDir: string;
  sharedTaskStore: TaskStore;
  token: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  openrouterApiKey?: string;
  openrouterBaseUrl?: string;
  workspaceCwd: string;
  statusChannel?: string;
  activeProviders: Set<string>;
  log: LoggerLike;
};

export async function runPostConnectStartupChecks(
  opts: PostConnectStartupOptions,
): Promise<{ credentialCheckReport: CredentialCheckReport; credentialReport: string }> {
  if (opts.system) {
    const newState: Record<string, string> = {};
    const resolvedGuild = opts.guildId || opts.system.guildId || '';
    if (resolvedGuild) newState.guildId = resolvedGuild;
    if (opts.system.systemCategoryId) newState.systemCategoryId = opts.system.systemCategoryId;
    if (opts.system.cronsForumId) newState.cronsForumId = opts.system.cronsForumId;
    if (opts.system.tasksForumId) newState.tasksForumId = opts.system.tasksForumId;
    if (Object.keys(newState).length > 0) {
      try {
        await fs.writeFile(opts.scaffoldStatePath, JSON.stringify(newState, null, 2) + '\n', 'utf8');
        opts.log.info({ scaffoldStatePath: opts.scaffoldStatePath }, 'system-scaffold: persisted forum IDs');
      } catch (err) {
        opts.log.warn({ err, scaffoldStatePath: opts.scaffoldStatePath }, 'system-scaffold: failed to persist forum IDs');
      }
    }
  }

  await cleanupOrphanedReplies({ client: opts.client, dataFilePath: path.join(opts.pidLockDir, 'inflight.json'), log: opts.log });

  healStaleTaskThreadRefs(opts.sharedTaskStore, opts.client, opts.log).catch((err) => {
    opts.log.warn({ err }, 'startup:heal:task thread refs failed');
  });

  const credentialCheckReport = await runCredentialChecks({
    token: opts.token,
    openaiApiKey: opts.openaiApiKey,
    openaiBaseUrl: opts.openaiBaseUrl,
    openrouterApiKey: opts.openrouterApiKey,
    openrouterBaseUrl: opts.openrouterBaseUrl,
    workspacePath: opts.workspaceCwd,
    statusChannelId: opts.statusChannel || opts.system?.statusChannelId || undefined,
    activeProviders: opts.activeProviders,
  });
  const credentialReport = formatCredentialReport(credentialCheckReport);
  if (credentialCheckReport.criticalFailures.length > 0) {
    for (const name of credentialCheckReport.criticalFailures) {
      const result = credentialCheckReport.results.find((r) => r.name === name);
      opts.log.error({ name, message: result?.message }, 'boot:credential-check: critical credential failed');
    }
  }
  for (const result of credentialCheckReport.results) {
    if (result.status === 'fail' && !credentialCheckReport.criticalFailures.includes(result.name)) {
      opts.log.warn({ name: result.name, message: result.message }, 'boot:credential-check: non-critical credential failed');
    }
  }
  opts.log.info({ credentialReport }, 'boot:credential-check');

  return { credentialCheckReport, credentialReport };
}

export function buildActionCategoriesEnabled(opts: {
  discordActionsChannels: boolean;
  discordActionsMessaging: boolean;
  discordActionsGuild: boolean;
  discordActionsModeration: boolean;
  discordActionsPolls: boolean;
  discordActionsTasks: boolean;
  tasksEnabled: boolean;
  discordActionsCrons: boolean;
  cronEnabled: boolean;
  discordActionsBotProfile: boolean;
  discordActionsForge: boolean;
  forgeCommandsEnabled: boolean;
  discordActionsPlan: boolean;
  planCommandsEnabled: boolean;
  discordActionsMemory: boolean;
  durableMemoryEnabled: boolean;
  discordActionsImagegen: boolean;
}): string[] {
  const enabled: string[] = [];
  if (opts.discordActionsChannels) enabled.push('channels');
  if (opts.discordActionsMessaging) enabled.push('messaging');
  if (opts.discordActionsGuild) enabled.push('guild');
  if (opts.discordActionsModeration) enabled.push('moderation');
  if (opts.discordActionsPolls) enabled.push('polls');
  if (opts.discordActionsTasks && opts.tasksEnabled) enabled.push('tasks');
  if (opts.discordActionsCrons && opts.cronEnabled) enabled.push('crons');
  if (opts.discordActionsBotProfile) enabled.push('bot-profile');
  if (opts.discordActionsForge && opts.forgeCommandsEnabled) enabled.push('forge');
  if (opts.discordActionsPlan && opts.planCommandsEnabled) enabled.push('plan');
  if (opts.discordActionsMemory && opts.durableMemoryEnabled) enabled.push('memory');
  if (opts.discordActionsImagegen) enabled.push('imagegen');
  return enabled;
}

export function publishBootReport(opts: {
  botStatus: StatusPoster | null;
  startupCtx: StartupContext;
  tasksEnabled: boolean;
  forumResolved: boolean;
  cronsEnabled: boolean;
  cronJobCount?: number;
  memoryEpisodicOn: boolean;
  memorySemanticOn: boolean;
  memoryWorkingOn: boolean;
  actionCategoriesEnabled: string[];
  configWarnings: number;
  permProbe: PermissionProbeResult;
  credentialReport: string;
  credentialCheckReport: CredentialCheckReport;
  runtimeModel: string;
  bootDurationMs: number;
  buildVersion?: string;
  log: LoggerLike;
}): void {
  if (!opts.botStatus?.bootReport) return;
  opts.botStatus.bootReport({
    startupType: opts.startupCtx.type,
    shutdownReason: opts.startupCtx.shutdown?.reason,
    shutdownMessage: opts.startupCtx.shutdown?.message,
    shutdownRequestedBy: opts.startupCtx.shutdown?.requestedBy,
    activeForge: opts.startupCtx.shutdown?.activeForge,
    tasksEnabled: opts.tasksEnabled,
    forumResolved: opts.forumResolved,
    cronsEnabled: opts.cronsEnabled,
    cronJobCount: opts.cronJobCount,
    memoryEpisodicOn: opts.memoryEpisodicOn,
    memorySemanticOn: opts.memorySemanticOn,
    memoryWorkingOn: opts.memoryWorkingOn,
    actionCategoriesEnabled: opts.actionCategoriesEnabled,
    configWarnings: opts.configWarnings,
    permissionsStatus: opts.permProbe.status === 'valid' ? 'ok' : opts.permProbe.status,
    permissionsReason: opts.permProbe.status === 'invalid' ? opts.permProbe.reason : undefined,
    permissionsTier: opts.permProbe.status === 'valid' ? opts.permProbe.permissions.tier : undefined,
    credentialReport: opts.credentialReport,
    credentialHealth: opts.credentialCheckReport.results.map((r) => ({
      name: r.name,
      status: r.status === 'ok' ? 'pass' : r.status,
      detail: r.message,
    })),
    runtimeModel: opts.runtimeModel,
    bootDurationMs: opts.bootDurationMs,
    buildVersion: opts.buildVersion,
  }).catch((err) => opts.log.warn({ err }, 'status-channel: boot report failed'));
}
