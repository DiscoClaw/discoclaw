// Gemini REST API runtime adapter — direct HTTP, no CLI subprocess.
// Uses the Gemini generateContent / streamGenerateContent endpoints.
// Auth via GEMINI_API_KEY header. Zero startup overhead vs. the CLI adapter.

import type { RuntimeAdapter, EngineEvent, RuntimeCapability, RuntimeInvokeParams } from './types.js';
import { splitSystemPrompt } from './openai-compat.js';

export type GeminiRestOpts = {
  apiKey: string;
  defaultModel: string;
  baseUrl?: string;
  log?: { debug(...args: unknown[]): void };
};

/** Extract the data payload from an SSE line, or undefined if not a data line. */
function parseSSEData(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(':')) return undefined;
  if (trimmed.startsWith('data: ')) return trimmed.slice('data: '.length);
  if (trimmed.startsWith('data:')) return trimmed.slice('data:'.length);
  return undefined;
}

export function createGeminiRestRuntime(opts: GeminiRestOpts): RuntimeAdapter {
  const capabilities: ReadonlySet<RuntimeCapability> = new Set(['streaming_text']);
  const baseUrl = opts.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';

  return {
    id: 'gemini',
    capabilities,
    defaultModel: opts.defaultModel,
    invoke(params: RuntimeInvokeParams) {
      return (async function* (): AsyncGenerator<EngineEvent> {
        const model = params.model || opts.defaultModel;
        const url = `${baseUrl}/models/${model}:streamGenerateContent?alt=sse`;

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
          opts.log?.debug({ url, model }, 'gemini-rest: request');

          // Build the Gemini API request body.
          const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [
            { role: 'user', parts: [{ text: userContent }] },
          ];

          const body: Record<string, unknown> = { contents };

          if (sysContent) {
            body.systemInstruction = { parts: [{ text: sysContent }] };
          }

          let accumulated = '';

          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'x-goog-api-key': opts.apiKey,
              'Content-Type': 'application/json',
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
              message: `Gemini API error: ${response.status} ${response.statusText}${detail ? `: ${detail}` : ''}`,
            };
            yield { type: 'done' };
            return;
          }

          if (!response.body) {
            yield { type: 'error', message: 'Gemini API returned no response body' };
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
                candidates?: Array<{
                  content?: { parts?: Array<{ text?: string }> };
                  finishReason?: string;
                }>;
                usageMetadata?: {
                  promptTokenCount?: number;
                  candidatesTokenCount?: number;
                  totalTokenCount?: number;
                };
              };

              // Extract text from all parts
              const parts = parsed.candidates?.[0]?.content?.parts;
              if (parts) {
                for (const part of parts) {
                  if (part.text) {
                    accumulated += part.text;
                    yield { type: 'text_delta', text: part.text };
                  }
                }
              }

              // Emit usage if present
              const usage = parsed.usageMetadata;
              if (usage) {
                yield {
                  type: 'usage',
                  inputTokens: usage.promptTokenCount,
                  outputTokens: usage.candidatesTokenCount,
                  totalTokens: usage.totalTokenCount,
                };
              }
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

          // Process any remaining buffered content
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
              yield { type: 'error', message: `gemini-rest timed out after ${params.timeoutMs}ms` };
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
