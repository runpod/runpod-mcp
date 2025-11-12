# Runpod MCP Server - Development Conventions

This document outlines the core conventions, rules, and best practices for developing and maintaining the Runpod MCP Server.

## What is this Project?

### The Model Context Protocol

The [Model Context Protocol (MCP)](https://modelcontextprotocol.io) is an open protocol that enables AI assistants to securely access external data sources and tools. MCP servers expose capabilities through standardized interfaces that MCP clients (like Claude Desktop) can consume.

### Our Server

The **Runpod MCP Server** (`@runpod/mcp-server`) is an MCP server implementation that exposes Runpod's REST API as MCP tools. It enables AI assistants to manage Runpod infrastructure (pods, endpoints, templates, volumes) through natural language interactions.

### How it Works

The server runs as a stdio-based MCP server that:
- Accepts tool calls from MCP clients via stdin
- Makes authenticated requests to Runpod's REST API (`https://rest.runpod.io/v1`)
- Returns structured responses via stdout
- Uses Zod schemas for input validation

### Value Proposition

- Natural Language Control: Manage Runpod infrastructure through AI assistants
- Standardized Interface: MCP protocol ensures compatibility across clients
- Full API Coverage: Exposes all major Runpod management operations
- Type Safety: Zod schemas provide runtime validation and type inference

## Project Structure

```
runpod-mcp/
├── src/                    # Source code
│   └── index.ts           # Single-file server implementation
├── docs/                   # Documentation
├── dist/                  # Build output (generated)
├── smithery.yaml         # Smithery deployment config
└── .changeset/           # Changesets for versioning
```

## Core Principles

### 1. Branding & Naming

- Always use "Runpod" (not "RunPod", "runpod", or "run-pod") in user-facing text
- Package name: `@runpod/mcp-server`
- Server name: "Runpod API Server"
- Environment variable: `RUNPOD_API_KEY`

### 2. API Structure

- Base URL: `https://rest.runpod.io/v1`
- Authentication: Bearer token via `Authorization` header
- Request format: JSON for POST/PATCH body, query params for filters
- Response format: JSON with error handling for non-JSON responses

### 3. Tool Organization

Tools are organized by resource type:
- Pod Management: `list-pods`, `get-pod`, `create-pod`, `update-pod`, `start-pod`, `stop-pod`, `delete-pod`
- Endpoint Management: `list-endpoints`, `get-endpoint`, `create-endpoint`, `update-endpoint`, `delete-endpoint`
- Template Management: `list-templates`, `get-template`, `create-template`, `update-template`, `delete-template`
- Network Volume Management: `list-network-volumes`, `get-network-volume`, `create-network-volume`, `update-network-volume`, `delete-network-volume`
- Container Registry Auth: `list-container-registry-auths`, `get-container-registry-auth`, `create-container-registry-auth`, `delete-container-registry-auth`

### 4. Error Handling

- Always return structured error messages with HTTP status codes
- Handle non-JSON responses gracefully
- Log errors to stderr for debugging
- Return JSON responses wrapped in MCP content format

## Development Workflow

### Package Management

- Use pnpm as the primary package manager
- Maintain `pnpm-lock.yaml` (not `package-lock.json`)
- Support all package managers in documentation

### Version Management

- Use Changesets for version management and releases
- Never manually edit version numbers or `CHANGELOG.md`
- Create changesets with: `pnpm changeset`
- Automated releases via GitHub Actions

### Code Quality

- ESLint: Use `eslint.config.mjs` for Node 18+ compatibility
- Prettier: Single quotes, 2 spaces, trailing commas
- TypeScript: Strict mode, full type safety
- Single-file architecture: Keep implementation in `src/index.ts` for simplicity

## Code Style

### TypeScript

```typescript
// Good - Consistent naming and structure
server.tool(
  'list-pods',
  {
    computeType: z.enum(['GPU', 'CPU']).optional().describe('Filter to only GPU or only CPU Pods'),
    // ... more params
  },
  async (params) => {
    const result = await runpodRequest(`/pods${queryString}`);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);
```

### Request Helper Pattern

```typescript
// Good - Centralized request handling
async function runpodRequest(
  endpoint: string,
  method: string = 'GET',
  body?: Record<string, unknown>
) {
  const url = `${API_BASE_URL}${endpoint}`;
  const headers = {
    Authorization: `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
  };
  // ... error handling
}
```

### Query Parameter Construction

```typescript
// Good - Build query params conditionally
const queryParams = new URLSearchParams();
if (params.computeType) queryParams.append('computeType', params.computeType);
if (params.gpuTypeId) {
  params.gpuTypeId.forEach((type) => queryParams.append('gpuTypeId', type));
}
const queryString = queryParams.toString() ? `?${queryParams.toString()}` : '';
```

## Testing Standards

### Manual Testing

- Test each tool with Claude Desktop or MCP client
- Verify error handling with invalid inputs
- Test query parameter combinations
- Validate response format matches MCP spec

### Development Testing

```bash
# Build and run locally
pnpm build
pnpm start

