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
//      mentions GPUs. Re-asserting the pre-update gpuIds afterwards restores them,
//      and is a no-op when nothing was dropped.
//
// saveEndpoint is NOT a sparse update: an id+name+gpuIds-only call was measured
// resetting workersMax 7→3, idleTimeout 42→10 and scalerValue 9→4 to server
// defaults. So every field read has to be echoed back on write. That is why the
// snapshot query and the input builder live together here rather than being
// reimplemented per call site.

import type { ToolRuntime } from '../tools/runtime.js';

export interface EndpointSnapshot {
  id: string;
  name: string;
  gpuIds: string;
  gpuCount: number;
  workersMin: number;
  workersMax: number;
  idleTimeout: number;
  scalerType: string;
  scalerValue: number;
  executionTimeoutMs: number;
  flashBootType: string;
  type: string;
  locations: string | null;
  templateId: string | null;
  // A comma-separated String on read AND write, not a list.
  allowedCudaVersions: string | null;
  minCudaVersion: string | null;
  // A [Compliance] ENUM on input, not [String] — the server rejects 'gdpr' and
  // suggests 'GDPR'. Read values are already enum names: pass back verbatim.
  compliance: string[] | null;
  modelReferences: string[] | null;
  networkVolumeIds: Array<{
    networkVolumeId: string;
    dataCenterId: string | null;
  }> | null;
}

interface MyEndpointsResponse {
  myself: { endpoints: EndpointSnapshot[] };
}

const SNAPSHOT_QUERY = `
  query {
    myself {
      endpoints {
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
        flashBootType
        type
        locations
        templateId
        allowedCudaVersions
        minCudaVersion
        compliance
        modelReferences
        networkVolumeIds {
          networkVolumeId
          dataCenterId
        }
      }
    }
  }
`;

/**
 * Reads one endpoint's full GraphQL settings. Returns null when the id is not in
 * the caller's account — callers decide whether that is an error or a skip.
 */
export async function readEndpointSnapshot(
  graphqlAuthed: ToolRuntime['graphqlAuthed'],
  endpointId: string
): Promise<EndpointSnapshot | null> {
  const data = await graphqlAuthed<MyEndpointsResponse>(SNAPSHOT_QUERY);
  return data.myself.endpoints.find((e) => e.id === endpointId) ?? null;
}

/**
 * True when a gpuIds string carries at least one SKU exclusion, i.e. an entry
 * beginning with '-'. Those are the entries v2 REST cannot represent.
 */
export function hasGpuExclusions(gpuIds: string | null | undefined): boolean {
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
    flashBootType: snapshot.flashBootType,
    type: snapshot.type,
    locations: snapshot.locations,
    networkVolumeIds:
      snapshot.networkVolumeIds && snapshot.networkVolumeIds.length > 0
        ? // Drop dataCenterId: NetworkVolumeIdsInput takes networkVolumeId ONLY,
          // and the read shape is rejected outright.
          snapshot.networkVolumeIds.map((v) => ({
            networkVolumeId: v.networkVolumeId,
          }))
        : null,
  };

  // Echoed only when set. Omitting a field that currently reads null resets it to
  // a default that is already null, while an explicit null risks a server-side
  // type rejection for no gain.
  for (const [key, value] of Object.entries({
    templateId: snapshot.templateId,
    allowedCudaVersions:
      overrides.allowedCudaVersions ?? snapshot.allowedCudaVersions,
    minCudaVersion: overrides.minCudaVersion ?? snapshot.minCudaVersion,
    compliance: snapshot.compliance,
    modelReferences: snapshot.modelReferences,
  })) {
    if (value !== null && value !== undefined) input[key] = value;
  }

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
