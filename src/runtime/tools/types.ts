/**
 * Shared types for standalone OpenAI function-calling tool modules.
 */

export type ToolResult = { result: string; ok: boolean };

export type OpenAIFunctionTool = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ToolHandler = (
  args: Record<string, unknown>,
  allowedRoots: string[],
) => Promise<ToolResult>;
