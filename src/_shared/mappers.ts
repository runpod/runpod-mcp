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
//   - template `category` may become optional / be removed
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
  // volumeInGb / volumeMountPath → mounts.persistent.{size,path}
  if (p.volumeInGb !== undefined || p.volumeMountPath !== undefined) {
    const persistent = compact({
      size: p.volumeInGb,
      path: p.volumeMountPath,
    });
    out.mounts = { persistent };
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
  // gpuTypeIds[] + gpuCount → gpu: { id, count }
  if (params.gpuTypeIds?.length || params.gpuCount !== undefined) {
    body.gpu = compact({
      id: params.gpuTypeIds?.[0],
      count: params.gpuCount,
    });
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
  };
}

// Registry create is unchanged between v1 and v2 (name/username/password) →
// identity. Exposed for symmetry so the descriptor table is uniform.
export function identityMapper(body: unknown): unknown {
  return body;
}
