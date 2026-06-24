import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from '../src/tools.js';

// A minimal stand-in for McpServer that records every server.tool(...) call.
// registerTools only calls `.tool()` at registration time (the tracking
// helpers that touch `server.server` run per-request, not here), so this is
// enough to introspect the registered surface without any network or SDK.
function captureRegisteredTools(): {
  names: string[];
  schemas: Map<string, Record<string, unknown>>;
} {
  const names: string[] = [];
  const schemas = new Map<string, Record<string, unknown>>();

  const fakeServer = {
    tool(name: string, ...args: unknown[]) {
      names.push(name);
      // The schema is the first plain-object argument after the name
      // (a tool may pass a description string before it).
      const schema = args.find(
        (a) => a !== null && typeof a === 'object' && !Array.isArray(a)
      );
      if (schema) schemas.set(name, schema as Record<string, unknown>);
    },
  } as unknown as McpServer;

  registerTools(fakeServer, { apiKey: 'test-key', transport: 'stdio' });
  return { names, schemas };
}

const LIST_TOOLS = [
  'list-pods',
  'list-endpoints',
  'list-templates',
  'list-network-volumes',
  'list-container-registry-auths',
];

// A high-frequency core that must always be present. Intentionally a subset,
// not the full surface, so the test is not brittle to additive changes.
const CORE_TOOLS = [
  'create-pod',
  'get-pod',
  'start-pod',
  'stop-pod',
  'restart-pod',
  'list-pods',
  'create-endpoint',
  'run-endpoint',
  'list-endpoints',
  'create-template',
  'list-templates',
  'list-gpu-types',
  ...LIST_TOOLS,
];

// The full registered surface, frozen. The source is split across
// src/tools/<resource>.ts and assembled by registerTools; this snapshot is the
// guard that a per-resource refactor (or a dropped registrar import) can't
// silently remove a tool. Update deliberately when adding/removing a tool.
const EXPECTED_TOOLS = [
  // catalog
  'list-gpu-types',
  'list-data-centers',
  'list-cpu-types',
  'get-gpu-type',
  // pods
  'list-pods',
  'get-pod',
  'create-pod',
  'update-pod',
  'start-pod',
  'stop-pod',
  'restart-pod',
  'delete-pod',
  // endpoints
  'list-endpoints',
  'get-endpoint',
  'create-endpoint',
  'update-endpoint',
  'delete-endpoint',
  // serverless runtime (jobs)
  'run-endpoint',
  'runsync-endpoint',
  'get-job-status',
  'stream-job',
  'cancel-job',
  'retry-job',
  'endpoint-health',
  'purge-endpoint-queue',
  // templates
  'list-templates',
  'get-template',
  'create-template',
  'update-template',
  'delete-template',
  // network volumes
  'list-network-volumes',
  'get-network-volume',
  'create-network-volume',
  'update-network-volume',
  'delete-network-volume',
  // container registry auth
  'list-container-registry-auths',
  'get-container-registry-auth',
  'create-container-registry-auth',
  'delete-container-registry-auth',
];

describe('tool registration', () => {
  it('registers a non-trivial number of tools', () => {
    const { names } = captureRegisteredTools();
    assert.ok(
      names.length >= 30,
      `expected at least 30 tools, got ${names.length}`
    );
  });

  it('registers exactly the expected tool surface (no silent add/drop)', () => {
    const { names } = captureRegisteredTools();
    assert.deepEqual(
      [...names].sort(),
      [...EXPECTED_TOOLS].sort(),
      'registered tool surface drifted from the frozen snapshot'
    );
  });

  it('registers every expected core tool', () => {
    const { names } = captureRegisteredTools();
    for (const tool of CORE_TOOLS) {
      assert.ok(names.includes(tool), `missing tool: ${tool}`);
    }
  });

  it('registers no duplicate tool names', () => {
    const { names } = captureRegisteredTools();
    const seen = new Set<string>();
    const dupes = names.filter((n) =>
      seen.has(n) ? true : (seen.add(n), false)
    );
    assert.deepEqual(dupes, [], `duplicate tool names: ${dupes.join(', ')}`);
  });

  it('exposes limit + cursor pagination params on every list-* tool', () => {
    const { schemas } = captureRegisteredTools();
    for (const tool of LIST_TOOLS) {
      const schema = schemas.get(tool);
      assert.ok(schema, `no schema captured for ${tool}`);
      assert.ok('limit' in schema, `${tool} missing 'limit' param`);
      assert.ok('cursor' in schema, `${tool} missing 'cursor' param`);
    }
  });
});
