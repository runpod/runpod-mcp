import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { capListResult, listPaginationParams } from '../pagination.js';
import {
  READ_ONLY,
  WRITE,
  DESTRUCTIVE,
  jsonErrorReply,
  type ToolRuntime,
} from './runtime.js';
import { logStreamParams, streamLogsReply } from './logs.js';
import {
  readEndpointGpuIds,
  hasGpuExclusions,
} from '../_shared/endpoint-gpu-ids.js';
import { v2AuthedGraphqlEnvironmentSkew } from '../_shared/backend.js';

// ============== ENDPOINT MANAGEMENT TOOLS ==============
// Serverless endpoint CRUD, version-aware via the backend adapter.
//   v2 (default): endpoints live at /v2/serverless with an INLINE config —
//     image + gpu.pools + workers + scaling (NO templateId).
//   v1: the legacy /endpoints model — templateId-based.
// list/get/delete route through the adapter on both versions; create/update
// branch on backend.version because the request model differs fundamentally.

// Autoscaling bounds, mirroring the v2 spec so a bad value is a clean client-side
// error instead of a server 422. `scalerValue` feeds two different union variants
// with different bounds — QUEUE_DELAY takes a float >= 0.5, REQUEST_COUNT an
// integer >= 1 — so the schema can only enforce the looser floor. The
// REQUEST_COUNT half is checked per-call by scalerValueError() below, which needs
// the resolved scaler type.
const MIN_QUEUE_DELAY = 0.5;
const MIN_REQUEST_COUNT = 1;
const MIN_IDLE_TIMEOUT = 1;
const MAX_IDLE_TIMEOUT = 3600;

// Returns a message when scalerValue is illegal for the scaler it will be sent as,
// or undefined when it is fine (including when either input is absent — the
// mapper's defaults are always in range).
function scalerValueError(
  scalerType: 'QUEUE_DELAY' | 'REQUEST_COUNT' | undefined,
  scalerValue: number | undefined
): string | undefined {
  if (scalerType !== 'REQUEST_COUNT' || scalerValue === undefined) return;
  if (!Number.isInteger(scalerValue) || scalerValue < MIN_REQUEST_COUNT) {
    return `REQUEST_COUNT scales on whole in-flight requests per worker, so scalerValue must be an integer >= ${MIN_REQUEST_COUNT} (got ${scalerValue}). For a fractional target use scalerType QUEUE_DELAY, which takes seconds >= ${MIN_QUEUE_DELAY}.`;
  }
  return;
}

