/**
 * OpenAI function-calling tool definitions for discoclaw tools.
 *
 * Maps internal tool names (Read, Write, …) to OpenAI function names
 * (read_file, write_file, …) and provides JSON Schema parameter definitions.
 */

/** Discoclaw tool name → OpenAI function name */
const DISCO_TO_OPENAI_NAME: Record<string, string> = {
  Read: 'read_file',
  Write: 'write_file',
  Edit: 'edit_file',
  Glob: 'list_files',
  Grep: 'search_content',
  Bash: 'bash',
  WebSearch: 'web_search',
  WebFetch: 'web_fetch',
};

/** OpenAI function name → discoclaw tool name (for dispatching tool results) */
export const OPENAI_TO_DISCO_NAME: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(DISCO_TO_OPENAI_NAME).map(([disco, openai]) => [openai, disco]),
);

// ── Individual tool schemas ──────────────────────────────────────────

type OpenAIFunctionTool = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

const TOOL_DEFS: Record<string, OpenAIFunctionTool> = {
  Read: {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file at the given path.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the file to read.' },
          offset: { type: 'number', description: 'Line number to start reading from (1-based).' },
          limit: { type: 'number', description: 'Maximum number of lines to read.' },
        },
        required: ['file_path'],
        additionalProperties: false,
      },
    },
  },

  Write: {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file, creating or overwriting it.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the file to write.' },
          content: { type: 'string', description: 'The full content to write to the file.' },
        },
        required: ['file_path', 'content'],
        additionalProperties: false,
      },
    },
  },

  Edit: {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Perform an exact string replacement in a file.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the file to edit.' },
          old_string: { type: 'string', description: 'The exact text to find and replace.' },
          new_string: { type: 'string', description: 'The replacement text.' },
          replace_all: {
            type: 'boolean',
            description: 'Replace all occurrences instead of just the first.',
          },
        },
        required: ['file_path', 'old_string', 'new_string'],
        additionalProperties: false,
      },
    },
  },

  Glob: {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'Find files matching a glob pattern.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern to match (e.g. "**/*.ts").' },
          path: { type: 'string', description: 'Directory to search in.' },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
    },
  },

  Grep: {
    type: 'function',
    function: {
      name: 'search_content',
      description: 'Search file contents using a regular expression pattern.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search for.' },
          path: { type: 'string', description: 'File or directory to search in.' },
          glob: { type: 'string', description: 'Glob to filter files (e.g. "*.ts").' },
          case_insensitive: { type: 'boolean', description: 'Case-insensitive search.' },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
    },
  },

  Bash: {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Execute a shell command and return its output.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to execute.' },
          timeout: {
            type: 'number',
            description: 'Timeout in milliseconds (max 600000).',
          },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
  },

  WebSearch: {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web and return results.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },

  WebFetch: {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch the content of a web page by URL.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to fetch.' },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
  },
};

// ── Public API ────────────────────────────────────────────────────────

/**
 * Build OpenAI function-calling tool definitions for the given enabled tools.
 *
 * Only tools that have a known schema are included; unknown names are silently
 * skipped so callers don't need to pre-filter.
 */
export function buildToolSchemas(enabledTools: string[]): OpenAIFunctionTool[] {
  const schemas: OpenAIFunctionTool[] = [];
  for (const tool of enabledTools) {
    const def = TOOL_DEFS[tool];
    if (def) schemas.push(def);
  }
  return schemas;
}
