// Test the artifact users install, with no workspace dependency resolution.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "runpod-sdk-consumer-"));
const run = (command, args, cwd = temporary) => execFileSync(command, args, {
  cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
});
try {
  // npm pack runs prepack; this must succeed even without an existing dist.
  rmSync(join(root, "dist"), { recursive: true, force: true });
  run("npm", ["pack", "--pack-destination", temporary], root);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const tarball = join(temporary, `${pkg.name.replace(/^@/, "").replaceAll("/", "-")}-${pkg.version}.tgz`);
  const typescript = JSON.parse(readFileSync(join(root, "node_modules/typescript/package.json"), "utf8")).version;
  writeFileSync(join(temporary, "package.json"), JSON.stringify({ private: true, type: "module" }));
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball, `typescript@${typescript}`]);
  const runtime = `
const assert = require("node:assert/strict");
async function verify(createRunpodClient) {
  const { iterateLogEvents, getRateLimitInfo, createDeadlineFetch } = require(${JSON.stringify(pkg.name)});
  assert.equal(typeof createDeadlineFetch, "function");
  assert.equal(getRateLimitInfo(new Headers({ RateLimit: 'hour;r=0;t=3600' })).retryDelayMs, 3600000);
  const events = [];
  for await (const event of iterateLogEvents(new Response('data: {"line":"hello"}\\n\\n').body)) events.push(event);
  assert.equal(events[0].data.line, "hello");
  let calls = 0;
  const client = createRunpodClient({ apiKey: "test-key", fetch: async (input) => {
    const request = new Request(input);
    assert.equal(request.headers.get("authorization"), "Bearer test-key");
    const url = new URL(request.url);
    assert.equal(url.pathname, "/v2/catalog/datacenters");
    assert.deepEqual(url.searchParams.getAll("regions"), ["EUROPE,ASIA"]);
    calls++;
    return Response.json({ dataCenters: [] });
  } });
  const result = await client.GET("/v2/catalog/datacenters", { params: { query: { regions: ["EUROPE", "ASIA"] } } });
  assert.equal(result.response.ok, true);
  assert.equal(calls, 1);
}
`;
  writeFileSync(join(temporary, "consumer.cjs"), runtime + `verify(require(${JSON.stringify(pkg.name)}).createRunpodClient).catch(error => { console.error(error); process.exitCode = 1; });\n`);
  writeFileSync(join(temporary, "consumer.mjs"), `import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\nimport { createRunpodClient } from ${JSON.stringify(pkg.name)};\n` + runtime + "await verify(createRunpodClient);\n");
  run(process.execPath, ["consumer.cjs"]);
  run(process.execPath, ["consumer.mjs"]);
  for (const extension of ["mts", "cts"]) {
    writeFileSync(join(temporary, `consumer.${extension}`), `
import { createRunpodClient, type components } from ${JSON.stringify(pkg.name)};
const client = createRunpodClient({ apiKey: "example" });
const pod: components["schemas"]["CreatePodRequest"] = { name: "example", image: "example/image", gpu: { id: "example" } };
client.GET("/v2/catalog/gpus");
// @ts-expect-error unknown routes must remain rejected in the installed types
client.GET("/not-an-api-route");
// @ts-expect-error a pod name is required
const invalidPod: components["schemas"]["CreatePodRequest"] = {};
// @ts-expect-error image is required through nested container inheritance
const invalidTemplate: components["schemas"]["CreateTemplateRequest"] = { name: "example" };
const partialTemplate: components["schemas"]["UpdateTemplateRequest"] = {};
declare const returnedPod: components["schemas"]["Pod"];
const image: string = returnedPod.image;
void [pod, invalidPod, invalidTemplate, partialTemplate, image];
`);
  }
  run(process.execPath, ["node_modules/typescript/bin/tsc", "--noEmit", "--strict", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", "consumer.mts", "consumer.cts"]);
  const files = run("tar", ["-tzf", tarball]).trim().split("\n");
  assert(files.some(file => file === "package/dist/index.cjs"));
  assert(files.some(file => file === "package/dist/index.d.cts"));
  assert(files.every(file => /^package\/(dist\/|package\.json$|README\.md$|LICENSE$|THIRD_PARTY_NOTICES\.txt$)/.test(file)), files.join("\n"));
  console.log("Packed ESM/CJS runtime calls, NodeNext declarations, and package contents passed.");
} catch (error) {
  if (error.stdout) console.error(String(error.stdout));
  if (error.stderr) console.error(String(error.stderr));
  throw error;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
