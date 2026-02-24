export type DestructivePattern = {
  /** Tool name this pattern applies to ('Bash', 'Write', 'Edit', etc.). */
  tool: string;
  /** Key in the tool input object to extract and test. */
  field: string;
  /** Regex pattern to match against the extracted field value. */
  pattern: RegExp;
  /** Human-readable reason returned when matched. */
  reason: string;
};

export const DESTRUCTIVE_TOOL_PATTERNS: readonly DestructivePattern[] = [
  // Bash: rm -rf targeting paths outside known build artifact directories.
  // The negative lookahead allows: node_modules, dist, build, coverage, tmp, out,
  // .cache, .tmp, .next (with optional leading ./ or /).
  {
    tool: 'Bash',
    field: 'command',
    pattern:
      /\brm\s+(?:-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*)\s+(?!(?:\.\/)?(?:node_modules|dist|build|coverage|tmp|out)(?:[/\s"']|$)|\.(?:cache|tmp|next)(?:[/\s"']|$))/i,
    reason: 'rm -rf outside build artifact directories',
  },
  // Bash: git force-push (--force or -f)
  {
    tool: 'Bash',
    field: 'command',
    pattern: /\bgit\s+push\b.*?\s(?:--force|-f)\b/i,
    reason: 'git push --force',
  },
  // Bash: force-delete a branch (-D)
  {
    tool: 'Bash',
    field: 'command',
    pattern: /\bgit\s+branch\b.*?\s-D\b/,
    reason: 'git branch -D',
  },
  // Bash: SQL DROP TABLE (case-insensitive)
  {
    tool: 'Bash',
    field: 'command',
    pattern: /\bDROP\s+TABLE\b/i,
    reason: 'DROP TABLE SQL statement',
  },
  // Bash: world-writable chmod
  {
    tool: 'Bash',
    field: 'command',
    pattern: /\bchmod\s+0?777\b/,
    reason: 'chmod 777',
  },
  // Write: .env files (.env, .env.local, .env.production, etc.)
  {
    tool: 'Write',
    field: 'file_path',
    pattern: /(?:^|[/\\])\.env(?:\.|$)/,
    reason: 'write to .env file',
  },
  // Write: root-policy.ts
  {
    tool: 'Write',
    field: 'file_path',
    pattern: /(?:^|[/\\])root-policy\.ts$/,
    reason: 'write to root-policy.ts',
  },
  // Write: ~/.ssh/ or ~/.claude/ (tilde-expanded or absolute home path)
  {
    tool: 'Write',
    field: 'file_path',
    pattern: /(?:^~\/|[/\\])(?:\.ssh|\.claude)[/\\]/,
    reason: 'write to ~/.ssh/ or ~/.claude/',
  },
  // Edit: .env files
  {
    tool: 'Edit',
    field: 'file_path',
    pattern: /(?:^|[/\\])\.env(?:\.|$)/,
    reason: 'edit .env file',
  },
  // Edit: root-policy.ts
  {
    tool: 'Edit',
    field: 'file_path',
    pattern: /(?:^|[/\\])root-policy\.ts$/,
    reason: 'edit root-policy.ts',
  },
  // Edit: ~/.ssh/ or ~/.claude/
  {
    tool: 'Edit',
    field: 'file_path',
    pattern: /(?:^~\/|[/\\])(?:\.ssh|\.claude)[/\\]/,
    reason: 'edit ~/.ssh/ or ~/.claude/',
  },
];

/**
 * Checks whether a tool call matches any destructive pattern.
 *
 * Returns `{ matched: true, reason }` on the first match, or
 * `{ matched: false, reason: '' }` when the call is considered safe.
 */
export function matchesDestructivePattern(
  toolName: string,
  toolInput: unknown,
): { matched: boolean; reason: string } {
  if (!toolInput || typeof toolInput !== 'object') {
    return { matched: false, reason: '' };
  }

  const input = toolInput as Record<string, unknown>;

  for (const entry of DESTRUCTIVE_TOOL_PATTERNS) {
    if (entry.tool !== toolName) continue;

    const fieldValue = input[entry.field];
    if (typeof fieldValue !== 'string') continue;

    if (entry.pattern.test(fieldValue)) {
      return { matched: true, reason: entry.reason };
    }
  }

  return { matched: false, reason: '' };
}
