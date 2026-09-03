// ============== v1 → v2 REQUEST BODY MAPPERS ==============
// Pure functions that translate the v1-shaped tool params (what the MCP tool
// schemas accept today) into v2 REST request bodies. Isolated here so the v2
// shape is a one-file change when the spec moves.
//
// These mappers target the vendored v2 spec snapshot under tests/fixtures and are
// pinned by committed fixtures. When the live spec changes, update the mapper AND
// its fixture in one commit.
//
// Two older mid-flight questions this file carried ARE now settled, and their
// workarounds are gone: `cloud` dropped `ALL` (the tool never offered it), and
// template `category` became optional with a documented server-side `NVIDIA`
// default, so the mapper no longer forces a value.
//
// `/v2/serverless` writes now match the vendored spec: `type` is a create field,
// `scaling` is a union keyed on it, and `idleTimeout` sits under `workers`. Note the
// spec-parity gate cannot police this — it checks operationId-to-tool coverage and
// never validates a request body against a schema, so the mapper tests in
// tests/mappers.test.ts are the only guard on the emitted shape.

// v1 params accepted by the create-pod / update-pod tool schemas (the fields the
// mapper knows how to translate). Unknown keys are intentionally dropped.
interface V1PodParams {
  name?: string;
  imageName?: string;
  cloudType?: 'SECURE' | 'COMMUNITY';
  gpuTypeIds?: string[];
  gpuCount?: number;
  containerDiskInGb?: number;
  volumeInGb?: number;
  volumeMountPath?: string;
  networkVolumeId?: string;
  ports?: string[];
  env?: Record<string, string>;
  dataCenterIds?: string[];
  containerRegistryAuthId?: string;
}

// Drop undefined entries so we never emit explicit `undefined`/`null` the API
// would reject; keeps the body minimal and the fixtures clean.
function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

// volumeInGb / volumeMountPath → mounts.persistent.{size,path}.
// v2 PersistentMount requires BOTH size and path (additionalProperties:false,
// 422 on a partial). So only emit the mount when both are present; a partial
// v1 input (size-only or path-only) yields `undefined` and is dropped rather
// than producing a body the API rejects. (Tool-schema validation should require
// both together.)
type PersistentMount = { persistent: { size: number; path: string } };
function persistentMount(
  size?: number,
  path?: string
): PersistentMount | undefined {
  if (size === undefined || path === undefined) return undefined;
  return { persistent: { size, path } };
}

// dockerStartCmd[] → v2 `args` (single string). Space-joined (lossy, but v2 has
// only `args`). Empty/undefined → no `args` key, so we never overwrite with "".
function joinStartCmd(cmd?: string[]): string | undefined {
  return cmd && cmd.length ? cmd.join(' ') : undefined;
}

// ---- ContainerConfig flatten shared by pod + template create/update ----
function containerConfigToV2(p: {
  imageName?: string;
  containerDiskInGb?: number;
  volumeInGb?: number;
  volumeMountPath?: string;
  ports?: string[];
  env?: Record<string, string>;
}): Record<string, unknown> {
  return compact({
    image: p.imageName,
    disk: p.containerDiskInGb,
    ports: p.ports,
    env: p.env,
    mounts: persistentMount(p.volumeInGb, p.volumeMountPath),
  });
}

// gpuTypeIds[] + gpuCount → gpu: { id, count }. v2 GpuConfig requires `id`, so
// return undefined for a count-only input — an idless gpu would be rejected
// (422). `count` is documented as optional (defaults to 1 server-side), but in
// practice omitting it makes the scheduler match ZERO machines and every create
// fails with a misleading "no instances available" 400 (observed live
// 2026-08-04, both v2 hosts; the identical body with count:1 succeeds). So
// always emit the documented default explicitly.
function gpuConfigToV2(
  gpuTypeIds?: string[],
  gpuCount?: number
): Record<string, unknown> | undefined {
  const id = gpuTypeIds?.[0];
  if (id === undefined) return undefined;
  return { id, count: gpuCount ?? 1 };
}

