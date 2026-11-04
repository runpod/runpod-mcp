---
'@runpod/mcp-server': minor
---

Redact email addresses in ALP submissions, non-ASCII ones included, as `[redacted:email]`, counted in `redactions`. Runpod Pod SSH logins (`@ssh.runpod.io`) and the `git@` user of an SSH remote are kept. `SCRUB_VERSION` is now 6 and is exported from `@runpod/mcp-server/alp`. The ingest endpoint keeps `tool` only when it is shaped like a tool name (`^[A-Za-z0-9_-]{1,64}$`) and drops anything else, as it does an off-enum `severity`, and answers a write the sink refused at its cap (`capped: true`) with `recorded: false` and the do-not-retry note.
