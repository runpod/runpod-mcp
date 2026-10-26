import { validateQueryEncoding } from "./query_contract.mjs";
// Validate the exact generator-facing contract without writing generated files.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import openapiTS from "openapi-typescript";
const script = fileURLToPath(new URL("./spec_for_types.py", import.meta.url));
const spec = JSON.parse(execFileSync(process.env.PYTHON ?? "python3", [script, process.argv[2]], {
  encoding: "utf8", maxBuffer: 20 * 1024 * 1024,
}));
validateQueryEncoding(spec);
await openapiTS(spec, { defaultNonNullable: false });
