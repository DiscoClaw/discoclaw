export type EngineEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'text_final'; text: string }
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
  | 'mcp';

export type RuntimeId = 'claude_code' | 'openai' | 'gemini' | 'other';

export type RuntimeInvokeParams = {
  prompt: string;
  model: string;
  cwd: string;
  sessionId?: string | null;
  tools?: string[];
  addDirs?: string[];
  timeoutMs?: number;
};

export interface RuntimeAdapter {
  id: RuntimeId;
  capabilities: ReadonlySet<RuntimeCapability>;
  invoke(params: RuntimeInvokeParams): AsyncIterable<EngineEvent>;
}
