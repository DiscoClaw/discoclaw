import type { RuntimeAdapter, EngineEvent, RuntimeCapability, RuntimeId } from './types.js';
import type { ChatGptTokenProvider } from './openai-auth.js';
import { buildToolSchemas, OPENAI_TO_DISCO_NAME } from './openai-tool-schemas.js';
import { executeToolCall } from './openai-tool-exec.js';

type CommonOpts = {
  id?: RuntimeId;
  baseUrl: string;
  defaultModel: string;
  enableTools?: boolean;
  log?: { debug(...args: unknown[]): void };
};

type ApiKeyOpts = CommonOpts & {
  auth?: 'api_key';
  apiKey: string;
};

type ChatGptOAuthOpts = CommonOpts & {
  auth: 'chatgpt_oauth';
  tokenProvider: ChatGptTokenProvider;
};

export type OpenAICompatOpts = ApiKeyOpts | ChatGptOAuthOpts;

const TOOL_LOOP_CAP = 25;

/**
 * Returns true for models that require `max_completion_tokens` instead of `max_tokens`.
 * Strips any provider namespace (e.g. "openai/") before matching.
 */
export function useMaxCompletionTokens(model: string): boolean {
  const name = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model;
  const lower = name.toLowerCase();
  return lower.startsWith('o1') || lower.startsWith('o3') || lower.startsWith('gpt-5');
}

/** Extract the data payload from an SSE line, or undefined if not a data line. */
function parseSSEData(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(':')) return undefined;
  // SSE spec: space after colon is optional (data:payload and data: payload are both valid)
  if (trimmed.startsWith('data: ')) return trimmed.slice('data: '.length);
  if (trimmed.startsWith('data:')) return trimmed.slice('data:'.length);
  return undefined;
}

