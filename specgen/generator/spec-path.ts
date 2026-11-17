// The OpenAPI spec the tools generate from: the copy shipped in the
// installed @runpod/typescript-api-sdk package, so the tools and the SDK the
// MCP calls through always describe the same API. RUNPOD_SPEC_PATH overrides
// it for tests.
import { createRequire } from 'node:module';

export const SPEC_PATH =
  process.env.RUNPOD_SPEC_PATH ||
  createRequire(import.meta.url).resolve(
    '@runpod/typescript-api-sdk/spec/openapi.yaml'
  );