export function mapPodCreateToV2(params: V1PodParams): Record<string, unknown> {
  const container = containerConfigToV2(params);

  // An existing Network Volume uses the v2 network-mount shape. Keep this
  // create-only: templates support persistent mounts only, and pod updates have
  // stricter mount-kind/volume-id immutability rules. The create-pod handler
  // rejects a missing path or a simultaneous volumeInGb before this mapper runs.
  // Assigning the whole mounts object also makes an explicit Network Volume
  // replace a persistent mount inherited from a template during the later merge.
  if (
    params.networkVolumeId !== undefined &&
    params.volumeMountPath !== undefined
  ) {
    container.mounts = {
      network: [
        {
          volumeId: params.networkVolumeId,
          path: params.volumeMountPath,
        },
      ],
    };
  }

  return compact({
    ...container,
    name: params.name,
    // Private-image registry credential (v2 ContainerConfig `registry`). When
    // deploying from a template, this spreads over the template's registry, so
    // passing it overrides the inherited credential. An empty string is an
    // explicit opt-out: emit `registry: null` (v2 accepts null) to CLEAR a
    // template's inherited credential. Undefined is dropped by compact, so an
    // omitted param leaves the template's registry in place.
    registry:
      params.containerRegistryAuthId === ''
        ? null
        : params.containerRegistryAuthId,
    cloud: params.cloudType,
    // v2 CreatePodRequest takes `dataCenterIds` as an ARRAY (preferred data
    // centers; omit/empty = scheduler chooses). Pass the v1 list straight
    // through — the earlier singular `dataCenter` key did not exist on the pod
    // schema, so placement was being silently dropped. GPU, by contrast, IS
    // singular on v2 (`gpu.id`): gpuConfigToV2 takes the first id; the
    // create-pod handler warns when more than one gpuTypeId was supplied.
    dataCenterIds: params.dataCenterIds?.length
      ? params.dataCenterIds
      : undefined,
    gpu: gpuConfigToV2(params.gpuTypeIds, params.gpuCount),
  });
}

export function mapPodUpdateToV2(params: V1PodParams): Record<string, unknown> {
  // Update has no gpu/cloud/dataCenter; just name + ContainerConfig fields.
  return {
    ...containerConfigToV2(params),
    ...compact({ name: params.name }),
  };
}

// ---- Endpoint (serverless) create/update → v2 /v2/serverless body ----
// v1 create-endpoint is templateId-based (a fundamentally different model); v2
// takes an INLINE container + compute config (image, gpu.pools, workers, scaling)
// and has NO templateId. So this mapper translates the v2-shaped tool params into
// the nested v2 body. It deliberately does NOT reuse containerConfigToV2 — that
// helper emits `mounts` (a pod/template concept), which the endpoint schema
// rejects; endpoints attach storage via `networkVolumes` instead.
//
// Required by v2 CreateEndpointRequest: `name`, `image`, `gpu` (with `gpu.pools`
// minItems 1), `type` and `scaling`. The create-endpoint handler guards the first
// three before calling, so a missing field yields a clean 400 rather than a raw
// 422 from the API; the last two are always emitted, defaulted below.

interface V2EndpointParams {
  name?: string;
  imageName?: string;
  args?: string;
  endpointType?: EndpointType;
  gpuPoolIds?: string[];
  gpuCount?: number;
  workersMin?: number;
  workersMax?: number;
  scalerType?: ScalerType;
  scalerValue?: number;
  idleTimeout?: number;
  dataCenterIds?: string[];
  networkVolumeIds?: string[];
  executionTimeoutMs?: number;
  flashboot?: 'OFF' | 'FLASHBOOT' | 'PRIORITY_FLASHBOOT';
  containerDiskInGb?: number;
  ports?: string[];
  env?: Record<string, string>;
  containerRegistryAuthId?: string;
}

type EndpointType = 'QUEUE' | 'LOAD_BALANCER';
type ScalerType = 'QUEUE_DELAY' | 'REQUEST_COUNT';

