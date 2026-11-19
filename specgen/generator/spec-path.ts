// The OpenAPI spec the tools generate from: the copy shipped in the installed
// @runpod/typescript-api-sdk package, so the tools and the SDK the MCP calls
// through describe the same API. SDK releases before 2.0.0 (runpod/js-sdk) do
// not ship the spec, so until the MCP moves to 2.0.0 it falls back to the copy
// in specgen/spec/. Delete that copy after the move. RUNPOD_SPEC_PATH
// overrides both for tests and unreleased specs.
import { createRequire } from 'node:module';

function sdkSpec(): string | undefined {
  try {
    return createRequire(import.meta.url).resolve(
      '@runpod/typescript-api-sdk/spec/openapi.yaml'
    );
  } catch {
    return undefined;
  }
}

export const SPEC_PATH =
  process.env.RUNPOD_SPEC_PATH || sdkSpec() || 'specgen/spec/openapi.yaml';
