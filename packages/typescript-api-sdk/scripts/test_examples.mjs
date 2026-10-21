import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
test("documented read-only examples execute against mocked responses", () => {
  const temporary = mkdtempSync(join(tmpdir(), "runpod-sdk-examples-"));
  try {
    const mock = join(temporary, "mock.mjs");
    writeFileSync(mock, `globalThis.fetch = async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/v2/catalog/gpus") return Response.json({ gpus: [] });
      if (path === "/v2/pods/example-pod/logs") return new Response("data: example log\\n\\n", { headers: { "content-type": "text/event-stream" } });
      throw new Error("Unexpected request: " + path);
    };`);
    const run = (file, args = []) => execFileSync(process.execPath, ["--import", mock, file, ...args], {
      cwd: root, env: { ...process.env, RUNPOD_API_KEY: "mock", RUNPOD_API_BASE_URL: "https://example.test" }, encoding: "utf8",
    });
    assert.match(run("examples/catalog.mjs"), /0 GPU types/);
    assert.match(run("examples/pod-logs.mjs", ["example-pod"]), /^example log\n$/);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
