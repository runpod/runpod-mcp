import { describe, expect, it } from "vitest";
import { DEFAULT_BASE_URL, createRunpodClient } from "../src/index.js";

const gpuTypesJson = {
  gpus: [
    {
      id: "NVIDIA GeForce RTX 4090",
      name: "RTX 4090",
      pool: "ADA_24",
      manufacturer: "NVIDIA",
      memory: 24,
      secure: true,
      community: true,
      price: { secure: 0.44, community: 0.31 },
      maxCount: { secure: 8, community: 4 },
    },
  ],
};

describe("createRunpodClient", () => {
  it("requires an API key", () => {
    const saved = process.env.RUNPOD_API_KEY;
    delete process.env.RUNPOD_API_KEY;
    try {
      expect(() => createRunpodClient()).toThrow(/API key required/);
    } finally {
      if (saved !== undefined) process.env.RUNPOD_API_KEY = saved;
    }
  });

  it("sends the bearer token and decodes a typed catalog response", async () => {
    let seenAuth = "";
    let seenPath = "";
    const mockFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      seenAuth = request.headers.get("Authorization") ?? "";
      seenPath = new URL(request.url).pathname;
      return new Response(JSON.stringify(gpuTypesJson), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const client = createRunpodClient({
      apiKey: "test-key",
      baseUrl: "https://example.test",
      fetch: mockFetch,
    });
    const { data, error } = await client.GET("/v2/catalog/gpus");

    expect(error).toBeUndefined();
    expect(seenAuth).toBe("Bearer test-key");
    expect(seenPath).toBe("/v2/catalog/gpus");
    expect(data?.gpus[0]?.id).toBe("NVIDIA GeForce RTX 4090");
    expect(data?.gpus[0]?.memory).toBe(24);
  });

  it("treats a blank base URL as unset", async () => {
    const saved = process.env.RUNPOD_API_BASE_URL;
    process.env.RUNPOD_API_BASE_URL = "";
    try {
      let seenOrigin = "";
      const mockFetch: typeof fetch = async (input, init) => {
        seenOrigin = new URL(new Request(input, init).url).origin;
        return new Response(JSON.stringify(gpuTypesJson), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      const client = createRunpodClient({ apiKey: "test-key", baseUrl: "  ", fetch: mockFetch });
      await client.GET("/v2/catalog/gpus");

      expect(seenOrigin).toBe(DEFAULT_BASE_URL);
    } finally {
      if (saved === undefined) delete process.env.RUNPOD_API_BASE_URL;
      else process.env.RUNPOD_API_BASE_URL = saved;
    }
  });
});

it("serializes catalog arrays as comma-separated values and preserves scalars", async () => {
  let url: URL | undefined;
  const client = createRunpodClient({ apiKey: "test", retry: false, fetch: async (input) => {
    url = new URL(new Request(input).url);
    return Response.json({ dataCenters: [] });
  } });
  await client.GET("/v2/catalog/datacenters", { params: { query: {
    regions: ["EUROPE", "ASIA"], include: ["GPU_AVAILABILITY", "CPU_AVAILABILITY"], globalNetwork: false,
  } } });
  expect(url?.searchParams.getAll("regions")).toEqual(["EUROPE,ASIA"]);
  expect(url?.searchParams.getAll("include")).toEqual(["GPU_AVAILABILITY,CPU_AVAILABILITY"]);
  expect(url?.searchParams.get("globalNetwork")).toBe("false");
});

it("exposes a bodyless HTTP error through response.ok even when error is undefined", async () => {
  const client = createRunpodClient({ apiKey: "test", retry: false, fetch: async () =>
    new Response(null, { status: 503, headers: { "content-length": "0" } }) });
  const result = await client.GET("/v2/catalog/gpus");
  expect(result.response.ok).toBe(false);
  expect(result.response.status).toBe(503);
  expect(result.error).toBeUndefined();
  expect(result.data).toBeUndefined();
});

it("rejects malformed JSON rather than returning a typed error", async () => {
  const client = createRunpodClient({ apiKey: "test", retry: false, fetch: async () =>
    new Response("not json", { status: 200, headers: { "content-type": "application/json" } }) });
  await expect(client.GET("/v2/catalog/gpus")).rejects.toThrow();
});