// `type` and `scaling` are required on create, so something must be sent. These are
// what the API used to apply server-side, so a caller that passes neither keeps
// getting the endpoint it always got.
//
// DEFAULT_ENDPOINT_TYPE is create-only — update never sends `type`. DEFAULT_SCALER_VALUE
// applies on BOTH: the scaling union requires a target next to its discriminator, so
// `scalerType` alone still has to carry a value.
const DEFAULT_ENDPOINT_TYPE: EndpointType = 'QUEUE';
const DEFAULT_SCALER_VALUE = 4;

// The scaler each endpoint type uses when the caller does not name one. Queue
// endpoints may use either signal; load-balancing endpoints have no queue, so
// REQUEST_COUNT is their only legal choice.
function defaultScalerType(endpointType: EndpointType): ScalerType {
  return endpointType === 'LOAD_BALANCER' ? 'REQUEST_COUNT' : 'QUEUE_DELAY';
}

// `scaling` is a union discriminated on `type`, with the target carried under a
// per-variant key rather than a shared `value`.
function endpointScaling(
  scalerType: ScalerType,
  value: number
): Record<string, unknown> {
  return scalerType === 'REQUEST_COUNT'
    ? { type: 'REQUEST_COUNT', requestCount: value }
    : { type: 'QUEUE_DELAY', queueDelay: value };
}

// gpu requires `pools` (minItems 1) — return undefined when no pools so the
// handler's guard, not the API, reports the omission.
function endpointGpuConfig(
  pools?: string[],
  count?: number
): Record<string, unknown> | undefined {
  if (!pools?.length) return undefined;
  return compact({ pools, count });
}

// `workers` absorbed `idleTimeout` from `scaling`. Returns undefined when the caller
// set none of the three, so we never send an empty `workers: {}`.
function endpointWorkers(
  params: V2EndpointParams
): Record<string, unknown> | undefined {
  const workers = compact({
    min: params.workersMin,
    max: params.workersMax,
    idleTimeout: params.idleTimeout,
  });
  return Object.keys(workers).length ? workers : undefined;
}

// The half of the body shared by create and update: container config, compute,
// placement and workers. Only `type` and `scaling` differ between the two.
function endpointCommonToV2(params: V2EndpointParams): Record<string, unknown> {
  return compact({
    name: params.name,
    image: params.imageName,
    args: params.args,
    disk: params.containerDiskInGb,
    ports: params.ports,
    env: params.env,
    registry: params.containerRegistryAuthId,
    gpu: endpointGpuConfig(params.gpuPoolIds, params.gpuCount),
    workers: endpointWorkers(params),
    dataCenterIds: params.dataCenterIds?.length
      ? params.dataCenterIds
      : undefined,
    networkVolumes: params.networkVolumeIds?.length
      ? params.networkVolumeIds
      : undefined,
    timeout: params.executionTimeoutMs,
    flashboot: params.flashboot,
  });
}

// CREATE. `type` and `scaling` are required, so both are always emitted.
export function mapEndpointCreateToV2(
  params: V2EndpointParams
): Record<string, unknown> {
  const endpointType = params.endpointType ?? DEFAULT_ENDPOINT_TYPE;
  return compact({
    ...endpointCommonToV2(params),
    type: endpointType,
    scaling: endpointScaling(
      params.scalerType ?? defaultScalerType(endpointType),
      params.scalerValue ?? DEFAULT_SCALER_VALUE
    ),
  });
}

// UPDATE. Only provided fields change, so nothing is defaulted into existence —
// except the scaler target, which the union requires alongside its `type`
// discriminator (so `scalerType` alone implies the default value). `type` is never
// sent: the API rejects it on PATCH ("additional properties 'type' not allowed") —
// an endpoint's routing model is fixed at creation.
export function mapEndpointUpdateToV2(
  params: V2EndpointParams
): Record<string, unknown> {
  return compact({
    ...endpointCommonToV2(params),
    scaling: params.scalerType
      ? endpointScaling(
          params.scalerType,
          params.scalerValue ?? DEFAULT_SCALER_VALUE
        )
      : undefined,
  });
}

