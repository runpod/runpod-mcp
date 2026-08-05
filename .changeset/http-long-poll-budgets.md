---
'@runpod/mcp-server': patch
---

Clamp long-poll tool budgets to 45 seconds on the hosted HTTP server, which runs inside a serverless function the platform kills at 60. `runsync-endpoint` waited 90 seconds by default (300 via `wait`) and `stream-job` polled for up to 5 minutes, so for a slow job the platform reaped the function before either tool's own timeout path could run: the caller got a bare 504 with everything collected so far discarded, and the function stayed billed for the full 60 seconds.

`runsync-endpoint` now always sends a `wait` capped at 45000 ms on HTTP, so a job that outlives it returns the job ID to poll with `get-job-status`. `stream-job` stops after 45 seconds and returns the chunks it has with `pollingTimedOut: true`; `/stream` drains what it hands out, so calling again resumes rather than replaying. Its HTTP polls also send `wait=1000` — the server otherwise holds an empty response for 10 seconds, and the budget is only checked between polls. Both descriptions now point callers who need the full budgets at `run-endpoint` + `get-job-status` or at the runtime API. The stdio server has no deadline and is unchanged.
