// Every list tool, walked end to end through the real MCP server against a
// local fake Runpod API over eight account shapes (scripts/smoke-lists.ts):
// empty, page edges, 250 rows, redaction, an oversized row, rows added
// mid-walk. A new list is covered automatically.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { generatedTools } from '#src/specgen/generated/tools.gen';
import { curatedTools } from '#src/specgen/server';

test('every list tool walks cleanly on every fake account shape', () => {
  const run = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/smoke-lists.ts'],
    {
      encoding: 'utf8',
      timeout: 120_000,
      // A key in the shell must never send this test to a real account.
      env: { ...process.env, RUNPOD_API_KEY: 'must-not-be-used' },
    }
  );
  const failures = run.stdout
    .split('\n')
    // The fake serves every list, so a skip (an API 4xx) is a failure too.
    .filter((line) => line.startsWith('FAIL') || line.startsWith('SKIP'));
  assert.deepEqual(failures, [], run.stderr);
  assert.equal(run.status, 0, run.stderr);
  // Guards against a run that quietly leaves a list out: every list tool
  // must appear, by name, with a PASS.
  const lists = [
    ...generatedTools.filter((tool) => tool.list).map((tool) => tool.name),
    ...curatedTools
      .filter((t) => t.name.startsWith('list-') || t.name === 'get-capacity')
      .map((tool) => tool.name),
  ];
  const unwalked = lists.filter(
    (name) => !new RegExp(`^PASS ${name} `, 'm').test(run.stdout)
  );
  assert.deepEqual(unwalked, []);
});
