/**
 * Server-side tool execution handlers for OpenAI function-calling tools.
 *
 * Each handler receives parsed arguments and returns { result, ok }.
 * All handlers catch exceptions — they never throw.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { sanitizeExternalContent } from '../sanitize-external.js';

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
   * Defaults to `<allowedRoots[0]>/.discoclaw/openai-pipeline-runs.json`.
   */
  pipelineStorePath?: string;
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
type PipelineRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

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
  status: PipelineRunStatus;
  currentStep: number;
  steps: PipelineStep[];
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  completedAt?: string;
  cancelledAt?: string;
};

type PipelineStore = {
  version: 1;
  runs: Record<string, PipelineRun>;
};

const PIPELINE_STORE_VERSION = 1 as const;
const PIPELINE_MAX_RUNS = 200;

function nowIso(): string {
  return new Date().toISOString();
}

function emptyPipelineStore(): PipelineStore {
  return { version: PIPELINE_STORE_VERSION, runs: {} };
}

function resolvePipelineStorePath(allowedRoots: string[], opts?: ExecuteToolCallOpts): string {
  if (opts?.pipelineStorePath && opts.pipelineStorePath.trim() !== '') {
    return path.resolve(opts.pipelineStorePath);
  }
  return path.join(allowedRoots[0], '.discoclaw', 'openai-pipeline-runs.json');
}

async function loadPipelineStore(storePath: string): Promise<{ store: PipelineStore; error?: string }> {
  try {
    const raw = await fs.readFile(storePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { store: emptyPipelineStore(), error: 'pipeline store is malformed (expected object root)' };
    }
    const obj = parsed as Record<string, unknown>;
    if (obj.version !== PIPELINE_STORE_VERSION) {
      return { store: emptyPipelineStore(), error: 'pipeline store has unsupported version' };
    }
    const runsRaw = obj.runs;
    if (!runsRaw || typeof runsRaw !== 'object' || Array.isArray(runsRaw)) {
      return { store: emptyPipelineStore(), error: 'pipeline store is malformed (runs must be an object)' };
    }
    return { store: obj as PipelineStore };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { store: emptyPipelineStore() };
    }
    return { store: emptyPipelineStore(), error: 'failed to read pipeline store' };
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
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  const tmpPath = `${storePath}.tmp.${process.pid}`;
  await fs.writeFile(tmpPath, JSON.stringify(store, null, 2) + '\n', 'utf-8');
  await fs.rename(tmpPath, storePath);
}

function parseRunId(args: Record<string, unknown>): string | undefined {
  const candidate = args.run_id ?? args.runId ?? args.id;
  return typeof candidate === 'string' && candidate.trim() !== '' ? candidate.trim() : undefined;
}

function parseAutoRun(args: Record<string, unknown>): boolean {
  const candidate = args.auto_run ?? args.autoRun;
  if (typeof candidate === 'boolean') return candidate;
  return true;
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

function summarizePipelineRun(run: PipelineRun): Record<string, unknown> {
  return {
    run_id: run.runId,
    status: run.status,
    current_step: run.currentStep,
    total_steps: run.steps.length,
    last_error: run.lastError ?? null,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
    completed_at: run.completedAt ?? null,
    cancelled_at: run.cancelledAt ?? null,
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
  run.status = 'running';
  run.updatedAt = nowIso();
  await savePipelineStore(storePath, store);

  while (run.currentStep < run.steps.length) {
    const step = run.steps[run.currentStep]!;
    if (step.status === 'done') {
      run.currentStep++;
      run.updatedAt = nowIso();
      await savePipelineStore(storePath, store);
      continue;
    }

    step.status = 'running';
    step.updatedAt = nowIso();
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
      run.lastError = `step ${run.currentStep + 1} (${step.tool}) failed: ${result.result}`;
      await savePipelineStore(storePath, store);
      return;
    }

    step.status = 'done';
    run.currentStep++;
    await savePipelineStore(storePath, store);
  }

  run.status = 'completed';
  run.completedAt = nowIso();
  run.updatedAt = run.completedAt;
  await savePipelineStore(storePath, store);
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

  const storePath = resolvePipelineStorePath(allowedRoots, opts);
  const loaded = await loadPipelineStore(storePath);
  if (loaded.error) {
    return { result: loaded.error, ok: false };
  }
  const store = loaded.store;

  if (name === 'pipeline.start') {
    const parsedSteps = parsePipelineSteps(args);
    if (parsedSteps.error || !parsedSteps.steps) {
      return { result: parsedSteps.error ?? 'invalid steps', ok: false };
    }

    const runId = parseRunId(args) ?? `plr_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
    if (store.runs[runId]) {
      return { result: `pipeline run already exists: ${runId}`, ok: false };
    }

    const createdAt = nowIso();
    const run: PipelineRun = {
      runId,
      status: 'pending',
      currentStep: 0,
      steps: parsedSteps.steps,
      createdAt,
      updatedAt: createdAt,
    };
    store.runs[runId] = run;
    prunePipelineRuns(store);
    await savePipelineStore(storePath, store);

    if (parseAutoRun(args)) {
      await executePipelineRun(run, storePath, store, allowedRoots, log, opts);
    }

    return {
      ok: run.status !== 'failed',
      result: JSON.stringify(summarizePipelineRun(run)),
    };
  }

  const runId = parseRunId(args);
  if (!runId) {
    return { result: 'run_id is required', ok: false };
  }
  const run = store.runs[runId];
  if (!run) {
    return { result: `pipeline run not found: ${runId}`, ok: false };
  }

  if (name === 'pipeline.status') {
    return { ok: true, result: JSON.stringify(summarizePipelineRun(run)) };
  }

  if (name === 'pipeline.resume') {
    if (run.status === 'completed') {
      return { result: `pipeline run already completed: ${runId}`, ok: false };
    }
    if (run.status === 'cancelled') {
      return { result: `pipeline run is cancelled: ${runId}`, ok: false };
    }
    if (run.status === 'running') {
      return { result: `pipeline run is already running: ${runId}`, ok: false };
    }

    if (run.status === 'failed' && run.currentStep < run.steps.length) {
      const step = run.steps[run.currentStep]!;
      if (step.status === 'failed') {
        step.status = 'pending';
        step.ok = undefined;
        step.result = undefined;
        step.updatedAt = nowIso();
      }
      run.lastError = undefined;
      run.status = 'pending';
      run.updatedAt = nowIso();
      await savePipelineStore(storePath, store);
    }

    await executePipelineRun(run, storePath, store, allowedRoots, log, opts);
    return {
      ok: run.status !== 'failed',
      result: JSON.stringify(summarizePipelineRun(run)),
    };
  }

  if (name === 'pipeline.cancel') {
    if (run.status === 'completed') {
      return { result: `pipeline run already completed: ${runId}`, ok: false };
    }
    if (run.status === 'failed') {
      return { result: `pipeline run already failed: ${runId}`, ok: false };
    }
    if (run.status !== 'cancelled') {
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
    return { ok: true, result: JSON.stringify(summarizePipelineRun(run)) };
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

  if (opts?.pipelineStepMode && name.startsWith('pipeline.')) {
    return { result: 'Nested pipeline.* calls are not allowed inside pipeline steps', ok: false };
  }
  if (opts?.allowedToolNames && !opts.allowedToolNames.has(name)) {
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
      return { result: message, ok: false };
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
