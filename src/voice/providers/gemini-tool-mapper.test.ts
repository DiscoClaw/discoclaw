import { describe, expect, it } from 'vitest';
import { toGeminiTools, convertSchema } from './gemini-tool-mapper.js';
import { buildToolSchemas } from '../../runtime/openai-tool-schemas.js';

// ---------------------------------------------------------------------------
// convertSchema
// ---------------------------------------------------------------------------

describe('convertSchema', () => {
  it('converts lowercase types to uppercase', () => {
    const result = convertSchema({ type: 'string', description: 'A name' });
    expect(result).toEqual({ type: 'STRING', description: 'A name' });
  });

  it('converts object with properties recursively', () => {
    const result = convertSchema({
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path' },
        count: { type: 'number', description: 'How many' },
      },
      required: ['file_path'],
    });

    expect(result).toEqual({
      type: 'OBJECT',
      properties: {
        file_path: { type: 'STRING', description: 'Path' },
        count: { type: 'NUMBER', description: 'How many' },
      },
      required: ['file_path'],
    });
  });

  it('strips additionalProperties', () => {
    const result = convertSchema({
      type: 'object',
      properties: { x: { type: 'string' } },
      additionalProperties: false,
    });
    expect(result).not.toHaveProperty('additionalProperties');
  });

  it('converts array types with items', () => {
    const result = convertSchema({
      type: 'array',
      items: {
        type: 'object',
        properties: {
          tool: { type: 'string', description: 'Tool name' },
        },
        required: ['tool'],
        additionalProperties: true,
      },
    });

    expect(result).toEqual({
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          tool: { type: 'STRING', description: 'Tool name' },
        },
        required: ['tool'],
      },
    });
  });

  it('handles boolean type', () => {
    const result = convertSchema({ type: 'boolean', description: 'Flag' });
    expect(result).toEqual({ type: 'BOOLEAN', description: 'Flag' });
  });

  it('handles integer type', () => {
    const result = convertSchema({ type: 'integer' });
    expect(result).toEqual({ type: 'INTEGER' });
  });

  it('preserves enum values', () => {
    const result = convertSchema({ type: 'string', enum: ['a', 'b', 'c'] });
    expect(result).toEqual({ type: 'STRING', enum: ['a', 'b', 'c'] });
  });

  it('defaults to OBJECT when type is missing', () => {
    const result = convertSchema({ properties: { x: { type: 'string' } } });
    expect(result.type).toBe('OBJECT');
  });

  it('omits description when not present', () => {
    const result = convertSchema({ type: 'string' });
    expect(result).toEqual({ type: 'STRING' });
    expect(Object.keys(result)).toEqual(['type']);
  });

  it('omits required when empty', () => {
    const result = convertSchema({ type: 'object', required: [] });
    expect(result).not.toHaveProperty('required');
  });
});

// ---------------------------------------------------------------------------
// toGeminiTools
// ---------------------------------------------------------------------------

describe('toGeminiTools', () => {
  it('returns undefined for empty input', () => {
    expect(toGeminiTools([])).toBeUndefined();
  });

  it('converts a single OpenAI tool to Gemini function declaration', () => {
    const openai = [{
      type: 'function' as const,
      function: {
        name: 'web_search',
        description: 'Search the web.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query.' },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
    }];

    const result = toGeminiTools(openai);
    expect(result).toEqual({
      functionDeclarations: [{
        name: 'web_search',
        description: 'Search the web.',
        parameters: {
          type: 'OBJECT',
          properties: {
            query: { type: 'STRING', description: 'Search query.' },
          },
          required: ['query'],
        },
      }],
    });
  });

  it('converts multiple tools', () => {
    const openai = [
      {
        type: 'function' as const,
        function: {
          name: 'read_file',
          description: 'Read a file.',
          parameters: {
            type: 'object',
            properties: {
              file_path: { type: 'string', description: 'Path.' },
            },
            required: ['file_path'],
            additionalProperties: false,
          },
        },
      },
      {
        type: 'function' as const,
        function: {
          name: 'bash',
          description: 'Run a command.',
          parameters: {
            type: 'object',
            properties: {
              command: { type: 'string', description: 'Command.' },
            },
            required: ['command'],
            additionalProperties: false,
          },
        },
      },
    ];

    const result = toGeminiTools(openai);
    expect(result?.functionDeclarations).toHaveLength(2);
    expect(result?.functionDeclarations[0].name).toBe('read_file');
    expect(result?.functionDeclarations[1].name).toBe('bash');
  });

  it('none of the declarations have additionalProperties', () => {
    const openai = buildToolSchemas(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash']);
    const result = toGeminiTools(openai);

    function checkNoAdditionalProperties(obj: Record<string, unknown>, path: string): void {
      expect(obj).not.toHaveProperty('additionalProperties');
      if (obj.properties && typeof obj.properties === 'object') {
        for (const [key, val] of Object.entries(obj.properties as Record<string, Record<string, unknown>>)) {
          checkNoAdditionalProperties(val, `${path}.${key}`);
        }
      }
      if (obj.items && typeof obj.items === 'object') {
        checkNoAdditionalProperties(obj.items as Record<string, unknown>, `${path}.items`);
      }
    }

    for (const decl of result!.functionDeclarations) {
      if (decl.parameters) {
        checkNoAdditionalProperties(decl.parameters as Record<string, unknown>, decl.name);
      }
    }
  });

  it('all type names are uppercase in converted schemas', () => {
    const openai = buildToolSchemas(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch']);
    const result = toGeminiTools(openai);

    function checkUppercaseTypes(obj: Record<string, unknown>, path: string): void {
      if (typeof obj.type === 'string') {
        expect(obj.type, `type at ${path}`).toMatch(/^[A-Z]+$/);
      }
      if (obj.properties && typeof obj.properties === 'object') {
        for (const [key, val] of Object.entries(obj.properties as Record<string, Record<string, unknown>>)) {
          checkUppercaseTypes(val, `${path}.${key}`);
        }
      }
      if (obj.items && typeof obj.items === 'object') {
        checkUppercaseTypes(obj.items as Record<string, unknown>, `${path}.items`);
      }
    }

    for (const decl of result!.functionDeclarations) {
      if (decl.parameters) {
        checkUppercaseTypes(decl.parameters as Record<string, unknown>, decl.name);
      }
    }
  });

  it('integrates with buildToolSchemas for full tool set', () => {
    const openai = buildToolSchemas(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch']);
    const result = toGeminiTools(openai);

    expect(result).toBeDefined();
    expect(result!.functionDeclarations).toHaveLength(8);

    const names = result!.functionDeclarations.map((d) => d.name);
    expect(names).toEqual([
      'read_file', 'write_file', 'edit_file', 'list_files',
      'search_content', 'bash', 'web_search', 'web_fetch',
    ]);

    // Each declaration has name, description, and parameters
    for (const decl of result!.functionDeclarations) {
      expect(typeof decl.name).toBe('string');
      expect(typeof decl.description).toBe('string');
      expect(decl.parameters).toBeDefined();
      expect(decl.parameters!.type).toBe('OBJECT');
    }
  });

  it('handles Pipeline expansion through buildToolSchemas', () => {
    const openai = buildToolSchemas(['Pipeline']);
    const result = toGeminiTools(openai);

    expect(result).toBeDefined();
    const names = result!.functionDeclarations.map((d) => d.name);
    expect(names).toEqual([
      'pipeline.start', 'pipeline.status', 'pipeline.resume', 'pipeline.cancel',
    ]);
  });
});
