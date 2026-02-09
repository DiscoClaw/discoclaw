export function parseAllowUserIds(raw: string | undefined): Set<string> {
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
