import { describe, expect, it } from "vitest";
import { createRunpodClient } from "../src/index.js";

// Read-only and explicitly opt-in, even when a developer has an API key set.
describe.skipIf(process.env.RUNPOD_LIVE_TESTS !== "1" || !process.env.RUNPOD_API_KEY)("live catalog", () => {
  it("lists GPU types", async () => {
    const client = createRunpodClient();
    const { data, error, response } = await client.GET("/v2/catalog/gpus", { signal: AbortSignal.timeout(15_000) });
    expect(response.ok).toBe(true);
    expect(error, `status ${response.status}`).toBeUndefined();
    expect(data?.gpus.length).toBeGreaterThan(0);
  }, 20_000);
});