# Or run directly with tsx
pnpm dev
```

## Documentation

### README Structure

1. Title & Badge (Smithery)
2. Features (list of tool categories)
3. Setup (prerequisites, installation, configuration)
4. Smithery Installation (automated setup)
5. Manual Setup (Claude Desktop config)
6. Usage Examples (natural language examples)
7. Security Considerations

### Code Comments

```typescript
// Good - Explain the "why", not the "what"
// Some endpoints might not return JSON
const contentType = response.headers.get('content-type');
if (contentType && contentType.includes('application/json')) {
  return await response.json();
}
```

## Release Management

- Use Changesets for all releases
- Never manually edit version numbers or `CHANGELOG.md`
- Create changeset for any user-facing changes with `pnpm changeset`
- GitHub Actions handles versioning and publishing automatically

## Common Patterns

### Tool Definition Pattern

```typescript
server.tool(
  'resource-action',
  {
    resourceId: z.string().describe('ID of the resource'),
    optionalParam: z.string().optional().describe('Optional parameter'),
  },
  async (params) => {
    const { resourceId, ...rest } = params;
    const result = await runpodRequest(`/resources/${resourceId}`, 'POST', rest);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);
```

### Environment Variable Loading

```typescript
// Good - Fail fast on missing API key
const API_KEY = process.env.RUNPOD_API_KEY;
if (!API_KEY) {
  console.error('RUNPOD_API_KEY environment variable is required');
  process.exit(1);
}
```

## Common Pitfalls

### Don't Do This

```typescript
// Bad - Inconsistent naming
const apiKey = process.env.runpod_api_key;

// Bad - Missing error context
throw new Error('API error');

// Bad - Hardcoded values
const url = 'https://rest.runpod.io/v1/pods';

// Bad - Not handling non-JSON responses
return await response.json();
```

### Do This Instead

```typescript
// Good - Consistent naming
const API_KEY = process.env.RUNPOD_API_KEY;

// Good - Clear error with context
throw new Error(`Runpod API Error: ${response.status} - ${errorText}`);

// Good - Use constant
const API_BASE_URL = 'https://rest.runpod.io/v1';
const url = `${API_BASE_URL}${endpoint}`;

// Good - Handle different response types
const contentType = response.headers.get('content-type');
if (contentType && contentType.includes('application/json')) {
  return await response.json();
}
return { success: true, status: response.status };
```

## Deployment

### Smithery Integration

- Configuration defined in `smithery.yaml`
- Supports stdio transport
- Requires `runpodApiKey` in config schema
- Command function generates node command with env vars

### Manual Deployment

- Build: `pnpm build`
- Run: `node dist/index.js`
- Requires `RUNPOD_API_KEY` environment variable
- Compatible with any MCP client supporting stdio transport

## Development Commands

```bash
# Development
pnpm dev          # Run with tsx (watch mode)
pnpm build        # Production build
pnpm start        # Run built server

# Code Quality
pnpm lint         # ESLint checking
pnpm type-check   # TypeScript checking
pnpm prettier-check # Prettier checking

# Release Management
pnpm changeset           # Create changeset
pnpm changeset:version   # Update versions
pnpm changeset:publish   # Publish to npm
```

---

**Remember**: These conventions exist to maintain consistency, quality, and ease of maintenance. When in doubt, follow the existing patterns in the codebase.