// ---- Network volume: dataCenterId → dataCenter (only field change) ----
interface V1NetworkVolumeCreate {
  name?: string;
  size?: number;
  dataCenterId?: string;
  // Storage tier. Optional on v2 — omitted means the data center's default
  // (primary) tier. Immutable after creation, so there is no update equivalent.
  volumeType?: 'STANDARD' | 'HIGH_PERFORMANCE';
}
export function mapNetworkVolumeCreateToV2(
  params: V1NetworkVolumeCreate
): Record<string, unknown> {
  return compact({
    name: params.name,
    size: params.size,
    dataCenter: params.dataCenterId,
    type: params.volumeType,
  });
}

// ---- Template: imageName→image, isServerless→serverless, dockerStartCmd→args,
// ContainerConfig flatten. `dockerEntrypoint` and `readme` are dropped (no v2
// equivalent — v2 ContainerConfig has only `args`, no separate entrypoint). ----
interface V1TemplateCreate {
  name?: string;
  imageName?: string;
  isServerless?: boolean;
  ports?: string[];
  env?: Record<string, string>;
  containerDiskInGb?: number;
  volumeInGb?: number;
  volumeMountPath?: string;
  // Startup command; joinStartCmd collapses the array into v2's `args` string.
  dockerStartCmd?: string[];
  // Template category (CPU/NVIDIA/AMD). Optional on v2, which defaults it to
  // NVIDIA server-side — so an omitted category is left unsent rather than
  // filled in here.
  category?: 'CPU' | 'NVIDIA' | 'AMD';
  // Container registry credential for pulling a private image. v1's field is
  // `containerRegistryAuthId`; v2 ContainerConfig calls it `registry`.
  containerRegistryAuthId?: string;
}
export function mapTemplateCreateToV2(
  params: V1TemplateCreate
): Record<string, unknown> {
  return {
    ...containerConfigToV2(params),
    ...compact({
      name: params.name,
      serverless: params.isServerless,
      registry: params.containerRegistryAuthId,
      args: joinStartCmd(params.dockerStartCmd),
      // No longer required by v2 (it defaults to NVIDIA server-side), so an
      // unset category is dropped by compact instead of being forced here.
      category: params.category,
    }),
  };
}

