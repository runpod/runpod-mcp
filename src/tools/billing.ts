import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { capListResult, listPaginationParams } from '../pagination.js';
import { READ_ONLY, type ToolRuntime } from './runtime.js';

// ============== BILLING TOOLS (v2-only) ==============
// Read-only, time-bucketed spend history. v2-only — returns a 501 notice on the
// v1 API. The records array can be large (buckets × resources), so it is capped
// via limit/cursor; the aggregate `metadata` is preserved alongside the page.

// scope → URL sub-path. 'all' is the aggregate /v2/billing; the rest are
// per-resource breakdowns. Values match the v2 spec sub-paths exactly
// (note: 'networkvolumes' has no hyphen here, unlike the /v2/network-volumes
// resource path).
const BILLING_SCOPE_PATH: Record<string, string> = {
  all: '/billing',
  pods: '/billing/pods',
  serverless: '/billing/serverless',
  endpoints: '/billing/endpoints',
  networkvolumes: '/billing/networkvolumes',
  clusters: '/billing/clusters',
};

export function registerBillingTools(server: McpServer, rt: ToolRuntime): void {
  const { jsonReply, callRestUrl, backendFor } = rt;

  server.tool(
    'get-billing',
    'Get time-bucketed Runpod spend history, either aggregated across all resources or broken down by resource type (pods, serverless, endpoints, network volumes, clusters). v2-only — returns a 501 notice on the v1 API. Records are capped via limit/cursor; narrow the window with startTime/endTime or lastN.',
    {
      ...listPaginationParams,
      scope: z
        .enum([
          'all',
          'pods',
          'serverless',
          'endpoints',
          'networkvolumes',
          'clusters',
        ])
        .optional()
        .describe(
          'Which billing breakdown to fetch. "all" (default) is the aggregate across every resource.'
        ),
      startTime: z
        .string()
        .optional()
        .describe(
          'Start of the period (RFC 3339, e.g. 2026-05-01T00:00:00Z). Defaults to 30 days ago. Mutually exclusive with lastN.'
        ),
      endTime: z
        .string()
        .optional()
        .describe(
          'End of the period (RFC 3339), exclusive. Defaults to now. Mutually exclusive with lastN.'
        ),
      bucketSize: z
        .enum(['hour', 'day', 'week', 'month', 'year'])
        .optional()
        .describe('Length of each time bucket. Defaults to day.'),
      lastN: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Return the last N buckets of bucketSize, ending with the current one. Mutually exclusive with startTime/endTime.'
        ),
    },
    { title: 'Get billing history', ...READ_ONLY },
    async (params) => {
      const backend = backendFor('billing');
      if (backend.version === 'v1') {
        return jsonReply({
          error:
            'get-billing is only available on the v2 REST API. Set RUNPOD_REST_VERSION=v2.',
          status: 501,
        });
      }

      const subPath = BILLING_SCOPE_PATH[params.scope ?? 'all'];
      const query = new URLSearchParams();
      if (params.startTime) query.set('startTime', params.startTime);
      if (params.endTime) query.set('endTime', params.endTime);
      if (params.bucketSize) query.set('bucketSize', params.bucketSize);
      // lastN is mutually exclusive with startTime/endTime; if a window was
      // given, ignore lastN so we never forward a contradictory request.
      if (
        params.lastN !== undefined &&
        !params.startTime &&
        !params.endTime
      )
        query.set('lastN', String(params.lastN));
      const qs = query.toString() ? `?${query.toString()}` : '';

      const raw = (await callRestUrl(`${backend.base}${subPath}${qs}`)) as
        | Record<string, unknown>
        | undefined;
      // Cap the (potentially large) records array but keep the aggregate
      // `metadata` alongside the page so totals aren't lost to truncation.
      return capListResult(
        backend.unwrap(raw),
        { limit: params.limit, cursor: params.cursor },
        { metadata: raw?.metadata }
      );
    }
  );
}
