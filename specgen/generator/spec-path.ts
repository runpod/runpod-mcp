// The OpenAPI spec the tools generate from: the copy shipped in the installed
// @runpod/typescript-api-sdk package (0.10.0 and later, released from
// runpod/js-sdk), so the tools and the SDK the MCP calls through describe the
// same API. RUNPOD_SPEC_PATH overrides it for tests and unreleased specs.
import { createRequire } from 'node:module';

function sdkSpec(): string {
  try {
    return createRequire(import.meta.url).resolve(
      '@runpod/typescript-api-sdk/spec/openapi.yaml'
    );
  } catch (error) {
    throw new Error(
      '@runpod/typescript-api-sdk does not ship spec/openapi.yaml. Install 0.10.0 or later, or set RUNPOD_SPEC_PATH.',
      { cause: error }
    );
  }
}

export const SPEC_PATH = process.env.RUNPOD_SPEC_PATH || sdkSpec();
