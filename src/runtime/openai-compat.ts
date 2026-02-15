import type { RuntimeAdapter, EngineEvent, RuntimeCapability } from './types.js';

export type OpenAICompatOpts = {
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  log?: { debug(...args: unknown[]): void };
};

export function createOpenAICompatRuntime(opts: OpenAICompatOpts): RuntimeAdapter {
  const capabilities: ReadonlySet<RuntimeCapability> = new Set(['streaming_text']);

  return {
    id: 'openai',
    capabilities,
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

          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${opts.apiKey}`,
              'Content-Type': 'application/json',
            },
            body,
            signal: controller.signal,
          });

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

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            // Process complete lines
            const lines = buffer.split('\n');
            // Keep the last (possibly incomplete) line in the buffer
            buffer = lines.pop() ?? '';

            for (const line of lines) {
              const trimmed = line.trim();

              // Skip empty lines and comments
              if (!trimmed || trimmed.startsWith(':')) continue;

              // Check for data lines
              if (!trimmed.startsWith('data: ')) continue;

              const data = trimmed.slice('data: '.length);

              // Check for stream end sentinel
              if (data === '[DONE]') {
                yield { type: 'text_final', text: accumulated };
                yield { type: 'done' };
                return;
              }

              // Parse the JSON payload
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
            }
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
