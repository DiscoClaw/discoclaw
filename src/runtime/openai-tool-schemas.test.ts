import { describe, expect, it } from 'vitest';
import { buildToolSchemas, OPENAI_TO_DISCO_NAME } from './openai-tool-schemas.js';

const ALL_DISCO_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'];

describe('buildToolSchemas', () => {
  it('returns schemas for all 8 tools when all are enabled', () => {
    const schemas = buildToolSchemas(ALL_DISCO_TOOLS);
    expect(schemas).toHaveLength(8);
  });

  it('each schema has correct shape', () => {
    const schemas = buildToolSchemas(ALL_DISCO_TOOLS);
    for (const schema of schemas) {
      expect(schema.type).toBe('function');
      expect(schema.function).toBeDefined();
      expect(typeof schema.function.name).toBe('string');
      expect(typeof schema.function.description).toBe('string');
      expect(schema.function.parameters).toBeDefined();
      expect(schema.function.parameters).toHaveProperty('type', 'object');
      expect(schema.function.parameters).toHaveProperty('properties');
      expect(schema.function.parameters).toHaveProperty('required');
    }
  });

  it('returns correct OpenAI function names', () => {
    const schemas = buildToolSchemas(ALL_DISCO_TOOLS);
    const names = schemas.map((s) => s.function.name);
    expect(names).toEqual([
      'read_file',
      'write_file',
      'edit_file',
      'list_files',
      'search_content',
      'bash',
      'web_search',
      'web_fetch',
    ]);
  });

  it('returns subset when only some tools are enabled', () => {
    const schemas = buildToolSchemas(['Read', 'Bash']);
    expect(schemas).toHaveLength(2);
    expect(schemas[0].function.name).toBe('read_file');
    expect(schemas[1].function.name).toBe('bash');
  });

  it('returns empty array for empty input', () => {
    expect(buildToolSchemas([])).toEqual([]);
  });

  it('silently skips unknown tool names', () => {
    const schemas = buildToolSchemas(['Read', 'UnknownTool', 'Bash']);
    expect(schemas).toHaveLength(2);
    expect(schemas.map((s) => s.function.name)).toEqual(['read_file', 'bash']);
  });

  it('expands Pipeline into lifecycle function tools', () => {
    const schemas = buildToolSchemas(['Read', 'Pipeline']);
    expect(schemas.map((s) => s.function.name)).toEqual([
      'read_file',
      'pipeline.start',
      'pipeline.status',
      'pipeline.resume',
      'pipeline.cancel',
    ]);
  });

  it('deduplicates lifecycle functions when Pipeline and explicit names overlap', () => {
    const schemas = buildToolSchemas(['Pipeline', 'pipeline.status']);
    expect(schemas.map((s) => s.function.name)).toEqual([
      'pipeline.start',
      'pipeline.status',
      'pipeline.resume',
      'pipeline.cancel',
    ]);
  });
});

describe('OPENAI_TO_DISCO_NAME', () => {
  it('maps every OpenAI function name back to the disco tool name', () => {
    expect(OPENAI_TO_DISCO_NAME['read_file']).toBe('Read');
    expect(OPENAI_TO_DISCO_NAME['write_file']).toBe('Write');
    expect(OPENAI_TO_DISCO_NAME['edit_file']).toBe('Edit');
    expect(OPENAI_TO_DISCO_NAME['list_files']).toBe('Glob');
    expect(OPENAI_TO_DISCO_NAME['search_content']).toBe('Grep');
    expect(OPENAI_TO_DISCO_NAME['bash']).toBe('Bash');
    expect(OPENAI_TO_DISCO_NAME['web_search']).toBe('WebSearch');
    expect(OPENAI_TO_DISCO_NAME['web_fetch']).toBe('WebFetch');
    expect(OPENAI_TO_DISCO_NAME['pipeline.start']).toBe('Pipeline');
    expect(OPENAI_TO_DISCO_NAME['pipeline.status']).toBe('Pipeline');
    expect(OPENAI_TO_DISCO_NAME['pipeline.resume']).toBe('Pipeline');
    expect(OPENAI_TO_DISCO_NAME['pipeline.cancel']).toBe('Pipeline');
  });

  it('is consistent with schemas — every schema name has a reverse mapping', () => {
    const schemas = buildToolSchemas(ALL_DISCO_TOOLS);
    for (const schema of schemas) {
      const openaiName = schema.function.name;
      expect(OPENAI_TO_DISCO_NAME[openaiName]).toBeDefined();
      // And the reverse mapping should be one of our disco tool names
      expect(ALL_DISCO_TOOLS).toContain(OPENAI_TO_DISCO_NAME[openaiName]);
    }
  });

  it('has exactly 12 entries', () => {
    expect(Object.keys(OPENAI_TO_DISCO_NAME)).toHaveLength(12);
  });
});
