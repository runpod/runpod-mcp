# Runpod MCP server development context

The engineering reference for contributors moved with the architecture:

- **[specgen/DESIGN.md](../specgen/DESIGN.md)** — progressive walkthrough: the three boxes, the flow of one request, where tools come from, the update/drift loop, skills, hosting constraints.
- **[specgen/README.md](../specgen/README.md)** — regeneration workflow (`spec:pull`, `generate:tools`, `spec:check`) and the gates.
- **[CLAUDE.md](../CLAUDE.md)** — style, changesets, PR conventions, adding tools.

Quick orientation: there is one tool surface, generated from the vendored v2 OpenAPI spec plus a curated overlay (`src/specgen/`). `src/http.ts` (hosted, per-request bearer auth) and `src/stdio.ts` (local, env key) both mount it. The OAuth authorization-server routes live in `api/index.ts`. Shared plumbing that predates specgen and still serves it: `_shared/credential-check.ts` (hosted pre-flight), `_shared/http.ts` (the OAuth flow's HTTP client), `_shared/rate-limit.ts` (429 → wait instruction), `_shared/tracking.ts` (outbound caller identification), `_shared/hosts.ts` (env host resolvers for the wrong-environment guard).

Tests are `node --test` via tsx (`pnpm test`), offline by default. The specgen gates (`tests/specgen-*.test.ts`) are the drift/parity/security invariants; `tests/http.test.ts`, `credential-check.test.ts`, `oauth.test.ts`, `cors.test.ts`, `pkce.test.ts`, and `install-clients.test.ts` cover the shell.
