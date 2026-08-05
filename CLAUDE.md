# Runpod MCP server

This is the official Runpod MCP (Model Context Protocol) server, published to npm as `@runpod/mcp-server`. It allows LLMs to manage Runpod infrastructure through the MCP standard, including Pods, Serverless endpoints, templates, network volumes, and container registry authentications.

## Documentation style

Always use sentence case for headings and titles.

Always use proper nouns when discussing specific Runpod products and features:

- Runpod (never Runpod).
- Pod/Pods (never lowercase "pod/pods").
- Serverless (never lowercase "serverless").
- Hub, Instant Clusters, Secure Cloud, Community Cloud, Tetra, Flash.
- Apply proper noun styling only to text that the user will see, not things like image/documentation links.

These are generic terms (use lowercase):

- endpoint, worker, cluster, template, handler, fine-tune, network volume.

Prefer using paragraphs to bullet points unless directly asked. When using bullet points, end each line with a period.

## Architecture

The server communicates with two separate Runpod API backends. The REST API at `https://rest.runpod.io/v1` handles all authenticated CRUD operations for Pods, endpoints, templates, network volumes, and container registry auths. It requires a `RUNPOD_API_KEY` environment variable. The GraphQL API at `https://api.runpod.io/graphql` is reached two ways. The public, unauthenticated path serves read-only discovery queries — GPU types, GPU capacity by CUDA version, data centers, the Hub catalog, Public Endpoints. The authenticated path (`graphqlAuthed`, API key as a Bearer token) serves the handful of write operations that have no REST equivalent: `deploy-hub-repo` and `set-endpoint-gpus`, both of which call the `saveEndpoint` mutation. The two resolve their host from separate env vars on purpose — see `RUNPOD_PUBLIC_GRAPHQL_URL` and `RUNPOD_AUTHED_GRAPHQL_URL` below.

The source is split by responsibility:

- `src/stdio.ts` is the local `stdio` entrypoint.
- `src/http.ts` does bearer-token extraction and the per-request MCP session for the Streamable HTTP transport.
- `src/tools.ts` contains all Runpod tools and API helpers.
- `src/server.ts` owns shared server metadata and construction.
- `api/index.ts` is the Vercel adapter and hosts the OAuth authorization-server routes (`/.well-known/*`, `/register`, `/authorize`, `/token`).

### Hosted/OAuth environment variables

The hosted HTTP path (`api/index.ts` + `src/http.ts`) reads these, all optional with production-safe defaults:

- `RUNPOD_GRAPHQL_URL`: flash auth backend for the OAuth flow (default `https://api.runpod.io/graphql`). Also the host the hosted credential pre-flight verifies against, so unlike the guest flash-auth mutations it now receives the caller's bearer token — point it only at a host you trust with that.
- `CONSOLE_BASE_URL`: console that hosts the sign-in handoff page (default `https://console.runpod.io`).
- `RUNPOD_REST_API_URL` / `RUNPOD_SERVERLESS_API_URL`: override the REST and Serverless API hosts (e.g. for a dev API key).
- `RUNPOD_PUBLIC_GRAPHQL_URL`: override the public discovery GraphQL host used by `list-gpu-types`, `list-data-centers`, `get-capacity`, `list-hub-repos`, and `list-public-endpoints` (default `https://api.runpod.io/graphql`). Never carries a credential — safe to point at a stub, though note `get-capacity` has no REST fallback on either API version.
- `RUNPOD_AUTHED_GRAPHQL_URL`: override the GraphQL host for **authenticated** operations with no REST equivalent — `deploy-hub-repo` and `set-endpoint-gpus` (default `https://api.runpod.io/graphql`). These send the caller's API key as a Bearer token, so only point this at a host you trust with it; on the hosted server that key is a per-user OAuth-minted one.
- `RUNPOD_API_KEY_NAME`: name for the minted key (default `runpod-mcp`; set to `""` to omit for a backend without the `apiKeyName` argument).
- `MCP_VERBOSE_LOGS`: set to `true` to log OAuth request ids (live auth codes) for debugging.
- `MCP_SKIP_CREDENTIAL_CHECK`: set to the exact string `true` to disable the hosted pre-flight credential verification (dead bearers then surface as tool-level 401 errors instead of an HTTP 401 re-auth signal). Use this if the pre-flight itself is ever causing outages. Note the pre-flight ALSO self-disables when a REST/Serverless host is overridden without a matching `RUNPOD_GRAPHQL_URL`, since it would otherwise validate the key against the wrong environment and reject every request.

