import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvedRelease, registryVersion, releaseVersion, preventDowngrade } from './release.mjs';

const repository = 'example/sdk';
const sha = 'a'.repeat(40);
const pr = { merged_at: '2026-01-01', merge_commit_sha: sha,
  base: { ref: 'main', repo: { full_name: repository } },
  head: { ref: 'changeset-release/main', repo: { full_name: repository } } };

test('only the merged release PR commit is approved, including manual retries', () => {
  assert.equal(approvedRelease(pr, repository, sha), true);
  assert.equal(approvedRelease({ ...pr, head: { ...pr.head, ref: 'automation/production-spec' } }, repository, sha), true);
  for (const rejected of [
    { ...pr, merged_at: null }, { ...pr, merge_commit_sha: 'b'.repeat(40) },
    { ...pr, head: { ...pr.head, ref: 'feature' } },
    { ...pr, head: { ...pr.head, repo: { full_name: 'fork/sdk' } } },
    { ...pr, head: { ref: 'automation/production-spec', repo: { full_name: 'fork/sdk' } } },
    { ...pr, base: { ...pr.base, ref: 'development' } },
  ]) assert.equal(approvedRelease(rejected, repository, sha), false);
});

test('bootstrap and unreviewed versions cannot publish', () => {
  for (const version of ['0.0.0', '0.1.0-beta.1', '0.1.0.1', '01.1.0']) {
    assert.throws(() => releaseVersion({ version }, `## ${version}`));
  }
  assert.throws(() => releaseVersion({ version: '0.1.0' }, '## 0.2.0'));
  assert.equal(releaseVersion({ version: '0.1.0' }, '# SDK\n\n## 0.1.0\n'), '0.1.0');
});

test('only registry 404 permits a new publish, outages and auth failures fail closed', async () => {
  assert.equal(await registryVersion('@example/sdk', '0.1.0', async () => new Response('', { status: 404 })), null);
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(registryVersion('@example/sdk', '0.1.0', async () => new Response('', { status })));
  }
  assert.deepEqual(await registryVersion('@example/sdk', '0.1.0', async () => Response.json({ version: '0.1.0' })), { version: '0.1.0' });
});

test('retrying an older release cannot move latest backwards', () => {
  for (const latest of ['0.2.0', '1.0.0', '0.1.1']) assert.throws(() => preventDowngrade('0.1.0', latest));
  for (const latest of [undefined, '0.0.9', '0.1.0']) assert.doesNotThrow(() => preventDowngrade('0.1.0', latest));
  assert.throws(() => preventDowngrade('0.1.0', 'unexpected'));
});

// Exercise the executable with simulated GitHub/npm services. No publish command
// can reach npm: the child process PATH points at a local test executable.
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('publisher creates a release, retries identical packages, and rejects conflicting packages', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdk-release-test-'));
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@example/sdk', version: '0.1.0',
      repository: { url: 'git+https://github.com/example/sdk.git' } }));
    writeFileSync(join(root, 'CHANGELOG.md'), '# SDK\n\n## 0.1.0\n\nRelease notes.\n');
    const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git(['init', '-b', 'main']); git(['add', '.']);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'Release']);
    const commit = git(['rev-parse', 'HEAD']).trim();
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'bin/npm'), `#!${process.execPath}\n` + `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'run') console.log('Build log: not JSON');
else if (args[0] === 'pack') console.log(JSON.stringify([{filename:'sdk.tgz', integrity:'sha512-example'}]));
else if (args[0] !== 'publish') process.exit(1);
`, { mode: 0o755 });
    const preload = join(root, 'services.mjs');
    writeFileSync(preload, `
import { appendFileSync } from 'node:fs';
globalThis.fetch = async (url, options = {}) => {
  appendFileSync(process.env.API_LOG, JSON.stringify({url, method:options.method || 'GET'}) + '\\n');
  if (url.includes('/commits/')) return Response.json([{
    merged_at:'2026-01-01', merge_commit_sha:process.env.GITHUB_SHA,
    base:{ref:'main',repo:{full_name:'example/sdk'}}, head:{ref:'changeset-release/main',repo:{full_name:'example/sdk'}}
  }]);
  if (url.startsWith('https://registry.npmjs.org/')) {
    if (process.env.EXISTING && !url.endsWith('/latest')) return Response.json({dist:{integrity:process.env.EXISTING}});
    return new Response('', {status:404});
  }
  if (options.method === 'POST') return Response.json({});
  return new Response('', {status:404});
};
`);
    const env = { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`,
      GITHUB_REPOSITORY: 'example/sdk', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: commit,
      CALL_LOG: join(root, 'calls'), API_LOG: join(root, 'api') };
    const execute = existing => {
      writeFileSync(env.CALL_LOG, ''); writeFileSync(env.API_LOG, '');
      const result = spawnSync(process.execPath, ['--import', preload, fileURLToPath(new URL('./release.mjs', import.meta.url)), 'publish'], {
        cwd: root, env: { ...env, EXISTING: existing }, encoding: 'utf8',
      });
      const calls = readFileSync(env.CALL_LOG, 'utf8').trim().split('\n').map(JSON.parse);
      const api = readFileSync(env.API_LOG, 'utf8').trim().split('\n').map(JSON.parse);
      return { result, calls, api };
    };
    const initial = execute('');
    assert.equal(initial.result.status, 0, initial.result.stderr);
    assert(initial.calls.some(args => args[0] === 'publish' && args.includes('--provenance')));
    assert(initial.api.some(call => call.url.endsWith('/releases') && call.method === 'POST'));
    const retry = execute('sha512-example');
    assert.equal(retry.result.status, 0, retry.result.stderr);
    assert(!retry.calls.some(args => args[0] === 'publish'));
    const conflict = execute('sha512-different');
    assert.notEqual(conflict.result.status, 0);
    assert(!conflict.calls.some(args => args[0] === 'publish'));
    assert(!conflict.api.some(call => call.method === 'POST'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
