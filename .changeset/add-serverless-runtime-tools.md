---
"@runpod/mcp-server": minor
---

Add Serverless endpoint runtime tools for invoking deployed workers. New tools: run-endpoint (async), runsync-endpoint (sync), get-job-status, stream-job, cancel-job, retry-job, endpoint-health, and purge-endpoint-queue. These use the Serverless API at api.runpod.ai/v2 with a new serverlessRequest helper.
