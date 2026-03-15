/**
 * Human-readable labels for tool activity display in Discord.
 */

function shortPath(p: string): string {
  const segments = p.replace(/\\/g, '/').split('/').filter(Boolean);
  if (segments.length <= 2) return segments.join('/');
  return '.../' + segments.slice(-2).join('/');
}

function extractPath(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  for (const key of ['file_path', 'path', 'pattern']) {
    if (typeof obj[key] === 'string' && obj[key]) return obj[key] as string;
  }
  return null;
}

export function toolActivityLabel(name: string, input?: unknown): string {
  const p = extractPath(input);
  const short = p ? shortPath(p) : null;

  switch (name) {
    case 'Read':
      return short ? `Reading ${short}` : 'Reading file...';
    case 'Write':
      return short ? `Writing ${short}` : 'Writing file...';
    case 'Edit':
      return short ? `Editing ${short}` : 'Editing file...';
    case 'Bash':
      return 'Running command...';
    case 'Grep':
      return 'Searching content...';
    case 'Glob':
      return 'Finding files...';
    case 'WebSearch':
      return 'Searching web...';
    case 'WebFetch':
      return 'Fetching URL...';
    case 'Task':
      return 'Running subtask...';
    case 'TodoRead':
    case 'TodoWrite':
      return 'Managing tasks...';
    default:
      return `Running ${name}...`;
  }
}
