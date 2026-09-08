// Compares the vendored spec (specgen/spec/openapi.yaml) against the spec the
// production API is serving right now. Exits non-zero on drift so CI can
// alert BEFORE a stale surface ships; prints the exact operations that
// appeared, disappeared, moved, or changed input contracts so the fix is obvious:
//
//   curl -s https://api.runpod.io/v2/openapi.json  (re-vendor, see specgen/README.md)
//   pnpm generate:tools
//
// Run: pnpm spec:check   (network required; CI runs it on a schedule and on
// PRs that touch specgen/)
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { operations } from './spec-drift.js';

const SPEC_URL =
  process.env.SPEC_URL ?? 'https://api.runpod.io/v2/openapi.json';
const vendored = operations(
  parse(readFileSync('specgen/spec/openapi.yaml', 'utf8'))
);
const response = await fetch(SPEC_URL, { signal: AbortSignal.timeout(30_000) });
if (!response.ok) {
  console.error(
    `spec-drift: fetching ${SPEC_URL} failed (${response.status}) — cannot judge drift.`
  );
  process.exit(2);
}
const live = operations(await response.json());

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
  '\nFix: re-vendor the spec and regenerate (specgen/README.md), then run pnpm test.'
);
process.exit(1);