export function registerEndpointTools(
  server: McpServer,
  rt: ToolRuntime
): void {
  const { jsonReply, callRestUrl, backendFor, graphqlAuthed } = rt;

  // List Endpoints — v1 supports includeTemplate/includeWorkers query params;
  // v2 (GET /v2/serverless) declares none, so we only build the query under v1.
  server.tool(
    'list-endpoints',
    'List your Serverless endpoints, optionally expanding template and worker details (v1 only). Paginated via limit/cursor. On v2 each endpoint carries its request routing in `type` and the URLs to call it in `requestUrls`.',
    {
      ...listPaginationParams,
      includeTemplate: z
        .boolean()
        .optional()
        .describe('Include template information (v1 only)'),
      includeWorkers: z
        .boolean()
        .optional()
        .describe('Include information about workers (v1 only)'),
    },
    { title: 'List endpoints', ...READ_ONLY },
    async (params) => {
      const backend = backendFor('endpoints');

      let queryString = '';
      if (backend.version === 'v1') {
        const queryParams = new URLSearchParams();
        if (params.includeTemplate)
          queryParams.append(
            'includeTemplate',
            params.includeTemplate.toString()
          );
        if (params.includeWorkers)
          queryParams.append(
            'includeWorkers',
            params.includeWorkers.toString()
          );
        queryString = queryParams.toString()
          ? `?${queryParams.toString()}`
          : '';
      }

      const result = await callRestUrl(
        `${backend.base}${backend.list}${queryString}`
      );

      return capListResult(backend.unwrap(result), {
        limit: params.limit,
        cursor: params.cursor,
      });
    }
  );

  // Get Endpoint Details
  server.tool(
    'get-endpoint',
    "Get one Serverless endpoint by id, optionally expanding template and worker details (v1 only). On v2 the reply carries `type` (queue-based vs load-balancing routing) and `requestUrls` — the run/runsync/status/... URLs for a queue endpoint, or the base + health URLs for a load-balancing one. Read those rather than constructing endpoint URLs by hand. NOTE: the `gpu.pools` list does NOT show GPU SKU exclusions; pass includeGpuIds to see an endpoint's true GPU selection.",
    {
      endpointId: z.string().describe('ID of the endpoint to retrieve'),
      includeTemplate: z
        .boolean()
        .optional()
        .describe('Include template information (v1 only)'),
      includeWorkers: z
        .boolean()
        .optional()
        .describe('Include information about workers (v1 only)'),
      includeGpuIds: z
        .boolean()
        .optional()
        .describe(
          "Add the authoritative `gpuIds` string (pools plus any '-<GPU type id>' SKU exclusions) via GraphQL (v2 only). The REST `gpu.pools` field cannot represent exclusions, so this is the only way to read an endpoint's real GPU selection without writing to it. Costs one extra request."
        ),
    },
    { title: 'Get endpoint', ...READ_ONLY },
    async (params) => {
      const backend = backendFor('endpoints');

      let queryString = '';
      if (backend.version === 'v1') {
        const queryParams = new URLSearchParams();
        if (params.includeTemplate)
          queryParams.append(
            'includeTemplate',
            params.includeTemplate.toString()
          );
        if (params.includeWorkers)
          queryParams.append(
            'includeWorkers',
            params.includeWorkers.toString()
          );
        queryString = queryParams.toString()
          ? `?${queryParams.toString()}`
          : '';
      }

      const result = await callRestUrl(
        `${backend.base}${backend.get!(params.endpointId)}${queryString}`
      );

      if (!params.includeGpuIds) return jsonReply(result);

      // v2 only: the whole point is that v2's `gpu.pools` cannot express exclusions.
      // v1 has no `gpu.pools`, and merging a `gpuIds` key into a v1 payload could
      // shadow a field of a different type. Say so rather than dropping the flag
      // silently — a caller who asked for gpuIds and got a reply without them
      // should not have to guess why.
      if (backend.version !== 'v2') {
        return jsonReply({
          ...(result as Record<string, unknown>),
          _gpuIdsError:
            'includeGpuIds applies to v2 only; this request used the v1 REST API, whose payload has no gpu.pools field to disambiguate.',
        });
      }

      if (v2AuthedGraphqlEnvironmentSkew(process.env)) {
        return jsonReply({
          ...(result as Record<string, unknown>),
          _gpuIdsError:
            'gpuIds enrichment was not attempted because the v2 REST and authenticated GraphQL environment overrides do not form a matched pair. Override both RUNPOD_REST_V2_API_URL and RUNPOD_AUTHED_GRAPHQL_URL for the same environment, or leave both at their production defaults.',
        });
      }

      // Opt-in because it is a second request against a different API. Reported as
      // an error string rather than throwing: the REST read succeeded, and losing
      // the whole reply because the GraphQL enrichment failed would be worse.
      const endpointGpuIds = await readEndpointGpuIds(
        graphqlAuthed,
        params.endpointId
      ).catch((error: unknown) => {
        return error instanceof Error ? error.message : String(error);
      });
      if (typeof endpointGpuIds === 'string') {
        return jsonReply({
          ...(result as Record<string, unknown>),
          _gpuIdsError: `Could not read gpuIds: ${endpointGpuIds}`,
        });
      }
      if (endpointGpuIds === null) {
        // Not "missing from a list" — the query fetches this endpoint by id, and an
        // unknown or invisible id makes the resolver throw into the branch above.
        // A null lands here only when `myself` itself is null, i.e. the credential
        // carries no user identity on the GraphQL API.
        return jsonReply({
          ...(result as Record<string, unknown>),
          _gpuIdsError: `gpuIds could not be read: the GraphQL API returned no user for this credential, so endpoint "${params.endpointId}" was not visible there.`,
        });
      }
      return jsonReply({
        ...(result as Record<string, unknown>),
        gpuIds: endpointGpuIds.gpuIds,
        gpuIdsHasExclusions: hasGpuExclusions(endpointGpuIds.gpuIds),
      });
    }
  );

  // Create Endpoint — model differs by version:
  //   v2: inline config. Requires imageName + gpuPoolIds (gpu.pools minItems 1).
  //   v1: templateId-based.
  server.tool(
    'create-endpoint',
    'Create a Serverless endpoint. On v2 (default), pass an inline config: imageName + gpuPoolIds (GPU pool names from list-gpu-types — the `pool` field, e.g. AMPERE_80/ADA_24) plus optional workers/scaling/disk/env. On v1, pass a templateId instead. Worker min/max set autoscaling bounds (min 0 = scale to zero). Use endpointType to pick queue-based (default) or load-balancing request routing; the response `requestUrls` carries the URLs to call the endpoint with.',
    {
      name: z.string().optional().describe('Name for the endpoint'),
      // --- v2 inline-config fields ---
      imageName: z
        .string()
        .optional()
        .describe('Docker image (v2). Required on v2 instead of a templateId.'),
      endpointType: z
        .enum(['QUEUE', 'LOAD_BALANCER'])
        .optional()
        .describe(
          'How requests reach the workers (v2). QUEUE (default) = submit jobs through the managed queue (run/runsync/status/...). LOAD_BALANCER = send HTTP requests straight to worker-defined paths, and forces scalerType REQUEST_COUNT. Fixed at creation — update-endpoint cannot change it.'
        ),
      gpuPoolIds: z
        .array(z.string())
        .optional()
        .describe(
          'GPU pool names (v2, required). The `pool` field from list-gpu-types, e.g. ["AMPERE_80"]. NOT GPU type ids.'
        ),
      gpuCount: z.number().optional().describe('GPUs per worker (v2)'),
      args: z.string().optional().describe('Container start command/args (v2)'),
      containerDiskInGb: z
        .number()
        .optional()
        .describe('Container disk size in GB (v2)'),
      ports: z
        .array(z.string())
        .optional()
        .describe("Ports to expose (v2), e.g. ['8000/http']"),
      env: z
        .record(z.string())
        .optional()
        .describe('Environment variables (v2)'),
      containerRegistryAuthId: z
        .string()
        .optional()
        .describe('Container registry auth id for a private image (v2)'),
      networkVolumeIds: z
        .array(z.string())
        .optional()
        .describe('Network volume ids to attach (v2)'),
      executionTimeoutMs: z
        .number()
        .optional()
        .describe('Per-job execution timeout in ms (v2)'),
      flashboot: z
        .enum(['OFF', 'FLASHBOOT', 'PRIORITY_FLASHBOOT'])
        .optional()
        .describe('FlashBoot mode (v2)'),
      // --- v1 template-based fields ---
      templateId: z
        .string()
        .optional()
        .describe('Template ID (v1). Required on v1.'),
      computeType: z
        .enum(['GPU', 'CPU'])
        .optional()
        .describe('GPU or CPU endpoint (v1)'),
      gpuTypeIds: z
        .array(z.string())
        .optional()
        .describe('List of acceptable GPU types (v1)'),
      // --- shared autoscaling fields ---
      workersMin: z.number().optional().describe('Minimum number of workers'),
      workersMax: z.number().optional().describe('Maximum number of workers'),
      scalerType: z
        .enum(['QUEUE_DELAY', 'REQUEST_COUNT'])
        .optional()
        .describe(
          'Autoscaler signal. QUEUE_DELAY scales on how long requests wait in the queue (queue endpoints only); REQUEST_COUNT scales on in-flight requests per worker. Defaults to QUEUE_DELAY for QUEUE endpoints and REQUEST_COUNT for LOAD_BALANCER ones.'
        ),
      scalerValue: z
        .number()
        .min(MIN_QUEUE_DELAY)
        .optional()
        .describe(
          'Autoscaler target for the chosen scalerType — seconds of queue delay (min 0.5) or in-flight requests per worker (integer, min 1). Defaults to 4.'
        ),
      idleTimeout: z
        .number()
        .int()
        .min(MIN_IDLE_TIMEOUT)
        .max(MAX_IDLE_TIMEOUT)
        .optional()
        .describe(
          'Idle timeout in seconds before scaling a worker down (1-3600). Does not apply to QUEUE endpoints scaling on REQUEST_COUNT.'
        ),
      dataCenterIds: z
        .array(z.string())
        .optional()
        .describe('List of preferred data centers'),
    },
    { title: 'Create endpoint', ...WRITE },
    async (params) => {
      const backend = backendFor('endpoints');

      if (backend.version === 'v2') {
        // Guard the v2-required fields before calling, so the caller gets a
        // clean 400 rather than a raw 422 from the API (mirrors create-pod).
        // v2 CreateEndpointRequest marks `name` required too — guard it so an
        // omitted name is a clean 400, not an opaque 422.
        if (!params.name) {
          return jsonReply({
            error: 'On the v2 REST API, create-endpoint requires a name.',
            status: 400,
          });
        }
        if (!params.imageName) {
          return jsonReply({
            error:
              'On the v2 REST API, create-endpoint needs an imageName (v2 endpoints are image-based, not template-based). To use a templateId, set RUNPOD_REST_VERSION=v1.',
            status: 400,
          });
        }
        if (!params.gpuPoolIds?.length) {
          return jsonReply({
            error:
              'create-endpoint needs gpuPoolIds on v2 (GPU pool names from list-gpu-types — the `pool` field, e.g. ["AMPERE_80"]).',
            status: 400,
          });
        }
        // A load balancer has no request queue, so there is no queue delay to
        // scale on. The API rejects this too, but catching it here costs a round
        // trip less and names the reason directly.
        if (
          params.endpointType === 'LOAD_BALANCER' &&
          params.scalerType === 'QUEUE_DELAY'
        ) {
          return jsonReply({
            error:
              'LOAD_BALANCER endpoints have no request queue, so they cannot scale on QUEUE_DELAY. Use scalerType REQUEST_COUNT (the default for this endpoint type), or create a QUEUE endpoint instead.',
            status: 400,
          });
        }
        // REQUEST_COUNT is the default scaler for a load balancer, so the value
        // has to be checked against the scaler that will actually be sent, not
        // just the one the caller named.
        const scalerError = scalerValueError(
          params.scalerType ??
            (params.endpointType === 'LOAD_BALANCER'
              ? 'REQUEST_COUNT'
              : undefined),
          params.scalerValue
        );
        if (scalerError) {
          return jsonReply({ error: scalerError, status: 400 });
        }
        // v1-only fields would be dropped on the floor here: mapEndpointCreateToV2 reads
        // only V2EndpointParams, which declares neither, so they never reach the body.
        // computeType:'CPU' is the expensive one — v2 cannot create a CPU endpoint at
        // all (the spec marks `cpu` read-only: "CPU create/update is not yet
        // supported"), so the request silently produced a GPU endpoint billed at GPU
        // rates. gpuTypeIds silently widened an SKU pin to the whole pool.
        //
        // update-endpoint already 400s for a lone gpuCount and an empty gpuPoolIds on
        // exactly this reasoning; create-endpoint applied the opposite standard to the
        // same class of request.
        const v1OnlyFields = (['computeType', 'gpuTypeIds'] as const).filter(
          (k) => params[k] !== undefined
        );
        if (v1OnlyFields.length > 0) {
          return jsonReply({
            error: `create-endpoint cannot apply ${v1OnlyFields.join(' or ')} on the v2 REST API — the field does not exist there, so it would be silently ignored and the endpoint created without it.${
              params.computeType === 'CPU'
                ? ' v2 cannot create CPU endpoints at all (the API exposes CPU config as read-only), so this would have created a GPU endpoint.'
                : ''
            }${
              params.gpuTypeIds
                ? ' To allow specific GPUs on v2, pass gpuPoolIds; to pin an individual SKU, create the endpoint then use set-endpoint-gpus.'
                : ''
            } Set RUNPOD_REST_VERSION=v1 to use these fields.`,
            status: 400,
          });
        }
        const body = backend.mapCreate(params) as Record<string, unknown>;
        const result = await callRestUrl(
          `${backend.base}${backend.list}`,
          'POST',
          body
        );
        return jsonReply(result);
      }

      // v1: legacy /endpoints, templateId-based. Guard the v1-required field.
      if (!params.templateId) {
        return jsonReply({
          error:
            'On the v1 REST API, create-endpoint needs a templateId. (On v2 — the default — pass imageName + gpuPoolIds instead.)',
          status: 400,
        });
      }
      // Send ONLY v1-relevant fields — the tool schema is a v1+v2 union, so
      // forwarding the raw params would also send v2-only keys (gpuPoolIds,
      // flashboot, networkVolumeIds, …) to the v1 API. Harmless today (v1 ignores
      // unknowns) but imprecise; filter explicitly.
      const v1Body: Record<string, unknown> = {};
      for (const k of [
        'templateId',
        'name',
        'computeType',
        'gpuTypeIds',
        'gpuCount',
        'workersMin',
        'workersMax',
        'dataCenterIds',
      ] as const) {
        if (params[k] !== undefined) v1Body[k] = params[k];
      }
      const result = await callRestUrl(
        `${backend.base}${backend.list}`,
        'POST',
        v1Body
      );
      return jsonReply(result);
    }
  );

  // Update Endpoint — only provided fields change. v2 maps to the nested
  // /v2/serverless body; v1 passes the flat fields through.
  server.tool(
    'update-endpoint',
    "Update a Serverless endpoint's config. On v2 you can change image/disk/env/ports/registry/workers/scaling/networkVolumes/timeout/flashboot; on v1, scaling fields (worker min/max, idle timeout, scaler type/value, name). Only provided fields change on v1. Safety requirement on v2: the current REST facade rebuilds gpuIds during every PATCH, so every call must include a non-empty gpuPoolIds plus replaceGpuSelection:true and intentionally replaces the endpoint's complete GPU selection. Do not use this tool for a v2 endpoint with SKU exclusions that must be preserved; no safe unrelated PATCH is available until the REST facade is fixed. An endpoint's request routing (queue vs load balancer) is fixed at creation and cannot be changed here — recreate the endpoint instead.",
    {
      endpointId: z.string().describe('ID of the endpoint to update'),
      name: z.string().optional().describe('New name for the endpoint'),
      workersMin: z
        .number()
        .optional()
        .describe('New minimum number of workers'),
      workersMax: z
        .number()
        .optional()
        .describe('New maximum number of workers'),
      idleTimeout: z
        .number()
        .int()
        .min(MIN_IDLE_TIMEOUT)
        .max(MAX_IDLE_TIMEOUT)
        .optional()
        .describe(
          'New idle timeout in seconds (1-3600). Does not apply to queue endpoints scaling on REQUEST_COUNT.'
        ),
      scalerType: z
        .enum(['QUEUE_DELAY', 'REQUEST_COUNT'])
        .optional()
        .describe(
          'New autoscaler signal. Switchable on queue endpoints; load-balancing endpoints only accept REQUEST_COUNT.'
        ),
      scalerValue: z
        .number()
        .min(MIN_QUEUE_DELAY)
        .optional()
        .describe(
          "New autoscaler target — seconds of queue delay (min 0.5) or in-flight requests per worker (integer, min 1). Applies to the endpoint's current scalerType unless you also pass a new one."
        ),
      // --- v2-only inline-config fields ---
      imageName: z.string().optional().describe('New Docker image (v2)'),
      gpuPoolIds: z
        .array(z.string())
        .optional()
        .describe(
          'Required for every v2 update while the REST facade is lossy. New GPU pool names, e.g. ["AMPERE_80"]; explicitly replaces the complete GPU selection and cannot carry existing "-<GPU type id>" SKU exclusions forward.'
        ),
      replaceGpuSelection: z
        .literal(true)
        .optional()
        .describe(
          'Required as true with gpuPoolIds on v2. Explicit acknowledgement that this call replaces the complete GPU selection and drops any existing SKU exclusions.'
        ),
      gpuCount: z
        .number()
        .optional()
        .describe(
          'New GPUs per worker (v2). Must be sent together with gpuPoolIds — the v2 gpu object requires pools, so a count on its own cannot be expressed. To change only the count, use set-endpoint-gpus.'
        ),
      args: z.string().optional().describe('New container args (v2)'),
      containerDiskInGb: z
        .number()
        .optional()
        .describe('New container disk size in GB (v2)'),
      ports: z.array(z.string()).optional().describe('New ports (v2)'),
      env: z
        .record(z.string())
        .optional()
        .describe('New environment variables (v2)'),
      containerRegistryAuthId: z
        .string()
        .optional()
        .describe('New container registry auth id (v2)'),
      networkVolumeIds: z
        .array(z.string())
        .optional()
        .describe('New network volume ids (v2)'),
      executionTimeoutMs: z
        .number()
        .optional()
        .describe('New per-job execution timeout in ms (v2)'),
      flashboot: z
        .enum(['OFF', 'FLASHBOOT', 'PRIORITY_FLASHBOOT'])
        .optional()
        .describe('New FlashBoot mode (v2)'),
    },
    { title: 'Update endpoint', ...WRITE, idempotentHint: true },
    async (params) => {
      const { endpointId, replaceGpuSelection, ...updateParams } = params;
      const backend = backendFor('endpoints');
      const url = `${backend.base}${backend.get!(endpointId)}`;

      if (backend.version !== 'v2') {
        const body = backend.mapUpdate(updateParams) as Record<string, unknown>;
        return jsonReply(await callRestUrl(url, 'PATCH', body));
      }

      // The current v2 facade rebuilds gpuIds from its lossy `{pools, count}`
      // representation during every PATCH, including requests that omit `gpu`.
      // A GraphQL pre-read cannot make a later REST PATCH atomic: another writer
      // can add an exclusion between those calls. Therefore an unrelated v2 PATCH
      // is never issued. Requiring pools makes the GPU replacement explicit and
      // puts it in the same request as the other changes.
      if (!updateParams.gpuPoolIds?.length) {
        if (updateParams.gpuCount !== undefined) {
          return jsonErrorReply({
            error:
              'gpuCount alone cannot be sent on v2: the gpu object requires pools. Send a non-empty gpuPoolIds together with gpuCount.',
            status: 400,
          });
        }
        if (updateParams.gpuPoolIds !== undefined) {
          return jsonErrorReply({
            error:
              'gpuPoolIds cannot be empty on v2: every v2 update currently requires a non-empty pool list that explicitly replaces the GPU selection.',
            status: 400,
          });
        }
        return jsonErrorReply({
          error:
            'Update not applied: every v2 PATCH currently rebuilds the endpoint GPU selection from a representation that cannot carry SKU exclusions. To proceed, pass a non-empty gpuPoolIds and intentionally replace the complete GPU selection. If this endpoint has "-<GPU type id>" exclusions that must be preserved, no safe v2 update is available through this tool until the REST facade is fixed.',
          status: 409,
        });
      }
      if (replaceGpuSelection !== true) {
        return jsonErrorReply({
          error:
            'Update not applied: set replaceGpuSelection:true to acknowledge that this v2 PATCH replaces the complete GPU selection and cannot preserve existing SKU exclusions.',
          status: 409,
        });
      }

      // `scaling` is a union keyed on the scaler type, so a bare "change the target
      // to N" has no expressible form without knowing which scaler is in effect.
      // Rather than reject the call, read the endpoint's current scaler and keep
      // it — which is what such a request has always meant.
      let scalerType = updateParams.scalerType;
      if (scalerType === undefined && updateParams.scalerValue !== undefined) {
        const current = (await callRestUrl(url)) as
          | { scaling?: { type?: string } }
          | undefined;
        scalerType =
          current?.scaling?.type === 'REQUEST_COUNT'
            ? 'REQUEST_COUNT'
            : 'QUEUE_DELAY';
      }

      // Checked against the resolved scaler, so `scalerValue` alone on an endpoint
      // already scaling on REQUEST_COUNT is still held to the integer bound.
      const scalerError = scalerValueError(
        scalerType,
        updateParams.scalerValue
      );
      if (scalerError) {
        return jsonReply({ error: scalerError, status: 400 });
      }

      const body = backend.mapUpdate({
        ...updateParams,
        scalerType,
      }) as Record<string, unknown>;
      return jsonReply(await callRestUrl(url, 'PATCH', body));
    }
  );

  // Delete Endpoint
  server.tool(
    'delete-endpoint',
    'Permanently delete a Serverless endpoint. This cannot be undone.',
    {
      endpointId: z.string().describe('ID of the endpoint to delete'),
    },
    { title: 'Delete endpoint', ...DESTRUCTIVE },
    async (params) => {
      const backend = backendFor('endpoints');
      const result = await callRestUrl(
        `${backend.base}${backend.get!(params.endpointId)}`,
        'DELETE'
      );
      return jsonReply(result);
    }
  );

  // List Endpoint Releases — GET /v2/serverless/{id}/releases. v2-only; v1 has no
  // equivalent, hence the 501 notice.
  server.tool(
    'list-endpoint-releases',
    "List a Serverless endpoint's release history and current rollout status (workers on the latest version). v2-only — returns a 501 notice on the v1 API. Paginated via limit/cursor.",
    {
      ...listPaginationParams,
      endpointId: z
        .string()
        .describe('ID of the Serverless endpoint whose releases to list'),
    },
    { title: 'List endpoint releases', ...READ_ONLY },
    async (params) => {
      const backend = backendFor('endpoints');
      if (backend.version === 'v1') {
        return jsonReply({
          error:
            'list-endpoint-releases is only available on the v2 REST API. Set RUNPOD_REST_VERSION=v2.',
          status: 501,
        });
      }
      const raw = (await callRestUrl(
        `${backend.base}/serverless/${params.endpointId}/releases`
      )) as Record<string, unknown> | undefined;
      const releases = Array.isArray(raw?.releases) ? raw!.releases : [];
      return capListResult(
        releases,
        { limit: params.limit, cursor: params.cursor },
        { rollout: raw?.rollout, endpointVersion: raw?.endpointVersion }
      );
    }
  );

  // List Endpoint Workers (v2-only — GET /v2/serverless/{id}/workers)
  // Returns the workers backing an endpoint plus an aggregate summary. v2-only:
  // returns a 501 notice on the v1 API. The workers array is capped via
  // limit/cursor; the `summary` and `endpointVersion` are preserved alongside.
  server.tool(
    'list-endpoint-workers',
    'List the workers backing a Serverless endpoint, with their status and an aggregate summary. v2-only — returns a 501 notice on the v1 API. An UNHEALTHY worker usually means the container is crash-looping (repeated starts that exit before the handler runs) — jobs on the endpoint will sit IN_QUEUE even though this is a worker failure, not a capacity shortage; inspect it with stream-worker-logs. Zero workers while jobs queue means the endpoint is waiting for GPU capacity. Paginated via limit/cursor.',
    {
      ...listPaginationParams,
      endpointId: z
        .string()
        .describe('ID of the Serverless endpoint whose workers to list'),
    },
    { title: 'List endpoint workers', ...READ_ONLY },
    async (params) => {
      const backend = backendFor('workers');
      if (backend.version === 'v1') {
        return jsonReply({
          error:
            'list-endpoint-workers is only available on the v2 REST API. Set RUNPOD_REST_VERSION=v2 (on v1, use get-endpoint with includeWorkers).',
          status: 501,
        });
      }
      const raw = (await callRestUrl(
        `${backend.base}/serverless/${params.endpointId}/workers`
      )) as Record<string, unknown> | undefined;
      return capListResult(
        backend.unwrap(raw),
        { limit: params.limit, cursor: params.cursor },
        { summary: raw?.summary, endpointVersion: raw?.endpointVersion }
      );
    }
  );

  // Stream Worker Logs (v2-only — GET /v2/serverless/{id}/workers/{workerId}/logs).
  // Same feature as stream-pod-logs; see streamLogsReply.
  server.tool(
    'stream-worker-logs',
    "Fetch a bounded snapshot of a serverless worker's live logs (container and/or system) via Server-Sent Events. v2-only — returns a 501 notice on the v1 API. Get the workerId from list-endpoint-workers. Use this to diagnose UNHEALTHY workers: repeated `start container` system lines with no container output is the crash-loop signature (the container exits before the handler runs). Reads for up to maxWaitMs (default 5s) and returns the collected log lines; use `tail` to backfill recent lines first. Large output is truncated (see the `truncated` flag).",
    {
      endpointId: z
        .string()
        .describe('ID of the Serverless endpoint the worker belongs to'),
      workerId: z
        .string()
        .describe(
          'ID of the worker whose logs to stream (from list-endpoint-workers)'
        ),
      ...logStreamParams,
    },
    { title: 'Stream worker logs', ...READ_ONLY },
    (params) =>
      streamLogsReply(
        rt,
        {
          name: 'stream-worker-logs',
          resource: 'workers',
          logsUrl: (backend) =>
            `${backend.base}/serverless/${encodeURIComponent(params.endpointId)}/workers/${encodeURIComponent(params.workerId)}/logs`,
        },
        params
      )
  );
}
