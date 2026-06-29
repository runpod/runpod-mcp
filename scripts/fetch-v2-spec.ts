// Refresh the vendored v2 OpenAPI spec used by the spec-parity drift gate.
//
//   pnpm tsx scripts/fetch-v2-spec.ts
//
// Fetches the live v2 spec and overwrites tests/fixtures/v2-openapi.yaml. The
// spec is served unauthenticated as YAML (the .json variant 401s). After
// refreshing, run `pnpm test` — tests/spec-parity.test.ts will fail loudly if
// the spec grew an endpoint that no MCP tool covers (and isn't allowlisted),
// which is exactly the signal to add a tool (or document the omission).
//
// Defaults to the DEV spec: prod v2 is allowlist-gated and its served spec is a
// subset of dev's, so vendoring dev is the more conservative choice for a parity
// gate (it covers strictly more endpoints). Override with RUNPOD_V2_SPEC_URL to
// vendor the prod spec once prod v2 is general — e.g.
//   RUNPOD_V2_SPEC_URL=https://v2-rest.runpod.io/v2/openapi.yaml pnpm tsx scripts/fetch-v2-spec.ts

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fetch from 'node-fetch';

const SPEC_URL =
  process.env.RUNPOD_V2_SPEC_URL ??
  'https://v2-rest.runpod.dev/v2/openapi.yaml';

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const dest = join(here, '..', 'tests', 'fixtures', 'v2-openapi.yaml');

  console.error(`Fetching ${SPEC_URL} ...`);
  const res = await fetch(SPEC_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch spec: ${res.status} ${res.statusText}`);
  }
  const yaml = await res.text();
  if (!yaml.includes('openapi:') || !yaml.includes('paths:')) {
    throw new Error('Fetched document does not look like an OpenAPI spec');
  }
  writeFileSync(dest, yaml, 'utf8');
  console.error(`Wrote ${yaml.length} bytes to ${dest}`);
  console.error(
    'Now run `pnpm test` to check tool parity against the new spec.'
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
