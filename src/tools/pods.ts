import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { capListResult, listPaginationParams } from '../pagination.js';
import { HttpError } from '../_shared/http.js';
import { restV1Base, restV2Base } from '../_shared/backend.js';
import {
  applySshPublicKey,
  normalizeSshPublicKey,
  podBodyFromTemplate,
} from '../_shared/mappers.js';
import { READ_ONLY, WRITE, DESTRUCTIVE, type ToolRuntime } from './runtime.js';
import { logStreamParams, streamLogsReply } from './logs.js';

// ============== POD MANAGEMENT TOOLS ==============

export function registerPodTools(server: McpServer, rt: ToolRuntime): void {
  const { jsonReply, callRestUrl, backendFor, podAction, env } = rt;

  // List Pods
  server.tool(
    'list-pods',
    'List your pods (running and stopped) with optional filters — compute type, GPU type, data center, name — plus machine/network-volume expansion. Paginated via limit/cursor.',
    {
      ...listPaginationParams,
      computeType: z
        .enum(['GPU', 'CPU'])
        .optional()
        .describe('Filter to only GPU or only CPU Pods'),
      gpuTypeId: z
        .array(z.string())
        .optional()
        .describe('Filter to Pods with any of the listed GPU types'),
      dataCenterId: z
        .array(z.string())
        .optional()
        .describe('Filter to Pods in any of the provided data centers'),
      name: z
        .string()
        .optional()
        .describe('Filter to Pods with the provided name'),
      includeMachine: z
        .boolean()
        .optional()
        .describe('Include information about the machine'),
      includeNetworkVolume: z
        .boolean()
        .optional()
        .describe('Include information about attached network volumes'),
    },
    { title: 'List pods', ...READ_ONLY },
    async (params) => {
      const backend = backendFor('pods');

      // v1 supports query-param filters; v2 has none (the spec declares no query
      // params and ignores them), so we only build the query string under v1.
      let queryString = '';
      if (backend.version === 'v1') {
        const queryParams = new URLSearchParams();
        if (params.computeType)
          queryParams.append('computeType', params.computeType);
        if (params.gpuTypeId)
          params.gpuTypeId.forEach((type) =>
            queryParams.append('gpuTypeId', type)
          );
        if (params.dataCenterId)
          params.dataCenterId.forEach((dc) =>
            queryParams.append('dataCenterId', dc)
          );
        if (params.name) queryParams.append('name', params.name);
        if (params.includeMachine)
          queryParams.append(
            'includeMachine',
            params.includeMachine.toString()
          );
        if (params.includeNetworkVolume)
          queryParams.append(
            'includeNetworkVolume',
            params.includeNetworkVolume.toString()
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

  // Get Pod Details
  server.tool(
    'get-pod',
    'Get full details for one pod by id, optionally expanding machine and attached network-volume info.',
    {
      podId: z.string().describe('ID of the pod to retrieve'),
      includeMachine: z
        .boolean()
        .optional()
        .describe('Include information about the machine'),
      includeNetworkVolume: z
        .boolean()
        .optional()
        .describe('Include information about attached network volumes'),
    },
    { title: 'Get pod', ...READ_ONLY },
    async (params) => {
      const backend = backendFor('pods');

      // v1-only expansion query params (v2 has no query params on get).
      let queryString = '';
      if (backend.version === 'v1') {
        const queryParams = new URLSearchParams();
        if (params.includeMachine)
          queryParams.append(
            'includeMachine',
            params.includeMachine.toString()
          );
        if (params.includeNetworkVolume)
          queryParams.append(
            'includeNetworkVolume',
            params.includeNetworkVolume.toString()
          );
        queryString = queryParams.toString()
          ? `?${queryParams.toString()}`
          : '';
      }

      const result = await callRestUrl(
        `${backend.base}${backend.get!(params.podId)}${queryString}`
      );
      return jsonReply(result);
    }
  );

  // Create Pod
  server.tool(
    'create-pod',
    'Create a new GPU/CPU pod on Runpod. Pass gpuTypeIds for a GPU pod, or computeType:"CPU" for a CPU pod (CPU pods are served by the v1 API for now). Pass either imageName or templateId (templateId deploys from an existing template — its name, image, start command, ports, env, disk, volume, and registry credential are used as defaults, and any field you also pass explicitly replaces the template value for that field, e.g. passing env replaces the whole env set rather than merging; pass containerRegistryAuthId to override or supply a private-image credential, or an empty string to deploy with none). To attach an existing Network Volume, pass networkVolumeId together with volumeMountPath; do not also pass volumeInGb. An explicit Network Volume replaces a persistent mount inherited from a template. For full SSH access (including SCP/SFTP/rsync), pass sshPublicKey — it sets the PUBLIC_KEY env var and exposes 22/tcp, which official Runpod images turn into a running sshd with the key authorized. If the user specifies neither an image nor a template, recommend the "Runpod Pytorch 2.8.0" image (runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404) as the default — it has the most up-to-date CUDA and PyTorch versions.',
    {
      name: z
        .string()
        .optional()
        .describe(
          'Name for the pod. Required on v2 unless deploying from a templateId (the template supplies its name as the default).'
        ),
      imageName: z
        .string()
        .optional()
        .describe('Docker image to use. Optional when templateId is provided.'),
      templateId: z
        .string()
        .optional()
        .describe(
          'Deploy from an existing template (see list-templates / get-template). The template supplies name, image, start command, ports, env, disk, volume, and registry credential as defaults; any field you also pass replaces the template value for that field (whole-field, not a merge). Override the registry credential with containerRegistryAuthId. Requires the v2 REST API. Still pass gpuTypeIds or computeType to choose the compute — a template does not pin the pod compute.'
        ),
      computeType: z
        .enum(['GPU', 'CPU'])
        .optional()
        .describe(
          "Pod type. On v2, required when not passing gpuTypeIds. 'CPU' is served by the v1 API for now (v2 has no CPU pods yet)."
        ),
      cloudType: z
        .enum(['SECURE', 'COMMUNITY'])
        .optional()
        .describe('SECURE or COMMUNITY cloud'),
      gpuTypeIds: z
        .array(z.string())
        .optional()
        .describe('List of acceptable GPU types'),
      // v2 GpuConfig.count is `integer, minimum: 1`. Without these bounds a 0,
      // a negative, or a fractional count reached the wire as-is and came back
      // as a raw 422; reject it here with a message that names the field.
      gpuCount: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Number of GPUs (minimum 1)'),
      containerDiskInGb: z
        .number()
        .optional()
        .describe('Container disk size in GB'),
      volumeInGb: z.number().optional().describe('Volume size in GB'),
      volumeMountPath: z
        .string()
        .optional()
        .describe('Path to mount the volume'),
      networkVolumeId: z
        .string()
        .min(1)
        .optional()
        .describe(
          'ID of an existing Network Volume to attach. Requires volumeMountPath and cannot be combined with volumeInGb. On a template deploy, this replaces an inherited persistent mount.'
        ),
      ports: z
        .array(z.string())
        .optional()
        .describe("Ports to expose (e.g., '8888/http', '22/tcp')"),
      env: z.record(z.string()).optional().describe('Environment variables'),
      sshPublicKey: z
        .string()
        .optional()
        .describe(
          'SSH PUBLIC key(s) to authorize on the pod — the CONTENTS of your ~/.ssh/<key>.pub file, i.e. a literal "ssh-ed25519 AAAAC3Nza… you@host" line, NOT a path to the file, a fingerprint, or the private key; newline-separate multiple keys. Merges the key into the PUBLIC_KEY env var and ensures 22/tcp is exposed, enabling full SSH (SCP/SFTP/rsync) on any image that honors the PUBLIC_KEY convention — all runpod/* official images do. Extends template ports/env rather than replacing them.'
        ),
      containerRegistryAuthId: z
        .string()
        .optional()
        .describe(
          'Container registry credential ID for pulling a private image (see list-container-registry-auths). When deploying from a templateId, this overrides the credential the template carries; pass an empty string to deploy with NO credential (clears a template’s inherited registry).'
        ),
      dataCenterIds: z
        .array(z.string())
        .optional()
        .describe('List of data centers'),
    },
    { title: 'Create pod', ...WRITE },
    async (params) => {
      const backend = backendFor('pods');

      // sshPublicKey is an MCP-side convenience, not an API field: strip it from
      // the params that become the request body (v1 mapCreate is identity, so it
      // would leak through) and fold it into the FINAL body via applySshPublicKey.
      const { sshPublicKey, ...podParams } = params;

      // A pod may have a newly allocated persistent mount OR an existing
      // Network Volume, never both. Network mounts also have no default path in
      // v2, so fail before any template fetch or pod create request.
      if (params.networkVolumeId !== undefined) {
        if (params.volumeInGb !== undefined) {
          return jsonReply({
            error:
              'Pass either volumeInGb for a new persistent volume or networkVolumeId for an existing Network Volume, not both.',
            status: 400,
          });
        }
        if (!params.volumeMountPath) {
          return jsonReply({
            error: 'networkVolumeId requires volumeMountPath.',
            status: 400,
          });
        }
      }

      // Validate and normalize BEFORE any pod exists. Refuses a PRIVATE key
      // before it can reach a pod's env (and every process listing inside the
      // container), and refuses a value that is not a public key at all — a path
      // or a fingerprint passed instead of the .pub file's contents used to
      // succeed, exposing 22/tcp with junk in PUBLIC_KEY and reporting SSH as
      // configured. See normalizeSshPublicKey.
      let sshKey: string | undefined;
      if (sshPublicKey !== undefined) {
        const validated = normalizeSshPublicKey(sshPublicKey);
        if (!validated.ok)
          return jsonReply({ error: validated.error, status: 400 });
        sshKey = validated.key;
      }

      // Reply note attached whenever sshPublicKey was applied, so the caller
      // knows what was set up and what full SSH still depends on.
      const sshNote =
        'sshPublicKey applied: PUBLIC_KEY env set and 22/tcp exposed. Full SSH (incl. SCP/SFTP/rsync) also requires an image that installs PUBLIC_KEY into authorized_keys and starts sshd (all runpod/* official images do) and a machine with a public IP — read the pod’s portMappings for port 22 once it is running.';

      // Template deploy is v2-only: v2 CreatePodRequest has no templateId, so we
      // fetch the template and spread its container config into the body below.
      // Only v2 templates are ContainerConfig-shaped.
      if (params.templateId && backend.version !== 'v2') {
        return jsonReply({
          error:
            'Deploying a pod from a templateId is only supported on the v2 REST API. Set RUNPOD_REST_VERSION=v2, or pass imageName instead.',
          status: 501,
        });
      }
      // Image comes from either imageName or the template; require one of them.
      if (!params.imageName && !params.templateId) {
        return jsonReply({
          error:
            'Provide imageName, or templateId to deploy from an existing template.',
          status: 400,
        });
      }

      // Pod type is decided by STATED intent, never inferred from the absence of
      // GPU fields (absence used to silently downgrade a misspecified GPU request
      // into a CPU pod). On v2 we require an explicit, non-contradictory choice;
      // v1 keeps its passthrough behavior (it validates the body itself).
      const hasGpuTypes = (params.gpuTypeIds?.length ?? 0) > 0;
      const hasGpuCount = (params.gpuCount ?? 0) > 0;
      const wantsCpu = params.computeType === 'CPU';
      const wantsGpu =
        hasGpuTypes || hasGpuCount || params.computeType === 'GPU';

      if (backend.version === 'v2') {
        if (wantsGpu && wantsCpu) {
          return jsonReply({
            error:
              "Specify a GPU pod (gpuTypeIds or computeType:'GPU') OR a CPU pod (computeType:'CPU'), not both.",
            status: 400,
          });
        }
        if (!wantsGpu && !wantsCpu) {
          return jsonReply({
            error:
              "No pod type specified. Pass gpuTypeIds (see list-gpu-types) for a GPU pod, or computeType:'CPU' for a CPU pod.",
            status: 400,
          });
        }
        if (wantsGpu && !hasGpuTypes) {
          return jsonReply({
            error:
              'A GPU pod needs gpuTypeIds (see list-gpu-types); gpuCount or computeType alone is under-specified.',
            status: 400,
          });
        }
        // v2 CreatePodRequest requires `name`. Guard the direct-image path so
        // the caller gets a clean 400 instead of the API's raw 422; a
        // templateId deploy inherits the template's name below. CPU pods fall
        // through to v1, which has no such requirement.
        if (!wantsCpu && !params.name && !params.templateId) {
          return jsonReply({
            error:
              'Provide a name for the pod (deploying from a templateId inherits the template name).',
            status: 400,
          });
        }
        // v2 has no CPU pods yet (AE-2991): serve a CPU pod from v1 (which supports
        // them) instead of failing, and tell the caller which API answered.
        if (wantsCpu) {
          // CPU pods route to v1, but the template fetch/merge below is v2-only;
          // rather than silently ignore the template, tell the caller.
          if (params.templateId) {
            return jsonReply({
              error:
                'Template-based deploy is currently supported only for GPU pods on the v2 API. Create the CPU pod with an explicit imageName instead.',
              status: 400,
            });
          }
          // v1 is a passthrough (mapCreate is identity there), so the stripped
          // tool params are the correct v1 body — `computeType` is a valid v1
          // field. Wrap the call so a v1 error surfaces as a clean message, not
          // a raw throw (matching the GPU/v2 path's error handling below).
          try {
            const cpuBody = sshKey
              ? applySshPublicKey(podParams as Record<string, unknown>, sshKey)
              : (podParams as Record<string, unknown>);
            const result = (await callRestUrl(
              `${restV1Base(env)}/pods`,
              'POST',
              cpuBody
            )) as Record<string, unknown>;
            return jsonReply({
              ...result,
              ...(sshKey ? { _ssh: sshNote } : {}),
              _servedBy: 'v1',
              _note:
                'CPU pod: created on the v1 API, because the v2 REST API does not support CPU pods yet.',
            });
          } catch (error) {
            if (error instanceof HttpError) {
              return jsonReply({
                error: error.message,
                status: error.status,
                _servedBy: 'v1',
                _note: 'CPU pod create was routed to the v1 API and failed.',
              });
            }
            throw error;
          }
        }
      }

      let body = backend.mapCreate(podParams) as Record<string, unknown>;

      // Template-based deploy (guaranteed v2 here). Fetch the template and use its
      // container config as the base; the mapped pod params spread ON TOP so an
      // explicitly-passed field (image, ports, disk, …) still wins.
      if (params.templateId) {
        // Fetch the template from v2 EXPLICITLY (not via backendFor('templates'),
        // whose independent version resolution could return a v1 shape under a
        // split override like RUNPOD_REST_VERSION_TEMPLATES=v1 → merged body with
        // `imageName` not `image` → 422). Template deploy is v2-only, so pin v2.
        let template: Record<string, unknown>;
        try {
          template = (await callRestUrl(
            `${restV2Base(env)}/templates/${params.templateId}`
          )) as Record<string, unknown>;
        } catch (error) {
          if (error instanceof HttpError) {
            return jsonReply({
              error: `Failed to load template ${params.templateId}: ${error.message}`,
              status: error.status,
            });
          }
          throw error;
        }
        // Template config as defaults; caller-passed fields spread on top and win
        // (including registry, overridable via containerRegistryAuthId).
        body = { ...podBodyFromTemplate(template), ...body };
      }

      // After the template merge, so a template's ports/env are extended (a
      // pre-merge injection would clobber the template's ports whole-field).
      if (sshKey) body = applySshPublicKey(body, sshKey);

      try {
        const result = (await callRestUrl(
          `${backend.base}${backend.list}`,
          'POST',
          body
        )) as Record<string, unknown>;
        const extras: Record<string, unknown> = {};
        if (sshKey) extras._ssh = sshNote;
        // v2 accepts a single GPU type (`gpu.id`); v1's gpuTypeIds is "any of
        // these". If the caller offered several, only the first was sent — say
        // so in the reply so the narrowing isn't silent.
        if (backend.version === 'v2' && (params.gpuTypeIds?.length ?? 0) > 1) {
          extras._warning = `v2 accepts one GPU type per pod; used "${params.gpuTypeIds![0]}" and ignored ${
            params.gpuTypeIds!.length - 1
          } other(s): ${params.gpuTypeIds!.slice(1).join(', ')}.`;
        }
        return jsonReply(
          Object.keys(extras).length ? { ...result, ...extras } : result
        );
      } catch (error) {
        if (error instanceof HttpError) {
          // Surface any API rejection (4xx/429/5xx/501) as a clean {error, status}
          // carrying the API's own message, instead of throwing a raw stack.
          //
          // Do NOT special-case 501 as "CPU not supported" here: CPU pods route to
          // v1 above and never reach this v2 POST, so a 501 here is a GPU request
          // hitting an unimplemented path — that CPU guidance lives on the CPU branch.
          return jsonReply({ error: error.message, status: error.status });
        }
        throw error;
      }
    }
  );

  // Update Pod
  server.tool(
    'update-pod',
    "Update a pod's mutable fields (name, image, container disk, volume, ports, env). Only the fields you provide change.",
    {
      podId: z.string().describe('ID of the pod to update'),
      name: z.string().optional().describe('New name for the pod'),
      imageName: z.string().optional().describe('New Docker image'),
      containerDiskInGb: z
        .number()
        .optional()
        .describe('New container disk size in GB'),
      volumeInGb: z.number().optional().describe('New volume size in GB'),
      volumeMountPath: z
        .string()
        .optional()
        .describe('New path to mount the volume'),
      ports: z.array(z.string()).optional().describe('New ports to expose'),
      env: z
        .record(z.string())
        .optional()
        .describe('New environment variables'),
    },
    { title: 'Update pod', ...WRITE, idempotentHint: true },
    async (params) => {
      const { podId, ...updateParams } = params;
      const backend = backendFor('pods');
      const body = backend.mapUpdate(updateParams) as Record<string, unknown>;
      const result = await callRestUrl(
        `${backend.base}${backend.get!(podId)}`,
        'PATCH',
        body
      );
      return jsonReply(result);
    }
  );

  // Start Pod — v1: POST /pods/{id}/start ; v2: POST /pods/{id}/action {action:'start'}
  server.tool(
    'start-pod',
    'Start a stopped pod (resumes the same pod and its billing).',
    {
      podId: z.string().describe('ID of the pod to start'),
    },
    { title: 'Start pod', ...WRITE, idempotentHint: true },
    async (params) => {
      const result = await podAction(params.podId, 'start');
      return jsonReply(result);
    }
  );

  // Stop Pod — v1: POST /pods/{id}/stop ; v2: POST /pods/{id}/action {action:'stop'}
  server.tool(
    'stop-pod',
    'Stop a running pod. The pod and its disk persist; GPU billing stops.',
    {
      podId: z.string().describe('ID of the pod to stop'),
    },
    { title: 'Stop pod', ...WRITE, idempotentHint: true },
    async (params) => {
      const result = await podAction(params.podId, 'stop');
      return jsonReply(result);
    }
  );

  // Restart Pod — v2-only state transition (PodAction enum). The v1 REST API has
  // no restart endpoint, so under v1 we return a clean message instead of firing
  // a request that would 404 (mirrors the create-pod 501 handling).
  server.tool(
    'restart-pod',
    'Restart a running pod (single PodAction call). v2-only — on the v1 API returns a 501 notice (stop then start the pod instead).',
    {
      podId: z.string().describe('ID of the pod to restart'),
    },
    { title: 'Restart pod', ...WRITE },
    async (params) => {
      const backend = backendFor('pods');
      if (backend.version === 'v1') {
        return jsonReply({
          error:
            'restart-pod is only available on the v2 REST API. Set RUNPOD_REST_VERSION=v2 (or stop then start the pod on v1).',
          status: 501,
        });
      }
      const result = await podAction(params.podId, 'restart');
      return jsonReply(result);
    }
  );

  // Stream Pod Logs (v2-only — GET /v2/pods/{id}/logs, Server-Sent Events).
  // Stream Pod Logs (v2-only — GET /v2/pods/{id}/logs). See streamLogsReply.
  server.tool(
    'stream-pod-logs',
    "Fetch a bounded snapshot of a pod's live logs (container and/or system) via Server-Sent Events. v2-only — returns a 501 notice on the v1 API. Reads for up to maxWaitMs (default 5s) and returns the collected log lines; use `tail` to backfill recent lines first. Large output is truncated (see the `truncated` flag).",
    {
      podId: z.string().describe('ID of the pod whose logs to stream'),
      ...logStreamParams,
    },
    { title: 'Stream pod logs', ...READ_ONLY },
    (params) =>
      streamLogsReply(
        rt,
        {
          name: 'stream-pod-logs',
          resource: 'pods',
          logsUrl: (backend) =>
            `${backend.base}${backend.get!(encodeURIComponent(params.podId))}/logs`,
        },
        params
      )
  );

  // Delete Pod
  server.tool(
    'delete-pod',
    'Permanently delete a pod and its data. This cannot be undone.',
    {
      podId: z.string().describe('ID of the pod to delete'),
    },
    { title: 'Delete pod', ...DESTRUCTIVE },
    async (params) => {
      const backend = backendFor('pods');
      const result = await callRestUrl(
        `${backend.base}${backend.get!(params.podId)}`,
        'DELETE'
      );
      return jsonReply(result);
    }
  );
}
