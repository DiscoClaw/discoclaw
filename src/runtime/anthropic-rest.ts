// Anthropic Messages API streaming adapter — direct HTTP, no CLI subprocess.
// Eliminates cold-start overhead for latency-sensitive paths like voice.
// Auth via x-api-key header. Streams SSE events from the Messages API.

import type { RuntimeAdapter, EngineEvent, RuntimeCapability, RuntimeInvokeParams } from './types.js';
import { splitSystemPrompt } from './openai-compat.js';

export type AnthropicRestOpts = {
  apiKey: string;
  defaultModel: string;
  baseUrl?: string;
  apiVersion?: string;
  /** Default max_tokens when not specified per-invocation. Defaults to 1024. */
  defaultMaxTokens?: number;
  log?: { debug(...args: unknown[]): void; warn(...args: unknown[]): void };
};

/** Extract the data payload from an SSE line, or undefined if not a data line. */
function parseSSEData(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(':')) return undefined;
  // Anthropic SSE also sends `event:` lines — skip those
  if (trimmed.startsWith('event:')) return undefined;
  if (trimmed.startsWith('data: ')) return trimmed.slice('data: '.length);
  if (trimmed.startsWith('data:')) return trimmed.slice('data:'.length);
  return undefined;
}

export function createAnthropicRestRuntime(opts: AnthropicRestOpts): RuntimeAdapter {
  const capabilities: ReadonlySet<RuntimeCapability> = new Set(['streaming_text']);
  const baseUrl = opts.baseUrl ?? 'https://api.anthropic.com';
  const apiVersion = opts.apiVersion ?? '2023-06-01';
  const defaultMaxTokens = opts.defaultMaxTokens ?? 1024;

  return {
    id: 'claude_code',
    capabilities,
    defaultModel: opts.defaultModel,
    invoke(params: RuntimeInvokeParams) {
      return (async function* (): AsyncGenerator<EngineEvent> {
        const model = params.model || opts.defaultModel;
        const url = `${baseUrl}/v1/messages`;
        const maxTokens = params.maxTokens ?? defaultMaxTokens;

        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;

        if (params.timeoutMs) {
          timer = setTimeout(() => controller.abort(), params.timeoutMs);
        }

        // Forward caller's AbortSignal into the controller.
        const onCallerAbort = () => controller.abort();
        params.signal?.addEventListener('abort', onCallerAbort, { once: true });
        if (params.signal?.aborted) controller.abort();

        const { system: sysContent, user: userContent } = splitSystemPrompt(params);

        try {
          opts.log?.debug({ url, model }, 'anthropic-rest: request');

          const body: Record<string, unknown> = {
            model,
            max_tokens: maxTokens,
            messages: [{ role: 'user', content: userContent }],
            stream: true,
          };

          if (sysContent) {
            body.system = sysContent;
          }

          let accumulated = '';

          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'x-api-key': opts.apiKey,
              'anthropic-version': apiVersion,
              'content-type': 'application/json',
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });

          if (!response.ok) {
            let detail = '';
            try {
              const errBody = (await response.json()) as { error?: { message?: string } };
              detail = errBody.error?.message ?? '';
            } catch {
              /* ignore parse error */
            }
            yield {
              type: 'error',
              message: `Anthropic API error: ${response.status} ${response.statusText}${detail ? `: ${detail}` : ''}`,
            };
            yield { type: 'done' };
            return;
          }

          if (!response.body) {
            yield { type: 'error', message: 'Anthropic API returned no response body' };
            yield { type: 'done' };
            return;
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          const processLine = function* (line: string): Generator<EngineEvent, void> {
            const data = parseSSEData(line);
            if (data === undefined) return;

            try {
              const parsed = JSON.parse(data) as {
                type?: string;
                delta?: { type?: string; text?: string; stop_reason?: string };
                message?: { usage?: { input_tokens?: number; output_tokens?: number } };
                usage?: { output_tokens?: number };
                error?: { message?: string };
              };

              if (parsed.type === 'content_block_delta') {
                const delta = parsed.delta;
                if (delta?.type === 'text_delta' && delta.text) {
                  accumulated += delta.text;
                  yield { type: 'text_delta', text: delta.text };
                }
              } else if (parsed.type === 'message_start') {
                // Input token usage from message_start
                const usage = parsed.message?.usage;
                if (usage?.input_tokens != null) {
                  yield {
                    type: 'usage',
                    inputTokens: usage.input_tokens,
                  };
                }
              } else if (parsed.type === 'message_delta') {
                // Output token usage from message_delta
                const usage = parsed.usage;
                if (usage?.output_tokens != null) {
                  yield {
                    type: 'usage',
                    outputTokens: usage.output_tokens,
                  };
                }
              } else if (parsed.type === 'error') {
                yield {
                  type: 'error',
                  message: parsed.error?.message ?? 'Unknown Anthropic streaming error',
                };
              }
              // message_stop, content_block_start, content_block_stop, ping — ignored
            } catch {
              // Skip unparseable lines
            }
          };

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
              yield* processLine(line);
            }
          }

          // Process any remaining buffered content (stream ended without trailing newline)
          if (buffer.trim()) {
            yield* processLine(buffer);
          }

          yield { type: 'text_final', text: accumulated };
          yield { type: 'done' };
        } catch (err) {
          if (timer) clearTimeout(timer);

          if (controller.signal.aborted) {
            if (params.signal?.aborted) {
              yield { type: 'error', message: 'aborted' };
            } else {
              yield { type: 'error', message: `anthropic-rest timed out after ${params.timeoutMs}ms` };
            }
            yield { type: 'done' };
            return;
          }

          yield { type: 'error', message: String(err) };
          yield { type: 'done' };
        } finally {
          if (timer) clearTimeout(timer);
          params.signal?.removeEventListener('abort', onCallerAbort);
        }
      })();
    },
  };
}
