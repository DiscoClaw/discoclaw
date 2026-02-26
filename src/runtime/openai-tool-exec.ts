/**
 * Server-side tool execution handlers for OpenAI function-calling tools.
 *
 * Each handler receives parsed arguments and returns { result, ok }.
 * All handlers catch exceptions — they never throw.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ── Constants ────────────────────────────────────────────────────────

const MAX_READ_BYTES = 1 * 1024 * 1024; // 1 MB
const BASH_TIMEOUT_MS = 30_000;
const BASH_MAX_OUTPUT = 100 * 1024; // 100 KB per stream
const FETCH_TIMEOUT_MS = 15_000;
const FETCH_MAX_BYTES = 512 * 1024; // 512 KB

/** RFC 1918 / private / loopback prefixes for SSRF protection. */
const PRIVATE_IP_PREFIXES = [
  '10.',
  '172.16.', '172.17.', '172.18.', '172.19.',
  '172.20.', '172.21.', '172.22.', '172.23.',
  '172.24.', '172.25.', '172.26.', '172.27.',
  '172.28.', '172.29.', '172.30.', '172.31.',
  '192.168.',
  '127.',
  '0.',
  '169.254.',
];

const LOCALHOST_HOSTNAMES = new Set(['localhost', '[::1]']);

// ── Types ────────────────────────────────────────────────────────────

export type ToolResult = { result: string; ok: boolean };

type LogFn = (msg: string) => void;

// ── Path security ────────────────────────────────────────────────────

/**
 * Canonicalize allowed roots once (resolves symlinks in the roots themselves).
 * Falls back to path.resolve if the root dir doesn't exist yet.
 */
async function canonicalizeRoots(roots: string[]): Promise<string[]> {
  const canonical: string[] = [];
  for (const root of roots) {
    try {
      canonical.push(await fs.realpath(root));
    } catch {
      canonical.push(path.resolve(root));
    }
  }
  return canonical;
}

/**
 * Verify that `targetPath` falls under at least one allowed root.
 * Uses fs.realpath to resolve symlinks, preventing symlink escapes.
 * When the target (or its parent) doesn't exist, walks up the directory tree
 * to find an existing ancestor and validates that.
 */
async function assertPathAllowed(
  targetPath: string,
  allowedRoots: string[],
  checkParent = false,
): Promise<void> {
  const canonicalRoots = await canonicalizeRoots(allowedRoots);
  let toCheck = checkParent ? path.dirname(targetPath) : targetPath;

  // Walk up to the nearest existing ancestor for realpath resolution
  let canonical: string | undefined;
  let current = toCheck;
  for (;;) {
    try {
      canonical = await fs.realpath(current);
      break;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        const parent = path.dirname(current);
        if (parent === current) {
          // Reached filesystem root without finding an existing dir
          throw new Error(`Path not accessible: ${toCheck}`);
        }
        current = parent;
        continue;
      }
      throw new Error(`Path not accessible: ${toCheck}`);
    }
  }

  // Reconstruct the full canonical path by appending the non-existing suffix
  const suffix = path.relative(current, toCheck);
  if (suffix && suffix !== '.') {
    canonical = path.join(canonical, suffix);
  }

  const allowed = canonicalRoots.some(
    (root) => canonical === root || canonical!.startsWith(root + path.sep),
  );
  if (!allowed) {
    throw new Error(`Path outside allowed roots: ${targetPath}`);
  }
}

/**
 * Resolve a file_path argument against the first allowed root,
 * then validate it falls within allowed roots.
 */
async function resolveAndCheck(
  filePath: string,
  allowedRoots: string[],
  checkParent = false,
): Promise<string> {
  // Resolve relative paths against the first root
  const resolved = path.resolve(allowedRoots[0], filePath);
  await assertPathAllowed(resolved, allowedRoots, checkParent);
  return resolved;
}

// ── Individual handlers ──────────────────────────────────────────────

