/**
 * Server-side tool execution handlers for OpenAI function-calling tools.
 *
 * Each handler receives parsed arguments and returns { result, ok }.
 * All handlers catch exceptions — they never throw.
 */

import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { sanitizeExternalContent } from '../sanitize-external.js';
import { stripAnsi } from './cli-shared.js';

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

export type ExecuteToolCallOpts = {
  /**
   * Optional strict allowlist of OpenAI function names enabled for the current
   * invocation. When provided, non-allowlisted tool names fail closed.
   */
  allowedToolNames?: ReadonlySet<string>;
  /**
   * Optional override for pipeline durable state storage path.
   * Defaults to `<allowedRoots[0]>/data/hybrid-pipeline-runs.json`.
   */
  pipelineStorePath?: string;
  /**
   * Runtime routing metadata for persisted hybrid runs.
   */
  runtimeId?: string;
  adapterId?: string;
  /**
   * Hybrid pipeline feature gate. When explicitly false, `pipeline.*` and
   * `step.*` calls are rejected as unavailable.
   */
  enableHybridPipeline?: boolean;
  /**
   * Internal recursion guard used when executing a pipeline step.
   * Nested `pipeline.*` calls are rejected deterministically.
   */
  pipelineStepMode?: boolean;
};

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

function validateListFilesPattern(pattern: string): string | null {
  if (typeof pattern !== 'string' || pattern.includes('\0')) {
    return 'pattern contains invalid characters';
  }

  if (path.isAbsolute(pattern) || path.win32.isAbsolute(pattern)) {
    return 'pattern must be relative';
  }

  if (/^[A-Za-z]:/.test(pattern)) {
    return 'pattern must be relative';
  }

  const normalized = pattern.replace(/\\/g, '/');
  // Reject absolute path branches hidden inside brace/extglob alternatives.
  if (/(^|[({,|])\s*\/+/.test(normalized)) {
    return 'pattern must be relative';
  }
  if (/(^|[({,|])\s*[A-Za-z]:/.test(normalized)) {
    return 'pattern must be relative';
  }

  // Treat common glob wrappers as separators so traversal hidden in braces,
  // extglob groups, or character classes is still rejected.
  const normalizedForTraversalCheck = normalized.replace(/[{},()[\]|]/g, '/');
  const segments = normalizedForTraversalCheck.split('/');
  if (segments.some((segment) => segment === '..')) {
    return 'pattern cannot contain parent directory traversal';
  }

  // Reject segments that can evaluate to ".." via glob syntax
  // (e.g. "[.][.]", "{.,.}{.,.}", "@(..|foo)").
  if (typeof path.matchesGlob === 'function') {
    for (const segment of normalized.split('/')) {
      if (!segment || segment === '.') continue;
      try {
        if (path.matchesGlob('..', segment)) {
          return 'pattern cannot contain parent directory traversal';
        }
      } catch {
        return 'pattern contains malformed glob syntax';
      }
    }
  }

  return null;
}

async function normalizeContainedGlobMatch(
  entry: string,
  baseDir: string,
  allowedRoots: string[],
): Promise<string> {
  const candidate = path.resolve(baseDir, entry);
  await assertPathAllowed(candidate, allowedRoots);

  const relativeToBase = path.relative(baseDir, candidate);
  if (
    relativeToBase === '' ||
    relativeToBase === '.' ||
    relativeToBase.startsWith(`..${path.sep}`) ||
    relativeToBase === '..' ||
    path.isAbsolute(relativeToBase)
  ) {
    throw new Error(`Glob match escaped base path: ${entry}`);
  }

  return relativeToBase.split(path.sep).join('/');
}

async function handleListFiles(
  args: Record<string, unknown>,
  allowedRoots: string[],
): Promise<ToolResult> {
  const pattern = args.pattern as string;
  const searchPath = args.path as string | undefined;
  if (!pattern) return { result: 'pattern is required', ok: false };

  const validationError = validateListFilesPattern(pattern);
  if (validationError) return { result: `Invalid glob pattern: ${validationError}`, ok: false };

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
      try {
        const safeEntry = await normalizeContainedGlobMatch(entry, baseDir, allowedRoots);
        matches.push(safeEntry);
      } catch {
        return { result: `Unsafe glob match rejected: ${entry}`, ok: false };
      }
      if (matches.length >= 1000) break; // safety cap
    }
  } else {
    // Fallback: recursive readdir + simple glob matching
    const allFiles = await collectFiles(baseDir, baseDir, 5000);
    const { minimatch } = await simpleMinimatch();
    for (const file of allFiles) {
      if (minimatch(file, pattern)) {
        try {
          const safeEntry = await normalizeContainedGlobMatch(file, baseDir, allowedRoots);
          matches.push(safeEntry);
        } catch {
          return { result: `Unsafe glob match rejected: ${file}`, ok: false };
        }
        if (matches.length >= 1000) break;
      }
    }
  }

  // Defense in depth: containment-check every output line right before returning.
  const verifiedMatches: string[] = [];
  for (const match of matches) {
    try {
      const safeEntry = await normalizeContainedGlobMatch(match, baseDir, allowedRoots);
      verifiedMatches.push(safeEntry);
    } catch {
      return { result: `Unsafe glob match rejected: ${match}`, ok: false };
    }
  }

  if (verifiedMatches.length === 0) {
    return { result: 'No files matched', ok: true };
  }

  return { result: verifiedMatches.join('\n'), ok: true };
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

    const cleanStdout = stripAnsi(stdout);
    const cleanStderr = stripAnsi(stderr);
    const parts: string[] = [];
    if (cleanStdout) parts.push(cleanStdout);
    if (cleanStderr) parts.push(`[stderr]\n${cleanStderr}`);
    return { result: parts.join('\n') || '(no output)', ok: true };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; killed?: boolean; message?: string };
    if (e.killed) {
      return { result: 'Command timed out (30s limit)', ok: false };
    }
    const cleanStdout = stripAnsi(e.stdout ?? '');
    const cleanStderr = stripAnsi(e.stderr ?? '');
    const parts: string[] = [];
    if (cleanStdout) parts.push(cleanStdout);
    if (cleanStderr) parts.push(cleanStderr);
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

    return { result: sanitizeExternalContent(buffer.toString('utf-8'), `Web page: ${url}`), ok: true };
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

// ── Hybrid pipeline lifecycle handlers ──────────────────────────────

type PipelineStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
type PipelineRunStatus = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled';
type PipelineToolName = 'pipeline.start' | 'pipeline.status' | 'pipeline.resume' | 'pipeline.cancel';

const FAILURE_CODE_VERSION = 'v1' as const;
type FailureCode =
  | 'E_TOOL_UNAVAILABLE'
  | 'E_POLICY_BLOCKED'
  | 'E_RETRY_EXHAUSTED'
  | 'E_IDEMPOTENCY_CONFLICT'
  | 'E_RUN_NOT_FOUND';

type StepToolName = 'step.run' | 'step.assert' | 'step.retry' | 'step.wait';

const STEP_TOOL_NAMES: ReadonlySet<StepToolName> = new Set([
  'step.run',
  'step.assert',
  'step.retry',
  'step.wait',
]);

const ACTIVE_STEP_RUN_STATUSES: ReadonlySet<PipelineRunStatus> = new Set(['running', 'waiting']);
const STEP_MAX_ATTEMPTS_TOTAL = 3;
const STEP_RETRY_DELAYS_MS = [1_000, 2_000] as const;
const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1_000;
const PIPELINE_STORE_WRITE_QUEUE: Map<string, Promise<void>> = new Map();

type PipelineStep = {
  tool: string;
  arguments: Record<string, unknown>;
  status: PipelineStepStatus;
  ok?: boolean;
  result?: string;
  updatedAt: string;
};

type PipelineRun = {
  runId: string;
  runtime: string;
  adapter: string;
  pipelineName: string;
  pipelineInputHash: string;
  idempotencyKey: string | null;
  requestHash: string;
  workspaceRoot: string;
  status: PipelineRunStatus;
  currentStep: number;
  steps: PipelineStep[];
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  completedAt?: string;
  cancelledAt?: string;
  attemptsByStep: Record<string, number>;
  lastAttemptAtByStep: Record<string, string | null>;
  nextRetryDueAtByStep: Record<string, string | null>;
  cancelRequested: boolean;
  failureCode?: FailureCode;
};

type PipelineStore = {
  version: 1;
  runs: Record<string, PipelineRun>;
};

const PIPELINE_STORE_VERSION = 1 as const;
const PIPELINE_MAX_RUNS = 200;

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map((v) => stableJson(v)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(record[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function nowIso(): string {
  return new Date().toISOString();
}

function stepKey(index: number): string {
  return String(index);
}

function emptyPipelineStore(): PipelineStore {
  return { version: PIPELINE_STORE_VERSION, runs: {} };
}

function pipelineStoreBackupPath(storePath: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${storePath}.corrupt.${timestamp}.${randomUUID().slice(0, 8)}`;
}

async function recoverCorruptPipelineStore(
  storePath: string,
  reason: string,
): Promise<{ store: PipelineStore; error?: string }> {
  const backupPath = pipelineStoreBackupPath(storePath);
  const emptyStore = emptyPipelineStore();
  try {
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    try {
      await fs.rename(storePath, backupPath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
    await savePipelineStore(storePath, emptyStore);
    return { store: emptyStore };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { store: emptyPipelineStore(), error: `${reason}; corruption recovery failed: ${message}` };
  }
}

function resolvePipelineStorePath(allowedRoots: string[], opts?: ExecuteToolCallOpts): string {
  if (opts?.pipelineStorePath && opts.pipelineStorePath.trim() !== '') {
    return path.resolve(opts.pipelineStorePath);
  }
  return path.join(allowedRoots[0], 'data', 'hybrid-pipeline-runs.json');
}

async function loadPipelineStore(storePath: string): Promise<{ store: PipelineStore; error?: string }> {
  try {
    const raw = await fs.readFile(storePath, 'utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return recoverCorruptPipelineStore(storePath, 'pipeline store is malformed (invalid JSON)');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return recoverCorruptPipelineStore(storePath, 'pipeline store is malformed (expected object root)');
    }
    const obj = parsed as Record<string, unknown>;
    if (obj.version !== PIPELINE_STORE_VERSION) {
      return recoverCorruptPipelineStore(storePath, 'pipeline store has unsupported version');
    }
    const runsRaw = obj.runs;
    if (!runsRaw || typeof runsRaw !== 'object' || Array.isArray(runsRaw)) {
      return recoverCorruptPipelineStore(storePath, 'pipeline store is malformed (runs must be an object)');
    }
    return { store: obj as PipelineStore };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { store: emptyPipelineStore() };
    }
    return { store: emptyPipelineStore(), error: 'failed to read pipeline store' };
  }
}

function normalizeRunStatus(status: unknown): PipelineRunStatus {
  if (status === 'pending') return 'queued';
  if (status === 'completed') return 'succeeded';
  if (status === 'queued' || status === 'running' || status === 'waiting' || status === 'succeeded' || status === 'failed' || status === 'cancelled') {
    return status;
  }
  return 'queued';
}

function normalizeStepStatus(status: unknown): PipelineStepStatus {
  if (status === 'pending' || status === 'running' || status === 'done' || status === 'failed' || status === 'cancelled') {
    return status;
  }
  return 'pending';
}

function normalizePipelineRun(run: PipelineRun, runIdHint?: string): void {
  const runRecord = run as unknown as Record<string, unknown>;
  if (typeof run.runId !== 'string' || run.runId.trim() === '') {
    const legacyRunId = runRecord.run_id;
    if (typeof legacyRunId === 'string' && legacyRunId.trim() !== '') {
      run.runId = legacyRunId;
    } else if (typeof runIdHint === 'string' && runIdHint.trim() !== '') {
      run.runId = runIdHint;
    }
  }

  if (typeof run.runtime !== 'string' || run.runtime.trim() === '') {
    run.runtime = 'openai';
  }
  if (typeof run.adapter !== 'string' || run.adapter.trim() === '') {
    run.adapter = run.runtime;
  }
  if (typeof run.pipelineName !== 'string' || run.pipelineName.trim() === '') {
    const legacyPipelineName = runRecord.pipeline_name;
    run.pipelineName = typeof legacyPipelineName === 'string' && legacyPipelineName.trim() !== ''
      ? legacyPipelineName
      : 'default';
  }
  if (typeof run.pipelineInputHash !== 'string' || run.pipelineInputHash.trim() === '') {
    const legacyPipelineInputHash = runRecord.pipeline_input_hash;
    run.pipelineInputHash = typeof legacyPipelineInputHash === 'string' && legacyPipelineInputHash.trim() !== ''
      ? legacyPipelineInputHash
      : sha256(stableJson(null));
  }
  if ((run.idempotencyKey as unknown) === undefined) {
    const legacyIdempotencyKey = runRecord.idempotency_key;
    if (legacyIdempotencyKey === null || typeof legacyIdempotencyKey === 'string') {
      run.idempotencyKey = legacyIdempotencyKey;
    }
  }
  if (run.idempotencyKey !== null && typeof run.idempotencyKey !== 'string') {
    run.idempotencyKey = null;
  } else if (typeof run.idempotencyKey === 'string' && run.idempotencyKey.trim() === '') {
    run.idempotencyKey = null;
  }
  if (typeof run.requestHash !== 'string' || run.requestHash.trim() === '') {
    const legacyRequestHash = runRecord.request_hash;
    if (typeof legacyRequestHash === 'string' && legacyRequestHash.trim() !== '') {
      run.requestHash = legacyRequestHash;
    }
  }
  if (!Array.isArray(run.steps)) {
    const legacySteps = runRecord.steps;
    run.steps = Array.isArray(legacySteps) ? legacySteps as PipelineStep[] : [];
  }
  if (typeof run.createdAt !== 'string' || run.createdAt.trim() === '') {
    const legacyCreatedAt = runRecord.created_at;
    run.createdAt = typeof legacyCreatedAt === 'string' && legacyCreatedAt.trim() !== ''
      ? legacyCreatedAt
      : nowIso();
  }
  if (typeof run.updatedAt !== 'string' || run.updatedAt.trim() === '') {
    const legacyUpdatedAt = runRecord.updated_at;
    run.updatedAt = typeof legacyUpdatedAt === 'string' && legacyUpdatedAt.trim() !== ''
      ? legacyUpdatedAt
      : run.createdAt;
  }
  if (run.completedAt === undefined) {
    const legacyCompletedAt = runRecord.completed_at;
    if (typeof legacyCompletedAt === 'string' && legacyCompletedAt.trim() !== '') {
      run.completedAt = legacyCompletedAt;
    }
  }
  if (run.cancelledAt === undefined) {
    const legacyCancelledAt = runRecord.cancelled_at;
    if (typeof legacyCancelledAt === 'string' && legacyCancelledAt.trim() !== '') {
      run.cancelledAt = legacyCancelledAt;
    }
  }
  if (run.lastError === undefined) {
    const legacyLastError = runRecord.last_error;
    if (typeof legacyLastError === 'string' && legacyLastError.trim() !== '') {
      run.lastError = legacyLastError;
    }
  }
  if (run.failureCode === undefined) {
    const legacyFailureCode = runRecord.failure_code;
    if (typeof legacyFailureCode === 'string') {
      run.failureCode = legacyFailureCode as FailureCode;
    }
  }
  if (typeof run.requestHash !== 'string' || run.requestHash.trim() === '') {
    run.requestHash = sha256(stableJson({
      runtime: run.runtime,
      adapter: run.adapter,
      pipeline_name: run.pipelineName,
      pipeline_input_hash: run.pipelineInputHash,
      steps: canonicalStepsForHash(run.steps),
    }));
  }
  if (typeof run.workspaceRoot !== 'string' || run.workspaceRoot.trim() === '') {
    const legacyWorkspaceRoot = runRecord.workspace_root;
    run.workspaceRoot = typeof legacyWorkspaceRoot === 'string' && legacyWorkspaceRoot.trim() !== ''
      ? legacyWorkspaceRoot
      : '';
  }

  run.status = normalizeRunStatus(run.status);
  run.cancelRequested = run.cancelRequested === true || runRecord.cancel_requested === true || run.status === 'cancelled';

  if (!Number.isInteger(run.currentStep) || run.currentStep < 0) {
    const legacyCurrentStep = runRecord.current_step;
    run.currentStep = Number.isInteger(legacyCurrentStep) && (legacyCurrentStep as number) >= 0
      ? legacyCurrentStep as number
      : 0;
  }
  if (run.currentStep > run.steps.length) {
    run.currentStep = run.steps.length;
  }

  for (const step of run.steps) {
    const stepRecord = step as unknown as Record<string, unknown>;
    step.status = normalizeStepStatus(step.status);
    if (typeof step.updatedAt !== 'string' || step.updatedAt.trim() === '') {
      const legacyUpdatedAt = stepRecord.updated_at;
      step.updatedAt = typeof legacyUpdatedAt === 'string' && legacyUpdatedAt.trim() !== ''
        ? legacyUpdatedAt
        : run.updatedAt;
    }
    if (!step.arguments || typeof step.arguments !== 'object' || Array.isArray(step.arguments)) {
      step.arguments = {};
    }
  }

  const attemptsRaw = (run.attemptsByStep as unknown) ?? runRecord.attempts_by_step;
  const lastAttemptRaw = (run.lastAttemptAtByStep as unknown) ?? runRecord.last_attempt_at_by_step;
  const nextRetryRaw = (run.nextRetryDueAtByStep as unknown) ?? runRecord.next_retry_due_at_by_step;

  const attempts: Record<string, number> = {};
  const lastAttempt: Record<string, string | null> = {};
  const nextRetry: Record<string, string | null> = {};

  const attemptsObj =
    attemptsRaw && typeof attemptsRaw === 'object' && !Array.isArray(attemptsRaw)
      ? attemptsRaw as Record<string, unknown>
      : {};
  const lastAttemptObj =
    lastAttemptRaw && typeof lastAttemptRaw === 'object' && !Array.isArray(lastAttemptRaw)
      ? lastAttemptRaw as Record<string, unknown>
      : {};
  const nextRetryObj =
    nextRetryRaw && typeof nextRetryRaw === 'object' && !Array.isArray(nextRetryRaw)
      ? nextRetryRaw as Record<string, unknown>
      : {};

  for (let i = 0; i < run.steps.length; i++) {
    const key = stepKey(i);
    const attemptsVal = attemptsObj[key];
    attempts[key] = typeof attemptsVal === 'number' && Number.isFinite(attemptsVal) && attemptsVal >= 0
      ? Math.floor(attemptsVal)
      : 0;

    const lastAttemptVal = lastAttemptObj[key];
    lastAttempt[key] = typeof lastAttemptVal === 'string' && lastAttemptVal.trim() !== ''
      ? lastAttemptVal
      : null;

    const nextRetryVal = nextRetryObj[key];
    nextRetry[key] = typeof nextRetryVal === 'string' && nextRetryVal.trim() !== ''
      ? nextRetryVal
      : null;
  }

  run.attemptsByStep = attempts;
  run.lastAttemptAtByStep = lastAttempt;
  run.nextRetryDueAtByStep = nextRetry;

  if (
    run.failureCode !== undefined
    && run.failureCode !== 'E_TOOL_UNAVAILABLE'
    && run.failureCode !== 'E_POLICY_BLOCKED'
    && run.failureCode !== 'E_RETRY_EXHAUSTED'
    && run.failureCode !== 'E_IDEMPOTENCY_CONFLICT'
    && run.failureCode !== 'E_RUN_NOT_FOUND'
  ) {
    run.failureCode = undefined;
  }
}

function normalizePipelineStore(store: PipelineStore): void {
  for (const [runId, run] of Object.entries(store.runs)) {
    normalizePipelineRun(run, runId);
  }
}

function prunePipelineRuns(store: PipelineStore): void {
  const entries = Object.entries(store.runs);
  if (entries.length <= PIPELINE_MAX_RUNS) return;
  entries.sort((a, b) => Date.parse(b[1].updatedAt) - Date.parse(a[1].updatedAt));
  const keep = new Set(entries.slice(0, PIPELINE_MAX_RUNS).map(([runId]) => runId));
  for (const runId of Object.keys(store.runs)) {
    if (!keep.has(runId)) delete store.runs[runId];
  }
}

async function savePipelineStore(storePath: string, store: PipelineStore): Promise<void> {
  const previous = PIPELINE_STORE_WRITE_QUEUE.get(storePath) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  PIPELINE_STORE_WRITE_QUEUE.set(storePath, queued);

  await previous;
  try {
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    const tmpPath = `${storePath}.tmp.${process.pid}.${randomUUID()}`;
    const persistedRuns: Record<string, Record<string, unknown>> = {};
    for (const [runId, run] of Object.entries(store.runs)) {
      persistedRuns[runId] = {
        run_id: run.runId,
        runtime: run.runtime,
        adapter: run.adapter,
        pipeline_name: run.pipelineName,
        pipeline_input_hash: run.pipelineInputHash,
        idempotency_key: run.idempotencyKey ?? null,
        request_hash: run.requestHash,
        workspace_root: run.workspaceRoot,
        status: run.status,
        current_step: run.currentStep,
        steps: run.steps.map((step) => ({
          tool: step.tool,
          arguments: step.arguments,
          status: step.status,
          ok: step.ok ?? null,
          result: step.result ?? null,
          updated_at: step.updatedAt,
        })),
        created_at: run.createdAt,
        updated_at: run.updatedAt,
        completed_at: run.completedAt ?? null,
        cancelled_at: run.cancelledAt ?? null,
        attempts_by_step: run.attemptsByStep,
        last_attempt_at_by_step: run.lastAttemptAtByStep,
        next_retry_due_at_by_step: run.nextRetryDueAtByStep,
        cancel_requested: run.cancelRequested,
        last_error: run.lastError ?? null,
        failure_code: run.failureCode ?? null,
      };
    }
    const persistedStore = {
      version: store.version,
      runs: persistedRuns,
    };
    await fs.writeFile(tmpPath, JSON.stringify(persistedStore, null, 2) + '\n', 'utf-8');
    await fs.rename(tmpPath, storePath);
  } finally {
    release?.();
    if (PIPELINE_STORE_WRITE_QUEUE.get(storePath) === queued) {
      PIPELINE_STORE_WRITE_QUEUE.delete(storePath);
    }
  }
}

function parseRunId(args: Record<string, unknown>): string | undefined {
  const candidate = args.run_id ?? args.runId ?? args.id;
  return typeof candidate === 'string' && candidate.trim() !== '' ? candidate.trim() : undefined;
}

function parseExpectedCurrentStep(args: Record<string, unknown>): number | undefined {
  const candidate = args.expected_current_step ?? args.expectedCurrentStep;
  if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 0) return candidate;
  if (typeof candidate === 'string' && /^\d+$/.test(candidate.trim())) return Number(candidate.trim());
  return undefined;
}

function parseMaxAttempts(args: Record<string, unknown>): number | undefined {
  const candidate = args.max_attempts ?? args.maxAttempts;
  if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) return candidate;
  if (typeof candidate === 'string' && /^\d+$/.test(candidate.trim())) return Number(candidate.trim());
  return undefined;
}

function parseAutoRun(args: Record<string, unknown>): boolean {
  const candidate = args.auto_run ?? args.autoRun;
  if (typeof candidate === 'boolean') return candidate;
  return true;
}

function parsePipelineName(args: Record<string, unknown>): string {
  const candidate = args.pipeline_name ?? args.pipelineName;
  if (typeof candidate === 'string' && candidate.trim() !== '') {
    return candidate.trim();
  }
  return 'default';
}

function parseIdempotencyKey(args: Record<string, unknown>): string | undefined {
  const candidate = args.idempotency_key ?? args.idempotencyKey;
  if (typeof candidate === 'string' && candidate.trim() !== '') {
    return candidate.trim();
  }
  return undefined;
}

function parsePipelineSteps(args: Record<string, unknown>): { steps?: PipelineStep[]; error?: string } {
  const rawSteps = args.steps;
  if (!Array.isArray(rawSteps)) {
    return { error: 'steps must be an array' };
  }
  if (rawSteps.length === 0) {
    return { error: 'steps must not be empty' };
  }

  const steps: PipelineStep[] = [];
  for (let i = 0; i < rawSteps.length; i++) {
    const raw = rawSteps[i];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { error: `steps[${i}] must be an object` };
    }
    const obj = raw as Record<string, unknown>;
    const toolCandidate = obj.tool ?? obj.name ?? obj.function ?? obj.tool_name;
    if (typeof toolCandidate !== 'string' || toolCandidate.trim() === '') {
      return { error: `steps[${i}].tool is required` };
    }
    const rawArgs = obj.arguments ?? obj.args ?? obj.input;
    let normalizedArgs: Record<string, unknown> = {};
    if (rawArgs !== undefined) {
      if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
        return { error: `steps[${i}] arguments must be an object when provided` };
      }
      normalizedArgs = rawArgs as Record<string, unknown>;
    }
    steps.push({
      tool: toolCandidate.trim(),
      arguments: normalizedArgs,
      status: 'pending',
      updatedAt: nowIso(),
    });
  }

  return { steps };
}

function canonicalStepsForHash(steps: PipelineStep[]): Array<{ tool: string; arguments: Record<string, unknown> }> {
  return steps.map((step) => ({
    tool: step.tool,
    arguments: step.arguments,
  }));
}

function normalizeRuntimeIdentity(opts: ExecuteToolCallOpts | undefined): { runtime: string; adapter: string } {
  const runtime = opts?.runtimeId?.trim() ? opts.runtimeId.trim() : 'openai';
  const adapter = opts?.adapterId?.trim() ? opts.adapterId.trim() : runtime;
  return { runtime, adapter };
}

function computeDerivedIdempotencyKey(
  runtime: string,
  adapter: string,
  pipelineName: string,
  canonicalInput: string,
): string {
  return sha256(`${runtime}\n${adapter}\n${pipelineName}\n${canonicalInput}`);
}

function isWithinIdempotencyWindow(run: PipelineRun, nowMs: number): boolean {
  const created = Date.parse(run.createdAt);
  if (!Number.isFinite(created)) return false;
  return (nowMs - created) <= IDEMPOTENCY_WINDOW_MS;
}

function summarizePipelineRun(run: PipelineRun): Record<string, unknown> {
  return {
    runtime: run.runtime,
    adapter: run.adapter,
    pipeline_name: run.pipelineName,
    pipeline_input_hash: run.pipelineInputHash,
    idempotency_key: run.idempotencyKey,
    workspace_root: run.workspaceRoot || null,
    run_id: run.runId,
    status: run.status,
    current_step: run.currentStep,
    total_steps: run.steps.length,
    last_error: run.lastError ?? null,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
    completed_at: run.completedAt ?? null,
    cancelled_at: run.cancelledAt ?? null,
    cancel_requested: run.cancelRequested,
    failure_code_version: FAILURE_CODE_VERSION,
    failure_code: run.failureCode ?? null,
    attempts_by_step: run.attemptsByStep,
    last_attempt_at_by_step: run.lastAttemptAtByStep,
    next_retry_due_at_by_step: run.nextRetryDueAtByStep,
    steps: run.steps.map((step, idx) => ({
      index: idx,
      tool: step.tool,
      status: step.status,
      ok: step.ok ?? null,
      result: step.result ?? null,
      updated_at: step.updatedAt,
    })),
  };
}

async function executePipelineRun(
  run: PipelineRun,
  storePath: string,
  store: PipelineStore,
  allowedRoots: string[],
  log: LogFn | undefined,
  opts: ExecuteToolCallOpts | undefined,
): Promise<void> {
  if (run.cancelRequested || run.status === 'cancelled') {
    run.status = 'cancelled';
    const cancelledAt = run.cancelledAt ?? nowIso();
    run.cancelledAt = cancelledAt;
    run.updatedAt = cancelledAt;
    for (let i = run.currentStep; i < run.steps.length; i++) {
      const step = run.steps[i]!;
      if (step.status === 'pending' || step.status === 'running') {
        step.status = 'cancelled';
        step.updatedAt = cancelledAt;
      }
    }
    await savePipelineStore(storePath, store);
    return;
  }

  run.status = 'running';
  run.updatedAt = nowIso();
  await savePipelineStore(storePath, store);

  while (run.currentStep < run.steps.length) {
    if (run.cancelRequested) {
      run.status = 'cancelled';
      const cancelledAt = run.cancelledAt ?? nowIso();
      run.cancelledAt = cancelledAt;
      run.updatedAt = cancelledAt;
      for (let i = run.currentStep; i < run.steps.length; i++) {
        const pending = run.steps[i]!;
        if (pending.status === 'pending' || pending.status === 'running') {
          pending.status = 'cancelled';
          pending.updatedAt = cancelledAt;
        }
      }
      await savePipelineStore(storePath, store);
      return;
    }

    const step = run.steps[run.currentStep]!;
    const key = stepKey(run.currentStep);
    if (step.status === 'done') {
      run.currentStep++;
      run.updatedAt = nowIso();
      await savePipelineStore(storePath, store);
      continue;
    }

    step.status = 'running';
    step.updatedAt = nowIso();
    run.attemptsByStep[key] = (run.attemptsByStep[key] ?? 0) + 1;
    run.lastAttemptAtByStep[key] = step.updatedAt;
    run.nextRetryDueAtByStep[key] = null;
    run.failureCode = undefined;
    run.updatedAt = step.updatedAt;
    await savePipelineStore(storePath, store);

    const result = await executeToolCall(
      step.tool,
      step.arguments,
      allowedRoots,
      log,
      { ...opts, pipelineStepMode: true },
    );

    step.ok = result.ok;
    step.result = result.result;
    step.updatedAt = nowIso();
    run.updatedAt = step.updatedAt;

    if (!result.ok) {
      step.status = 'failed';
      run.status = 'failed';
      run.failureCode = classifyFailureCode(result.result);
      run.lastError = `step ${run.currentStep + 1} (${step.tool}) failed: ${result.result}`;
      await savePipelineStore(storePath, store);
      return;
    }

    step.status = 'done';
    run.currentStep++;
    await savePipelineStore(storePath, store);
  }

  run.status = 'succeeded';
  run.failureCode = undefined;
  run.completedAt = nowIso();
  run.updatedAt = run.completedAt;
  await savePipelineStore(storePath, store);
}

function stepFailure(
  operation: StepToolName,
  code: FailureCode,
  message: string,
  extra?: Record<string, unknown>,
): ToolResult {
  return {
    ok: false,
    result: JSON.stringify({
      ok: false,
      operation,
      failure_code_version: FAILURE_CODE_VERSION,
      failure_code: code,
      message,
      ...(extra ?? {}),
    }),
  };
}

function stepSuccess(
  operation: StepToolName,
  extra?: Record<string, unknown>,
): ToolResult {
  return {
    ok: true,
    result: JSON.stringify({
      ok: true,
      operation,
      ...(extra ?? {}),
    }),
  };
}

function pipelineFailure(
  operation: PipelineToolName,
  code: FailureCode,
  message: string,
  extra?: Record<string, unknown>,
): ToolResult {
  return {
    ok: false,
    result: JSON.stringify({
      ok: false,
      operation,
      failure_code_version: FAILURE_CODE_VERSION,
      failure_code: code,
      message,
      ...(extra ?? {}),
    }),
  };
}

function pipelineSuccess(run: PipelineRun, ok = true): ToolResult {
  return { ok, result: JSON.stringify(summarizePipelineRun(run)) };
}

function parseFailureCodePayload(message: string): FailureCode | undefined {
  try {
    const parsed = JSON.parse(message) as Record<string, unknown>;
    const code = parsed.failure_code;
    if (
      code === 'E_TOOL_UNAVAILABLE'
      || code === 'E_POLICY_BLOCKED'
      || code === 'E_RETRY_EXHAUSTED'
      || code === 'E_IDEMPOTENCY_CONFLICT'
      || code === 'E_RUN_NOT_FOUND'
    ) {
      return code;
    }
  } catch {
    // Ignore parse failures; regex fallbacks apply.
  }
  return undefined;
}

function classifyFailureCode(message: string): FailureCode {
  const parsed = parseFailureCodePayload(message);
  if (parsed) return parsed;
  if (/tool not allowlisted/i.test(message) || /nested pipeline/i.test(message) || /nested step/i.test(message)) {
    return 'E_POLICY_BLOCKED';
  }
  if (/run not found/i.test(message) || /run_id is required/i.test(message)) {
    return 'E_RUN_NOT_FOUND';
  }
  if (/retry exhausted/i.test(message)) {
    return 'E_RETRY_EXHAUSTED';
  }
  if (/unknown tool/i.test(message)) {
    return 'E_TOOL_UNAVAILABLE';
  }
  return 'E_TOOL_UNAVAILABLE';
}

type StepToolContext = {
  storePath: string;
  store: PipelineStore;
  run: PipelineRun;
  step: PipelineStep;
  stepIndex: number;
  stepStateKey: string;
};

function primaryWorkspaceRoot(allowedRoots: string[]): string {
  return path.resolve(allowedRoots[0]!);
}

function workspaceAffinityFailure(
  operation: PipelineToolName | StepToolName,
  expectedRoot: string,
  actualRoot: string,
): ToolResult {
  const message = `run workspace_root mismatch (expected ${expectedRoot}, got ${actualRoot})`;
  if ((operation as string).startsWith('pipeline.')) {
    return pipelineFailure(operation as PipelineToolName, 'E_POLICY_BLOCKED', message);
  }
  return stepFailure(operation as StepToolName, 'E_POLICY_BLOCKED', message);
}

async function loadStepToolContext(
  operation: StepToolName,
  args: Record<string, unknown>,
  allowedRoots: string[],
  opts: ExecuteToolCallOpts | undefined,
): Promise<{ ctx?: StepToolContext; failure?: ToolResult }> {
  const storePath = resolvePipelineStorePath(allowedRoots, opts);
  const loaded = await loadPipelineStore(storePath);
  if (loaded.error) {
    return { failure: stepFailure(operation, 'E_TOOL_UNAVAILABLE', loaded.error) };
  }

  const store = loaded.store;
  normalizePipelineStore(store);

  const runId = parseRunId(args);
  if (!runId) {
    return { failure: stepFailure(operation, 'E_RUN_NOT_FOUND', 'run_id is required') };
  }

  const run = store.runs[runId];
  if (!run) {
    return { failure: stepFailure(operation, 'E_RUN_NOT_FOUND', `pipeline run not found: ${runId}`) };
  }

  const workspaceRoot = primaryWorkspaceRoot(allowedRoots);
  if (run.workspaceRoot && run.workspaceRoot !== workspaceRoot) {
    return { failure: workspaceAffinityFailure(operation, run.workspaceRoot, workspaceRoot) };
  }

  const expectedCurrentStep = parseExpectedCurrentStep(args);
  if (expectedCurrentStep === undefined) {
    return { failure: stepFailure(operation, 'E_POLICY_BLOCKED', 'expected_current_step is required') };
  }
  if (expectedCurrentStep !== run.currentStep) {
    return {
      failure: stepFailure(
        operation,
        'E_POLICY_BLOCKED',
        `expected_current_step mismatch (expected ${expectedCurrentStep}, actual ${run.currentStep})`,
      ),
    };
  }

  if (
    run.status === 'failed'
    && run.failureCode !== 'E_RETRY_EXHAUSTED'
    && run.currentStep >= 0
    && run.currentStep < run.steps.length
    && run.steps[run.currentStep]?.status === 'failed'
  ) {
    run.status = 'waiting';
    run.updatedAt = nowIso();
    await savePipelineStore(storePath, store);
  }

  if (run.cancelRequested) {
    return { failure: stepFailure(operation, 'E_POLICY_BLOCKED', 'run cancel has been requested') };
  }
  if (run.status === 'queued') {
    run.status = 'running';
    run.updatedAt = nowIso();
    await savePipelineStore(storePath, store);
  }
  if (!ACTIVE_STEP_RUN_STATUSES.has(run.status)) {
    return { failure: stepFailure(operation, 'E_POLICY_BLOCKED', `run status is not active: ${run.status}`) };
  }
  if (run.currentStep < 0 || run.currentStep >= run.steps.length) {
    return { failure: stepFailure(operation, 'E_POLICY_BLOCKED', 'run has no active current step') };
  }

  const step = run.steps[run.currentStep]!;
  return {
    ctx: {
      storePath,
      store,
      run,
      step,
      stepIndex: run.currentStep,
      stepStateKey: stepKey(run.currentStep),
    },
  };
}

async function handleStepTool(
  name: string,
  args: Record<string, unknown>,
  allowedRoots: string[],
  log: LogFn | undefined,
  opts: ExecuteToolCallOpts | undefined,
): Promise<ToolResult> {
  if (!STEP_TOOL_NAMES.has(name as StepToolName)) {
    return { result: `Unknown tool: ${name}`, ok: false };
  }

  const operation = name as StepToolName;
  const { ctx, failure } = await loadStepToolContext(operation, args, allowedRoots, opts);
  if (failure || !ctx) return failure!;

  if (operation === 'step.assert') {
    const expectedStepStatus = args.expected_step_status ?? args.expectedStepStatus;
    if (typeof expectedStepStatus === 'string' && expectedStepStatus.trim() !== '' && ctx.step.status !== expectedStepStatus) {
      return stepFailure(
        operation,
        'E_POLICY_BLOCKED',
        `expected step status "${expectedStepStatus}" did not match current status "${ctx.step.status}"`,
        { run: summarizePipelineRun(ctx.run) },
      );
    }
    return stepSuccess(operation, {
      run: summarizePipelineRun(ctx.run),
      step_index: ctx.stepIndex,
      step_status: ctx.step.status,
    });
  }

  if (operation === 'step.wait') {
    const dueAt = ctx.run.nextRetryDueAtByStep[ctx.stepStateKey];
    if (ctx.step.status === 'failed' && !dueAt) {
      return stepFailure(
        operation,
        'E_POLICY_BLOCKED',
        `retry has not been scheduled for failed step ${ctx.stepIndex}; call step.retry first`,
        { run: summarizePipelineRun(ctx.run) },
      );
    }
    if (ctx.step.status === 'done' || ctx.step.status === 'cancelled') {
      return stepFailure(
        operation,
        'E_POLICY_BLOCKED',
        `current step is not retry-eligible (status=${ctx.step.status})`,
        { run: summarizePipelineRun(ctx.run) },
      );
    }

    const nowMs = Date.now();
    if (!dueAt) {
      if (ctx.run.status !== 'running') {
        ctx.run.status = 'running';
        ctx.run.updatedAt = nowIso();
        await savePipelineStore(ctx.storePath, ctx.store);
      }
      return stepSuccess(operation, {
        ready: true,
        wait_ms: 0,
        next_retry_due_at: null,
        run: summarizePipelineRun(ctx.run),
      });
    }

    const dueMs = Date.parse(dueAt);
    if (!Number.isFinite(dueMs) || dueMs <= nowMs) {
      ctx.run.nextRetryDueAtByStep[ctx.stepStateKey] = null;
      ctx.run.status = 'running';
      ctx.run.updatedAt = nowIso();
      await savePipelineStore(ctx.storePath, ctx.store);
      return stepSuccess(operation, {
        ready: true,
        wait_ms: 0,
        next_retry_due_at: dueAt,
        run: summarizePipelineRun(ctx.run),
      });
    }

    const waitMs = dueMs - nowMs;
    if (ctx.run.status !== 'waiting') {
      ctx.run.status = 'waiting';
      ctx.run.updatedAt = nowIso();
      await savePipelineStore(ctx.storePath, ctx.store);
    }
    return stepSuccess(operation, {
      ready: false,
      wait_ms: waitMs,
      next_retry_due_at: dueAt,
      run: summarizePipelineRun(ctx.run),
    });
  }

  if (operation === 'step.retry') {
    if (ctx.step.status !== 'failed') {
      return stepFailure(
        operation,
        'E_POLICY_BLOCKED',
        `current step is not failed (status=${ctx.step.status})`,
        { run: summarizePipelineRun(ctx.run) },
      );
    }

    const configuredMaxAttempts = parseMaxAttempts(args);
    const maxAttempts = Math.min(STEP_MAX_ATTEMPTS_TOTAL, Math.max(1, configuredMaxAttempts ?? STEP_MAX_ATTEMPTS_TOTAL));
    const attempts = ctx.run.attemptsByStep[ctx.stepStateKey] ?? 0;
    if (attempts >= maxAttempts) {
      ctx.run.status = 'failed';
      ctx.run.failureCode = 'E_RETRY_EXHAUSTED';
      ctx.run.updatedAt = nowIso();
      await savePipelineStore(ctx.storePath, ctx.store);
      return stepFailure(
        operation,
        'E_RETRY_EXHAUSTED',
        `retry exhausted for step ${ctx.stepIndex} (${attempts}/${maxAttempts} attempts used)`,
        { run: summarizePipelineRun(ctx.run) },
      );
    }

    const retryOrdinal = Math.max(1, attempts);
    const delayMs = STEP_RETRY_DELAYS_MS[Math.min(retryOrdinal - 1, STEP_RETRY_DELAYS_MS.length - 1)];
    const dueAt = new Date(Date.now() + delayMs).toISOString();
    const updatedAt = nowIso();

    ctx.run.nextRetryDueAtByStep[ctx.stepStateKey] = dueAt;
    ctx.run.status = 'waiting';
    ctx.run.failureCode = undefined;
    ctx.run.lastError = undefined;
    ctx.run.updatedAt = updatedAt;
    ctx.step.status = 'pending';
    ctx.step.ok = undefined;
    ctx.step.result = undefined;
    ctx.step.updatedAt = updatedAt;
    await savePipelineStore(ctx.storePath, ctx.store);

    return stepSuccess(operation, {
      retry_due_at: dueAt,
      max_attempts: maxAttempts,
      attempts_used: attempts,
      run: summarizePipelineRun(ctx.run),
    });
  }

  if (ctx.step.status === 'failed') {
    return stepFailure(
      operation,
      'E_POLICY_BLOCKED',
      `current step is failed (status=${ctx.step.status}); call step.retry before step.run`,
      { run: summarizePipelineRun(ctx.run) },
    );
  }
  if (ctx.step.status === 'done' || ctx.step.status === 'cancelled') {
    return stepFailure(
      operation,
      'E_POLICY_BLOCKED',
      `current step is not executable (status=${ctx.step.status})`,
      { run: summarizePipelineRun(ctx.run) },
    );
  }

  const dueAt = ctx.run.nextRetryDueAtByStep[ctx.stepStateKey];
  if (dueAt) {
    const dueMs = Date.parse(dueAt);
    if (Number.isFinite(dueMs) && dueMs > Date.now()) {
      return stepFailure(
        operation,
        'E_POLICY_BLOCKED',
        `retry not due yet for step ${ctx.stepIndex}; wait until ${dueAt}`,
        { run: summarizePipelineRun(ctx.run) },
      );
    }
  }

  const updatedAt = nowIso();
  ctx.run.status = 'running';
  ctx.run.failureCode = undefined;
  ctx.run.nextRetryDueAtByStep[ctx.stepStateKey] = null;
  ctx.run.updatedAt = updatedAt;
  ctx.step.status = 'running';
  ctx.step.updatedAt = updatedAt;
  ctx.run.attemptsByStep[ctx.stepStateKey] = (ctx.run.attemptsByStep[ctx.stepStateKey] ?? 0) + 1;
  ctx.run.lastAttemptAtByStep[ctx.stepStateKey] = updatedAt;
  await savePipelineStore(ctx.storePath, ctx.store);

  const result = await executeToolCall(
    ctx.step.tool,
    ctx.step.arguments,
    allowedRoots,
    log,
    { ...opts, pipelineStepMode: true },
  );

  const completedAt = nowIso();
  ctx.step.ok = result.ok;
  ctx.step.result = result.result;
  ctx.step.updatedAt = completedAt;
  ctx.run.updatedAt = completedAt;

  if (!result.ok) {
    const failureCode = classifyFailureCode(result.result);
    ctx.step.status = 'failed';
    ctx.run.status = 'failed';
    ctx.run.failureCode = failureCode;
    ctx.run.lastError = `step ${ctx.stepIndex + 1} (${ctx.step.tool}) failed: ${result.result}`;
    await savePipelineStore(ctx.storePath, ctx.store);
    return stepFailure(
      operation,
      failureCode,
      ctx.run.lastError,
      { run: summarizePipelineRun(ctx.run) },
    );
  }

  ctx.step.status = 'done';
  ctx.run.currentStep++;
  ctx.run.failureCode = undefined;
  ctx.run.lastError = undefined;
  if (ctx.run.currentStep >= ctx.run.steps.length) {
    ctx.run.status = 'succeeded';
    ctx.run.completedAt = completedAt;
  } else {
    ctx.run.status = 'running';
  }
  await savePipelineStore(ctx.storePath, ctx.store);

  return stepSuccess(operation, {
    step_result: result.result,
    run: summarizePipelineRun(ctx.run),
  });
}

async function handlePipelineTool(
  name: string,
  args: Record<string, unknown>,
  allowedRoots: string[],
  log: LogFn | undefined,
  opts: ExecuteToolCallOpts | undefined,
): Promise<ToolResult> {
  if (!['pipeline.start', 'pipeline.status', 'pipeline.resume', 'pipeline.cancel'].includes(name)) {
    return { result: `Unknown tool: ${name}`, ok: false };
  }
  const operation = name as PipelineToolName;

  const storePath = resolvePipelineStorePath(allowedRoots, opts);
  const loaded = await loadPipelineStore(storePath);
  if (loaded.error) {
    return pipelineFailure(operation, 'E_TOOL_UNAVAILABLE', loaded.error);
  }
  const store = loaded.store;
  normalizePipelineStore(store);
  const invocationWorkspaceRoot = primaryWorkspaceRoot(allowedRoots);
  const { runtime, adapter } = normalizeRuntimeIdentity(opts);

  if (operation === 'pipeline.start') {
    const parsedSteps = parsePipelineSteps(args);
    if (parsedSteps.error || !parsedSteps.steps) {
      return pipelineFailure(operation, 'E_POLICY_BLOCKED', parsedSteps.error ?? 'invalid steps');
    }

    const pipelineName = parsePipelineName(args);
    const autoRun = parseAutoRun(args);
    const canonicalInput = stableJson(args.input ?? null);
    const pipelineInputHash = sha256(canonicalInput);
    const explicitIdempotencyKey = parseIdempotencyKey(args);
    const derivedIdempotencyKey = computeDerivedIdempotencyKey(runtime, adapter, pipelineName, canonicalInput);
    const dedupeLookupKey = explicitIdempotencyKey ?? derivedIdempotencyKey;
    const requestHash = sha256(stableJson({
      runtime,
      adapter,
      pipeline_name: pipelineName,
      pipeline_input_hash: pipelineInputHash,
      auto_run: autoRun,
      steps: canonicalStepsForHash(parsedSteps.steps),
    }));
    const nowMs = Date.now();

    for (const existing of Object.values(store.runs)) {
      if (!isWithinIdempotencyWindow(existing, nowMs)) continue;
      if (existing.idempotencyKey !== dedupeLookupKey) continue;
      if (existing.workspaceRoot && existing.workspaceRoot !== invocationWorkspaceRoot) {
        return workspaceAffinityFailure(operation, existing.workspaceRoot, invocationWorkspaceRoot);
      }
      if (existing.requestHash !== requestHash) {
        return pipelineFailure(
          operation,
          'E_IDEMPOTENCY_CONFLICT',
          `idempotency key conflict for ${dedupeLookupKey}`,
          { run: summarizePipelineRun(existing) },
        );
      }
      return pipelineSuccess(existing, existing.status !== 'failed');
    }

    const runId = parseRunId(args) ?? `plr_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
    if (store.runs[runId]) {
      return pipelineFailure(operation, 'E_IDEMPOTENCY_CONFLICT', `pipeline run already exists: ${runId}`);
    }

    const createdAt = nowIso();
    const attemptsByStep: Record<string, number> = {};
    const lastAttemptAtByStep: Record<string, string | null> = {};
    const nextRetryDueAtByStep: Record<string, string | null> = {};
    for (let i = 0; i < parsedSteps.steps.length; i++) {
      const key = stepKey(i);
      attemptsByStep[key] = 0;
      lastAttemptAtByStep[key] = null;
      nextRetryDueAtByStep[key] = null;
    }
    const run: PipelineRun = {
      runId,
      runtime,
      adapter,
      pipelineName,
      pipelineInputHash,
      idempotencyKey: dedupeLookupKey,
      requestHash,
      workspaceRoot: invocationWorkspaceRoot,
      status: autoRun ? 'running' : 'queued',
      currentStep: 0,
      steps: parsedSteps.steps,
      createdAt,
      updatedAt: createdAt,
      attemptsByStep,
      lastAttemptAtByStep,
      nextRetryDueAtByStep,
      cancelRequested: false,
    };
    store.runs[runId] = run;
    prunePipelineRuns(store);
    await savePipelineStore(storePath, store);

    if (autoRun) {
      await executePipelineRun(run, storePath, store, allowedRoots, log, opts);
    }

    return pipelineSuccess(run, run.status !== 'failed');
  }

  const runId = parseRunId(args);
  if (!runId) {
    return pipelineFailure(operation, 'E_RUN_NOT_FOUND', 'run_id is required');
  }
  const run = store.runs[runId];
  if (!run) {
    return pipelineFailure(operation, 'E_RUN_NOT_FOUND', `pipeline run not found: ${runId}`);
  }
  if (run.workspaceRoot && run.workspaceRoot !== invocationWorkspaceRoot) {
    return workspaceAffinityFailure(operation, run.workspaceRoot, invocationWorkspaceRoot);
  }

  if (operation === 'pipeline.status') {
    return pipelineSuccess(run);
  }

  if (operation === 'pipeline.resume') {
    if (run.status === 'succeeded' || run.status === 'cancelled') {
      return pipelineSuccess(run);
    }
    if (run.cancelRequested) {
      return pipelineFailure(operation, 'E_POLICY_BLOCKED', `pipeline run cancel has been requested: ${runId}`);
    }
    if (run.status === 'failed' && run.failureCode === 'E_RETRY_EXHAUSTED') {
      return pipelineFailure(operation, 'E_RETRY_EXHAUSTED', `retry exhausted for run: ${runId}`);
    }
    if (run.status === 'running' && run.currentStep < run.steps.length) {
      const currentStep = run.steps[run.currentStep]!;
      if (currentStep.status === 'running') {
        const recoveredAt = nowIso();
        currentStep.status = 'pending';
        currentStep.ok = undefined;
        currentStep.result = undefined;
        currentStep.updatedAt = recoveredAt;
        run.updatedAt = recoveredAt;
        await savePipelineStore(storePath, store);
      }
    }
    if (run.status === 'waiting' && run.currentStep < run.steps.length) {
      const key = stepKey(run.currentStep);
      const dueAt = run.nextRetryDueAtByStep[key];
      if (typeof dueAt !== 'string' || dueAt.trim() === '') {
        return pipelineFailure(operation, 'E_POLICY_BLOCKED', `retry has not been scheduled for run: ${runId}; call step.retry first`);
      }
      const dueMs = Date.parse(dueAt);
      if (!Number.isFinite(dueMs)) {
        return pipelineFailure(operation, 'E_POLICY_BLOCKED', `retry schedule is malformed for run: ${runId} (next_retry_due_at=${dueAt})`);
      }
      if (dueMs > Date.now()) {
        return pipelineFailure(operation, 'E_POLICY_BLOCKED', `retry not due yet for run: ${runId} (next_retry_due_at=${dueAt})`);
      }
      run.nextRetryDueAtByStep[key] = null;
      run.status = 'running';
      run.updatedAt = nowIso();
      await savePipelineStore(storePath, store);
    }

    if (run.status === 'failed' && run.currentStep < run.steps.length) {
      const step = run.steps[run.currentStep]!;
      if (step.status === 'failed') {
        const key = stepKey(run.currentStep);
        const dueAt = run.nextRetryDueAtByStep[key];
        if (typeof dueAt !== 'string' || dueAt.trim() === '') {
          return pipelineFailure(operation, 'E_POLICY_BLOCKED', `retry has not been scheduled for run: ${runId}; call step.retry first`);
        }
        const dueMs = Date.parse(dueAt);
        if (!Number.isFinite(dueMs)) {
          return pipelineFailure(operation, 'E_POLICY_BLOCKED', `retry schedule is malformed for run: ${runId} (next_retry_due_at=${dueAt})`);
        }
        if (dueMs > Date.now()) {
          return pipelineFailure(operation, 'E_POLICY_BLOCKED', `retry not due yet for run: ${runId} (next_retry_due_at=${dueAt})`);
        }
        step.status = 'pending';
        step.ok = undefined;
        step.result = undefined;
        step.updatedAt = nowIso();
        run.nextRetryDueAtByStep[key] = null;
      }
      run.lastError = undefined;
      run.failureCode = undefined;
      run.status = 'running';
      run.updatedAt = nowIso();
      await savePipelineStore(storePath, store);
    }
    if (run.status === 'queued') {
      run.status = 'running';
      run.updatedAt = nowIso();
      await savePipelineStore(storePath, store);
    }

    await executePipelineRun(run, storePath, store, allowedRoots, log, opts);
    return pipelineSuccess(run, run.status !== 'failed');
  }

  if (operation === 'pipeline.cancel') {
    if (run.status === 'succeeded') {
      return pipelineFailure(operation, 'E_POLICY_BLOCKED', `pipeline run already succeeded: ${runId}`);
    }
    if (run.status === 'failed') {
      return pipelineFailure(operation, 'E_POLICY_BLOCKED', `pipeline run already failed: ${runId}`);
    }
    if (run.status !== 'cancelled') {
      run.cancelRequested = true;
      run.status = 'cancelled';
      run.cancelledAt = nowIso();
      run.updatedAt = run.cancelledAt;
      for (let i = run.currentStep; i < run.steps.length; i++) {
        const step = run.steps[i]!;
        if (step.status === 'pending' || step.status === 'running') {
          step.status = 'cancelled';
          step.updatedAt = run.updatedAt;
        }
      }
      await savePipelineStore(storePath, store);
    }
    return pipelineSuccess(run);
  }

  return { result: `Unknown tool: ${name}`, ok: false };
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
  opts?: ExecuteToolCallOpts,
): Promise<ToolResult> {
  if (allowedRoots.length === 0) {
    return { result: 'No allowed roots configured', ok: false };
  }

  if (opts?.pipelineStepMode && (name.startsWith('pipeline.') || name.startsWith('step.'))) {
    if (name.startsWith('pipeline.')) {
      return pipelineFailure(
        name as PipelineToolName,
        'E_POLICY_BLOCKED',
        'Nested pipeline.* and step.* calls are not allowed inside pipeline steps',
      );
    }
    if (STEP_TOOL_NAMES.has(name as StepToolName)) {
      return stepFailure(
        name as StepToolName,
        'E_POLICY_BLOCKED',
        'Nested pipeline.* and step.* calls are not allowed inside pipeline steps',
      );
    }
    return { result: 'Nested pipeline.* and step.* calls are not allowed inside pipeline steps', ok: false };
  }
  if (opts?.enableHybridPipeline === false && (name.startsWith('pipeline.') || name.startsWith('step.'))) {
    if (name.startsWith('pipeline.')) {
      return pipelineFailure(
        name as PipelineToolName,
        'E_TOOL_UNAVAILABLE',
        'Hybrid pipeline tools are disabled for this runtime',
      );
    }
    return stepFailure(
      name as StepToolName,
      'E_TOOL_UNAVAILABLE',
      'Hybrid pipeline tools are disabled for this runtime',
    );
  }
  if (opts?.allowedToolNames && !opts.allowedToolNames.has(name)) {
    if (name.startsWith('pipeline.')) {
      return pipelineFailure(
        name as PipelineToolName,
        'E_POLICY_BLOCKED',
        `Tool not allowlisted for this invocation: ${name}`,
      );
    }
    if (STEP_TOOL_NAMES.has(name as StepToolName)) {
      return stepFailure(
        name as StepToolName,
        'E_POLICY_BLOCKED',
        `Tool not allowlisted for this invocation: ${name}`,
      );
    }
    return { result: `Tool not allowlisted for this invocation: ${name}`, ok: false };
  }

  if (name.startsWith('pipeline.')) {
    try {
      log?.(`tool:${name} start`);
      const result = await handlePipelineTool(name, args, allowedRoots, log, opts);
      log?.(`tool:${name} done ok=${result.ok}`);
      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log?.(`tool:${name} error: ${message}`);
      return pipelineFailure(name as PipelineToolName, 'E_TOOL_UNAVAILABLE', message);
    }
  }

  if (name.startsWith('step.')) {
    try {
      log?.(`tool:${name} start`);
      const result = await handleStepTool(name, args, allowedRoots, log, opts);
      log?.(`tool:${name} done ok=${result.ok}`);
      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log?.(`tool:${name} error: ${message}`);
      return stepFailure(name as StepToolName, 'E_TOOL_UNAVAILABLE', message);
    }
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
