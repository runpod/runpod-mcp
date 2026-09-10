import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { SERVER_NAME } from '../src/server.js';
import {
  createSpecgenServer,
  SERVER_INSTRUCTIONS,
} from '../src/specgen/server.js';
import { createToolContext } from '../src/specgen/context.js';

// Full client<->server handshake over an in-memory transport, asserting on
// what actually goes over the wire in the `initialize` response: the
// advertised capabilities (tools AND resources — the skills are served) and
// the instructions block that routes agents to the skills and the contracts.
describe('initialize handshake', () => {
  async function connect() {
    const server = createSpecgenServer(
      createToolContext({ apiKey: 'rpa_test' }),
      '0.0.0-test'
    );
    const client = new Client({ name: 'handshake-test', version: '0.0.0' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    return client;
  }

  it('reports serverInfo without stray capabilities', async () => {
    const client = await connect();
    const serverInfo = client.getServerVersion();
    assert.ok(serverInfo);
    assert.equal(serverInfo.name, SERVER_NAME);
    assert.match(serverInfo.version, /^0\.0\.0-test \[specgen\]/);
    assert.equal('capabilities' in serverInfo, false);
  });

  it('advertises tools and resources, nothing else', async () => {
    const client = await connect();
    const capabilities = client.getServerCapabilities();
    assert.ok(capabilities?.tools);
    assert.ok(capabilities?.resources);
    assert.equal(capabilities?.prompts, undefined);
  });

  it('sends instructions pointing at the skills and the API contract', async () => {
    const client = await connect();
    const instructions = client.getInstructions();
    assert.equal(instructions, SERVER_INSTRUCTIONS);
    assert.match(instructions ?? '', /runpod:\/\/skills\/runpod/);
    assert.match(instructions ?? '', /api\.runpod\.io\/v2\/openapi\.json/);
  });
});