async function handleReadFile(
  args: Record<string, unknown>,
  allowedRoots: string[],
): Promise<ToolResult> {
  const filePath = args.file_path as string;
  if (!filePath) return { result: 'file_path is required', ok: false };

  const resolved = await resolveAndCheck(filePath, allowedRoots);

  const stat = await fs.stat(resolved);
  if (stat.size > MAX_READ_BYTES) {
    return { result: `File too large: ${stat.size} bytes (max ${MAX_READ_BYTES})`, ok: false };
  }

  const content = await fs.readFile(resolved, 'utf-8');
  const lines = content.split('\n');

  const offset = typeof args.offset === 'number' ? Math.max(0, args.offset - 1) : 0; // 1-based to 0-based
  const limit = typeof args.limit === 'number' ? args.limit : lines.length;
  const sliced = lines.slice(offset, offset + limit);

  return { result: sliced.join('\n'), ok: true };
}

async function handleWriteFile(
  args: Record<string, unknown>,
  allowedRoots: string[],
): Promise<ToolResult> {
  const filePath = args.file_path as string;
  const content = args.content as string;
  if (!filePath) return { result: 'file_path is required', ok: false };
  if (typeof content !== 'string') return { result: 'content is required', ok: false };

  const resolved = await resolveAndCheck(filePath, allowedRoots, true);

  // Ensure parent directory exists
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, content, 'utf-8');

  return { result: `Wrote ${Buffer.byteLength(content)} bytes to ${resolved}`, ok: true };
}

async function handleEditFile(
  args: Record<string, unknown>,
  allowedRoots: string[],
): Promise<ToolResult> {
  const filePath = args.file_path as string;
  const oldText = args.old_string as string;
  const newText = args.new_string as string;
  const replaceAll = args.replace_all === true;

  if (!filePath) return { result: 'file_path is required', ok: false };
  if (typeof oldText !== 'string') return { result: 'old_string is required', ok: false };
  if (typeof newText !== 'string') return { result: 'new_string is required', ok: false };

  const resolved = await resolveAndCheck(filePath, allowedRoots);

  const content = await fs.readFile(resolved, 'utf-8');

  if (replaceAll) {
    if (!content.includes(oldText)) {
      return { result: 'old_string not found in file', ok: false };
    }
    const updated = content.replaceAll(oldText, newText);
    await fs.writeFile(resolved, updated, 'utf-8');
    return { result: 'All occurrences replaced', ok: true };
  }

  // Count occurrences for unique-match requirement
  let count = 0;
  let idx = 0;
  while ((idx = content.indexOf(oldText, idx)) !== -1) {
    count++;
    idx += oldText.length;
  }

  if (count === 0) {
    return { result: 'old_string not found in file', ok: false };
  }
  if (count > 1) {
    return { result: `old_string found ${count} times (must be unique); use replace_all or provide more context`, ok: false };
  }

  const updated = content.replace(oldText, newText);
  await fs.writeFile(resolved, updated, 'utf-8');
  return { result: 'Edit applied', ok: true };
}

async function handleListFiles(
  args: Record<string, unknown>,
  allowedRoots: string[],
): Promise<ToolResult> {
  const pattern = args.pattern as string;
  const searchPath = args.path as string | undefined;
  if (!pattern) return { result: 'pattern is required', ok: false };

  const baseDir = searchPath
    ? await resolveAndCheck(searchPath, allowedRoots)
    : allowedRoots[0];

  // Use recursive readdir + minimatch-style matching via fs.glob (Node 22+)
  // Fall back to recursive readdir if fs.glob is not available
  const matches: string[] = [];

  if (typeof (fs as unknown as Record<string, unknown>).glob === 'function') {
    // Node 22+ fs.glob
    const globFn = (fs as unknown as { glob: (pattern: string, opts: Record<string, unknown>) => AsyncIterable<string> }).glob;
    for await (const entry of globFn(pattern, { cwd: baseDir })) {
      matches.push(entry);
      if (matches.length >= 1000) break; // safety cap
    }
  } else {
    // Fallback: recursive readdir + simple glob matching
    const allFiles = await collectFiles(baseDir, baseDir, 5000);
    const { minimatch } = await simpleMinimatch();
    for (const file of allFiles) {
      if (minimatch(file, pattern)) {
        matches.push(file);
        if (matches.length >= 1000) break;
      }
    }
  }

  if (matches.length === 0) {
    return { result: 'No files matched', ok: true };
  }

  return { result: matches.join('\n'), ok: true };
}

