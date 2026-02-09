import process from 'node:process';
import { execa } from 'execa';
import type { EngineEvent, RuntimeAdapter, RuntimeInvokeParams } from './types.js';

function extractTextFromUnknownEvent(evt: unknown): string | null {
  if (!evt || typeof evt !== 'object') return null;
  const anyEvt = evt as Record<string, unknown>;

  const candidates: unknown[] = [
    anyEvt.text,
    anyEvt.delta,
    anyEvt.content,
    // Sometimes nested.
    (anyEvt.data && typeof anyEvt.data === 'object') ? (anyEvt.data as any).text : undefined,
  ];

  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return null;
}

function* textAsChunks(text: string): Generator<EngineEvent> {
  if (!text) return;
  yield { type: 'text_final', text };
  yield { type: 'done' };
}

function tryParseJsonLine(line: string): unknown | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export type ClaudeCliRuntimeOpts = {
  claudeBin: string;
  dangerouslySkipPermissions: boolean;
  outputFormat: 'text' | 'stream-json';
  // Echo raw CLI output for debugging / "terminal-like" Discord output.
  echoStdio?: boolean;
  // If set, pass `--debug-file` to Claude CLI. Keep local; may contain sensitive info.
  debugFile?: string | null;
};

export function createClaudeCliRuntime(opts: ClaudeCliRuntimeOpts): RuntimeAdapter {
  const capabilities = new Set([
    'streaming_text',
    'sessions',
    'workspace_instructions',
    'tools_exec',
    'tools_fs',
    'tools_web',
    'mcp',
  ] as const);

  async function* invoke(params: RuntimeInvokeParams): AsyncIterable<EngineEvent> {
    const args: string[] = ['-p', '--model', params.model];

    if (opts.dangerouslySkipPermissions) {
      args.push('--dangerously-skip-permissions');
    }

    if (opts.debugFile && opts.debugFile.trim()) {
      args.push('--debug-file', opts.debugFile.trim());
    }

    if (params.sessionId) {
      args.push('--session-id', params.sessionId);
    }

    if (params.addDirs && params.addDirs.length > 0) {
      // `--add-dir` accepts multiple values.
      args.push('--add-dir', ...params.addDirs);
    }

    if (opts.outputFormat) {
      args.push('--output-format', opts.outputFormat);
    }

    if (opts.outputFormat === 'stream-json') {
      args.push('--include-partial-messages');
    }

    // Tool flags are runtime-specific; keep optional and configurable.
    if (params.tools && params.tools.length > 0) {
      // `--tools` accepts a comma-separated list for built-in tools.
      // We keep this simple; if we need finer control, add --allowedTools/--disallowedTools.
      args.push('--tools', params.tools.join(','));
    }

    args.push(params.prompt);

    const subprocess = execa(opts.claudeBin, args, {
      cwd: params.cwd,
      timeout: params.timeoutMs,
      reject: false,
      // Ensure the CLI can't hang waiting for input (auth prompts, trust dialogs, etc).
      stdin: 'ignore',
      env: {
        ...process.env,
        // Prefer plain output: Discord doesn't render ANSI well.
        NO_COLOR: process.env.NO_COLOR ?? '1',
        FORCE_COLOR: process.env.FORCE_COLOR ?? '0',
        TERM: process.env.TERM ?? 'dumb',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    if (!subprocess.stdout) {
      yield { type: 'error', message: 'claude: missing stdout stream' };
      yield { type: 'done' };
      return;
    }

    // Emit stdout/stderr as they arrive via a small async queue so we can
    // yield events from both streams without risking pipe backpressure deadlocks.
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

    let mergedStdout = '';
    let merged = '';
    let stdoutBuffered = '';
    let stderrBuffered = '';
    let stderrForError = '';
    let finished = false;
    let stdoutEnded = false;
    let stderrEnded = subprocess.stderr == null;
    let procResult: any | null = null;

    subprocess.stdout.on('data', (chunk) => {
      const s = String(chunk);
      mergedStdout += s;
      if (opts.outputFormat === 'text') {
        push({ type: 'text_delta', text: s });
        return;
      }

      // stream-json: parse line-delimited JSON events.
      stdoutBuffered += s;
      const lines = stdoutBuffered.split(/\r?\n/);
      stdoutBuffered = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (opts.echoStdio) {
          // Echo raw stream-json lines so Discord can show "what the terminal shows"
          // even when no text fields are emitted yet.
          push({ type: 'log_line', stream: 'stdout', line: trimmed });
        }
        const evt = tryParseJsonLine(trimmed);
        const text = extractTextFromUnknownEvent(evt ?? trimmed);
        if (text) {
          merged += text;
          push({ type: 'text_delta', text });
        }
      }
    });

    subprocess.stderr?.on('data', (chunk) => {
      const s = String(chunk);
      stderrForError += s;
      if (!opts.echoStdio) return;
      stderrBuffered += s;
      const lines = stderrBuffered.split(/\r?\n/);
      stderrBuffered = lines.pop() ?? '';
      for (const line of lines) {
        push({ type: 'log_line', stream: 'stderr', line });
      }
    });

    subprocess.stdout.on('end', () => {
      stdoutEnded = true;
      // If the process resolved before the streams flushed (mocked tests, edge cases),
      // finalize once we know stdout is done.
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

      const exitCode = procResult.exitCode;
      const stdout = procResult.stdout ?? '';
      const stderr = procResult.stderr ?? '';

      if (procResult.timedOut) {
        const msg = (procResult.originalMessage || procResult.shortMessage || procResult.message || '').trim();
        push({
          type: 'error',
          message: `claude timed out after ${params.timeoutMs ?? 0}ms${msg ? `: ${msg}` : ''}`,
        });
        push({ type: 'done' });
        finished = true;
        wake();
        return;
      }

      if (procResult.failed && exitCode == null) {
        const msg = (procResult.shortMessage || procResult.originalMessage || procResult.message || '').trim();
        push({
          type: 'error',
          message: msg || 'claude failed (no exit code)',
        });
        push({ type: 'done' });
        finished = true;
        wake();
        return;
      }

      // Flush trailing stderr.
      const stderrTail = stderrBuffered.trimEnd();
      if (opts.echoStdio && stderrTail) {
        push({ type: 'log_line', stream: 'stderr', line: stderrTail });
      }

      if (opts.outputFormat === 'stream-json') {
        // Flush trailing stdout.
        const tail = stdoutBuffered.trim();
        if (tail) {
          const evt = tryParseJsonLine(tail);
          const text = extractTextFromUnknownEvent(evt ?? tail);
          if (text) {
            merged += text;
            push({ type: 'text_delta', text });
          }
        }
      }

      if (exitCode !== 0) {
        const msg = (stderrForError || stderr || stdout || `claude exit ${exitCode}`).trim();
        push({ type: 'error', message: msg });
        push({ type: 'done' });
        finished = true;
        wake();
        return;
      }

      if (opts.outputFormat === 'text') {
        const final = (stdout || mergedStdout).trimEnd();
        if (final) push({ type: 'text_final', text: final });
      } else {
        if (merged.trim()) push({ type: 'text_final', text: merged.trimEnd() });
      }

      push({ type: 'done' });
      finished = true;
      wake();
    }

    // When the process completes, wait for streams to end too, then finalize.
    // Important: keep the full execa result so we preserve fields like `timedOut`
    // and `failed` (otherwise we end up with "claude exit undefined").
    subprocess.then((result) => {
      procResult = result;
      tryFinalize();
    }).catch((err: any) => {
      // Timeouts/spawn errors reject the promise (even with `reject: false`).
      // Surface a stable message and include execa's short/original message when present.
      const timedOut = Boolean(err?.timedOut);
      const msg = String(
        (err?.originalMessage || err?.shortMessage || err?.message || err || '')
      ).trim();
      push({
        type: 'error',
        message: timedOut
          ? `claude timed out after ${params.timeoutMs ?? 0}ms${msg ? `: ${msg}` : ''}`
          : (msg || 'claude failed'),
      });
      push({ type: 'done' });
      finished = true;
      wake();
    });

    while (!finished || q.length > 0) {
      if (q.length === 0) await wait();
      while (q.length > 0) {
        yield q.shift()!;
      }
    }
  }

  return {
    id: 'claude_code',
    capabilities,
    invoke,
  };
}
