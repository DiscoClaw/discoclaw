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
//   - Plain text stdout by default; `--json` for JSONL.
//   - Diagnostic/progress output goes to stderr.

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
  const capabilities = new Set(['streaming_text', 'tools_fs'] as const);

  async function* invoke(params: RuntimeInvokeParams): AsyncIterable<EngineEvent> {
    const model = params.model || opts.defaultModel;

    const useStdin = Buffer.byteLength(params.prompt, 'utf-8') > STDIN_THRESHOLD;

    const args: string[] = ['exec', '-m', model, '--skip-git-repo-check', '--ephemeral', '-s', 'read-only'];

    // Pass --add-dir flags for additional read-only directories (mirrors claude-code-cli.ts).
    if (params.addDirs && params.addDirs.length > 0) {
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
    let stderrForError = '';
    let stdoutEnded = false;
    let stderrEnded = subprocess.stderr == null;
    let procResult: any | null = null;

    subprocess.stdout.on('data', (chunk) => {
      const s = String(chunk);
      mergedStdout += s;
      push({ type: 'text_delta', text: s });
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
        const raw = (stderrForError || procResult.stderr || procResult.stdout || `codex exit ${procResult.exitCode}`).trim();
        push({ type: 'error', message: sanitizeError(raw) });
        push({ type: 'done' });
        finished = true;
        wake();
        return;
      }

      // Success — emit final text.
      const final = mergedStdout.trimEnd();
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
