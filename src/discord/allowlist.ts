export function parseAllowUserIds(raw: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const part of String(raw ?? '').split(/[,\s]+/g)) {
    const v = part.trim();
    if (!v) continue;
    if (/^\d+$/.test(v)) out.add(v);
  }
  return out;
}

export function parseAllowChannelIds(raw: string | undefined): Set<string> {
  // Same format as user IDs: comma/space-separated Discord snowflakes.
  const out = new Set<string>();
  for (const part of String(raw ?? '').split(/[,\s]+/g)) {
    const v = part.trim();
    if (!v) continue;
    if (/^\d+$/.test(v)) out.add(v);
  }
  return out;
}

export function isAllowlisted(allow: Set<string>, userId: string): boolean {
  // Fail closed: if allowlist is empty, respond to nobody.
  if (allow.size === 0) return false;
  return allow.has(userId);
}

export function parseAllowBotIds(raw: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const part of String(raw ?? '').split(/[,\s]+/g)) {
    const v = part.trim();
    if (!v) continue;
    if (/^\d+$/.test(v)) out.add(v);
  }
  return out;
}

export function isTrustedBot(allow: Set<string>, botId: string): boolean {
  // Fail closed: if allowlist is empty, trust no bots.
  if (allow.size === 0) return false;
  return allow.has(botId);
}

/**
 * Check whether a requester is authorized for config-mutating actions.
 * Fail closed: missing or empty allowlist, or missing requesterId, denies.
 */
export function isConfigAuthorized(
  allowUserIds: Set<string> | undefined,
  requesterId: string | undefined,
): boolean {
  if (!requesterId) return false;
  if (!allowUserIds || allowUserIds.size === 0) return false;
  return allowUserIds.has(requesterId);
}
