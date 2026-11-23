// Tool results are compact JSON unless MCP_PRETTY_RESPONSES=true, and the
// page budget measures exactly the text the server sends, in either format.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSpecgenServer } from '#src/specgen/server';
import { createToolContext } from '#src/specgen/context';
import { PAGE_BUDGET_BYTES } from '#src/specgen/pagination';
import { serializeResult } from '#src/specgen/serialize';

type Guides = {
  guides: unknown[];
  pagination: { hasNextPage: boolean; nextCursor: string | null };
};

// list-guides pages local data, so this runs the server's real result path
// with no network.
async function withFormat<T>(
  pretty: string | undefined,
  run: (call: (args: Record<string, unknown>) => Promise<string>) => Promise<T>
): Promise<T> {
  const saved = process.env.MCP_PRETTY_RESPONSES;
  if (pretty === undefined) delete process.env.MCP_PRETTY_RESPONSES;
  else process.env.MCP_PRETTY_RESPONSES = pretty;
  const server = createSpecgenServer(createToolContext({ apiKey: 'none' }));
  const client = new Client({ name: 'test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    return await run(async (args) => {
      const result = await client.callTool({
        name: 'list-guides',
        arguments: args,
      });
      return (result.content as Array<{ text: string }>)[0].text;
    });
  } finally {
    await Promise.all([client.close(), server.close()]);
    if (saved === undefined) delete process.env.MCP_PRETTY_RESPONSES;
    else process.env.MCP_PRETTY_RESPONSES = saved;
  }
}

test('results are compact by default and pretty only for MCP_PRETTY_RESPONSES=true', async () => {
  for (const [value, pretty] of [
    [undefined, false],
    ['false', false],
    ['1', false],
    ['TRUE', false],
    ['yes', false],
    [' true', false],
    ['true', true],
  ] as const) {
    const text = await withFormat(value, (call) => call({ limit: 2 }));
    const parsed = JSON.parse(text);
    assert.equal(
      text,
      pretty ? JSON.stringify(parsed, null, 2) : JSON.stringify(parsed),
      `MCP_PRETTY_RESPONSES=${value}`
    );
  }
});

test('error results use the same format', async () => {
  for (const [value, pretty] of [
    [undefined, false],
    ['true', true],
  ] as const) {
    const text = await withFormat(value, (call) => call({ cursor: 'bad' }));
    const parsed = JSON.parse(text);
    assert.equal(parsed.code, 'invalid_cursor');
    assert.equal(
      text,
      pretty ? JSON.stringify(parsed, null, 2) : JSON.stringify(parsed)
    );
  }
});

// A full page must fit the budget as sent, and one more row must not: if
// the budget measured another format than the one sent, the page would
// either pass the budget (measured compact, sent pretty) or leave room for
// more rows (measured pretty, sent compact).
test('a full page is as full as the sent text allows, in both formats', async () => {
  for (const value of [undefined, 'true']) {
    await withFormat(value, async (call) => {
      const text = await call({ limit: 100 });
      const page = JSON.parse(text) as Guides;
      assert.ok(page.pagination.hasNextPage, 'the budget cuts the page');
      assert.ok(page.guides.length < 100);
      assert.ok(
        Buffer.byteLength(text) <= PAGE_BUDGET_BYTES,
        `sent ${Buffer.byteLength(text)} B`
      );
      const next = JSON.parse(
        await call({ limit: 100, cursor: page.pagination.nextCursor })
      ) as Guides;
      const oneMore = { ...page, guides: [...page.guides, next.guides[0]] };
      assert.ok(
        Buffer.byteLength(serializeResult(oneMore)) > PAGE_BUDGET_BYTES,
        `MCP_PRETTY_RESPONSES=${value}: one more row still fits`
      );
    });
  }
});
