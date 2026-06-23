// ============== v1 → v2 REQUEST BODY MAPPERS ==============
// Pure functions that translate the v1-shaped tool params (what the MCP tool
// schemas accept today) into v2 REST request bodies. Isolated here so the v2
// shape is a one-file change when the spec moves.
//
// ⚠️ SPEC IS MID-FLIGHT (see PLAN.md Part 7/8). These mappers target the current
// v2 dev spec snapshot and are pinned by committed fixtures under tests/fixtures.
// Known pending upstream changes that will require updating these + the fixtures:
//   - `dataCenter` (scalar) may revert to `dataCenterIds` (array)
//   - `cloud` enum may drop `ALL`
//   - template `category` may become optional / be removed (we currently emit it
//     with an NVIDIA default since the committed spec marks it required)
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

// ---- ContainerConfig flatten shared by pod + template create/update ----
function containerConfigToV2(p: {
  imageName?: string;
  containerDiskInGb?: number;
  volumeInGb?: number;
  volumeMountPath?: string;
  ports?: string[];
  env?: Record<string, string>;
}): Record<string, unknown> {
  const out: Record<string, unknown> = compact({
    image: p.imageName,
    disk: p.containerDiskInGb,
    ports: p.ports,
    env: p.env,
  });
  // volumeInGb / volumeMountPath → mounts.persistent.{size,path}.
  // v2 PersistentMount requires BOTH size and path (additionalProperties:false,
  // 422 on a partial). So only emit the mount when both are present; a partial
  // v1 input (size-only or path-only) is dropped rather than producing a body
  // the API rejects. (Tool-schema validation should require both together.)
  if (p.volumeInGb !== undefined && p.volumeMountPath !== undefined) {
    out.mounts = {
      persistent: { size: p.volumeInGb, path: p.volumeMountPath },
    };
  }
  return out;
}

export function mapPodCreateToV2(params: V1PodParams): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...containerConfigToV2(params),
    ...compact({
      name: params.name,
      cloud: params.cloudType,
      // array → scalar: v2 takes a single GPU type id
      dataCenter: params.dataCenterIds?.[0],
    }),
  };
  // gpuTypeIds[] + gpuCount → gpu: { id, count }. v2 GpuConfig requires `id`, so
  // only emit `gpu` when a concrete id is present — a count-only input would
  // produce an idless gpu the API rejects (422). count is optional (defaults 1).
  const gpuId = params.gpuTypeIds?.[0];
  if (gpuId !== undefined) {
    body.gpu = compact({ id: gpuId, count: params.gpuCount });
  }
  return body;
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

// Registry create is unchanged between v1 and v2 (name/username/password) →
// identity. Exposed for symmetry so the descriptor table is uniform.
export function identityMapper(body: unknown): unknown {
  return body;
}
