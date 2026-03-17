// Builds a concise summary message after a stop command (!stop or 🛑 reaction)
// so the user can see what work was interrupted.

import type { AbortSnapshot } from './abort-registry.js';

const MAX_USER_MESSAGE_LEN = 80;

function truncate(text: string, max: number): string {
  const clean = text.replace(/[\r\n]+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1) + '\u2026';
}

function formatElapsedCompact(ms: number): string {
  if (ms < 1000) return '<1s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

function formatSnapshot(snap: AbortSnapshot): string {
  const parts: string[] = [];

  if (snap.userMessage) {
    parts.push(`**Request:** "${truncate(snap.userMessage, MAX_USER_MESSAGE_LEN)}"`);
  }

  if (snap.activityLabel) {
    parts.push(`**Activity:** ${snap.activityLabel}`);
  }

  parts.push(`**Duration:** ${formatElapsedCompact(snap.elapsedMs)}`);

  const responseLen = snap.partialResponse.trim().length;
  if (responseLen > 0) {
    parts.push(`**Partial output:** ${responseLen} chars streamed`);
  } else {
    parts.push('**Output:** none yet');
  }

  return parts.join('\n');
}

/**
 * Build a stop summary message for one or more aborted streams.
 * Returns an empty string if there are no snapshots to summarize.
 */
export function buildStopSummary(
  snapshots: AbortSnapshot[],
  opts?: { forgeCancelled?: boolean },
): string {
  if (snapshots.length === 0 && !opts?.forgeCancelled) return '';

  const lines: string[] = [];

  if (snapshots.length === 1) {
    lines.push('**Stop summary:**');
    lines.push(formatSnapshot(snapshots[0]));
  } else if (snapshots.length > 1) {
    lines.push(`**Stop summary** (${snapshots.length} streams):`);
    for (let i = 0; i < snapshots.length; i++) {
      lines.push(`\n**Stream ${i + 1}:**`);
      lines.push(formatSnapshot(snapshots[i]));
    }
  }

  if (opts?.forgeCancelled) {
    lines.push('**Forge:** cancel requested');
  }

  return lines.join('\n');
}
