---
'@runpod/mcp-server': minor
---

The journey playbooks now come only from `@runpod/plugin-knowledge`, bumped to
1.7.1. The server no longer keeps its own copy under `runpod://skills/`: an
agent loads the plugin's `runpod-mcp` skill, or `read-guide runpod-mcp` without
the plugin, and that routes it to the journey guides (`discovery`,
`lifecycle-crud`, `serverless-deploy`, `pod-deploy`, `pod-doctor`,
`endpoint-ops`, `cost-audit`). `resources/list` serves the plugin guides as
`runpod://guides/<id>`. The instructions and the `ask_question` text point at
`read-guide` instead of `runpod://skills/`.

The instructions also tell an agent whose instructions look out of date to
reconnect the server (or ask the user to), since reconnecting re-runs
initialize and delivers the current instructions and tool list.
