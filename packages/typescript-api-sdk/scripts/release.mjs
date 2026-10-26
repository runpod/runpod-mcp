import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Branches whose PRs carry a version bump: the Changesets release PR and the
// daily spec update PR.
const releaseBranches = ['changeset-release/main', 'automation/production-spec'];

export function approvedRelease(pr, repository, sha) {
  return Boolean(pr.merged_at && pr.merge_commit_sha === sha &&
    pr.base?.ref === 'main' && pr.base?.repo?.full_name === repository &&
    releaseBranches.includes(pr.head?.ref) && pr.head?.repo?.full_name === repository);
}

export function releaseVersion(pkg, changelog) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(pkg.version) || pkg.version === '0.0.0') {
    throw new Error('Only reviewed, stable-format release versions may publish.');
  }
  if (!changelog.split('\n').includes(`## ${pkg.version}`)) {
    throw new Error('The package version has no Changesets changelog entry.');
  }
  return pkg.version;
}

export function preventDowngrade(version, latest) {
  if (!latest) return;
  const parse = value => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
    ? value.split('.').map(BigInt) : null;
  const target = parse(version);
  const published = parse(latest);
  if (!target || !published) throw new Error('Cannot compare stable release versions.');
  for (let index = 0; index < 3; index++) {
    if (published[index] > target[index]) throw new Error('A newer npm release exists; refusing to move latest backwards.');
    if (published[index] < target[index]) return;
  }
}

async function github(path, options = {}) {
  const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', ...options.headers },
    signal: AbortSignal.timeout(30000),
  });
  if (response.status === 404 && options.allowMissing) return null;
  if (!response.ok) throw new Error(`GitHub request failed: ${response.status}`);
  return response.json();
}

export async function registryVersion(name, version, fetcher = fetch) {
  const response = await fetcher(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`, {
    signal: AbortSignal.timeout(30000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`npm registry request failed: ${response.status}`);
  return response.json();
}

async function approvedHead() {
  if (process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Releases must run from main.');
  const sha = process.env.GITHUB_SHA;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!/^[a-f0-9]{40}$/.test(sha ?? '') || !/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) {
    throw new Error('Missing GitHub release context.');
  }
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (head !== sha) throw new Error('Checkout differs from the workflow commit.');
  for (let page = 1; ; page++) {
    const prs = await github(`commits/${sha}/pulls?per_page=100&page=${page}`);
    if (prs.some(pr => approvedRelease(pr, repository, sha))) return true;
    if (prs.length < 100) return false;
  }
}

async function main() {
  const command = process.argv[2];
  if (!['plan', 'publish', 'dry-run'].includes(command)) throw new Error('Use plan, publish, or dry-run.');
  const approved = await approvedHead();
  if (command === 'plan') {
    appendFileSync(process.env.GITHUB_OUTPUT, `eligible=${approved}\n`);
    console.log(approved ? 'Merged release PR: eligible for validation.' : 'No merged release PR at this commit; nothing to publish.');
    return;
  }
  if (!approved) throw new Error('Publishing requires the merged release PR commit.');
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const changelog = readFileSync('CHANGELOG.md', 'utf8');
  const version = releaseVersion(pkg, changelog);
  const expectedRepository = `git+https://github.com/${process.env.GITHUB_REPOSITORY}.git`;
  if (pkg.repository?.url !== expectedRepository) throw new Error('Package repository metadata must match the publishing repository.');
  const run = (program, args) => execFileSync(program, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  run('npm', ['run', 'build']);
  const [packed] = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json']));
  if (command === 'dry-run') {
    run('npm', ['publish', packed.filename, '--dry-run', '--access', 'public', '--tag', 'latest']);
    console.log(`Dry run passed for ${pkg.name}@${version}; nothing published or tagged.`);
    return;
  }
  const tag = `v${version}`;
  const existingTag = await github(`git/ref/tags/${tag}`, { allowMissing: true });
  if (existingTag && (existingTag.object.type !== 'commit' || existingTag.object.sha !== process.env.GITHUB_SHA)) {
    throw new Error('Existing release tag does not point to this commit.');
  }
  const latest = await registryVersion(pkg.name, "latest");
  preventDowngrade(version, latest?.version);
  const existing = await registryVersion(pkg.name, version);
  if (existing) {
    if (existing.dist?.integrity !== packed.integrity) throw new Error('This npm version already exists with different package contents.');
    console.log('Identical npm artifact already published; completing GitHub release if needed.');
  } else {
    run('npm', ['publish', packed.filename, '--access', 'public', '--tag', 'latest', '--provenance']);
  }
  if (!existingTag) await github('git/refs', {
    method: 'POST', body: JSON.stringify({ ref: `refs/tags/${tag}`, sha: process.env.GITHUB_SHA }),
  });
  const release = await github(`releases/tags/${tag}`, { allowMissing: true });
  if (!release) {
    const notes = changelog.split(`## ${version}\n`)[1].split('\n## ')[0].trim();
    await github('releases', { method: 'POST', body: JSON.stringify({ tag_name: tag, name: tag, body: notes }) });
  }
  console.log(`Released ${pkg.name}@${version}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
