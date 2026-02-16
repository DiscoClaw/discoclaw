// Codex CLI runtime adapter — shells out to `codex exec`.
//
// Verified CLI interface (codex exec --help, v0.101.0):
//   codex exec [OPTIONS] [PROMPT]
//   - Prompt is a positional arg after all flags.
//   - Use `-` as the prompt to read from stdin.
//   - `-m MODEL` selects the model.
//   - `--skip-git-repo-check` allows running outside a git repo.
//   - `--ephemeral` skips session persistence.
//   - `-s read-only` forces read-only sandbox (no workspace writes).
//   - `--add-dir DIR` adds additional directories (writable, but overridden by -s read-only).
//   - Plain text stdout by default; `--json` for JSONL.
//   - Diagnostic/progress output goes to stderr.
//
// Session persistence (codex exec resume):
//   When a sessionKey is provided, the adapter omits `--ephemeral` and uses
//   `--json` to capture the `thread.started` event containing the thread_id.
//   Subsequent calls with the same sessionKey use `codex exec resume <thread_id>`
//   to continue in the same session context.
//
//   IMPORTANT: `codex exec resume` has a reduced flag set compared to `codex exec`.
//   Supported on resume: -m, --skip-git-repo-check, --json, --ephemeral, --full-auto,
//     --dangerously-bypass-approvals-and-sandbox, -c/--config, --enable, --disable, -i/--image.
//   NOT supported on resume (inherited from original session):
//     -s/--sandbox, --add-dir, -C/--cd, -p/--profile, --oss, --local-provider,
//     --output-schema, --color, -o/--output-last-message.

import process from 'node:process';
import { execa, type ResultPromise } from 'execa';
import type { EngineEvent, RuntimeAdapter, RuntimeInvokeParams } from './types.js';

/** Byte threshold above which prompts are piped via stdin instead of positional arg. */
const STDIN_THRESHOLD = 100_000;

/** Max chars for error messages exposed outside the adapter. Prevents prompt/session leaks. */
const MAX_ERROR_LENGTH = 200;

/**
 * Strip prompt content and internal details from error messages.
 * Codex CLI can include the full prompt, session paths, and auth details in stderr on failure.
 */
function sanitizeError(raw: string): string {
  if (!raw) return 'codex failed (no details)';
  // Take only the first line — subsequent lines often contain prompt/session content.
  const firstLine = raw.split('\n')[0]!.trim();
  return (firstLine || 'codex failed').slice(0, MAX_ERROR_LENGTH);
}

// Track active Codex subprocesses so we can kill them on shutdown.
const activeSubprocesses = new Set<ResultPromise>();

/** SIGKILL all tracked Codex subprocesses (e.g. on SIGTERM). */
export function killActiveCodexSubprocesses(): void {
  for (const p of activeSubprocesses) {
    p.kill('SIGKILL');
  }
  activeSubprocesses.clear();
}

export type CodexCliRuntimeOpts = {
  codexBin: string;
  defaultModel: string;
  log?: { debug(...args: unknown[]): void; info?(...args: unknown[]): void };
};

