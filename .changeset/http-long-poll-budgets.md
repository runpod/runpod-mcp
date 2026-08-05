---
'@runpod/mcp-server': minor
---

Clamp long-poll tool budgets on the hosted HTTP server, which runs behind a 60-second Vercel function limit. `runsync-endpoint` waited 90 seconds by default (300 via `wait`) and `stream-job` polled for up to 5 minutes, so for a slow job the function was reaped mid-flight: the caller got a bare 504 and every chunk collected so far was discarded.

Over HTTP, `runsync-endpoint` now sends a `wait` capped at 45000 ms — a job that outlives it comes back as a job ID plus a non-terminal status to poll with `get-job-status`. `stream-job` stops after 45 seconds over HTTP and returns what it has with `pollingTimedOut: true`; `/stream` drains what it hands out, so calling again resumes rather than replaying. Its HTTP polls also send `wait=1000`, since the server otherwise holds an empty response for 10 seconds and the budget is only checked between polls. Both tool descriptions are now written per transport, so a caller is told the one budget that applies to them and where to go for more — `run-endpoint` + `get-job-status`, or the runtime API directly. The stdio server has no deadline and is unchanged.
