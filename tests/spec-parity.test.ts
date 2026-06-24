import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fetch from 'node-fetch';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from '../src/tools.js';

// ============== v2 REST spec ↔ tool parity (drift gate) ==============
// Walks every operation in the vendored v2 OpenAPI spec and asserts that a
// registered MCP tool covers it — or that the operation is on an explicit,
// documented allowlist. This is the merge gate that catches drift: when the v2
// API grows an endpoint, this test fails until a tool is added (or the omission
// is justified in ALLOWLIST_UNMAPPED_OPS).
//
// The spec is vendored at tests/fixtures/v2-openapi.yaml (refresh with
// `pnpm tsx scripts/fetch-v2-spec.ts`). The test is hermetic — it parses the
// committed file, with NO network and NO YAML dependency (a small, well-scoped
// regex parse of the `paths:` block; the dev spec is machine-generated and
// uniformly 2-space indented).

interface SpecOp {
  path: string;
  method: string;
  operationId: string;
}

// Parse the operations (path + method + operationId) out of the OpenAPI YAML.
// Scoped strictly to the top-level `paths:` block so component schemas can't
// leak in. Indentation contract: path keys at 2 spaces, methods at 4,
// `operationId:` at 6 — matches the generated spec.
function parseSpecOperations(yaml: string): SpecOp[] {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => /^paths:\s*$/.test(l));
  assert.ok(start >= 0, 'spec has no top-level `paths:` block');
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[A-Za-z]/.test(lines[i])) {
      end = i;
      break;
    }
  }

  const ops: SpecOp[] = [];
  let currentPath: string | null = null;
  for (const line of lines.slice(start + 1, end)) {
    const pathMatch = /^ {2}(\/[^:]+):\s*$/.exec(line);
    const methodMatch = /^ {4}(get|post|put|patch|delete):\s*$/.exec(line);
    const oidMatch = /^ {6}operationId:\s*(\S+)/.exec(line);
    if (pathMatch) {
      currentPath = pathMatch[1];
    } else if (methodMatch && currentPath) {
      ops.push({
        path: currentPath,
        method: methodMatch[1].toUpperCase(),
        operationId: '',
      });
    } else if (oidMatch && ops.length > 0) {
      ops[ops.length - 1].operationId = oidMatch[1];
    }
  }
  return ops;
}

function registeredToolNames(): Set<string> {
  const names = new Set<string>();
  const fakeServer = {
    tool(name: string) {
      names.add(name);
    },
  } as unknown as McpServer;
  registerTools(fakeServer, { apiKey: 'test-key', transport: 'stdio' });
  return names;
}

// Maps each v2 spec operationId to the MCP tool(s) that cover it. A single spec
// op can map to several tools (the unified `podAction` → start/stop/restart),
// and several spec ops can map to one tool (the six billing breakdowns → the
// one scoped `get-billing`). Keep this in sync with the spec: a new operationId
// with no entry here fails the parity test below.
const SPEC_OP_TO_TOOLS: Record<string, string[]> = {
  // pods
  listPods: ['list-pods'],
  createPod: ['create-pod'],
  getPod: ['get-pod'],
  updatePod: ['update-pod'],
  deletePod: ['delete-pod'],
  podAction: ['start-pod', 'stop-pod', 'restart-pod'],
  // serverless endpoints
  listEndpoints: ['list-endpoints'],
  createEndpoint: ['create-endpoint'],
  getEndpoint: ['get-endpoint'],
  updateEndpoint: ['update-endpoint'],
  deleteEndpoint: ['delete-endpoint'],
  listEndpointWorkers: ['list-endpoint-workers'],
  // templates
  listTemplates: ['list-templates'],
  createTemplate: ['create-template'],
  getTemplate: ['get-template'],
  updateTemplate: ['update-template'],
  deleteTemplate: ['delete-template'],
  // tags
  listTags: ['list-tags'],
  createTag: ['create-tag'],
  getTag: ['get-tag'],
  updateTag: ['update-tag'],
  deleteTag: ['delete-tag'],
  attachTagResource: ['attach-tag'],
  detachTagResource: ['detach-tag'],
  // network volumes
  listNetworkVolumes: ['list-network-volumes'],
  createNetworkVolume: ['create-network-volume'],
  getNetworkVolume: ['get-network-volume'],
  updateNetworkVolume: ['update-network-volume'],
  deleteNetworkVolume: ['delete-network-volume'],
  // container registries
  listRegistries: ['list-container-registry-auths'],
  createRegistry: ['create-container-registry-auth'],
  getRegistry: ['get-container-registry-auth'],
  deleteRegistry: ['delete-container-registry-auth'],
  // catalog
  listGpuTypes: ['list-gpu-types'],
  getGpuType: ['get-gpu-type'],
  listCpuTypes: ['list-cpu-types'],
  getCpuType: ['get-cpu-type'],
  listDataCenters: ['list-data-centers'],
  getDataCenter: ['get-data-center'],
  // billing — all six breakdowns are served by the one scoped get-billing tool
  listBilling: ['get-billing'],
  listPodBilling: ['get-billing'],
  listServerlessBilling: ['get-billing'],
  listEndpointBilling: ['get-billing'],
  listNetworkVolumeBilling: ['get-billing'],
  listClusterBilling: ['get-billing'],
};

