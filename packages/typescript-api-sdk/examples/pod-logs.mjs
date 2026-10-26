// Read-only. Run after pnpm build: RUNPOD_API_KEY=... node examples/pod-logs.mjs POD_ID
import { createRunpodClient, iterateLogEvents } from "../dist/index.js";

const id = process.argv[2];
if (!id) throw new Error("Usage: node examples/pod-logs.mjs POD_ID");
const client = createRunpodClient();
const { data, error, response } = await client.GET("/v2/pods/{id}/logs", {
  params: { path: { id }, query: { tail: 100 } },
  parseAs: "stream",
});
if (!response.ok) throw new Error(`Logs failed (${response.status}): ${JSON.stringify(error)}`);
if (!data) throw new Error("Log response had no body");

try {
  for await (const event of iterateLogEvents(data)) {
    console.log(event.data.line ?? event.data.raw ?? JSON.stringify(event.data));
  }
} catch (error) {
  // The SDK's default deadline includes time spent consuming the stream.
  if (error?.name !== "TimeoutError") throw error;
  console.error("Stopped reading logs after the 30-second request deadline.");
}