/** Recursively collect relative file paths. */
async function collectFiles(dir: string, base: string, limit: number): Promise<string[]> {
  const results: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (results.length >= limit) break;
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full);
    if (entry.isDirectory()) {
      // Skip hidden dirs and node_modules
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const sub = await collectFiles(full, base, limit - results.length);
      results.push(...sub);
    } else {
      results.push(rel);
    }
  }
  return results;
}

/** Lazy simple minimatch: basic glob matching without external deps. */
function simpleMinimatch(): { minimatch: (file: string, pattern: string) => boolean } {
  return {
    minimatch(file: string, pattern: string): boolean {
      // Convert glob to regex: ** → any path, * → any non-sep, ? → single char
      let re = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex specials (except * and ?)
        .replace(/\*\*/g, '\0DOUBLESTAR\0')
        .replace(/\*/g, '[^/]*')
        .replace(/\0DOUBLESTAR\0/g, '.*')
        .replace(/\?/g, '[^/]');
      re = '^' + re + '$';
      return new RegExp(re).test(file);
    },
  };
}

async function handleSearchContent(
  args: Record<string, unknown>,
  allowedRoots: string[],
): Promise<ToolResult> {
  const pattern = args.pattern as string;
  const searchPath = args.path as string | undefined;
  const glob = args.glob as string | undefined;
  const caseInsensitive = args.case_insensitive === true;

  if (!pattern) return { result: 'pattern is required', ok: false };

  const baseDir = searchPath
    ? await resolveAndCheck(searchPath, allowedRoots)
    : allowedRoots[0];

  // Try rg first, fall back to grep if rg isn't installed
  const rgArgs = ['--no-heading', '--line-number', '--color', 'never'];
  if (caseInsensitive) rgArgs.push('-i');
  if (glob) rgArgs.push('--glob', glob);
  rgArgs.push('--', pattern, baseDir);

  try {
    const { stdout } = await execFileAsync('rg', rgArgs, {
      timeout: BASH_TIMEOUT_MS,
      maxBuffer: BASH_MAX_OUTPUT,
    });
    return { result: stdout || 'No matches found', ok: true };
  } catch (err: unknown) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
    // rg exits 1 when no matches found — not an error
    if (e.code === 1) {
      return { result: 'No matches found', ok: true };
    }
    // rg not installed — fall back to grep
    if (e.message?.includes('ENOENT')) {
      return searchWithGrep(pattern, baseDir, { caseInsensitive, glob });
    }
    return { result: e.stderr || e.message || 'search failed', ok: false };
  }
}

/** Fallback grep-based search when ripgrep is not available. */
async function searchWithGrep(
  pattern: string,
  baseDir: string,
  opts: { caseInsensitive?: boolean; glob?: string },
): Promise<ToolResult> {
  const grepArgs = ['-rn', '--color=never'];
  if (opts.caseInsensitive) grepArgs.push('-i');
  if (opts.glob) {
    grepArgs.push('--include', opts.glob);
  }
  grepArgs.push('--', pattern, baseDir);

  try {
    const { stdout } = await execFileAsync('grep', grepArgs, {
      timeout: BASH_TIMEOUT_MS,
      maxBuffer: BASH_MAX_OUTPUT,
    });
    return { result: stdout || 'No matches found', ok: true };
  } catch (err: unknown) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
    // grep exits 1 when no matches found — not an error
    if (e.code === 1) {
      return { result: 'No matches found', ok: true };
    }
    return { result: e.stderr || e.message || 'search failed', ok: false };
  }
}

