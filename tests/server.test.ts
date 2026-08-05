import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createServer, SERVER_INSTRUCTIONS, SERVER_NAME } from '../src/server.js';

// Full client<->server handshake over an in-memory transport, asserting on
// what actually goes over the wire in the `initialize` response. Guards the
// two things `createServer` owns: the advertised capabilities (only ones the
// server implements — it registers tools and no resources) and the
// instructions block that points agents at the full API contracts.
describe('createServer initialize handshake', () => {
  async function connect() {
    const server = createServer('0.0.0-test');
    const client = new Client({ name: 'handshake-test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  it('reports serverInfo without stray capabilities', async () => {
    const client = await connect();
    const serverInfo = client.getServerVersion();
    assert.ok(serverInfo);
    assert.equal(serverInfo.name, SERVER_NAME);
    assert.match(serverInfo.version, /^0\.0\.0-test \[RUNPOD_REST_VERSION/);
    assert.equal('capabilities' in serverInfo, false);
  });

  it('advertises tools and does not advertise resources', async () => {
    const client = await connect();
    const capabilities = client.getServerCapabilities();
    assert.ok(capabilities?.tools);
    assert.equal(capabilities?.resources, undefined);
  });

  it('sends instructions pointing at the API contracts', async () => {
    const client = await connect();
    const instructions = client.getInstructions();
    assert.equal(instructions, SERVER_INSTRUCTIONS);
    assert.match(instructions ?? '', /api\.runpod\.io\/v2\/openapi\.json/);
    assert.match(instructions ?? '', /graphql-spec\.runpod\.io/);
  });
});