// Spec operations we deliberately do NOT expose as a tool. Empty today (full
// parity). When the v2 spec adds an endpoint we choose not to wrap, add its
// operationId here with a reason instead of leaving the parity test red.
const ALLOWLIST_UNMAPPED_OPS: Record<string, string> = {};

// Registered tools that intentionally have NO v2 REST spec operation. The
// serverless RUNTIME tools target a different service (api.runpod.ai/v2 — job
// submission/streaming), which is not part of this control-plane REST spec.
const ALLOWLIST_UNMAPPED_TOOLS: Record<string, string> = {
  'run-endpoint': 'serverless runtime API (api.runpod.ai/v2), not v2 REST',
  'runsync-endpoint': 'serverless runtime API, not v2 REST',
  'get-job-status': 'serverless runtime API, not v2 REST',
  'stream-job': 'serverless runtime API, not v2 REST',
  'cancel-job': 'serverless runtime API, not v2 REST',
  'retry-job': 'serverless runtime API, not v2 REST',
  'endpoint-health': 'serverless runtime API, not v2 REST',
  'purge-endpoint-queue': 'serverless runtime API, not v2 REST',
};

const specYaml = readFileSync(
  new URL('./fixtures/v2-openapi.yaml', import.meta.url),
  'utf8'
);
const SPEC_OPS = parseSpecOperations(specYaml);
const TOOLS = registeredToolNames();

