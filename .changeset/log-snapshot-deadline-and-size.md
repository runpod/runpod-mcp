---
'@runpod/mcp-server': patch
---

`stream-pod-logs` and `stream-worker-logs` no longer fail with "did not respond before the request deadline" when the log stream's headers take longer than `maxWaitMs`. Headers now get their own 10-second budget, and `maxWaitMs` measures how long the open stream is read. Snapshots are also capped at 32,000 serialized characters so they fit within MCP clients' tool-output limits: a capped snapshot keeps its leading lines, cuts only between timestamps where it can so `since` resumes without skipping lines, clips any single line over 16,000 characters, and sets `truncated: true`.
