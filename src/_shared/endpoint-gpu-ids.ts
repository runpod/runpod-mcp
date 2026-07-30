// ============== GraphQL gpuIds: read, inspect, update ==============
// The v2 REST endpoint model cannot represent a GPU SKU exclusion. Its
// EndpointGpuConfig is `{pools: string[], count?: number}` — a bare pool list with
// no room for the '-<GPU type id>' entries that pin an individual SKU. The
// authoritative value lives only in the GraphQL `gpuIds` string
// ("POOL[,POOL...][,-<GPU type id>...]").
//
// Two consequences this module exists to handle:
//
//   1. `get-endpoint` on v2 cannot show exclusions, so a caller has no way to
//      read-verify the live GPU config before or after a write (issue #63).
//   2. `set-endpoint-gpus` is the explicit GraphQL path for changing the complete
//      gpuIds value, including exclusions the v2 REST model cannot express.
//
// saveEndpoint is NOT a sparse update: an id+name+gpuIds-only call was measured
// resetting workersMax 7→3, idleTimeout 42→10 and scalerValue 9→4 to server
// defaults. So every field the resolver writes unconditionally has to be echoed back
// — but ONLY those. Echoing a field whose write is gated does damage rather than
// preventing it (see buildSaveEndpointInput). That balance is why the snapshot query
// and the input builder live together here rather than being reimplemented per call
// site.

import type { ToolRuntime } from '../tools/runtime.js';

// The fields the update resolver writes without gating on their presence in the
// input. Two mechanisms make omission unsafe for them, and only the first actually
// resets anything: a GraphQL input DEFAULT materialises a value the resolver then
// writes (idleTimeout=10, scalerValue=4, workersMax=3, workersMin=0, gpuCount=1,
// scalerType=QUEUE_DELAY — exactly the fields measured resetting), or the resolver
// derives an explicit null (`instanceIds ? join : null`, `locations || null`). The
// remaining echoed fields (the CUDA pair, executionTimeoutMs, requestTTL) reach
// Prisma as `undefined` and would NOT be reset — requestTTL is echoed anyway because
// its absence is read as a change and triggers a rolling worker restart, and the
// others for symmetry.
//
// Fields whose write is gated on the input carrying them are deliberately absent:
// compliance, modelReferences, templateId, networkVolumeIds, and `type` (written only
// `...(input.type ? {type} : {})`, and validated only `if (input.type && …)`, so
// echoing a future AiApiType the validator rejects — RT exists in the enum — would
// fail every saveEndpoint update for no benefit). For those, omission is already a no-op and
// echoing does harm. See buildSaveEndpointInput.
export interface EndpointSnapshot {
  id: string;
  name: string;
  // Nullable: a CPU endpoint has no gpuIds.
  gpuIds: string | null;
  gpuCount: number;
  workersMin: number;
  workersMax: number;
  idleTimeout: number;
  scalerType: string;
  scalerValue: number;
  // Column is `Int? @default(0)` — nullable despite the non-null-looking default.
  executionTimeoutMs: number | null;
  // Written unconditionally AND compared for the SLS-version bump, so omitting it
  // means the comparison sees `{requestTTL: undefined}` against a stored value and
  // reports a change — a rolling worker restart for a write that changed nothing.
  requestTTL: number | null;
  flashBootType: string;
  locations: string | null;
  // A comma-separated String on read AND write, not a list.
  allowedCudaVersions: string | null;
  minCudaVersion: string | null;
  // Nulled UNCONDITIONALLY when omitted (`input?.instanceIds ? join(',') : null`),
  // so it has to be read and echoed or a CPU endpoint's instance selection is wiped
  // by any write through this builder. Reads as `[]`, never null, when there are
  // none — hence echoed only when non-empty, since `[]` is truthy and would be
  // written as an empty string where the column held NULL.
  instanceIds: string[];
}

interface EndpointSnapshotResponse {
  // Documented live response for a credential with no user identity: HTTP 200 with
  // `myself: null` and no `errors` array, so this must be nullable.
  myself: { endpoint: EndpointSnapshot | null } | null;
}

export interface EndpointGpuIds {
  gpuIds: string | null;
}

interface EndpointGpuIdsResponse {
  myself: { endpoint: EndpointGpuIds | null } | null;
}

// Read-only consumers need exactly one field. Keeping this separate from the
// mutation snapshot avoids making get-endpoint enrichment depend on unrelated
// field authorization and schema details.
export const GPU_IDS_QUERY = `
  query EndpointGpuIds($id: String!) {
    myself {
      endpoint(id: $id) {
        gpuIds
      }
    }
  }
`;

export async function readEndpointGpuIds(
  graphqlAuthed: ToolRuntime['graphqlAuthed'],
  endpointId: string
): Promise<EndpointGpuIds | null> {
  const data = await graphqlAuthed<EndpointGpuIdsResponse>(GPU_IDS_QUERY, {
    id: endpointId,
  });
  return data?.myself?.endpoint ?? null;
}

// Queries ONE endpoint by id. `myself { endpoints }` is capped at 400 rows,
// oldest-first, with no pagination — so on a large account the endpoint being
// updated could simply be absent from the list. `endpoint(id:)` has no cap, returns
// one row instead of 400, and throws for an id it cannot see.
//
// Selects only what the write needs. Every extra field is a liability: several
// Endpoint fields carry their own field-level authorisation, and one rejected field
// fails the entire read even when the rest came back.
// Exported for tests: a field present in EndpointSnapshot but missing from the
// selection set reads as `undefined`, which JSON.stringify drops from the GraphQL
// variables — silently turning an echo into an omission. That is exactly how the
// instanceIds data-loss bug got in, and no fixture-based test can catch it, because a
// fake response returns whatever it likes regardless of what was asked for.
export const SNAPSHOT_QUERY = `
  query EndpointSnapshot($id: String!) {
    myself {
      endpoint(id: $id) {
        id
        name
        gpuIds
        gpuCount
        workersMin
        workersMax
        idleTimeout
        scalerType
        scalerValue
        executionTimeoutMs
        requestTTL
        flashBootType
        locations
        allowedCudaVersions
        minCudaVersion
        instanceIds
      }
    }
  }
`;

