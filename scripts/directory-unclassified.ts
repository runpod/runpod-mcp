// Prints the tools that have no directory decision in DIRECTORY_TOOLS
// (src/specgen/profile.ts), one per line. The production spec update uses it
// to decide whether new tools need classifying against
// specgen/DIRECTORY_POLICY.md.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createToolContext } from '#src/specgen/context';
import { DIRECTORY_TOOLS } from '#src/specgen/profile';
import { createSpecgenServer } from '#src/specgen/server';

// Every optional tool on, so the list covers everything the server can serve.
const server = createSpecgenServer(
  createToolContext({ apiKey: 'unused' }),
  'cli',
  {
    alp: { ingestUrl: 'http://127.0.0.1:9/', transport: 'stdio' },
    search: async () => ({ status: 200, body: {} as never }),
  }
);
const client = new Client({ name: 'directory-unclassified', version: '1' });
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
const { tools } = await client.listTools();
await client.close();

for (const { name } of tools) if (!(name in DIRECTORY_TOOLS)) console.log(name);
