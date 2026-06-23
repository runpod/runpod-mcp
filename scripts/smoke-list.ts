// Live end-to-end check for the list-* pagination caps. Boots the stdio MCP
// server as a subprocess, connects a real MCP client, calls each list tool,
// and prints the pagination envelope so you can confirm the cap fires against
// a real account.
//
//   RUNPOD_API_KEY=... tsx scripts/smoke-list.ts
//
// Requires a Runpod API key. Read-only: only calls list-* tools.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const LIST_TOOLS = [
  'list-pods',
  'list-endpoints',
  'list-templates',
  'list-network-volumes',
  'list-container-registry-auths',
];

async function main() {
  const apiKey = process.env.RUNPOD_API_KEY;
  if (!apiKey) throw new Error('RUNPOD_API_KEY is required');

  const transport = new StdioClientTransport({
    command: 'tsx',
    args: ['src/stdio.ts'],
    env: { ...process.env, RUNPOD_API_KEY: apiKey },
  });

  const client = new Client(
    { name: 'smoke-list', version: '0.0.0' },
    { capabilities: {} }
  );
  await client.connect(transport);

  for (const name of LIST_TOOLS) {
    // list-templates needs the include flag to surface the full catalog.
    const args =
      name === 'list-templates' ? { includeRunpodTemplates: true } : {};
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ type: string; text: string }>)[0]
      ?.text;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    const pagination =
      parsed && typeof parsed === 'object' && 'pagination' in parsed
        ? (parsed as { pagination: unknown }).pagination
        : '(no pagination envelope)';
    console.log(`\n=== ${name} ===`);
    console.log(JSON.stringify(pagination, null, 2));
  }

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
