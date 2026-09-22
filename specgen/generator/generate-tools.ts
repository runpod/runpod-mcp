// Generate MCP tool metadata from the vendored OpenAPI spec and overrides.
import { readFileSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'yaml';
import { generateTools, type GeneratorConfig } from './tools.js';

const spec = parse(readFileSync('specgen/spec/openapi.yaml', 'utf8'));
const config: GeneratorConfig =
  parse(readFileSync('specgen/generator-config.yaml', 'utf8')) ?? {};
const tools = generateTools(spec, config);

if (process.argv.includes('--check')) {
  const { generatedTools } = await import(
    '../../src/specgen/generated/tools.gen.js'
  );
  if (!isDeepStrictEqual(tools, generatedTools)) {
    console.error(
      'Generated tools are stale. Run pnpm generate:tools and commit the result.'
    );
    process.exit(1);
  }
  console.log('Generated tools match the vendored spec and generator config.');
  process.exit(0);
}

const header = `// Code generated from specgen/spec/openapi.yaml by specgen/generator/generate-tools.ts; DO NOT EDIT.

export interface GeneratedToolParam {
  name: string;
  location: "path" | "query";
  /** Spec-declared \`explode: false\`: serialize an array as one comma-joined value. */
  explode?: false;
}

/** MCP tool annotations (tools/list \`annotations\`): behavioral hints hosts use
 *  to decide what needs human approval. */
export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface GeneratedTool {
  name: string;
  operationId: string;
  description: string;
  method: string;
  path: string;
  params: GeneratedToolParam[];
  hasBody: boolean;
  annotations: ToolAnnotations;
  inputSchema: Record<string, unknown>;
}

export const generatedTools: GeneratedTool[] = `;

writeFileSync(
  'src/specgen/generated/tools.gen.ts',
  header + JSON.stringify(tools, null, 2) + ';\n'
);
console.log(
  `generated ${tools.length} tools (${Object.keys(config.exclude ?? {}).length} excluded by config)`
);
