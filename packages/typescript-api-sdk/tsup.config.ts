import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  target: "node20",
  // openapi-fetch's CJS default export cannot be called through tsup's
  // external default-import shim. Bundle its implementation for both formats.
  noExternal: ["openapi-fetch", "structured-headers"],
});
