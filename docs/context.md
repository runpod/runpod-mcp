# Runpod MCP server development context

This document is the short engineering reference for contributors working on `@runpod/mcp-server`.

## What this project does

The server exposes Runpod operations as MCP tools so LLM clients can manage:

- Pods.
- Serverless endpoints.
- Templates.
- Network volumes.
- Container registry authentications.

It talks to two Runpod backends:

- REST API: `https://rest.runpod.io/v1` for authenticated CRUD operations.
- GraphQL API: `https://api.runpod.io/graphql` for public discovery queries such as GPU types and data centers.

## Runtime architecture

The codebase now has two transport entrypoints and one shared tool registry:

- `src/stdio.ts`: local MCP server over `stdio`.
- `src/http.ts`: shared Streamable HTTP handler for hosted deployments.
- `src/tools.ts`: all tool definitions plus REST and GraphQL helpers.
- `src/server.ts`: shared server metadata and construction.
- `api/index.ts`: Vercel adapter with CORS handling.

The npm package exports:

- `@runpod/mcp-server`: default `stdio` entrypoint.
- `@runpod/mcp-server/http`: hosted Streamable HTTP entrypoint.
- `@runpod/mcp-server/tools`: shared tool registration for custom wrappers.

## Current transport model

### Local `stdio`

Use local `stdio` when the MCP client launches a process on the user's machine. This is the path for:

- Claude Desktop local servers.
- Claude Code.
- Cursor.
- Local VS Code MCP configs.

Authentication comes from the local process environment through `RUNPOD_API_KEY`.

### Hosted Streamable HTTP

Use hosted HTTP when the MCP client can send authenticated HTTP requests to a public endpoint.

Current behavior:

- Stateless per request.
- Caller supplies `Authorization: Bearer <RUNPOD_API_KEY>`.
- No server-side API-key storage or session affinity.

This design is good for generic HTTP MCP clients and custom integrations. It is not a drop-in fit for Claude's current remote connector flow because that flow is designed around authless or OAuth-based remote servers.

## Tool authoring conventions

Keep tool names in kebab case and aligned to the existing resource patterns:

- `list-pods`, `get-pod`, `create-pod`, `update-pod`, `delete-pod`.
- `list-endpoints`, `get-endpoint`, `create-endpoint`, `update-endpoint`, `delete-endpoint`.

Tool parameters should use Zod and every field should have a useful `.describe()` string. Keep descriptions short and operational.

Handlers should return MCP text content in the existing JSON-stringified shape:

```typescript
return {
  content: [
    {
      type: 'text',
      text: JSON.stringify(result, null, 2),
    },
  ],
};
```

## Request helper conventions

`src/tools.ts` owns both request helpers:

- `graphqlRequest<T>()` for public GraphQL reads.
- `createRunpodRequest(apiKey)` for authenticated REST calls.

When adding a new REST-backed tool:

- Reuse the shared request helper.
- Preserve non-JSON response handling.
- Keep query-param building explicit.
- Surface HTTP status and response text in errors.

## Versioning and metadata

Server metadata is centralized in `src/server.ts`. Do not hardcode server name or version in transport entrypoints.

User-facing text should always use `Runpod`, not `RunPod`.

## Development workflow

Install and build:

```bash
pnpm install
pnpm build
```

Check the repo:

```bash
pnpm type-check
pnpm lint
pnpm build
```

Smoke-test both transports:

```bash
RUNPOD_API_KEY=YOUR_API_KEY pnpm smoke:stdio
MCP_SERVER_URL=https://YOUR-DEPLOYMENT.vercel.app RUNPOD_API_KEY=YOUR_API_KEY pnpm smoke:http
```

## Release workflow

This repo uses Changesets.

- Add a changeset for user-facing changes.
- Do not manually edit `CHANGELOG.md` or published version numbers.
- Release automation publishes the npm package from `main`.

Changeset template:

```markdown
---
"@runpod/mcp-server": minor
---

Describe the user-facing change.
```

## Known edges

- `DELETE` endpoints may return `204 No Content`; the helpers must not assume JSON.
- Pod networking fields can be empty while a Pod is still initializing.
- Hosted HTTP smoke tests need a real `RUNPOD_API_KEY` because they validate both GraphQL and REST-backed tools.
