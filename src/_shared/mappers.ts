// ============== v1 → v2 REQUEST BODY MAPPERS ==============
// Pure functions that translate the v1-shaped tool params (what the MCP tool
// schemas accept today) into v2 REST request bodies. Isolated here so the v2
// shape is a one-file change when the spec moves.
//
// ⚠️ SPEC IS MID-FLIGHT (see PLAN.md Part 7/8). These mappers target the current
// v2 dev spec snapshot and are pinned by committed fixtures under tests/fixtures.
// Known pending upstream changes that will require updating these + the fixtures:
//   - `cloud` enum may drop `ALL`
//   - template `category` may become optional / be removed (v2 marks it required
//     today; the create-template tool now exposes `category`, defaulting to
//     NVIDIA only when the caller omits it)
// When the live spec changes, update the mapper AND its fixture in one commit.

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
  ports?: string[];
  env?: Record<string, string>;
  dataCenterIds?: string[];
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
// (422). count is optional (defaults to 1 server-side).
function gpuConfigToV2(
  gpuTypeIds?: string[],
  gpuCount?: number
): Record<string, unknown> | undefined {
  const id = gpuTypeIds?.[0];
  if (id === undefined) return undefined;
  return compact({ id, count: gpuCount });
}

export function mapPodCreateToV2(params: V1PodParams): Record<string, unknown> {
  return compact({
    ...containerConfigToV2(params),
    name: params.name,
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

// ---- Network volume: dataCenterId → dataCenter (only field change) ----
interface V1NetworkVolumeCreate {
  name?: string;
  size?: number;
  dataCenterId?: string;
}
export function mapNetworkVolumeCreateToV2(
  params: V1NetworkVolumeCreate
): Record<string, unknown> {
  return compact({
    name: params.name,
    size: params.size,
    dataCenter: params.dataCenterId,
  });
}

// ---- Template: imageName→image, isServerless→serverless, ContainerConfig flatten,
// drop readme/dockerEntrypoint/dockerStartCmd (no v2 equivalent; args collapse is
// lossy — see PLAN B3, deferred to a follow-up that decides join semantics). ----
interface V1TemplateCreate {
  name?: string;
  imageName?: string;
  isServerless?: boolean;
  ports?: string[];
  env?: Record<string, string>;
  containerDiskInGb?: number;
  volumeInGb?: number;
  volumeMountPath?: string;
  // v2 CreateTemplateRequest requires `category` (CPU/NVIDIA/AMD). The v1 tool
  // has no such field; default to NVIDIA (the documented default) so the body is
  // valid, and accept an explicit override once the tool schema exposes it.
  category?: 'CPU' | 'NVIDIA' | 'AMD';
}
export function mapTemplateCreateToV2(
  params: V1TemplateCreate
): Record<string, unknown> {
  return {
    ...containerConfigToV2(params),
    ...compact({
      name: params.name,
      serverless: params.isServerless,
    }),
    // Required by v2 — always emit, defaulting to NVIDIA.
    category: params.category ?? 'NVIDIA',
  };
}

interface V1TemplateUpdate {
  name?: string;
  imageName?: string;
  ports?: string[];
  env?: Record<string, string>;
  // readme has no v2 equivalent — dropped.
}
// Update has no required `category`; just flatten ContainerConfig + name. Crucial:
// this maps imageName→image (an identity mapper would wrongly send `imageName` to
// v2, which expects `image`).
export function mapTemplateUpdateToV2(
  params: V1TemplateUpdate
): Record<string, unknown> {
  return {
    ...containerConfigToV2(params),
    ...compact({ name: params.name }),
  };
}