async function handleBash(
  args: Record<string, unknown>,
  allowedRoots: string[],
): Promise<ToolResult> {
  const command = args.command as string;
  if (!command) return { result: 'command is required', ok: false };

  try {
    const { stdout, stderr } = await execFileAsync('/bin/bash', ['-c', command], {
      cwd: allowedRoots[0],
      timeout: BASH_TIMEOUT_MS,
      maxBuffer: BASH_MAX_OUTPUT,
    });

    const parts: string[] = [];
    if (stdout) parts.push(stdout);
    if (stderr) parts.push(`[stderr]\n${stderr}`);
    return { result: parts.join('\n') || '(no output)', ok: true };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; killed?: boolean; message?: string };
    if (e.killed) {
      return { result: 'Command timed out (30s limit)', ok: false };
    }
    const parts: string[] = [];
    if (e.stdout) parts.push(e.stdout);
    if (e.stderr) parts.push(e.stderr);
    return { result: parts.join('\n') || e.message || 'command failed', ok: false };
  }
}

async function handleWebFetch(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const url = args.url as string;
  if (!url) return { result: 'url is required', ok: false };

  // Validate URL
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { result: 'Invalid URL', ok: false };
  }

  // HTTPS only
  if (parsed.protocol !== 'https:') {
    return { result: `Blocked: only HTTPS URLs are allowed (got ${parsed.protocol})`, ok: false };
  }

  // Block private/loopback IPs and localhost
  const hostname = parsed.hostname;
  if (LOCALHOST_HOSTNAMES.has(hostname)) {
    return { result: 'Blocked: localhost URLs are not allowed', ok: false };
  }
  if (PRIVATE_IP_PREFIXES.some((prefix) => hostname.startsWith(prefix))) {
    return { result: 'Blocked: private/internal IP addresses are not allowed', ok: false };
  }
  // IPv6 loopback
  if (hostname === '::1' || hostname === '[::1]') {
    return { result: 'Blocked: loopback addresses are not allowed', ok: false };
  }

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'error',
    });

    if (!response.ok) {
      return { result: `HTTP ${response.status} ${response.statusText}`, ok: false };
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > FETCH_MAX_BYTES) {
      return {
        result: `Response too large: ${buffer.length} bytes (max ${FETCH_MAX_BYTES})`,
        ok: false,
      };
    }

    return { result: buffer.toString('utf-8'), ok: true };
  } catch (err: unknown) {
    const e = err instanceof Error ? err : null;
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      return { result: 'Request timed out (15s limit)', ok: false };
    }
    if (e?.name === 'TypeError' && String(e.message).includes('redirect')) {
      return { result: 'Blocked: unexpected redirect', ok: false };
    }
    return { result: e?.message || 'fetch failed', ok: false };
  }
}

function handleWebSearch(): ToolResult {
  return {
    result: 'web_search not available — requires search API key configuration (not yet implemented)',
    ok: false,
  };
}

// ── Dispatcher ───────────────────────────────────────────────────────

const HANDLERS: Record<
  string,
  (args: Record<string, unknown>, allowedRoots: string[], log?: LogFn) => Promise<ToolResult> | ToolResult
> = {
  read_file: handleReadFile,
  write_file: handleWriteFile,
  edit_file: handleEditFile,
  list_files: handleListFiles,
  search_content: handleSearchContent,
  bash: handleBash,
  web_fetch: (args) => handleWebFetch(args),
  web_search: () => handleWebSearch(),
};

/**
 * Execute an OpenAI function-calling tool by name.
 *
 * @param name      OpenAI function name (e.g. 'read_file')
 * @param args      Parsed arguments from the function call
 * @param allowedRoots  Directories the tool is allowed to access (cwd + addDirs)
 * @param log       Optional logging function
 */
export async function executeToolCall(
  name: string,
  args: Record<string, unknown>,
  allowedRoots: string[],
  log?: LogFn,
): Promise<ToolResult> {
  if (allowedRoots.length === 0) {
    return { result: 'No allowed roots configured', ok: false };
  }

  const handler = HANDLERS[name];
  if (!handler) {
    return { result: `Unknown tool: ${name}`, ok: false };
  }

  try {
    log?.(`tool:${name} start`);
    const result = await handler(args, allowedRoots, log);
    log?.(`tool:${name} done ok=${result.ok}`);
    return result;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log?.(`tool:${name} error: ${message}`);
    return { result: message, ok: false };
  }
}