export function createOpenAICompatRuntime(opts: OpenAICompatOpts): RuntimeAdapter {
  const caps: RuntimeCapability[] = ['streaming_text'];
  if (opts.enableTools) {
    caps.push('tools_fs', 'tools_exec');
  }
  const capabilities: ReadonlySet<RuntimeCapability> = new Set(caps);

  /** Shared fetch with OAuth 401 retry logic. Used by both streaming and tool-loop paths. */
  async function fetchWithAuth(url: string, body: string, signal: AbortSignal): Promise<Response> {
    let bearerToken = opts.auth === 'chatgpt_oauth'
      ? await opts.tokenProvider.getAccessToken()
      : (opts as ApiKeyOpts).apiKey;

    let response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${bearerToken}`,
        'Content-Type': 'application/json',
      },
      body,
      signal,
    });

    // On 401 with OAuth, force-refresh the token and retry once
    if (!response.ok && response.status === 401 && opts.auth === 'chatgpt_oauth') {
      opts.log?.debug('openai-compat: 401 received, force-refreshing OAuth token');
      bearerToken = await opts.tokenProvider.getAccessToken(true);
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${bearerToken}`,
          'Content-Type': 'application/json',
        },
        body,
        signal,
      });
    }

    return response;
  }

  return {
    id: opts.id ?? 'openai',
    capabilities,
    defaultModel: opts.defaultModel,
    invoke(params) {
      return (async function* (): AsyncGenerator<EngineEvent> {
        const model = params.model || opts.defaultModel;
        const url = `${opts.baseUrl}/chat/completions`;

        const tokenField = params.maxTokens !== undefined
          ? (useMaxCompletionTokens(model)
            ? { max_completion_tokens: params.maxTokens }
            : { max_tokens: params.maxTokens })
          : {};

        // Determine whether to enter the tool loop
        const toolsRequested = opts.enableTools && params.tools && params.tools.length > 0;
        const toolSchemas = toolsRequested ? buildToolSchemas(params.tools!) : [];
        const useTools = toolSchemas.length > 0;

        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;

        if (params.timeoutMs) {
          timer = setTimeout(() => controller.abort(), params.timeoutMs);
        }

        // Forward caller's AbortSignal into the controller.
        const onCallerAbort = () => controller.abort();
        params.signal?.addEventListener('abort', onCallerAbort, { once: true });

        if (params.signal?.aborted) controller.abort();

        try {
          opts.log?.debug({ url, model }, 'openai-compat: request');

          if (useTools) {
            // ── Tool-loop path (non-streaming rounds) ──────────────────
            const allowedRoots = [params.cwd, ...(params.addDirs ?? [])].filter(s => s !== '');
            const messages: Array<Record<string, unknown>> = [
              { role: 'user', content: params.prompt },
            ];

            for (let round = 0; round < TOOL_LOOP_CAP; round++) {
              const body = JSON.stringify({
                model,
                messages,
                stream: false,
                tools: toolSchemas,
                ...tokenField,
              });

              const response = await fetchWithAuth(url, body, controller.signal);

              if (!response.ok) {
                yield { type: 'error', message: `OpenAI API error: ${response.status} ${response.statusText}` };
                yield { type: 'done' };
                return;
              }

              const json = await response.json();
              const choice = json.choices?.[0];
              const assistantMsg = choice?.message;

              if (!assistantMsg) {
                yield { type: 'error', message: 'No response from model' };
                yield { type: 'done' };
                return;
              }

              const toolCalls: Array<{
                id?: string;
                function?: { name?: string; arguments?: string };
              }> | undefined = assistantMsg.tool_calls;

              if (!toolCalls || toolCalls.length === 0) {
                // Model returned a final text response — emit and exit
                const content: string = assistantMsg.content ?? '';
                if (content) yield { type: 'text_delta', text: content };
                yield { type: 'text_final', text: content };
                yield { type: 'done' };
                return;
              }

              // Append the assistant message (with tool_calls) to the conversation
              messages.push(assistantMsg);

              // Execute each tool call
              for (const tc of toolCalls) {
                const fnName: string = tc.function?.name ?? '';
                const tcId: string | undefined = tc.id;
                const discoName: string = OPENAI_TO_DISCO_NAME[fnName] ?? fnName;

                let args: Record<string, unknown>;
                try {
                  args = JSON.parse(tc.function?.arguments ?? '{}');
                } catch {
                  // Malformed JSON — feed error back to model instead of crashing
                  yield { type: 'tool_start', name: discoName, input: tc.function?.arguments };
                  yield { type: 'tool_end', name: discoName, output: 'Malformed JSON in tool call arguments', ok: false };
                  messages.push({
                    role: 'tool',
                    tool_call_id: tcId ?? 'unknown',
                    content: 'Malformed JSON in tool call arguments',
                  });
                  continue;
                }

                yield { type: 'tool_start', name: discoName, input: args };

                const result = await executeToolCall(fnName, args, allowedRoots);
                yield { type: 'tool_end', name: discoName, output: result.result, ok: result.ok };

                messages.push({
                  role: 'tool',
                  tool_call_id: tcId ?? 'unknown',
                  content: result.result,
                });
              }
            }

            // Safety cap reached
            yield { type: 'error', message: 'Tool loop safety cap reached (25 iterations)' };
            yield { type: 'done' };
          } else {
            // ── Streaming text path (no tools) ─────────────────────────
            const body = JSON.stringify({
              model,
              messages: [{ role: 'user', content: params.prompt }],
              stream: true,
              ...tokenField,
            });

            let accumulated = '';

            const response = await fetchWithAuth(url, body, controller.signal);

            if (!response.ok) {
              yield { type: 'error', message: `OpenAI API error: ${response.status} ${response.statusText}` };
              yield { type: 'done' };
              return;
            }

            if (!response.body) {
              yield { type: 'error', message: 'OpenAI API returned no response body' };
              yield { type: 'done' };
              return;
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            // Process a single SSE line, returning 'done' if [DONE] sentinel was hit
            const processLine = function* (line: string): Generator<EngineEvent, boolean> {
              const data = parseSSEData(line);
              if (data === undefined) return false;

              if (data === '[DONE]') {
                yield { type: 'text_final', text: accumulated };
                yield { type: 'done' };
                return true;
              }

              try {
                const parsed = JSON.parse(data);
                const content = parsed?.choices?.[0]?.delta?.content;
                if (content) {
                  accumulated += content;
                  yield { type: 'text_delta', text: content };
                }
              } catch {
                // Skip unparseable lines
              }
              return false;
            };

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });

              // Process complete lines
              const lines = buffer.split('\n');
              // Keep the last (possibly incomplete) line in the buffer
              buffer = lines.pop() ?? '';

              for (const line of lines) {
                const result = processLine(line);
                let step = result.next();
                while (!step.done) {
                  yield step.value;
                  step = result.next();
                }
                if (step.value) return; // [DONE] hit
              }
            }

            // Process any remaining buffered content (stream ended without trailing newline)
            if (buffer.trim()) {
              const result = processLine(buffer);
              let step = result.next();
              while (!step.done) {
                yield step.value;
                step = result.next();
              }
              if (step.value) return; // [DONE] hit
            }

            // Stream ended without [DONE] — emit what we have
            yield { type: 'text_final', text: accumulated };
            yield { type: 'done' };
          }
        } catch (err) {
          if (timer) clearTimeout(timer);

          if (controller.signal.aborted) {
            if (params.signal?.aborted) {
              yield { type: 'error', message: 'aborted' };
            } else {
              yield { type: 'error', message: `openai-compat timed out after ${params.timeoutMs}ms` };
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
