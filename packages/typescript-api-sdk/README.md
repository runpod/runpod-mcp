# Runpod REST API v2 — TypeScript SDK

A typed TypeScript/JavaScript client for **Runpod REST API v2**
(`https://api.runpod.io/v2`). Manage pods, clusters,
Serverless endpoints, templates, network volumes, registries, catalog, SSH keys,
and billing.

[REST v2 API docs](https://api.runpod.io/v2/docs) ·
[OpenAPI spec](https://api.runpod.io/v2/openapi.json) ·
[Runpod plugin](https://github.com/runpod/runpod-plugins-official) ·
[MCP server](https://github.com/runpod/runpod-mcp)

Supports **Node.js 20+**, ESM, and CommonJS. For Serverless job submission and
results, use the existing [runpod-sdk](https://github.com/runpod/js-sdk).

<!-- runpod-agent-setup:start -->
**For AI agents:** setup instructions for the Runpod skills and MCP server are at https://agents.runpod.io/
<!-- runpod-agent-setup:end -->

## Using an AI agent instead?

The **[Runpod plugin](https://github.com/runpod/runpod-plugins-official#install)**
adds Runpod skills and tools to your agent. In Claude Code:

```text
/plugin marketplace add runpod/runpod-plugins-official
/plugin install runpod@runpod
/reload-plugins
```

Authenticate through `/mcp` → **runpod** → **Sign in with Runpod**.
[Install for other agents](https://github.com/runpod/runpod-plugins-official#install).

For **[MCP tools only](https://github.com/runpod/runpod-mcp#quick-start)**,
run the guided installer and follow its connection/authentication prompts:

```bash
npx @runpod/mcp-server@latest add
```

These alternatives let an agent manage Runpod without integrating this SDK.

## Install from npm

Install the SDK in your app:

```bash
npm install @runpod/typescript-api-sdk
```

Or with pnpm:

```bash
pnpm add @runpod/typescript-api-sdk
```

Then [create a client with your API key](#use-it-in-your-app). Node.js 20+ is
required; Python and the source build tools are not needed to use the npm package.

## Build from source

To build from source, install **Node.js 24** and **pnpm 11**. Python is only needed
when regenerating types or running the spec tests.

From the SDK checkout:

```bash
pnpm install --frozen-lockfile
pnpm build
cp .env.example .env
```

Set `RUNPOD_API_KEY` in `.env`, then run a read-only request to list GPU types:

```bash
node --env-file=.env examples/catalog.mjs
```

### Install a local build

Create a local package from the SDK checkout:

```bash
npm pack
```

Then install that file **in your app's directory**, using the tarball path printed
by `npm pack`:

```bash
npm install /path/to/package.tgz
```

## Use it in your app

After installing from npm or a local build, pass your API key when creating a
client and make a request:

```ts
import { createRunpodClient } from "@runpod/typescript-api-sdk";

const client = createRunpodClient({ apiKey: "YOUR_API_KEY" });
const { data, response } = await client.GET("/v2/catalog/gpus", {
  signal: AbortSignal.timeout(15_000),
});

if (!response.ok) throw new Error(`Runpod request failed: ${response.status}`);
if (!data) throw new Error("Runpod returned no data");
console.log(data.gpus);
```

The client retries transient failures by default; pass `{ retry: false }` to disable retries.
Use `response.ok` to check HTTP status. Network, timeout, and parsing failures
reject the promise. A **30-second deadline** covers retries and response-body
consumption; configure `timeoutMs` or set it to `false` for long-lived streams.
The SDK does not load `.env` automatically. Keep API keys in server-side code.

## One API key per client

Each call to `createRunpodClient` creates an independent client. Pass `apiKey`
to configure credentials for that instance; requests send it as
`Authorization: Bearer <apiKey>`.

```ts
import { createRunpodClient } from "@runpod/typescript-api-sdk";

const clientA = createRunpodClient({ apiKey: "YOUR_FIRST_API_KEY" });
const clientB = createRunpodClient({ apiKey: "YOUR_SECOND_API_KEY" });

const podsA = await clientA.GET("/v2/pods"); // Uses the first key
const podsB = await clientB.GET("/v2/pods"); // Uses the second key
```

Create as many clients as you need. Each keeps its own credentials and options;
creating another client does not change existing clients. Load real keys from
server-side configuration or a secret store rather than committing them to code.

If you omit `apiKey`, the client reads `RUNPOD_API_KEY` from the environment when
it is created. An explicit `apiKey` takes precedence. For example:

```ts
const client = createRunpodClient(); // Uses RUNPOD_API_KEY
```

## More

- [Client guide](docs/client.md): options, errors, retries, CommonJS, and log streams.
- [Logging guide](docs/logging.md): structured events, cancellation, and parser limits.
- [Examples](examples): runnable catalog and pod-log requests.
- [Development](docs/development.md): tests, type generation, and spec-update automation.

MIT — [License](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.txt)
