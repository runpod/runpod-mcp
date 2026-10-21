import { validateQueryEncoding } from "./query_contract.mjs";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import openapiTS, { astToString, COMMENT_HEADER } from "openapi-typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const { values } = parseArgs({ options: {
  check: { type: "boolean", default: false },
  spec: { type: "string", default: `${root}spec/openapi.yaml` },
} });
const check = values.check;
const specPath = values.spec;
// execFileSync propagates Python failures. A shell pipeline could hide them.
const spec = JSON.parse(execFileSync(process.env.PYTHON ?? "python3", [
  `${root}scripts/spec_for_types.py`, specPath,
], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }));
validateQueryEncoding(spec);
const output = COMMENT_HEADER + astToString(await openapiTS(spec, { defaultNonNullable: false }));
const destination = `${root}src/generated/schema.ts`;
if (check) {
  if (readFileSync(destination, "utf8") !== output) {
    throw new Error("Generated schema is stale; run pnpm generate and commit the result.");
  }
  console.log("Generated schema is current.");
} else {
  writeFileSync(destination, output);
  console.log("Generated src/generated/schema.ts");
}
