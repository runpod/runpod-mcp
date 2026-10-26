// Compares the vendored spec (packages/typescript-api-sdk/spec/openapi.yaml)
// against the spec the production API is serving right now. Exits non-zero on
// drift so CI can alert BEFORE a stale surface ships; prints the exact
// operations that appeared, disappeared, moved, or changed input contracts so
// the fix is obvious:
//
//   pnpm spec:pull && pnpm generate   (see specgen/README.md)
//
// The vendored file is the output of the SDK's patch layer
// (packages/typescript-api-sdk/scripts/fix_spec.py), so the live spec goes
// through the same layer before the comparison. Needs Python 3 with PyYAML
// (packages/typescript-api-sdk/scripts/requirements.txt); set PYTHON to pick
// the interpreter.
//
// Run: pnpm spec:check   (network required; CI runs it on a schedule and on
// every PR)
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { operations, type OpenApiSpec } from './spec-drift.js';

const VENDORED_SPEC = 'packages/typescript-api-sdk/spec/openapi.yaml';
const FIX_SPEC = 'packages/typescript-api-sdk/scripts/fix_spec.py';

const SPEC_URL =
  process.env.SPEC_URL ?? 'https://api.runpod.io/v2/openapi.json';
const vendored = operations(parse(readFileSync(VENDORED_SPEC, 'utf8')));
let body: string;
try {
  const response = await fetch(SPEC_URL, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  // Reading the body can also fail if the connection drops or times out.
  body = await response.text();
} catch (error) {
  console.error(
    `spec-drift: fetching ${SPEC_URL} failed (${error instanceof Error ? error.message : String(error)}) — cannot judge drift.`
  );
  process.exit(2);
}
// Invalid JSON/schema and comparison failures must still fail CI.
const live = operations(applyPatchLayer(JSON.parse(body)));

const added = [...live.keys()].filter((id) => !vendored.has(id));
const removed = [...vendored.keys()].filter((id) => !live.has(id));
const moved = [...live.keys()].filter(
  (id) => vendored.has(id) && vendored.get(id)!.route !== live.get(id)!.route
);

const changed = [...live.keys()].filter(
  (id) => vendored.has(id) && vendored.get(id)!.input !== live.get(id)!.input
);

if (!added.length && !removed.length && !moved.length && !changed.length) {
  console.log(
    `spec-drift: vendored spec matches ${SPEC_URL} (${live.size} operations).`
  );
  process.exit(0);
}
console.error(`spec-drift: the vendored spec is out of date with ${SPEC_URL}:`);
for (const id of added)
  console.error(
    `  + ${id}  (${live.get(id)!.route}) — new upstream operation, no tool serves it`
  );
for (const id of removed)
  console.error(
    `  - ${id}  (${vendored.get(id)!.route}) — gone upstream, its tool now dead-ends`
  );
for (const id of moved)
  console.error(
    `  ~ ${id}  ${vendored.get(id)!.route} -> ${live.get(id)!.route} — its tool calls the OLD path`
  );
for (const id of changed)
  console.error(
    `  ~ ${id} — request body, parameters, or referenced schemas changed`
  );
console.error(
  '\nFix: run pnpm spec:pull, pnpm generate, and pnpm test; review and commit the resulting changes.'
);
process.exit(1);

// Run the served spec through the SDK's patch layer, the same step that wrote
// the vendored file. A patch whose anchor is gone upstream fails the layer;
// that is drift too, because the next pull would fail the same way.
function applyPatchLayer(spec: unknown): OpenApiSpec {
  const dir = mkdtempSync(join(tmpdir(), 'spec-drift-'));
  try {
    const file = join(dir, 'openapi.yaml');
    // The patch layer reads YAML. Escape only the characters PyYAML treats as
    // extra line breaks; escaping every non-ASCII code unit corrupts emoji.
    writeFileSync(
      file,
      JSON.stringify(spec).replace(
        /[\u0085\u2028\u2029]/g,
        (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
      )
    );
    const python =
      process.env.PYTHON ??
      (process.platform === 'win32' ? 'python' : 'python3');
    const result = spawnSync(python, [FIX_SPEC, file], { encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      console.error(
        `spec-drift: the vendored spec is out of date with ${SPEC_URL}: the patch layer no longer applies.\n${result.stderr.trim()}`
      );
      console.error(
        '\nFix: run pnpm spec:pull; if a patch fails, update it in packages/typescript-api-sdk/scripts/fix_spec.py.'
      );
      process.exit(1);
    }
    return parse(readFileSync(file, 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
