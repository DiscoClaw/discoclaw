import type { ForumChannel } from 'discord.js';
import type { DiscordActionResult, ActionContext } from './actions.js';
import type { LoggerLike } from './action-types.js';
import type { StatusPoster } from './status-channel.js';
import type { RuntimeAdapter } from '../runtime/types.js';
import type { TagMap, TaskData, TaskStatus, TaskSyncResult } from '../tasks/types.js';
import type { BeadSyncCoordinator } from '../beads/bead-sync-coordinator.js';
import type { ForumCountSync } from './forum-count-sync.js';

/** Pre-computed set for filtering status names from tag candidates. */
import { TASK_STATUSES, isTaskStatus } from '../tasks/types.js';
const STATUS_NAME_SET = new Set<string>(TASK_STATUSES);
import type { TaskStore } from '../tasks/store.js';
import {
  resolveBeadsForum,
  createBeadThread,
  closeBeadThread,
  updateBeadThreadName,
  updateBeadStarterMessage,
  updateBeadThreadTags,
  ensureUnarchived,
  getThreadIdFromBead,
  reloadTagMapInPlace,
} from '../beads/discord-sync.js';
import { autoTagBead } from '../beads/auto-tag.js';
import { beadThreadCache } from '../beads/bead-thread-cache.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskActionRequest =
  | { type: 'beadCreate'; title: string; description?: string; priority?: number; tags?: string }
  | { type: 'beadUpdate'; beadId: string; title?: string; description?: string; priority?: number; status?: string }
  | { type: 'beadClose'; beadId: string; reason?: string }
  | { type: 'beadShow'; beadId: string }
  | { type: 'beadList'; status?: string; label?: string; limit?: number }
  | { type: 'beadSync' }
  | { type: 'tagMapReload' };

const TASK_TYPE_MAP: Record<TaskActionRequest['type'], true> = {
  beadCreate: true,
  beadUpdate: true,
  beadClose: true,
  beadShow: true,
  beadList: true,
  beadSync: true,
  tagMapReload: true,
};
export const TASK_ACTION_TYPES = new Set<string>(Object.keys(TASK_TYPE_MAP));

