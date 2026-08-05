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
  'get-cpu-type',
  'get-data-center',
  'get-capacity',
  // hub
  'list-hub-repos',
  'deploy-hub-repo',
  // public endpoints
  'list-public-endpoints',
  // pods
  'list-pods',
  'get-pod',
  'create-pod',
  'update-pod',
  'start-pod',
  'stop-pod',
  'restart-pod',
  'stream-pod-logs',
  'delete-pod',
  // endpoints
  'list-endpoints',
  'get-endpoint',
  'create-endpoint',
  'update-endpoint',
  'delete-endpoint',
  'list-endpoint-workers',
  'list-endpoint-releases',
  'stream-worker-logs',
  'set-endpoint-gpus',
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
  // ECR delegations (v2-only)
  'list-registry-delegations',
  'create-registry-delegation',
  'delete-registry-delegation',
  // billing (v2-only)
  'get-billing',
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
    const { names, schemas } = captureRegisteredTools();
    // Derived, not hardcoded: LIST_TOOLS is a fixed subset, so a new list-*
    // tool would join the surface ungated by this check.
    const listTools = names.filter((n) => n.startsWith('list-'));
    assert.ok(
      listTools.length >= LIST_TOOLS.length,
      'expected to discover at least the known list tools'
    );
    for (const tool of listTools) {
      const schema = schemas.get(tool);
      assert.ok(schema, `no schema captured for ${tool}`);
      assert.ok('limit' in schema, `${tool} missing 'limit' param`);
      assert.ok('cursor' in schema, `${tool} missing 'cursor' param`);
    }
  });

  // The autoscaling bounds are in the v2 spec, so an out-of-range value can be
  // refused here instead of spending a round trip on a 422. Asserted on the
  // registered zod schema because the handler tests call handlers directly and
  // never run parameter validation.
  describe('autoscaling parameter bounds', () => {
    const parse = (tool: string, param: string, value: unknown) => {
      const { schemas } = captureRegisteredTools();
      const schema = schemas.get(tool);
      assert.ok(schema, `no schema captured for ${tool}`);
      const field = schema[param] as {
        safeParse: (v: unknown) => { success: boolean };
      };
      assert.ok(
        field && typeof field.safeParse === 'function',
        `${tool}.${param} is not a zod schema`
      );
      return field.safeParse(value).success;
    };

    for (const tool of ['create-endpoint', 'update-endpoint']) {
      it(`${tool} bounds idleTimeout to an integer 1-3600`, () => {
        assert.equal(parse(tool, 'idleTimeout', 1), true);
        assert.equal(parse(tool, 'idleTimeout', 3600), true);
        assert.equal(parse(tool, 'idleTimeout', 0), false, 'accepted 0');
        assert.equal(parse(tool, 'idleTimeout', 3601), false, 'accepted 3601');
        assert.equal(
          parse(tool, 'idleTimeout', 12.5),
          false,
          'accepted a float'
        );
      });

      it(`${tool} floors scalerValue at the QUEUE_DELAY minimum (0.5)`, () => {
        // The looser of the two union bounds — REQUEST_COUNT additionally
        // requires an integer, which is enforced per-call once the scaler that
        // will be sent is known (see the handler tests).
        assert.equal(parse(tool, 'scalerValue', 0.5), true);
        assert.equal(parse(tool, 'scalerValue', 4), true);
        assert.equal(parse(tool, 'scalerValue', 0.4), false, 'accepted 0.4');
        assert.equal(parse(tool, 'scalerValue', 0), false, 'accepted 0');
      });
    }
  });

  // The hosted clamp computes min(wait ?? 90000, 45000) and only omits the
  // query when the result is undefined. A `wait: 0` would therefore be sent as
  // `?wait=0`, which upstream rejects — loudly, which is the point. What must
  // never happen is 0 silently becoming "no wait" and handing the request back
  // to the upstream 90s default, past the gateway deadline. This bound is the
  // first line of that defense, and the handler tests bypass it entirely.
  describe('runsync-endpoint wait bounds', () => {
    const parseWait = (value: unknown) => {
      const { schemas } = captureRegisteredTools();
      const schema = schemas.get('runsync-endpoint');
      assert.ok(schema, 'no schema captured for runsync-endpoint');
      const field = schema.wait as {
        safeParse: (v: unknown) => { success: boolean };
      };
      assert.ok(
        field && typeof field.safeParse === 'function',
        'runsync-endpoint.wait is not a zod schema'
      );
      return field.safeParse(value).success;
    };

    it('accepts the documented 1000-300000 range and rejects outside it', () => {
      assert.equal(parseWait(1000), true);
      assert.equal(parseWait(45000), true);
      assert.equal(parseWait(300000), true);
      assert.equal(parseWait(0), false, 'accepted 0');
      assert.equal(parseWait(999), false, 'accepted 999');
      assert.equal(parseWait(300001), false, 'accepted 300001');
    });

    it('stays optional — an omitted wait is what the hosted clamp pins to its budget', () => {
      assert.equal(parseWait(undefined), true);
    });
  });
});
