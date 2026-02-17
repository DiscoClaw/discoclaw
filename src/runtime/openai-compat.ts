import type { RuntimeAdapter, EngineEvent, RuntimeCapability } from './types.js';
import type { ChatGptTokenProvider } from './openai-auth.js';

type CommonOpts = {
  baseUrl: string;
  defaultModel: string;
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
  const capabilities: ReadonlySet<RuntimeCapability> = new Set(['streaming_text']);

  return {
    id: 'openai',
    capabilities,
    defaultModel: opts.defaultModel,
    invoke(params) {
      return (async function* (): AsyncGenerator<EngineEvent> {
        const model = params.model || opts.defaultModel;
        const url = `${opts.baseUrl}/chat/completions`;

        const body = JSON.stringify({
          model,
          messages: [{ role: 'user', content: params.prompt }],
          stream: true,
        });

        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;

        if (params.timeoutMs) {
          timer = setTimeout(() => controller.abort(), params.timeoutMs);
        }

        let accumulated = '';

        try {
          opts.log?.debug({ url, model }, 'openai-compat: request');

          // Resolve bearer token: static key or dynamic OAuth
          let bearerToken = opts.auth === 'chatgpt_oauth'
            ? await opts.tokenProvider.getAccessToken()
            : opts.apiKey;

          let response = await fetch(url, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${bearerToken}`,
              'Content-Type': 'application/json',
            },
            body,
            signal: controller.signal,
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
              signal: controller.signal,
            });
          }

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
        } catch (err) {
          if (timer) clearTimeout(timer);

          if (controller.signal.aborted) {
            yield { type: 'error', message: `openai-compat timed out after ${params.timeoutMs}ms` };
            yield { type: 'done' };
            return;
          }

          yield { type: 'error', message: String(err) };
          yield { type: 'done' };
        } finally {
          if (timer) clearTimeout(timer);
        }
      })();
    },
  };
}
