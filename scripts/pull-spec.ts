// Re-vendors specgen/spec/openapi.yaml from the spec the API serves.
//
//   pnpm spec:pull                          ← production (the default)
//   SPEC_URL=https://v2-rest.runpod.dev/v2/openapi.yaml pnpm spec:pull
//                                           ← dev generation, or any host
//
// The written file records its source and pull date in a header, so a
// checkout always says which generation it was vendored from. Note the two
// generations serve DIFFERENT paths (/v2/catalog/gpus vs /v2/gpu-types): a
// dev-vendored spec makes the drift check (which defaults to production)
// go red — that red is correct, not a bug. After pulling:
//   pnpm generate:tools && pnpm test
import { writeFileSync } from 'node:fs';
import { parse, stringify } from 'yaml';

const DEFAULT_SPEC_URL = 'https://api.runpod.io/v2/openapi.json';
const url = process.env.SPEC_URL ?? DEFAULT_SPEC_URL;

const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
if (!response.ok) {
  console.error(`spec:pull: fetching ${url} failed (${response.status})`);
  process.exit(1);
}
// Served as JSON or YAML depending on the host; parse() reads both.
const spec = parse(await response.text());
const operationCount = Object.values(
  spec.paths as Record<string, Record<string, unknown>>
).reduce(
  (n, item) =>
    n +
    ['get', 'put', 'post', 'delete', 'patch'].filter((m) => m in item).length,
  0
);

const header = [
  `# Vendored from ${url}`,
  `# on ${new Date().toISOString().slice(0, 10)} by scripts/pull-spec.ts (pnpm spec:pull).`,
  '#',
  '# PRODUCTION is the default source. The dev host (v2-rest.runpod.dev)',
  '# serves a different generation with different paths — vendor it only',
  '# deliberately (SPEC_URL=... pnpm spec:pull), and expect the drift check',
  '# against production to go red while you do.',
  '#',
  '# After pulling: pnpm generate:tools && pnpm test',
  '',
].join('\n');

writeFileSync('specgen/spec/openapi.yaml', header + stringify(spec));
console.log(
  `spec:pull: wrote specgen/spec/openapi.yaml from ${url} (${operationCount} operations).`
);