// ---- Template → pod create body (client-side template-based deploy) ----
// v2 CreatePodRequest has no `templateId`, so create-pod can't deploy from a
// template the way v1 did. Bridge on the MCP side: copy the template's container
// config into the pod body as DEFAULTS; the caller's explicit params override
// them. `registry` is included so a private-image template deploys with its
// credential — the caller can override it via create-pod's containerRegistryAuthId
// param. Template-only fields (id, serverless, public, category) and null values
// are dropped.
export function podBodyFromTemplate(
  template: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keys = [
    'name',
    'image',
    'args',
    'disk',
    'ports',
    'env',
    'mounts',
    'registry',
  ];
  for (const key of keys) {
    const value = template[key];
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

// ---- SSH convenience (create-pod sshPublicKey param) ----

// An OpenSSH public key line: key-type token, then the base64 blob (a trailing
// comment is optional). `ssh-*` covers rsa/ed25519/dss, `ecdsa-*` the NIST curves,
// `sk-*` FIDO/U2F security keys. authorized_keys also permits a leading options
// field (`no-port-forwarding ssh-rsa …`), which a .pub file never carries —
// accepting arbitrary leading tokens would defeat the point of validating, so an
// options-prefixed line is rejected with the format message.
const SSH_PUBLIC_KEY_LINE =
  /^(ssh-[a-z0-9-]+|ecdsa-[a-z0-9-]+|sk-[a-z0-9@.-]+)\s+\S+/i;

// Any spelling of "private key" in any case, plus PuTTY's own header — a .ppk
// says `PuTTY-User-Key-File-2` and keeps its secret under `Private-Lines`, so it
// never contains the words the PEM guard looks for.
const PRIVATE_KEY_MARKER = /private[-\s]?key|PuTTY-User-Key-File/i;

export type SshPublicKeyResult =
  | { ok: true; key: string }
  | { ok: false; error: string };

/**
 * Validate and normalize the caller-supplied SSH public key(s).
 *
 * Anything that is not a usable public key must be rejected BEFORE a pod is
 * created: an unusable value still exposed 22/tcp, wrote junk into PUBLIC_KEY,
 * and returned the "SSH configured" note, leaving a running, billing pod that
 * nobody can log into and no indication of why. Both real cases fail that way —
 * a path (`~/.ssh/id_ed25519.pub`) or a fingerprint (`SHA256:…`) passed instead
 * of the file's contents, which is the mistake an LLM filling this param makes.
 *
 * Empty or whitespace-only is an error, not a silent skip: the way to say "no
 * SSH" is to omit the param, so a blank value is a caller bug, and failing here
 * is cheaper than a pod that cannot be reached.
 *
 * Normalizes CRLF and per-line whitespace. authorized_keys is one key per line,
 * and a stray \r would corrupt the entry it lands on.
 *
 * The error messages never echo the input: a rejected value may be secret
 * (a header-stripped private blob), and the reply is logged by every client.
 */
export function normalizeSshPublicKey(input: string): SshPublicKeyResult {
  if (PRIVATE_KEY_MARKER.test(input))
    return {
      ok: false,
      error:
        'sshPublicKey looks like a PRIVATE key. Pass the PUBLIC key instead — the contents of your ~/.ssh/<key>.pub file (e.g. "ssh-ed25519 AAAA…").',
    };
  const lines = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0)
    return {
      ok: false,
      error:
        'sshPublicKey is empty. Pass the contents of your ~/.ssh/<key>.pub file, or omit the parameter entirely to create the pod without SSH.',
    };
  if (lines.some((line) => !SSH_PUBLIC_KEY_LINE.test(line)))
    return {
      ok: false,
      error:
        'sshPublicKey is not an SSH public key. Expected the CONTENTS of your ~/.ssh/<key>.pub file — a line like "ssh-ed25519 AAAAC3Nza… you@host" (ssh-*, ecdsa-*, or sk-* followed by the base64 key) — not a file path, a SHA256 fingerprint, or a bare base64 blob. Newline-separate multiple keys.',
    };
  return { ok: true, key: lines.join('\n') };
}

// The REST API has no SSH switch yet: the console and runpodctl set GraphQL
// `startSsh`, which injects the account's registered keys as a PUBLIC_KEY env
// var that official images install into authorized_keys before starting sshd.
// Until REST v2 ships its own startSsh field, create-pod reproduces the
// convention client-side from a caller-supplied key: merge the key into
// env.PUBLIC_KEY and make sure 22/tcp is exposed. Must run on the FINAL body
// (after any template merge) so a template's ports/env are extended, not
// clobbered. Works on v1 and v2 bodies alike — `ports` and `env` have the
// same shape on both.
export function applySshPublicKey(
  body: Record<string, unknown>,
  sshPublicKey: string
): Record<string, unknown> {
  const ports = Array.isArray(body.ports) ? (body.ports as string[]) : [];
  const hasSshPort = ports.some((p) => /^\s*22\/tcp\s*$/i.test(String(p)));
  const env = { ...((body.env as Record<string, string> | undefined) ?? {}) };
  const key = sshPublicKey.trim();
  // A PUBLIC_KEY already present (caller's env or the template's) stays
  // authorized: authorized_keys is one key per line, so append, don't replace.
  if (!env.PUBLIC_KEY) env.PUBLIC_KEY = key;
  else if (!env.PUBLIC_KEY.includes(key))
    env.PUBLIC_KEY = `${env.PUBLIC_KEY}\n${key}`;
  return {
    ...body,
    ports: hasSshPort ? ports : [...ports, '22/tcp'],
    env,
  };
}

interface V1TemplateUpdate {
  name?: string;
  imageName?: string;
  ports?: string[];
  env?: Record<string, string>;
  dockerStartCmd?: string[];
  containerRegistryAuthId?: string;
  // readme has no v2 equivalent — dropped.
}
// Update has no required `category`; flatten ContainerConfig + name. Maps
// imageName→image (v2 expects `image`) and dockerStartCmd→args like create.
export function mapTemplateUpdateToV2(
  params: V1TemplateUpdate
): Record<string, unknown> {
  return {
    ...containerConfigToV2(params),
    ...compact({
      name: params.name,
      registry: params.containerRegistryAuthId,
      args: joinStartCmd(params.dockerStartCmd),
    }),
  };
}
