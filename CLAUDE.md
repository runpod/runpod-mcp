# Runpod MCP server

This is the official Runpod MCP (Model Context Protocol) server, published to npm as `@runpod/mcp-server`. It allows LLMs to manage Runpod infrastructure through the MCP standard, including Pods, Serverless endpoints, templates, network volumes, and container registry authentications.

## Documentation style

Always use sentence case for headings and titles.

Always use proper nouns when discussing specific Runpod products and features:
- Runpod (never RunPod).
- Pod/Pods (never lowercase "pod/pods").
- Serverless (never lowercase "serverless").
- Hub, Instant Clusters, Secure Cloud, Community Cloud, Tetra, Flash.
- Apply proper noun styling only to text that the user will see, not things like image/documentation links.

These are generic terms (use lowercase):
- endpoint, worker, cluster, template, handler, fine-tune, network volume.

Prefer using paragraphs to bullet points unless directly asked. When using bullet points, end each line with a period.

## Architecture

The server communicates with two separate Runpod API backends. The REST API at `https://rest.runpod.io/v1` handles all authenticated CRUD operations for Pods, endpoints, templates, network volumes, and container registry auths. It requires a `RUNPOD_API_KEY` environment variable. The GraphQL API at `https://api.runpod.io/graphql` is public and requires no authentication. It serves read-only discovery queries like GPU types and data centers.

All tools and helpers live in `src/index.ts`. The build produces both an ESM output (`dist/index.mjs`) used by the `bin` field and for local development, and a CJS output (`dist/index.js`) for `require()` consumers. Because `package.json` has `"type": "module"`, always use `dist/index.mjs` when running locally with `node`.

## Local development

```bash
pnpm install
pnpm build
```

To point Claude Code to your local build:

```bash
claude mcp add runpod -s user \
  -e RUNPOD_API_KEY=YOUR_API_KEY \
  -- node /absolute/path/to/runpod-mcp/dist/index.mjs
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

Tools are grouped by section comments in `src/index.ts` (infrastructure, Pod management, endpoint management, template management, network volume management, container registry auth). Add new tools in the appropriate section. If adding a new resource category, follow the same comment style.

## Known issues

DELETE endpoints in the Runpod REST API return 204 No Content with no body. The `runpodRequest()` helper handles this by checking `content-type` before parsing JSON, but MCP clients may still surface an "Unexpected end of JSON input" message. The operation succeeds regardless.

Pod `publicIp` and `portMappings` fields are empty while the container is initializing. This is Runpod API behavior, not an MCP server bug. Pods need to be polled until they are fully running.

## Changesets and versioning

This project uses [changesets](https://github.com/changesets/changesets) for version management and npm publishing. Every PR that changes user-facing behavior needs a changeset, including new tools, modified tool params or descriptions, bug fixes in tool handlers, and changes to API request logic. Documentation-only changes, dev tooling changes, and test files do not need changesets.

The interactive `npx changeset` command does not work in non-TTY environments like Claude Code. Create the changeset file manually instead:

`.changeset/DESCRIPTIVE_NAME.md`
```markdown
---
"@runpod/mcp-server": minor
---

Description of what changed and why.
```

Use `patch` for bug fixes, `minor` for new tools, params, or features, and `major` for breaking changes to existing tool interfaces.

The `.changeset/` directory is in `.gitignore`, so you must use `git add -f` to stage changeset files.

After merging to `main`, the changesets bot opens a "Version Packages" PR that bumps `package.json` and updates `CHANGELOG.md`. Merging that PR triggers `changeset publish` which pushes to npm as `@runpod/mcp-server`.

## PR conventions

Use branch names like `feat/description` or `fix/description`. Include one changeset per PR. Follow conventional commit messages: `feat: ...`, `fix: ...`, `chore: ...`. Include a test plan in the PR description listing what was manually verified.
