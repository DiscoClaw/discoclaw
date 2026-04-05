/**
 * Gemini tool mapper — converts OpenAI function-calling tool schemas into
 * Gemini-compatible function declarations for the Multimodal Live API.
 *
 * Gemini expects:
 * - Uppercase type names (STRING, NUMBER, OBJECT, BOOLEAN, ARRAY, INTEGER)
 * - No `additionalProperties` field
 * - Function declarations as `{ name, description, parameters }` (no `type: 'function'` wrapper)
 *
 * The mapper is intentionally stateless and pure — it transforms schemas at
 * session setup time and has no runtime side effects.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Gemini function declaration parameter schema (recursive). */
export type GeminiSchema = {
  type: string;
  description?: string;
  properties?: Record<string, GeminiSchema>;
  items?: GeminiSchema;
  required?: string[];
  enum?: string[];
};

/** A single Gemini function declaration. */
export type GeminiFunctionDeclaration = {
  name: string;
  description: string;
  behavior?: 'NON_BLOCKING';
  parameters?: GeminiSchema;
};

/** The tools block sent in the Gemini Live setup message. */
export type GeminiToolsConfig = {
  functionDeclarations: GeminiFunctionDeclaration[];
};

export type ToGeminiToolsOpts = {
  nonBlockingFunctionNames?: Iterable<string>;
};

/** OpenAI function tool shape (matches openai-tool-schemas.ts). */
type OpenAIFunctionTool = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

// ---------------------------------------------------------------------------
// Type mapping
// ---------------------------------------------------------------------------

const TYPE_MAP: Record<string, string> = {
  string: 'STRING',
  number: 'NUMBER',
  integer: 'INTEGER',
  boolean: 'BOOLEAN',
  object: 'OBJECT',
  array: 'ARRAY',
};

/**
 * Convert a JSON Schema type string to Gemini's uppercase equivalent.
 * Returns the input uppercased if not in the known map (defensive).
 */
function mapType(jsonSchemaType: string): string {
  return TYPE_MAP[jsonSchemaType] ?? jsonSchemaType.toUpperCase();
}

// ---------------------------------------------------------------------------
// Schema conversion
// ---------------------------------------------------------------------------

/**
 * Recursively convert a JSON Schema object to a GeminiSchema.
 * Strips `additionalProperties` and converts type names.
 */
export function convertSchema(schema: Record<string, unknown>): GeminiSchema {
  const result: GeminiSchema = {
    type: mapType(String(schema.type ?? 'object')),
  };

  if (typeof schema.description === 'string') {
    result.description = schema.description;
  }

  if (schema.properties != null && typeof schema.properties === 'object') {
    const props = schema.properties as Record<string, Record<string, unknown>>;
    result.properties = {};
    for (const [key, value] of Object.entries(props)) {
      result.properties[key] = convertSchema(value);
    }
  }

  if (schema.items != null && typeof schema.items === 'object') {
    result.items = convertSchema(schema.items as Record<string, unknown>);
  }

  if (Array.isArray(schema.required) && schema.required.length > 0) {
    result.required = schema.required as string[];
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    result.enum = schema.enum as string[];
  }

  // additionalProperties is intentionally omitted — Gemini doesn't support it.

  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert an array of OpenAI function tool schemas to a Gemini tools config.
 * Returns `undefined` when the input array is empty (no tools block needed).
 */
export function toGeminiTools(
  openaiTools: OpenAIFunctionTool[],
  opts: ToGeminiToolsOpts = {},
): GeminiToolsConfig | undefined {
  if (openaiTools.length === 0) return undefined;
  const nonBlockingFunctionNames = new Set(opts.nonBlockingFunctionNames ?? []);

  const declarations: GeminiFunctionDeclaration[] = openaiTools.map((tool) => {
    const decl: GeminiFunctionDeclaration = {
      name: tool.function.name,
      description: tool.function.description,
    };

    // Only include parameters if the schema has properties
    const params = tool.function.parameters;
    if (params && typeof params === 'object' && Object.keys(params).length > 0) {
      decl.parameters = convertSchema(params);
    }

    if (nonBlockingFunctionNames.has(tool.function.name)) {
      decl.behavior = 'NON_BLOCKING';
    }

    return decl;
  });

  return { functionDeclarations: declarations };
}
