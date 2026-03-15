export type TaskRuntimeId = 'claude_code' | 'openai' | 'openrouter' | 'codex' | 'gemini' | 'other';
export type TaskModelResolver = (model: string, runtimeId: TaskRuntimeId) => string;

export type TaskRuntimeInvokeParams = {
  prompt: string;
  model: string;
  cwd: string;
  tools?: string[];
  timeoutMs?: number;
};

export type TaskRuntimeEvent = {
  type: string;
  text?: string;
  message?: string;
  [key: string]: unknown;
};

export interface TaskRuntimeAdapter {
  id: TaskRuntimeId;
  capabilities?: ReadonlySet<string>;
  defaultModel?: string;
  invoke(params: TaskRuntimeInvokeParams): AsyncIterable<TaskRuntimeEvent>;
}
