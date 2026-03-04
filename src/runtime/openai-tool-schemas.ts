/**
 * OpenAI function-calling tool definitions for discoclaw tools.
 *
 * Maps internal tool names (Read, Write, …) to OpenAI function names
 * (read_file, write_file, …) and provides JSON Schema parameter definitions.
 */

/** Discoclaw tool name → OpenAI function names */
const DISCO_TO_OPENAI_NAMES: Readonly<Record<string, string[]>> = {
  Read: ['read_file'],
  Write: ['write_file'],
  Edit: ['edit_file'],
  Glob: ['list_files'],
  Grep: ['search_content'],
  Bash: ['bash'],
  WebSearch: ['web_search'],
  WebFetch: ['web_fetch'],
  // Hybrid pipeline runtime lifecycle wiring.
  Pipeline: ['pipeline.start', 'pipeline.status', 'pipeline.resume', 'pipeline.cancel'],
  Step: ['step.run', 'step.assert', 'step.retry', 'step.wait'],
};

/** OpenAI function name → discoclaw tool name (for dispatching tool results) */
export const OPENAI_TO_DISCO_NAME: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(DISCO_TO_OPENAI_NAMES).flatMap(([disco, openaiNames]) =>
    openaiNames.map((openai) => [openai, disco]),
  ),
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
          pattern: {
            type: 'string',
            description:
              'Glob pattern to match, relative to allowed workspace roots; must not be absolute or contain ".." path traversal segments (e.g. "**/*.ts").',
          },
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

  'pipeline.start': {
    type: 'function',
    function: {
      name: 'pipeline.start',
      description: 'Create a durable pipeline run and optionally execute it.',
      parameters: {
        type: 'object',
        properties: {
          run_id: { type: 'string', description: 'Optional caller-specified run identifier.' },
          pipeline_name: { type: 'string', description: 'Optional logical pipeline name for idempotency and routing context.' },
          idempotency_key: { type: 'string', description: 'Optional caller-provided idempotency key.' },
          auto_run: {
            type: 'boolean',
            description: 'When true (default), execute from the first step immediately.',
          },
          input: {
            description: 'Optional pipeline input payload used for request identity hashing.',
          },
          steps: {
            type: 'array',
            description: 'Ordered pipeline steps to execute. Each step must include a tool name.',
            items: {
              type: 'object',
              properties: {
                tool: { type: 'string', description: 'Tool function name to execute for this step.' },
                arguments: { type: 'object', description: 'Arguments object passed to the tool.' },
              },
              required: ['tool'],
              additionalProperties: true,
            },
          },
        },
        required: ['steps'],
        additionalProperties: false,
      },
    },
  },

  'pipeline.status': {
    type: 'function',
    function: {
      name: 'pipeline.status',
      description: 'Get status for an existing pipeline run.',
      parameters: {
        type: 'object',
        properties: {
          run_id: { type: 'string', description: 'Run identifier returned by pipeline.start.' },
        },
        required: ['run_id'],
        additionalProperties: false,
      },
    },
  },

  'pipeline.resume': {
    type: 'function',
    function: {
      name: 'pipeline.resume',
      description: 'Resume a pending or failed pipeline run from its current step.',
      parameters: {
        type: 'object',
        properties: {
          run_id: { type: 'string', description: 'Run identifier returned by pipeline.start.' },
        },
        required: ['run_id'],
        additionalProperties: false,
      },
    },
  },

  'pipeline.cancel': {
    type: 'function',
    function: {
      name: 'pipeline.cancel',
      description: 'Cancel an existing pipeline run.',
      parameters: {
        type: 'object',
        properties: {
          run_id: { type: 'string', description: 'Run identifier returned by pipeline.start.' },
        },
        required: ['run_id'],
        additionalProperties: false,
      },
    },
  },

  'step.run': {
    type: 'function',
    function: {
      name: 'step.run',
      description: 'Execute the current step for an active pipeline run.',
      parameters: {
        type: 'object',
        properties: {
          run_id: { type: 'string', description: 'Run identifier returned by pipeline.start.' },
          expected_current_step: {
            type: 'number',
            description: 'Expected current step index for optimistic concurrency checks.',
          },
        },
        required: ['run_id', 'expected_current_step'],
        additionalProperties: false,
      },
    },
  },

  'step.assert': {
    type: 'function',
    function: {
      name: 'step.assert',
      description: 'Assert that a run is still on the expected active step.',
      parameters: {
        type: 'object',
        properties: {
          run_id: { type: 'string', description: 'Run identifier returned by pipeline.start.' },
          expected_current_step: {
            type: 'number',
            description: 'Expected current step index for optimistic concurrency checks.',
          },
          expected_step_status: {
            type: 'string',
            description: 'Optional expected status for the current step (e.g. "pending", "failed").',
          },
        },
        required: ['run_id', 'expected_current_step'],
        additionalProperties: false,
      },
    },
  },

  'step.retry': {
    type: 'function',
    function: {
      name: 'step.retry',
      description: 'Schedule a deterministic retry for the current failed step.',
      parameters: {
        type: 'object',
        properties: {
          run_id: { type: 'string', description: 'Run identifier returned by pipeline.start.' },
          expected_current_step: {
            type: 'number',
            description: 'Expected current step index for optimistic concurrency checks.',
          },
          max_attempts: {
            type: 'number',
            description: 'Optional step-level max attempts (1-3). Values above 3 are clamped to 3.',
          },
        },
        required: ['run_id', 'expected_current_step'],
        additionalProperties: false,
      },
    },
  },

  'step.wait': {
    type: 'function',
    function: {
      name: 'step.wait',
      description: 'Report whether the current step retry window is ready to run.',
      parameters: {
        type: 'object',
        properties: {
          run_id: { type: 'string', description: 'Run identifier returned by pipeline.start.' },
          expected_current_step: {
            type: 'number',
            description: 'Expected current step index for optimistic concurrency checks.',
          },
        },
        required: ['run_id', 'expected_current_step'],
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
  const expanded = new Set<string>();
  for (const tool of enabledTools) {
    if (tool === 'Pipeline') {
      expanded.add('pipeline.start');
      expanded.add('pipeline.status');
      expanded.add('pipeline.resume');
      expanded.add('pipeline.cancel');
      continue;
    }
    if (tool === 'Step') {
      expanded.add('step.run');
      expanded.add('step.assert');
      expanded.add('step.retry');
      expanded.add('step.wait');
      continue;
    }
    expanded.add(tool);
  }

  const schemas: OpenAIFunctionTool[] = [];
  const seenNames = new Set<string>();
  for (const tool of expanded) {
    const def = TOOL_DEFS[tool];
    if (def && !seenNames.has(def.function.name)) {
      seenNames.add(def.function.name);
      schemas.push(def);
    }
  }
  return schemas;
}
