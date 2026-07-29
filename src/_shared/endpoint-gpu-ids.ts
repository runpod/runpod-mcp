// ============== GraphQL gpuIds: read, inspect, re-assert ==============
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
//   2. A v2 PATCH round-trips the endpoint through a representation with nowhere
//      to keep exclusions, so they can be lost even by an update that never
//      mentions GPUs. Re-asserting the pre-update gpuIds afterwards restores them.
//      Callers skip the write entirely when the patch left gpuIds alone, because the
//      write itself is not free: it re-runs validation and can bump the SLS version,
//      rolling the endpoint's workers.
//
// saveEndpoint is NOT a sparse update: an id+name+gpuIds-only call was measured
// resetting workersMax 7→3, idleTimeout 42→10 and scalerValue 9→4 to server
// defaults. So every field the resolver writes unconditionally has to be echoed back
// — but ONLY those. Echoing a field whose write is gated does damage rather than
// preventing it (see buildSaveEndpointInput). That balance is why the snapshot query
// and the input builder live together here rather than being reimplemented per call
// site.

import type { ToolRuntime } from '../tools/runtime.js';

// Exactly the fields the update resolver writes UNCONDITIONALLY, so that omitting
// one would reset it. Fields whose write is gated on `input.<field> !== undefined`
// (compliance, modelReferences) or on a truthy derived value (templateId,
// networkVolumeIds) are deliberately absent: for those, omission is already a no-op,
// and echoing them does harm. See buildSaveEndpointInput.
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
  type: string;
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

// Queries ONE endpoint by id. `myself { endpoints }` is capped at 400 rows,
// oldest-first, with no pagination — so on a large account the endpoint being
// updated could simply be absent from the list, and the exclusion protection would
// silently no-op. `endpoint(id:)` has no cap, returns one row instead of 400, and
// throws for an id it cannot see rather than reporting a false "no exclusions".
//
// Selects only what the write needs. Every extra field is a liability: several
// Endpoint fields carry their own field-level authorisation, and one rejected field
// fails the entire read even when the rest came back — which turns into a skipped
// GPU check on an endpoint that needed it.
const SNAPSHOT_QUERY = `
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
        type
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
export function hasGpuExclusions(
  gpuIds: string | null | undefined
): gpuIds is string {
  if (!gpuIds) return false;
  return gpuIds
    .split(',')
    .some((entry) => entry.trim().startsWith('-') && entry.trim().length > 1);
}

/**
 * Builds a saveEndpoint input that echoes the snapshot back, with `overrides`
 * applied on top. Every field the snapshot carries is included, because omitting
 * one resets it server-side.
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
    type: snapshot.type,
    locations: snapshot.locations,
    allowedCudaVersions:
      overrides.allowedCudaVersions ?? snapshot.allowedCudaVersions,
    minCudaVersion: overrides.minCudaVersion ?? snapshot.minCudaVersion,
  };

  // Only when non-empty: the server writes `input.instanceIds ? join(',') : null`,
  // and `[]` is truthy — echoing an empty list would store an empty string where
  // the column held NULL. Omitting it when there are none writes null, which is what
  // "none" already means.
  // Guarded rather than `snapshot.instanceIds.length`: this builder runs inside the
  // restore's try/catch, so a TypeError here would surface as "re-asserting the
  // exclusions failed" and silently cost the caller their SKU pins.
  if (snapshot.instanceIds && snapshot.instanceIds.length > 0) {
    input.instanceIds = snapshot.instanceIds;
  }

  // NOT echoed, deliberately — each of these is written only when the input carries
  // it, so omission preserves the stored value, and echoing causes real damage:
  //
  //   modelReferences: gated on `!== undefined`. Reads as `[]` when there are none,
  //     and `[]` means "clear all model references" — which strips MODEL_NAME /
  //     MODEL_NAMES from the endpoint's env and rolls its workers. When non-empty it
  //     re-validates every reference, and the restore carries no HuggingFace token,
  //     so a gated model fails the write outright.
  //   compliance: gated on `!== undefined`. Reads as `[]`, never null, and the
  //     server re-sorts the stored csv, which can flip the change-detection compare.
  //   templateId: only a resolved template acts on update, and echoing it re-runs
  //     template validation — which throws if that template is gone.
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
