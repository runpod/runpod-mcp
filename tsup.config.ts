import { createRequire } from 'node:module';
import { defineConfig } from 'tsup';

const { version } = createRequire(import.meta.url)('./package.json') as {
  version: string;
};

export default defineConfig([
  // stdio entrypoint — CLI binary, needs shebang
  {
    entry: ['src/stdio.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    sourcemap: true,
    noExternal: ['@runpod/typescript-api-sdk'],
    banner: {
      js: '#!/usr/bin/env node',
    },
    define: {
      __PACKAGE_VERSION__: JSON.stringify(version),
    },
    outExtension({ format }) {
      return {
        js: format === 'cjs' ? '.cjs' : '.mjs',
      };
    },
  },
  // http entrypoint + shared tools — library modules, no shebang
  {
    entry: ['src/http.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    sourcemap: true,
    // Bundle the workspace SDK in both entrypoints; it is a build dependency.
    noExternal: ['@runpod/typescript-api-sdk'],
    define: {
      __PACKAGE_VERSION__: JSON.stringify(version),
    },
    outExtension({ format }) {
      return {
        js: format === 'cjs' ? '.cjs' : '.mjs',
      };
    },
  },
]);