/**
 * Reads one endpoint's full GraphQL settings. Returns null when the endpoint is not
 * visible to this credential — callers decide whether that is an error or a skip.
 * The resolver throws for an unknown id, which surfaces as a rejected promise.
 */
export async function readEndpointSnapshot(
  graphqlAuthed: ToolRuntime['graphqlAuthed'],
  endpointId: string
): Promise<EndpointSnapshot | null> {
  const data = await graphqlAuthed<EndpointSnapshotResponse>(SNAPSHOT_QUERY, {
    id: endpointId,
  });
  return data?.myself?.endpoint ?? null;
}

/**
 * True when a gpuIds string carries at least one SKU exclusion, i.e. an entry
 * beginning with '-'. Those are the entries v2 REST cannot represent.
 */
// Deliberately NOT a `gpuIds is string` type predicate: a false result does not mean
// "not a string" — a pool-only "AMPERE_16" is a perfectly good string with no
// exclusions — and TS would narrow it to null|undefined in the negative branch.
export function hasGpuExclusions(gpuIds: string | null | undefined): boolean {
  if (!gpuIds) return false;
  return gpuIds
    .split(',')
    .some((entry) => entry.trim().startsWith('-') && entry.trim().length > 1);
}

/**
 * Builds a saveEndpoint input that echoes the snapshot back, with `overrides`
 * applied on top. Echoes every field the resolver writes unconditionally, because
 * omitting one of those resets it server-side — and deliberately omits the ones it
 * writes only when the input carries them, because echoing a read value back is what
 * does the damage there. The list of omissions and why is below.
 */
export function buildSaveEndpointInput(
  snapshot: EndpointSnapshot,
  overrides: { gpuIds?: string; gpuCount?: number } & Partial<
    Pick<EndpointSnapshot, 'allowedCudaVersions' | 'minCudaVersion'>
  > = {}
): Record<string, unknown> {
  const input: Record<string, unknown> = {
    id: snapshot.id,
    name: snapshot.name,
    gpuIds: overrides.gpuIds ?? snapshot.gpuIds,
    gpuCount: overrides.gpuCount ?? snapshot.gpuCount,
    workersMin: snapshot.workersMin,
    workersMax: snapshot.workersMax,
    idleTimeout: snapshot.idleTimeout,
    scalerType: snapshot.scalerType,
    scalerValue: snapshot.scalerValue,
    executionTimeoutMs: snapshot.executionTimeoutMs,
    requestTTL: snapshot.requestTTL,
    flashBootType: snapshot.flashBootType,
    locations: snapshot.locations,
    allowedCudaVersions:
      overrides.allowedCudaVersions ?? snapshot.allowedCudaVersions,
    minCudaVersion: overrides.minCudaVersion ?? snapshot.minCudaVersion,
  };

  // Only when non-empty: the server writes `input.instanceIds ? join(',') : null`,
  // and `[]` is truthy — echoing an empty list would store an empty string where
  // the column held NULL. Omitting it when there are none writes null, which is what
  // "none" already means.
  // Guarded rather than `snapshot.instanceIds.length`: tolerate an older or malformed
  // GraphQL response instead of throwing while a caller builds the mutation.
  if (snapshot.instanceIds && snapshot.instanceIds.length > 0) {
    input.instanceIds = snapshot.instanceIds;
  }

  // NOT echoed, deliberately — each of these is written only when the input carries
  // it, so omission preserves the stored value, and echoing causes real damage:
  //
  //   modelReferences: gated on `!== undefined`. Reads as `[]` when there are none,
  //     and `[]` means "clear all model references" — which strips MODEL_NAME /
  //     MODEL_NAMES from the endpoint's env and rolls its workers. When non-empty it
  //     re-validates every reference, and this mutation carries no HuggingFace token,
  //     so a gated model fails the write outright.
  //   compliance: gated on `!== undefined`. Reads as `[]`, never null — and `[]`
  //     resolves to NULL server-side, which CLEARS the endpoint's compliance
  //     requirements. For a GDPR/HIPAA-tagged endpoint that is a placement change, not
  //     a bookkeeping one.
  //   templateId: read only on the create path (`if (isCreating)`), so echoing it on an
  //     update is at best a no-op — nothing on the update path reads it.
  //   networkVolumeIds: a null/omitted value means "don't touch volumes"; echoing a
  //     legacy single-volume endpoint's volume creates rows that did not exist and
  //     bumps the SLS version.
  //
  // Verified in runpod-backend node/graphql/schema/aiApi.ts (the isUpdating branch
  // of saveEndpoint).

  return input;
}

export interface SaveEndpointResult {
  saveEndpoint: {
    id: string;
    name: string;
    gpuIds: string;
    gpuCount: number;
    workersMin: number;
    workersMax: number;
  };
}

export const SAVE_ENDPOINT_MUTATION = `
  mutation saveEndpoint($input: EndpointInput!) {
    saveEndpoint(input: $input) {
      id
      name
      gpuIds
      gpuCount
      workersMin
      workersMax
    }
  }
`;

export function saveEndpoint(
  graphqlAuthed: ToolRuntime['graphqlAuthed'],
  input: Record<string, unknown>
): Promise<SaveEndpointResult> {
  return graphqlAuthed<SaveEndpointResult>(SAVE_ENDPOINT_MUTATION, { input });
}
