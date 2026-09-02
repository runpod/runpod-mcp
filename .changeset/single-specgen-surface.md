---
'@runpod/mcp-server': major
---

One tool surface everywhere: stdio now serves the same spec-generated surface the hosted server serves (66 tools + the skills as MCP resources), and the legacy hand-written surface is removed. Breaking for hardcoded tool names: 8 tools follow their spec operationIds (e.g. `create-container-registry-auth` → `create-registry`, `get-billing` → `list-billing`) and `start-pod`/`stop-pod`/`restart-pod` fold into `pod-action` with an `action` argument — `specgen/old-mcp-tools.yaml` maps every old name to its replacement. The server is v2-only: `RUNPOD_REST_VERSION` and the v1 fallback are retired. 429 responses now carry a parsed wait instruction and outbound API calls carry caller-tracking headers on both transports.
