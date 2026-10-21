// Which tool surface a connection gets. `default` is the full surface every
// client has always had. `directory` is what app directories (Anthropic's
// connector directory, OpenAI's plugin directory) list: their policies forbid
// tool descriptions that instruct the model, steer it toward other tools or
// external instructions, or collect conversation data beyond the tool's job.
// The directory profile is served only at DIRECTORY_PATH; nothing about the
// default surface changes.
export type ServerProfile = 'default' | 'directory';

export const DIRECTORY_PATH = '/directory';

/** Whether a tool is listed on the directory profile. Every tool the server
 *  can serve must have an entry, so a new tool (a spec regeneration, a new
 *  curated tool) fails tests/specgen-directory.test.ts until someone decides.
 *  The rules for deciding are in specgen/DIRECTORY_POLICY.md.
 *  `omitInputs` hides top-level arguments the directory must not ask for (a
 *  credential, for example); a call that passes one is refused. */
export type DirectoryDecision =
  | { include: true; omitInputs?: readonly string[] }
  | { include: false; reason: string };

const IN = { include: true } as const;
const CREDENTIAL_INPUT =
  'Takes a secret or password as input; directories forbid collecting credentials.';
const ALP =
  'Collects conversation-derived data beyond the task; the directory profile never serves it.';

export const DIRECTORY_TOOLS: Readonly<Record<string, DirectoryDecision>> = {
  'cancel-job': IN,
  'create-cluster': IN,
  'create-delegation': IN,
  'create-endpoint': IN,
  'create-global-volume': IN,
  'create-network-volume': IN,
  'create-pod': IN,
  'create-template': IN,
  'delete-cluster': IN,
  'delete-endpoint': IN,
  'delete-global-volume': IN,
  'delete-network-volume': IN,
  'delete-pod': IN,
  'delete-registry': IN,
  'delete-secret': IN,
  'delete-template': IN,
  'deploy-hub-repo': IN,
  'endpoint-health': IN,
  'get-capacity': IN,
  'get-cluster': IN,
  'get-cpu-type': IN,
  'get-data-center': IN,
  'get-endpoint': IN,
  'get-endpoint-build': IN,
  'get-global-volume': IN,
  'get-gpu-type': IN,
  'get-job-status': IN,
  'get-network-volume': IN,
  'get-organization': IN,
  'get-pod': IN,
  'get-registry': IN,
  'get-secret': IN,
  'get-ssh-keys': IN,
  'get-template': IN,
  'list-billing': IN,
  'list-cluster-billing': IN,
  'list-cluster-pods': IN,
  'list-clusters': IN,
  'list-cpu-types': IN,
  'list-data-centers': IN,
  'list-delegations': IN,
  'list-endpoint-billing': IN,
  'list-endpoint-builds': IN,
  'list-endpoint-releases': IN,
  'list-endpoint-workers': IN,
  'list-endpoints': IN,
  'list-global-volumes': IN,
  'list-gpu-types': IN,
  'list-hub-repos': IN,
  'list-network-volume-billing': IN,
  'list-network-volumes': IN,
  'list-pod-billing': IN,
  'list-pods': IN,
  'list-public-endpoints': IN,
  'list-public-templates': IN,
  'list-registries': IN,
  'list-secrets': IN,
  'list-serverless-billing': IN,
  'list-templates': IN,
  'lookup-concept': IN,
  'pod-action': IN,
  'purge-endpoint-queue': IN,
  'retry-job': IN,
  'revoke-delegation': IN,
  'search-concepts': IN,
  'search-docs': IN,
  'set-endpoint-gpus': IN,
  'stream-job': IN,
  'stream-pod-logs': IN,
  'stream-worker-logs': IN,
  'update-cluster': IN,
  'update-endpoint': IN,
  'update-global-volume': IN,
  'update-network-volume': IN,
  'update-pod': IN,
  'update-ssh-keys': IN,
  'update-template': IN,
  'run-endpoint': { include: true, omitInputs: ['s3Config'] },
  'runsync-endpoint': { include: true, omitInputs: ['s3Config'] },
  'list-guides': {
    include: false,
    reason: 'Serves playbooks that instruct the model how to behave.',
  },
  'read-guide': {
    include: false,
    reason: 'Serves playbooks that instruct the model how to behave.',
  },
  'describe-tool': {
    include: false,
    reason:
      'Fetches schemas the directory already lists in full; directories reject schema fetching.',
  },
  'create-secret': { include: false, reason: CREDENTIAL_INPUT },
  'update-secret': { include: false, reason: CREDENTIAL_INPUT },
  'create-registry': { include: false, reason: CREDENTIAL_INPUT },
  report_feedback: { include: false, reason: ALP },
  report_how_user_found_runpod: { include: false, reason: ALP },
  save_to_journal: { include: false, reason: ALP },
  read_journal: { include: false, reason: ALP },
  ask_question: { include: false, reason: ALP },
};

/** Served on the directory profile only with an explicit include. */
export function directoryIncludes(name: string): boolean {
  return DIRECTORY_TOOLS[name]?.include === true;
}

export function directoryOmittedInputs(name: string): readonly string[] {
  const decision = DIRECTORY_TOOLS[name];
  return decision?.include ? (decision.omitInputs ?? []) : [];
}

export function profileForPath(pathname: string): ServerProfile {
  return pathname.replace(/\/+$/, '') === DIRECTORY_PATH
    ? 'directory'
    : 'default';
}
