export type ImageData = {
  base64: string;
  mediaType: string; // 'image/png', 'image/jpeg', 'image/webp'
};

/** Max images per invocation to prevent runaway accumulation. */
export const MAX_IMAGES_PER_INVOCATION = 10;

export type EngineEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'text_final'; text: string }
  | { type: 'image_data'; image: ImageData }
  | { type: 'log_line'; stream: 'stdout' | 'stderr'; line: string }
  | { type: 'tool_start'; name: string; input?: unknown }
  | { type: 'tool_end'; name: string; output?: unknown; ok: boolean }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; totalTokens?: number; costUsd?: number }
  | { type: 'error'; message: string }
  | { type: 'done' };

export type RuntimeCapability =
  | 'streaming_text'
  | 'sessions'
  | 'workspace_instructions'
  | 'tools_exec'
  | 'tools_fs'
  | 'tools_web'
  | 'mcp'
  | 'multi_turn';

export type RuntimeId = 'claude_code' | 'openai' | 'codex' | 'gemini' | 'other';

export type RuntimeInvokeParams = {
  prompt: string;
  model: string;
  cwd: string;
  sessionId?: string | null;
  sessionKey?: string | null;
  tools?: string[];
  addDirs?: string[];
  timeoutMs?: number;
  images?: ImageData[];
};

export interface RuntimeAdapter {
  id: RuntimeId;
  capabilities: ReadonlySet<RuntimeCapability>;
  invoke(params: RuntimeInvokeParams): AsyncIterable<EngineEvent>;
}
