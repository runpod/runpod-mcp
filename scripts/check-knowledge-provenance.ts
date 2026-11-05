// Checks that a @runpod/plugin-knowledge release was published with npm
// provenance from runpod-plugins-official. @runpod/mcp-server depends on the
// exact version package.json pins, so the release and the daily knowledge
// update run this on that pin.
//
// The SLSA provenance the registry serves names the repository whose workflow
// built the package, and that must be runpod-plugins-official. `npm audit
// signatures` then verifies the registry signature and the attestations, in a
// throwaway project that holds only that package. The audit alone passes a
// package that has no attestation at all, so the provenance is required first.
//
// Run: pnpm knowledge:provenance [<name>@<version>]   (network required;
// defaults to the pinned @runpod/plugin-knowledge)
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PACKAGE = '@runpod/plugin-knowledge';
const SOURCE_REPOSITORY = 'https://github.com/runpod/runpod-plugins-official';
const SLSA_PROVENANCE_V1 = 'https://slsa.dev/provenance/v1';

try {
  const spec = process.argv[2] ?? pinnedSpec();
  const repository = await provenanceRepository(spec);
  if (repository !== SOURCE_REPOSITORY)
    throw new Error(
      `${spec} was built from ${repository}, not ${SOURCE_REPOSITORY}.`
    );
  console.log(auditSignatures(spec));
  console.log(
    `knowledge-provenance: ${spec} has verified provenance from ${SOURCE_REPOSITORY}.`
  );
} catch (error) {
  console.error(
    `knowledge-provenance: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
}

function pinnedSpec(): string {
  const { dependencies } = JSON.parse(readFileSync('package.json', 'utf8')) as {
    dependencies?: Record<string, string | undefined>;
  };
  const version = dependencies?.[PACKAGE];
  if (!version) throw new Error(`package.json does not depend on ${PACKAGE}.`);
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error(
      `package.json must pin ${PACKAGE} to an exact version, not "${version}".`
    );
  return `${PACKAGE}@${version}`;
}

/** The repository the SLSA provenance on npm says built spec. */
async function provenanceRepository(spec: string): Promise<string> {
  const url = npm(['view', spec, 'dist.attestations.url']).trim();
  if (!url) throw new Error(`${spec} has no attestations on npm.`);
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`npm answered ${response.status} for ${url}.`);
  const { attestations } = (await response.json()) as {
    attestations: {
      predicateType: string;
      bundle: { dsseEnvelope: { payload: string } };
    }[];
  };
  const provenance = attestations.find(
    (attestation) => attestation.predicateType === SLSA_PROVENANCE_V1
  );
  if (!provenance)
    throw new Error(`${spec} has no SLSA provenance attestation on npm.`);
  const statement = JSON.parse(
    Buffer.from(provenance.bundle.dsseEnvelope.payload, 'base64').toString(
      'utf8'
    )
  ) as {
    predicate?: {
      buildDefinition?: {
        externalParameters?: { workflow?: { repository?: string } };
      };
    };
  };
  const repository =
    statement.predicate?.buildDefinition?.externalParameters?.workflow
      ?.repository;
  if (!repository)
    throw new Error(`The provenance of ${spec} names no source repository.`);
  return repository;
}

function auditSignatures(spec: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-provenance-'));
  try {
    writeFileSync(join(dir, 'package.json'), '{ "private": true }\n');
    npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', spec], dir);
    return npm(['audit', 'signatures'], dir).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function npm(args: string[], cwd?: string): string {
  const result = spawnSync('npm', args, { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const how = result.signal
      ? `was killed by ${result.signal}`
      : `exited ${result.status}`;
    throw new Error(
      `npm ${args.join(' ')} ${how}.\n${`${result.stdout}${result.stderr}`.trim()}`
    );
  }
  return result.stdout;
}
