// Run after pnpm build: RUNPOD_API_KEY=... node examples/catalog.mjs
import { createRunpodClient } from "../dist/index.js";
const client = createRunpodClient();
const { data, error, response } = await client.GET("/v2/catalog/gpus", {
  signal: AbortSignal.timeout(15_000),
});
if (!response.ok) throw new Error(`Catalog failed (${response.status}): ${JSON.stringify(error)}`);
if (!data) throw new Error("Catalog response had no data");
console.log(`${data.gpus.length} GPU types`);