export function createCodexCliRuntime(opts: CodexCliRuntimeOpts): RuntimeAdapter {
  const capabilities = new Set(['streaming_text', 'tools_fs', 'sessions'] as const);

  // Maps sessionKey → Codex thread_id (UUID) for session resume.
  const sessionMap = new Map<string, string>();

  async function* invoke(params: RuntimeInvokeParams): AsyncIterable<EngineEvent> {
    const model = params.model || opts.defaultModel;
    const wantSession = Boolean(params.sessionKey);
    const existingThreadId = params.sessionKey ? sessionMap.get(params.sessionKey) : undefined;

    const useStdin = Buffer.byteLength(params.prompt, 'utf-8') > STDIN_THRESHOLD;

    // When resuming, use `codex exec resume <thread_id> [PROMPT]`.
    // The resume subcommand does NOT support -s/--sandbox (inherits from original session).
    // When starting a new session (or ephemeral), use `codex exec [PROMPT]`.
    const args: string[] = existingThreadId
      ? ['exec', 'resume', existingThreadId, '-m', model, '--skip-git-repo-check']
      : ['exec', '-m', model, '--skip-git-repo-check', ...(wantSession ? [] : ['--ephemeral']), '-s', 'read-only'];

    // When session tracking is active, use --json so we can capture the thread_id
    // from the `thread.started` event.
    if (wantSession) {
      args.push('--json');
    }

    // Pass --add-dir flags for additional directories (mirrors claude-code-cli.ts).
    // Note: Codex's --help describes --add-dir as "writable", but -s read-only overrides
    // that — verified empirically (Codex v0.101.0). The dirs become read-accessible only.
    // The resume subcommand does NOT support --add-dir (inherits from original session).
    if (!existingThreadId && params.addDirs && params.addDirs.length > 0) {
      for (const dir of params.addDirs) {
        args.push('--add-dir', dir);
      }
    }

    if (useStdin) {
      // Use `-` to signal stdin reading.
      args.push('-');
    } else {
      args.push(params.prompt);
    }

    if (opts.log) {
      opts.log.debug({ args: args.slice(0, -1), useStdin }, 'codex-cli: constructed args');
    }

    const subprocess = execa(opts.codexBin, args, {
      cwd: params.cwd,
      timeout: params.timeoutMs,
      reject: false,
      forceKillAfterDelay: 5000,
      stdin: useStdin ? 'pipe' : 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        TERM: 'dumb',
      },
    });

    // When using stdin, pipe the prompt and close.
    if (useStdin && subprocess.stdin) {
      try {
        subprocess.stdin.write(params.prompt);
        subprocess.stdin.end();
      } catch {
        // stdin write failed — process will run without input and exit with error.
      }
    }

    activeSubprocesses.add(subprocess);
    subprocess.then(() => activeSubprocesses.delete(subprocess))
      .catch(() => activeSubprocesses.delete(subprocess));

    if (!subprocess.stdout) {
      yield { type: 'error', message: 'codex: missing stdout stream' };
      yield { type: 'done' };
      return;
    }

    // Async event queue — mirrors claude-code-cli.ts streaming pattern.
    const q: EngineEvent[] = [];
    let notify: (() => void) | null = null;
    const wake = () => {
      if (!notify) return;
      const n = notify;
      notify = null;
      n();
    };
    const push = (evt: EngineEvent) => {
      q.push(evt);
      wake();
    };
    const wait = () => new Promise<void>((r) => { notify = r; });

    let finished = false;
    let mergedStdout = '';
    let mergedText = ''; // Extracted text content (from JSONL or raw stdout)
    let stderrForError = '';
    let stdoutEnded = false;
    let stderrEnded = subprocess.stderr == null;
    let procResult: any | null = null;
    let stdoutBuffer = ''; // Line buffer for JSONL parsing

    subprocess.stdout.on('data', (chunk) => {
      const s = String(chunk);
      mergedStdout += s;

      if (!wantSession) {
        // Plain text mode — pass through directly.
        push({ type: 'text_delta', text: s });
        return;
      }

      // JSONL mode — parse line by line and extract text + thread_id.
      stdoutBuffer += s;
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const evt = JSON.parse(trimmed);

          // Capture thread_id for session resume on subsequent calls.
          if (evt.type === 'thread.started' && evt.thread_id && params.sessionKey) {
            sessionMap.set(params.sessionKey, evt.thread_id);
            if (opts.log) {
              opts.log.debug({ sessionKey: params.sessionKey, threadId: evt.thread_id }, 'codex-cli: session mapped');
            }
          }

          // Extract text from agent_message items.
          if (evt.type === 'item.completed' && evt.item?.type === 'agent_message' && evt.item.text) {
            mergedText += evt.item.text;
            push({ type: 'text_delta', text: evt.item.text });
          }
        } catch {
          // Non-JSON line in JSONL mode — treat as raw text.
          push({ type: 'text_delta', text: trimmed });
        }
      }
    });

    subprocess.stderr?.on('data', (chunk) => {
      stderrForError += String(chunk);
    });

    subprocess.stdout.on('end', () => {
      stdoutEnded = true;
      tryFinalize();
    });
    subprocess.stderr?.on('end', () => {
      stderrEnded = true;
      tryFinalize();
    });

    function tryFinalize() {
      if (finished) return;
      if (!procResult) return;
      if (!stdoutEnded) return;
      if (!stderrEnded) return;

      if (procResult.timedOut) {
        push({
          type: 'error',
          message: `codex timed out after ${params.timeoutMs ?? 0}ms`,
        });
        push({ type: 'done' });
        finished = true;
        wake();
        return;
      }

      if (procResult.failed && procResult.exitCode == null) {
        // Spawn failures (ENOENT, EACCES, etc.) — execa's shortMessage includes the full
        // command line with prompt text, so we use a fixed message with only the error code.
        const code = procResult.code || procResult.errno || '';
        const isNotFound = code === 'ENOENT' || (procResult.originalMessage || '').includes('ENOENT');
        push({
          type: 'error',
          message: isNotFound
            ? `codex binary not found (${opts.codexBin}). Check CODEX_BIN or PATH.`
            : `codex failed to start${code ? ` (${code})` : ''}`,
        });
        push({ type: 'done' });
        finished = true;
        wake();
        return;
      }

      if (procResult.exitCode !== 0) {
        // Clear stale session mapping — the thread may be corrupt/incomplete.
        if (params.sessionKey) sessionMap.delete(params.sessionKey);
        const raw = (stderrForError || procResult.stderr || procResult.stdout || `codex exit ${procResult.exitCode}`).trim();
        push({ type: 'error', message: sanitizeError(raw) });
        push({ type: 'done' });
        finished = true;
        wake();
        return;
      }

      // Flush any trailing JSONL buffer.
      if (wantSession && stdoutBuffer.trim()) {
        try {
          const evt = JSON.parse(stdoutBuffer.trim());
          if (evt.type === 'thread.started' && evt.thread_id && params.sessionKey) {
            sessionMap.set(params.sessionKey, evt.thread_id);
          }
          if (evt.type === 'item.completed' && evt.item?.type === 'agent_message' && evt.item.text) {
            mergedText += evt.item.text;
            push({ type: 'text_delta', text: evt.item.text });
          }
        } catch {
          // ignore
        }
        stdoutBuffer = '';
      }

      // Success — emit final text.
      const final = wantSession ? mergedText.trimEnd() : mergedStdout.trimEnd();
      if (final) push({ type: 'text_final', text: final });
      push({ type: 'done' });
      finished = true;
      wake();
    }

    // When the process completes, stash the result and try to finalize.
    subprocess.then((result) => {
      procResult = result;
      tryFinalize();
    }).catch((err: any) => {
      if (finished) return;
      const timedOut = Boolean(err?.timedOut);
      // Use fixed messages — err.shortMessage/originalMessage can contain the full
      // command line (including prompt text), so we never expose raw error strings.
      const code = err?.code || err?.errno || '';
      const isNotFound = code === 'ENOENT' || String(err?.originalMessage || '').includes('ENOENT');
      push({
        type: 'error',
        message: timedOut
          ? `codex timed out after ${params.timeoutMs ?? 0}ms`
          : isNotFound
            ? `codex binary not found (${opts.codexBin}). Check CODEX_BIN or PATH.`
            : `codex process failed unexpectedly${code ? ` (${code})` : ''}`,
      });
      push({ type: 'done' });
      finished = true;
      wake();
    });

    try {
      while (!finished || q.length > 0) {
        if (q.length === 0) await wait();
        while (q.length > 0) {
          yield q.shift()!;
        }
      }
    } finally {
      if (!finished) subprocess.kill('SIGKILL');
      activeSubprocesses.delete(subprocess);
    }
  }

  return {
    id: 'codex',
    capabilities,
    invoke,
  };
}
