import type { TaskData, TagMap } from './types.js';
import { STATUS_EMOJI, TASK_STATUSES } from './types.js';

const THREAD_NAME_MAX = 100;

/** Strip the project prefix from a task ID: `ws-001` → `001`. */
export function shortTaskId(id: string): string {
  const idx = id.indexOf('-');
  return idx >= 0 ? id.slice(idx + 1) : id;
}

/** Build a thread name: `{emoji} [{shortId}] {title}`, capped at 100 chars. */
export function buildThreadName(taskId: string, title: string, status: string): string {
  const emoji = STATUS_EMOJI[status] ?? STATUS_EMOJI.open;
  const prefix = `${emoji} [${shortTaskId(taskId)}] `;
  const maxTitle = THREAD_NAME_MAX - prefix.length;
  const trimmedTitle = title.length > maxTitle ? title.slice(0, maxTitle - 1) + '\u2026' : title;
  return `${prefix}${trimmedTitle}`;
}

export function taskIdToken(taskId: string): string {
  return `[${shortTaskId(taskId)}]`;
}

const emojiPrefix = Object.values(STATUS_EMOJI).map(e => e.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|');
const TASK_THREAD_PATTERN = new RegExp(`^(?:${emojiPrefix})\\s*\\[(\\d+)\\]`);

/**
 * Extract the short numeric ID from a thread name that starts with a
 * recognised task status emoji followed by `[NNN]`.
 * Returns the numeric string, or null if the name doesn't match.
 */
export function extractShortIdFromThreadName(name: string): string | null {
  const m = TASK_THREAD_PATTERN.exec(name);
  return m ? m[1] : null;
}

/**
 * Extract the Discord thread ID from a task's external_ref field.
 * Supports formats:
 *   - `discord:<threadId>`
 *   - raw numeric ID
 */
export function getThreadIdFromTask(task: TaskData): string | null {
  const ref = (task.external_ref ?? '').trim();
  if (!ref) return null;
  if (ref.startsWith('discord:')) return ref.slice('discord:'.length).trim() || null;
  if (/^\d+$/.test(ref)) return ref;
  return null;
}

/** Returns the set of Discord tag IDs that correspond to task statuses. */
export function getStatusTagIds(tagMap: TagMap): Set<string> {
  const ids = new Set<string>();
  for (const status of TASK_STATUSES) {
    const id = tagMap[status];
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * Strip old status tags, add the new one, preserve content tags.
 * Status tag gets priority: up to 4 content tags + 1 status tag.
 * If no status tag ID exists in tagMap, content tags get all 5 slots.
 */
export function buildAppliedTagsWithStatus(
  currentTagIds: string[],
  status: string,
  tagMap: TagMap,
): string[] {
  const statusIds = getStatusTagIds(tagMap);
  const uniqueContent = [...new Set(currentTagIds.filter(id => !statusIds.has(id)))];
  const newStatusId = tagMap[status];
  if (newStatusId) {
    return [...uniqueContent.slice(0, 4), newStatusId];
  }
  return uniqueContent.slice(0, 5);
}

/** Build the starter message content for a task thread. */
export function buildTaskStarterContent(task: TaskData, mentionUserId?: string): string {
  const lines: string[] = [];
  if (task.description) lines.push(task.description);
  lines.push('');
  lines.push(`**ID:** \`${task.id}\``);
  lines.push(`**Priority:** P${task.priority ?? 2}`);
  lines.push(`**Status:** ${task.status}`);
  if (task.owner) lines.push(`**Owner:** ${task.owner}`);
  if (mentionUserId) {
    lines.push('');
    lines.push(`<@${mentionUserId}>`);
  }
  return lines.join('\n');
}