export type TaskContext = {
  beadsCwd: string;
  forumId: string;
  tagMap: TagMap;
  tagMapPath?: string;
  store: TaskStore;
  runtime: RuntimeAdapter;
  autoTag: boolean;
  autoTagModel: string;
  mentionUserId?: string;
  sidebarMentionUserId?: string;
  statusPoster?: StatusPoster;
  log?: LoggerLike;
  syncCoordinator?: BeadSyncCoordinator;
  forumCountSync?: ForumCountSync;
};

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export async function executeTaskAction(
  action: TaskActionRequest,
  ctx: ActionContext,
  taskCtx: TaskContext,
): Promise<DiscordActionResult> {
  switch (action.type) {
    case 'beadCreate': {
      if (!action.title) {
        return { ok: false, error: 'beadCreate requires a title' };
      }

      // Resolve labels from tags string (comma-separated).
      const labels: string[] = [];
      if (action.tags) {
        labels.push(...action.tags.split(',').map((t) => t.trim()).filter(Boolean));
      }

      const bead = taskCtx.store.create({
        title: action.title,
        description: action.description,
        priority: action.priority,
        labels,
      });

      // Auto-tag if enabled and we have available tags (excluding status tags).
      const tagNames = Object.keys(taskCtx.tagMap).filter(k => !STATUS_NAME_SET.has(k));
      if (taskCtx.autoTag && tagNames.length > 0) {
        try {
          const suggestedTags = await autoTagBead(
            taskCtx.runtime,
            bead.title,
            bead.description ?? '',
            tagNames,
            { model: taskCtx.autoTagModel, cwd: taskCtx.beadsCwd },
          );
          for (const tag of suggestedTags) {
            if (!labels.includes(tag)) labels.push(tag);
          }
          for (const tag of suggestedTags) {
            try { taskCtx.store.addLabel(bead.id, `tag:${tag}`); } catch {}
          }
        } catch (err) {
          taskCtx.log?.warn({ err, beadId: bead.id }, 'beads:auto-tag failed');
        }
      }

      // Create Discord thread.
      let threadId = '';
      try {
        // Honor no-thread policy across all implementations.
        if (labels.includes('no-thread') || (bead.labels ?? []).includes('no-thread')) {
          // Skip thread creation.
        } else {
          const forum = await resolveBeadsForum(ctx.guild, taskCtx.forumId);
          if (forum) {
          // Merge auto-tag labels into bead data for thread creation.
          const beadForThread: TaskData = { ...bead, labels };
          threadId = await createBeadThread(forum, beadForThread, taskCtx.tagMap, taskCtx.mentionUserId);

          // Link thread ID back to bead via external_ref.
          try {
            taskCtx.store.update(bead.id, { externalRef: `discord:${threadId}` });
          } catch (err) {
            taskCtx.log?.warn({ err, beadId: bead.id, threadId }, 'beads:external-ref update failed');
          }
          }
        }
      } catch (err) {
        taskCtx.log?.warn({ err, beadId: bead.id }, 'beads:thread creation failed');
      }

      beadThreadCache.invalidate();
      taskCtx.forumCountSync?.requestUpdate();
      const threadNote = threadId ? ` (thread created)` : '';
      return { ok: true, summary: `Bead ${bead.id} created: "${bead.title}"${threadNote}` };
    }

    case 'beadUpdate': {
      if (!action.beadId) {
        return { ok: false, error: 'beadUpdate requires beadId' };
      }

      if (action.status && !isTaskStatus(action.status)) {
        return { ok: false, error: `Invalid bead status: "${action.status}"` };
      }

      const bead = taskCtx.store.update(
        action.beadId,
        {
          title: action.title,
          description: action.description,
          priority: action.priority,
          status: action.status as TaskStatus | undefined,
        },
      );

      // Update thread name if bead has a linked thread.
      const threadId = getThreadIdFromBead(bead);
      if (threadId) {
        try {
          await ensureUnarchived(ctx.client, threadId);
          await updateBeadThreadName(ctx.client, threadId, bead);
        } catch (err) {
          taskCtx.log?.warn({ err, beadId: action.beadId, threadId }, 'beads:thread name update failed');
        }
        try {
          await updateBeadStarterMessage(ctx.client, threadId, bead, taskCtx.sidebarMentionUserId);
        } catch (err) {
          taskCtx.log?.warn({ err, beadId: action.beadId, threadId }, 'beads:starter message update failed');
        }
        try {
          await updateBeadThreadTags(ctx.client, threadId, bead, taskCtx.tagMap);
        } catch (err) {
          taskCtx.log?.warn({ err, beadId: action.beadId, threadId }, 'beads:thread tag update failed');
        }
      }

      beadThreadCache.invalidate();
      if (action.status) taskCtx.forumCountSync?.requestUpdate();
      const changes: string[] = [];
      if (action.title) changes.push(`title → "${action.title}"`);
      if (action.status) changes.push(`status → ${action.status}`);
      if (action.priority != null) changes.push(`priority → P${action.priority}`);
      return { ok: true, summary: `Bead ${action.beadId} updated: ${changes.join(', ') || 'no changes'}` };
    }

    case 'beadClose': {
      if (!action.beadId) {
        return { ok: false, error: 'beadClose requires beadId' };
      }

      const bead = taskCtx.store.close(action.beadId, action.reason);

      // Close thread.
      const threadId = getThreadIdFromBead(bead);
      if (threadId) {
        try {
          await closeBeadThread(ctx.client, threadId, bead, taskCtx.tagMap, taskCtx.log);
        } catch (err) {
          taskCtx.log?.warn({ err, beadId: action.beadId, threadId }, 'beads:thread close failed');
        }
      }

      beadThreadCache.invalidate();
      taskCtx.forumCountSync?.requestUpdate();
      return { ok: true, summary: `Bead ${action.beadId} closed${action.reason ? `: ${action.reason}` : ''}` };
    }

    case 'beadShow': {
      if (!action.beadId) {
        return { ok: false, error: 'beadShow requires beadId' };
      }

      const bead = taskCtx.store.get(action.beadId);
      if (!bead) {
        return { ok: false, error: `Bead "${action.beadId}" not found` };
      }

      const lines = [
        `**${bead.title}** (\`${bead.id}\`)`,
        `Status: ${bead.status} | Priority: P${bead.priority}`,
      ];
      if (bead.owner) lines.push(`Owner: ${bead.owner}`);
      if (bead.labels?.length) lines.push(`Labels: ${bead.labels.join(', ')}`);
      if (bead.description) lines.push(`\n${bead.description.slice(0, 500)}`);
      return { ok: true, summary: lines.join('\n') };
    }

    case 'beadList': {
      // Default to 50 for interactive queries to avoid unbounded prompt payloads.
      const beads = taskCtx.store.list({
        status: action.status,
        label: action.label,
        limit: action.limit ?? 50,
      });

      if (beads.length === 0) {
        return { ok: true, summary: 'No beads found matching the filter.' };
      }

      const lines = beads.map(
        (b) => `\`${b.id}\` [${b.status}] P${b.priority} — ${b.title}`,
      );
      return { ok: true, summary: lines.join('\n') };
    }

    case 'beadSync': {
      try {
        let result: TaskSyncResult;
        if (taskCtx.syncCoordinator) {
          // Use coordinator: passes statusPoster for user-initiated syncs.
          const coordResult = await taskCtx.syncCoordinator.sync(taskCtx.statusPoster);
          if (!coordResult) {
            return { ok: true, summary: 'Sync already running; changes will be picked up.' };
          }
          result = coordResult;
        } else {
          // Fallback: no coordinator (watcher not initialized).
          if (taskCtx.tagMapPath) {
            try {
              await reloadTagMapInPlace(taskCtx.tagMapPath, taskCtx.tagMap);
            } catch (err) {
              taskCtx.log?.warn({ err, tagMapPath: taskCtx.tagMapPath }, 'beads:tag-map reload failed; using cached map');
            }
          }
          const tagMapSnapshot = { ...taskCtx.tagMap };
          const { runBeadSync } = await import('../beads/bead-sync.js');
          result = await runBeadSync({
            client: ctx.client,
            guild: ctx.guild,
            forumId: taskCtx.forumId,
            tagMap: tagMapSnapshot,
            store: taskCtx.store,
            log: taskCtx.log,
            statusPoster: taskCtx.statusPoster,
            mentionUserId: taskCtx.sidebarMentionUserId,
          });
          beadThreadCache.invalidate();
          taskCtx.forumCountSync?.requestUpdate();
        }
        return {
          ok: true,
          summary: `Sync complete: ${result.threadsCreated} created, ${result.emojisUpdated} updated, ${result.starterMessagesUpdated} starters, ${result.tagsUpdated} tags, ${result.threadsArchived} archived, ${result.statusesUpdated} status-fixes${result.threadsReconciled ? `, ${result.threadsReconciled} reconciled` : ''}${result.orphanThreadsFound ? `, ${result.orphanThreadsFound} orphans` : ''}${result.warnings ? `, ${result.warnings} warnings` : ''}`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `Bead sync failed: ${msg}` };
      }
    }

    case 'tagMapReload': {
      if (!taskCtx.tagMapPath) {
        return { ok: false, error: 'Tag map path not configured' };
      }
      const oldCount = Object.keys(taskCtx.tagMap).length;
      try {
        await reloadTagMapInPlace(taskCtx.tagMapPath, taskCtx.tagMap);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `Tag map reload failed: ${msg}` };
      }
      const newCount = Object.keys(taskCtx.tagMap).length;
      const tagList = Object.keys(taskCtx.tagMap);
      const tagsDisplay = tagList.length <= 10
        ? tagList.join(', ')
        : `${tagList.slice(0, 10).join(', ')} (+${tagList.length - 10} more)`;
      return { ok: true, summary: `Tag map reloaded (${oldCount} -> ${newCount}): ${tagsDisplay}` };
    }
  }
}

