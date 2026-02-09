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
      stdout: 'pipe',
      stderr: 'pipe',
    });

    if (!subprocess.stdout) {
      yield { type: 'error', message: 'claude: missing stdout stream' };
      yield { type: 'done' };
      return;
    }

    if (opts.outputFormat === 'text') {
      const { stdout, stderr, exitCode } = await subprocess;
      if (exitCode !== 0) {
        const msg = (stderr || stdout || `claude exit ${exitCode}`).trim();
        yield { type: 'error', message: msg };
        yield { type: 'done' };
        return;
      }
      yield* textAsChunks(stdout.trimEnd());
      return;
    }

    // stream-json: parse line-delimited JSON events.
    let buffered = '';
    let merged = '';

    // Capture stderr in case we need to surface it on failure.
    let stderrBuf = '';
    subprocess.stderr?.on('data', (chunk) => {
      stderrBuf += String(chunk);
    });

    for await (const chunk of subprocess.stdout) {
      buffered += String(chunk);

      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const evt = tryParseJsonLine(trimmed);
        const text = extractTextFromUnknownEvent(evt ?? trimmed);
        if (text) {
          merged += text;
          yield { type: 'text_delta', text };
        }
      }
    }

    const { exitCode } = await subprocess;
    if (exitCode !== 0) {
      const msg = (stderrBuf || `claude exit ${exitCode}`).trim();
      yield { type: 'error', message: msg };
      yield { type: 'done' };
      return;
    }

    // Flush any trailing buffered line.
    const tail = buffered.trim();
    if (tail) {
      const evt = tryParseJsonLine(tail);
      const text = extractTextFromUnknownEvent(evt ?? tail);
      if (text) {
        merged += text;
        yield { type: 'text_delta', text };
      }
    }

    if (merged.trim()) yield { type: 'text_final', text: merged.trimEnd() };
    yield { type: 'done' };
  }

  return {
    id: 'claude_code',
    capabilities,
    invoke,
  };
}
