/**
 * Stat schemas — field definitions for structured data collection.
 *
 * Each schema is a list of fields with descriptions. The MCP tool prompt
 * includes the full field list so Claude knows what to record.
 * No runtime validation — append-only JSONL, bad entries are cheap.
 *
 * Data is written to ~/.claudebox/stats/<schema>.jsonl
 *
 * Schemas are registered by plugins in their setup() method.
 */

export interface StatField {
  name: string;
  type: string;       // "number", "string", "boolean", "string[]", "string?" etc.
  description: string;
}

export interface StatSchema {
  name: string;
  description: string;
  fields: StatField[];
}

const schemas = new Map<string, StatSchema>();

export function register(s: StatSchema): void { schemas.set(s.name, s); }
export function getSchema(name: string): StatSchema | undefined { return schemas.get(name); }
export function allSchemas(): StatSchema[] { return [...schemas.values()]; }

/** Format all schemas as a prompt string for the MCP tool description. */
export function schemasPrompt(): string {
  return allSchemas().map(s => {
    const fields = s.fields.map(f => `  - ${f.name} (${f.type}): ${f.description}`).join("\n");
    return `### ${s.name}\n${s.description}\n\n${fields}`;
  }).join("\n\n");
}