// ---------------------------------------------------------------------------
// Prompt section
// ---------------------------------------------------------------------------

export function taskActionsPromptSection(): string {
  return `### Bead Task Tracking

**beadCreate** — Create a new bead (task):
\`\`\`
<discord-action>{"type":"beadCreate","title":"Task title","description":"Optional details","priority":2,"tags":"feature,work"}</discord-action>
\`\`\`
- \`title\` (required): Bead title.
- \`description\` (optional): Detailed description.
- \`priority\` (optional): 0-4 (0=highest, default 2).
- \`tags\` (optional): Comma-separated labels/tags.

**beadUpdate** — Update a bead's fields:
\`\`\`
<discord-action>{"type":"beadUpdate","beadId":"ws-001","status":"in_progress","priority":1}</discord-action>
\`\`\`
- \`beadId\` (required): Bead ID.
- \`title\`, \`description\`, \`priority\`, \`status\` (optional): Fields to update.

**beadClose** — Close a bead:
\`\`\`
<discord-action>{"type":"beadClose","beadId":"ws-001","reason":"Done"}</discord-action>
\`\`\`

**beadShow** — Show bead details:
\`\`\`
<discord-action>{"type":"beadShow","beadId":"ws-001"}</discord-action>
\`\`\`

**beadList** — List beads:
\`\`\`
<discord-action>{"type":"beadList","status":"open","limit":10}</discord-action>
\`\`\`
- \`status\` (optional): Filter by status (open, in_progress, blocked, closed, all).
- \`label\` (optional): Filter by label.
- \`limit\` (optional): Max results.

**beadSync** — Run full sync between beads DB and Discord threads:
\`\`\`
<discord-action>{"type":"beadSync"}</discord-action>
\`\`\`

**tagMapReload** — Reload tag map from disk (hot-reload without restart):
\`\`\`
<discord-action>{"type":"tagMapReload"}</discord-action>
\`\`\`

#### Bead Quality Guidelines
- **Title**: imperative mood, specific, <60 chars. Good: "Add retry logic to webhook handler", "Plan March Denver trip". Bad: "fix stuff".
- **Description** should answer what/why/scope. Use markdown for structure. Include what "done" looks like for larger tasks.
- **Priority**: P0=urgent, P1=important, P2=normal (default), P3=nice-to-have, P4=someday.
- If the user explicitly asks to create a bead, always create it — don't second-guess.
- Apply the same description quality standards when using beadUpdate to backfill details.

#### Cross-Bead References
When interacting with another bead, always use bead actions with its bead ID — not \`sendMessage\`, \`readMessages\`, or \`listPins\` against a thread channel name. Thread names can go stale when threads are deleted or archived, causing those actions to fail or target the wrong channel. Use the appropriate bead action instead:
- **Read bead content**: \`beadShow <id>\`
- **Update a bead**: \`beadUpdate <id>\`
- **Close a bead**: \`beadClose <id>\`
- **Find beads**: \`beadList\` (filter by status or label)
- **Reconcile Discord threads**: \`beadSync\``;
}