describe('v2 spec ↔ tool parity', () => {
  it('parsed a plausible number of operations from the vendored spec', () => {
    // Guard against a broken parse silently passing every other assertion.
    assert.ok(
      SPEC_OPS.length >= 40,
      `expected to parse >=40 operations, got ${SPEC_OPS.length}`
    );
  });

  it('parsed EVERY operationId in the spec file (parse-integrity guard)', () => {
    // The forward gate is only as trustworthy as the parser. The hand parser
    // relies on the spec's indentation contract; if a refreshed spec is
    // reformatted (different indent, paths reordered before components, a stray
    // top-level key), the parser could silently DROP operations — and a
    // drift gate that silently undercounts is worse than none. Cross-check the
    // parsed count against a format-independent count of `operationId:` lines in
    // the whole file: if they diverge, the parser mis-read a reformatted spec.
    const fileOperationIds = (specYaml.match(/^\s+operationId:/gm) ?? [])
      .length;
    assert.equal(
      SPEC_OPS.length,
      fileOperationIds,
      `parser extracted ${SPEC_OPS.length} operations but the spec file contains ${fileOperationIds} operationId entries — the parser likely mis-parsed a reformatted spec (see parseSpecOperations indentation contract)`
    );
  });

  it('every spec operation has an operationId', () => {
    const missing = SPEC_OPS.filter((o) => !o.operationId).map(
      (o) => `${o.method} ${o.path}`
    );
    assert.deepEqual(missing, [], `operations missing operationId: ${missing}`);
  });

  it('every spec operation maps to a registered tool (or is allowlisted)', () => {
    const gaps: string[] = [];
    for (const op of SPEC_OPS) {
      if (op.operationId in ALLOWLIST_UNMAPPED_OPS) continue;
      const tools = SPEC_OP_TO_TOOLS[op.operationId];
      if (!tools) {
        gaps.push(
          `${op.method} ${op.path} (${op.operationId}): no tool mapping — add a tool or allowlist it`
        );
        continue;
      }
      const covered = tools.some((t) => TOOLS.has(t));
      if (!covered) {
        gaps.push(
          `${op.method} ${op.path} (${op.operationId}): mapped to [${tools.join(', ')}] but none are registered`
        );
      }
    }
    assert.deepEqual(
      gaps,
      [],
      `v2 endpoints with no MCP tool:\n${gaps.join('\n')}`
    );
  });

  it('no mapping entry references a tool that is not registered', () => {
    const orphans: string[] = [];
    for (const [op, tools] of Object.entries(SPEC_OP_TO_TOOLS)) {
      for (const t of tools) {
        if (!TOOLS.has(t)) orphans.push(`${op} → ${t}`);
      }
    }
    assert.deepEqual(
      orphans,
      [],
      `mappings point at unregistered tools: ${orphans}`
    );
  });

  it('no mapping entry references an operationId absent from the spec (stale mapping)', () => {
    const specIds = new Set(SPEC_OPS.map((o) => o.operationId));
    const stale = Object.keys(SPEC_OP_TO_TOOLS).filter(
      (id) => !specIds.has(id)
    );
    assert.deepEqual(stale, [], `mappings for non-existent spec ops: ${stale}`);
  });

  it('every registered tool is mapped to a spec op or explicitly allowlisted', () => {
    const mapped = new Set(Object.values(SPEC_OP_TO_TOOLS).flat());
    const unaccounted = [...TOOLS].filter(
      (t) => !mapped.has(t) && !(t in ALLOWLIST_UNMAPPED_TOOLS)
    );
    assert.deepEqual(
      unaccounted,
      [],
      `tools neither mapped to a spec op nor allowlisted (decide which): ${unaccounted}`
    );
  });
});

// ============== Optional live shape check (opt-in, skipped in CI) ==============
// The hermetic gate above proves a tool EXISTS per endpoint. This block proves
// the live endpoint still RETURNS the shape our list tools unwrap. It is
// skipped unless MCP_LIVE_V2_KEY is set (so CI never depends on a secret or the
// network); set MCP_LIVE_V2_KEY (+ optional MCP_LIVE_V2_BASE) to run it.
const LIVE_KEY = process.env.MCP_LIVE_V2_KEY;
const LIVE_BASE =
  process.env.MCP_LIVE_V2_BASE ?? 'https://v2-rest.runpod.dev/v2';
const liveSkip = LIVE_KEY
  ? false
  : 'set MCP_LIVE_V2_KEY to run live shape checks';

describe('live v2 shape (opt-in)', () => {
  // Read-only GETs whose response envelope key our list tools rely on.
  const CHECKS: Array<{ path: string; key: string }> = [
    { path: '/catalog/gpus', key: 'gpus' },
    { path: '/catalog/cpus', key: 'cpus' },
    { path: '/catalog/datacenters', key: 'dataCenters' },
    { path: '/pods', key: 'pods' },
    { path: '/templates', key: 'templates' },
    { path: '/network-volumes', key: 'networkVolumes' },
    { path: '/registries', key: 'registries' },
    { path: '/tags', key: 'tags' },
  ];

  for (const check of CHECKS) {
    it(
      `GET ${check.path} responds 2xx with a "${check.key}" envelope`,
      { skip: liveSkip },
      async () => {
        const res = await fetch(`${LIVE_BASE}${check.path}`, {
          headers: { Authorization: `Bearer ${LIVE_KEY}` },
        });
        assert.ok(
          res.ok,
          `${check.path} returned ${res.status} ${res.statusText}`
        );
        const body = (await res.json()) as Record<string, unknown>;
        assert.ok(
          check.key in body,
          `${check.path} response missing "${check.key}" key (got: ${Object.keys(body).join(', ')})`
        );
      }
    );
  }
});