The build produces `dist/stdio.*`, `dist/http.*`, and `dist/tools.*`. Because `package.json` has `"type": "module"`, always use `dist/stdio.mjs` when running the built local server with `node`.

## Local development

```bash
pnpm install
pnpm build
```

To point Claude Code to your local build:

```bash
claude mcp add runpod -s user \
  -e RUNPOD_API_KEY=YOUR_API_KEY \
  -- node /absolute/path/to/runpod-mcp/dist/stdio.mjs
```

After making changes, rebuild with `pnpm build`. If you are in an active Claude Code session, type `/mcp` to reconnect without restarting. You can also use `pnpm build:watch` for auto-rebuilding during development.

## Adding tools

Tools are registered with `server.tool()`. There are two signatures:

```typescript
// Without a description
server.tool('tool-name', { ...zodParams }, async (params) => { ... });

// With a description (recommended when LLM guidance helps)
server.tool('tool-name', 'Description visible to the LLM', { ...zodParams }, async (params) => { ... });
```

Use kebab-case names matching the resource pattern: `list-pods`, `get-pod`, `create-pod`, `update-pod`, `delete-pod`. For REST-backed tools, use the `runpodRequest()` helper which handles auth headers, JSON parsing, and error responses. For GraphQL-backed tools, use the `graphqlRequest<T>()` helper which hits the public endpoint without authentication.

Define parameters with Zod schemas, calling `.describe()` on each field and `.optional()` on non-required ones. Add a tool description string when the LLM benefits from guidance, such as recommending a default template. Keep descriptions concise and actionable.

All tool handlers should return the same shape: `{ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }`.

Tools are grouped by section comments in `src/tools.ts` (infrastructure, Pod management, endpoint management, template management, network volume management, container registry auth). Add new tools in the appropriate section. If adding a new resource category, follow the same comment style.

For transport regressions, use:

```bash
pnpm smoke:stdio
pnpm smoke:http
```

## Known issues

DELETE endpoints in the Runpod REST API return 204 No Content with no body. The `runpodRequest()` helper handles this by checking `content-type` before parsing JSON, but MCP clients may still surface an "Unexpected end of JSON input" message. The operation succeeds regardless.

Pod `publicIp` and `portMappings` fields are empty while the container is initializing. This is Runpod API behavior, not an MCP server bug. Pods need to be polled until they are fully running.

## Changesets and versioning

This project uses [changesets](https://github.com/changesets/changesets) for version management and npm publishing. Every PR that changes user-facing behavior needs a changeset, including new tools, modified tool params or descriptions, bug fixes in tool handlers, and changes to API request logic. Documentation-only changes, dev tooling changes, and test files do not need changesets.

The interactive `npx changeset` command does not work in non-TTY environments like Claude Code. Create the changeset file manually instead:

`.changeset/DESCRIPTIVE_NAME.md`

```markdown
---
'@runpod/mcp-server': minor
---

Description of what changed and why.
```

Use `patch` for bug fixes, `minor` for new tools, params, or features, and `major` for breaking changes to existing tool interfaces.

The `.changeset/` directory is tracked in git — it is the source the release workflow consumes — so stage changeset files normally with `git add`.

After merging to `main`, the changesets bot opens a "Version Packages" PR that bumps `package.json` and updates `CHANGELOG.md`. Merging that PR triggers `changeset publish` which pushes to npm as `@runpod/mcp-server`.

## PR conventions

Use branch names like `feat/description` or `fix/description`. Include one changeset per PR. Follow conventional commit messages: `feat: ...`, `fix: ...`, `chore: ...`. Include a test plan in the PR description listing what was manually verified.
