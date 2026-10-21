// Code generated from specgen/spec/openapi.yaml by specgen/generator/generate-tools.ts; DO NOT EDIT.

export interface GeneratedToolParam {
  name: string;
  location: 'path' | 'query';
  /** Spec-declared `explode: false`: serialize an array as one comma-joined value. */
  explode?: false;
}

/** MCP tool annotations (tools/list `annotations`): behavioral hints hosts use
 *  to decide what needs human approval. */
export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface GeneratedTool {
  name: string;
  /** Human-readable name hosts show in place of `name`. */
  title: string;
  operationId: string;
  description: string;
  /** Served instead of `description` in the directory profile. */
  directoryDescription?: string;
  method: string;
  path: string;
  params: GeneratedToolParam[];
  hasBody: boolean;
  annotations: ToolAnnotations;
  /** Listed with its call shape only; describe-tool serves the full schema. */
  schemaOnDemand?: true;
  inputSchema: Record<string, unknown>;
}

export const generatedTools: GeneratedTool[] = [
  {
    name: 'create-cluster',
    title: 'Create cluster',
    operationId: 'createCluster',
    description:
      "Create an instant cluster (multiple pods with high-speed interconnect). BILLABLE from creation for every pod in the cluster: it rents compute.podCount identical pods at once, each with compute.gpuCountPerPod GPUs of compute.gpuTypeId — state the hourly price for the total GPU count (podCount * gpuCountPerPod, priced from the catalog tools) and create only after the user's explicit go on that quoted shape and total hourly price. Verify GPU stock first via the catalog tools. The compute shape and type are fixed at creation; only the name can be changed later. The container configuration applies to every pod, and templateId is the only private-image path — a bare registry property is rejected. Delete with delete-cluster when finished.",
    directoryDescription:
      "Create an Instant Cluster: compute.podCount identical Pods joined by a high-speed interconnect, each with compute.gpuCountPerPod GPUs of compute.gpuTypeId. Billable from creation for every Pod in the cluster, at the GPU type's hourly price times the total GPU count. The compute shape and type are fixed at creation; only the name can change later. The container configuration applies to every Pod, and templateId is the only way to use a private image; a bare registry property is rejected.",
    method: 'POST',
    path: '/v2/clusters',
    params: [],
    hasBody: true,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    schemaOnDemand: true,
    inputSchema: {
      type: 'object',
      properties: {
        body: {
          $ref: '#/$defs/CreateClusterRequest',
        },
      },
      required: ['body'],
      $defs: {
        BaseContainerConfig: {
          type: 'object',
          properties: {
            args: {
              type: 'string',
              description:
                'The container\'s command as one raw string: a bare shell string is treated as CMD and split into arguments; a JSON object `{"entrypoint":[...],"cmd":[...]}` sets either or both. Send `""` to clear; omit to leave unchanged.',
              examples: [
                '--model meta-llama/Llama-3-8B --max-model-len 8192',
                '{"entrypoint":["/bin/bash","-c"],"cmd":["python -u main.py"]}',
                '',
              ],
            },
            cmd: {
              type: 'array',
              items: {
                type: 'string',
              },
              description:
                'Container CMD in exec form: when the image defines an ENTRYPOINT, the argument list passed to it. Encoded into `args`; supply both only when they describe the same command. Send `[]` to clear; omit to leave unchanged.',
              examples: [
                ['--model', 'meta-llama/Llama-3-8B', '--max-model-len', '8192'],
              ],
            },
            entrypoint: {
              type: 'array',
              items: {
                type: 'string',
              },
              description:
                "Container ENTRYPOINT in exec form, overriding the image's own. Encoded into `args` field; supplying both is allowed only when they describe the same command. Send `[]` to clear, omit to leave unchanged.",
              examples: [['/bin/bash', '-c']],
            },
            disk: {
              type: 'integer',
              minimum: 1,
              description: 'Container disk in GB (ephemeral, wiped on restart)',
              examples: [50],
            },
            env: {
              type: 'object',
              additionalProperties: {
                type: 'string',
              },
              description: 'Environment variables as key-value pairs',
              examples: [
                {
                  JUPYTER_PASSWORD: 'hunter2',
                },
              ],
            },
            image: {
              type: 'string',
              description: 'Docker image reference',
              examples: ['runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404'],
            },
            ports: {
              type: 'array',
              description: 'Exposed ports, formatted as port/protocol',
              items: {
                type: 'string',
              },
              examples: [['8888/http', '22/tcp']],
            },
          },
        },
        BaseMounts: {
          type: 'object',
          properties: {
            persistent: {
              $ref: '#/$defs/PersistentMount',
            },
            network: {
              type: 'array',
              maxItems: 1,
              items: {
                $ref: '#/$defs/NetworkMount',
              },
            },
          },
        },
        ClusterCompute: {
          type: 'object',
          additionalProperties: false,
          description:
            'The homogeneous compute shape of a cluster. Every pod in the cluster is identical: `podCount` pods, each with `gpuCountPerPod` GPUs of type `gpuTypeId`. Total GPUs = `podCount` * `gpuCountPerPod`.',
          required: ['gpuTypeId', 'gpuCountPerPod', 'podCount'],
          properties: {
            gpuTypeId: {
              type: 'string',
              minLength: 1,
              description:
                'GPU type for every pod in the cluster, as returned by GET /v2/catalog/gpus.',
              examples: ['NVIDIA H100 80GB HBM3'],
            },
            gpuCountPerPod: {
              type: 'integer',
              minimum: 1,
              description:
                "Number of GPUs on each pod. Bounded above by the GPU type's per-cloud maximum (GpuType.maxCount); the upstream rejects values beyond it.",
              examples: [8],
            },
            podCount: {
              type: 'integer',
              minimum: 2,
              maximum: 250,
              description: 'Number of pods (nodes) in the cluster.',
              examples: [4],
            },
          },
        },
        ClusterMounts: {
          description:
            'Storage mounts for a cluster create: `persistent` or `network`, not both. Clusters cannot mount global volumes, so `global` is rejected.',
          allOf: [
            {
              $ref: '#/$defs/BaseMounts',
            },
          ],
          unevaluatedProperties: false,
        },
        ClusterType: {
          type: 'string',
          description:
            'Cluster type. TRAINING is the generic distributed-training cluster; SLURM provisions a managed Slurm controller/compute topology; RAY provisions a managed Ray head/worker topology; APPLICATION is a general multi-node application cluster.',
          enum: ['APPLICATION', 'TRAINING', 'SLURM', 'RAY'],
          examples: ['TRAINING'],
        },
        CreateClusterRequest: {
          allOf: [
            {
              $ref: '#/$defs/BaseContainerConfig',
            },
            {
              type: 'object',
              required: ['name', 'type', 'compute'],
              description:
                'Request body for creating a cluster. `compute` defines the homogeneous pod shape; the container configuration (image, env, ports, …) applies to every pod.',
              properties: {
                compute: {
                  $ref: '#/$defs/ClusterCompute',
                },
                name: {
                  type: 'string',
                  minLength: 1,
                  examples: ['my-training-cluster'],
                },
                type: {
                  $ref: '#/$defs/ClusterType',
                },
                templateId: {
                  type: 'string',
                  minLength: 1,
                  description:
                    'ID of a pod template to provision every member pod from: it supplies the container settings (image, args, disk, env, ports) and the registry credential for private images — the only private-image path for clusters. Mutually exclusive with the inline container fields (`image`, `args`, `entrypoint`, `cmd`, `disk`, `env`, `ports`, `mounts`). Must be a non-serverless template you can access.',
                  examples: ['30zmvf89kd'],
                },
                dataCenterIds: {
                  type: 'array',
                  items: {
                    type: 'string',
                  },
                  description:
                    'Preferred data centers for placement. Omit or pass an empty array to let the scheduler choose. A cluster is always placed within a single data center.',
                  example: ['US-TX-3'],
                },
                mounts: {
                  $ref: '#/$defs/ClusterMounts',
                },
                startJupyter: {
                  type: 'boolean',
                  default: false,
                  description:
                    'Start Jupyter on every member pod, as on pod create.',
                },
                startSsh: {
                  type: 'boolean',
                  default: false,
                  description:
                    "Provision SSH access on every member pod: injects a PUBLIC_KEY environment variable carrying your account's registered SSH public key. Same semantics as the pod create flag.",
                },
              },
            },
          ],
          unevaluatedProperties: false,
        },
        NetworkMount: {
          type: 'object',
          required: ['volumeId', 'path'],
          additionalProperties: false,
          description:
            'Reference to a NetworkVolume. Custom paths are honored at runtime on both GPU and CPU pods. The underlying `volumeId` is immutable post-create; the mount `path` may be changed via PATCH.',
          properties: {
            volumeId: {
              type: 'string',
              description:
                'ID of an existing NetworkVolume in the same data center as the pod.',
              examples: ['vol_xyz'],
            },
            path: {
              type: 'string',
              description:
                'Mount path inside the container. No default — must be specified explicitly.',
              examples: ['/runpod-volume'],
            },
          },
        },
        PersistentMount: {
          type: 'object',
          required: ['size', 'path'],
          additionalProperties: false,
          description:
            "Host-local persistent storage. Pinned to the pod's host machine — data does not survive a host failure. Disallowed on CPU pods. Mutually exclusive with NetworkMount. Deprecated: prefer NetworkMount for any data you cannot recreate.",
          properties: {
            size: {
              type: 'integer',
              minimum: 10,
              description:
                'Host-local persistent storage in GB. Upstream enforces a 10 GB floor.',
              examples: [20],
            },
            path: {
              type: 'string',
              description:
                'Mount path inside the container. May be changed via PATCH.',
              examples: ['/workspace'],
            },
          },
        },
      },
    },
  },
  {
    name: 'create-delegation',
    title: 'Create ECR delegation',
    operationId: 'createDelegation',
    description: 'Register an ECR delegation',
    method: 'POST',
    path: '/v2/registries/delegations',
    params: [],
    hasBody: true,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        body: {
          $ref: '#/$defs/CreateDelegationRequest',
          type: 'object',
        },
      },
      required: ['body'],
      $defs: {
        CreateDelegationRequest: {
          type: 'object',
          additionalProperties: false,
          required: ['resource'],
          properties: {
            resource: {
              type: 'string',
              description: 'ECR resource ARN',
              examples: [
                'arn:aws:ecr:us-east-2:418399314813:repository/runpod/deployment',
              ],
            },
            name: {
              type: ['string', 'null'],
              description: 'Optional name for the delegation',
              examples: ['my-delegation'],
            },
          },
        },
      },
    },
  },
  {
    name: 'create-endpoint',
    title: 'Create endpoint',
    operationId: 'createEndpoint',
    description:
      "Create a serverless endpoint. BILLABLE: state the worker's hourly price (from the catalog tools) before creating. Worker hardware is one of two choices: the gpu object (gpu.pools takes serverless pool ids from the catalog, e.g. ADA_24, never display names; gpu.count sets GPUs per worker) or the cpu array of CPU flavor configurations for a CPU endpoint. type and scaling are required and fix the request-routing model. Workers cold-start on the first job: expect minutes, poll with get-job-status wait.",
    directoryDescription:
      "Create a Serverless endpoint. Billable while its workers run, at the worker's hourly price. Worker hardware is either the gpu object (gpu.pools takes Serverless pool ids such as ADA_24, and gpu.count sets GPUs per worker) or the cpu array of CPU flavor configurations. type and scaling are required and set the request-routing model. Workers cold-start on their first job, which commonly takes minutes.",
    method: 'POST',
    path: '/v2/serverless',
    params: [],
    hasBody: true,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    schemaOnDemand: true,
    inputSchema: {
      type: 'object',
      properties: {
        body: {
          $ref: '#/$defs/CreateEndpointRequest',
        },
      },
      required: ['body'],
      $defs: {
        BaseContainerConfig: {
          type: 'object',
          properties: {
            args: {
              type: 'string',
              description:
                'The container\'s command as one raw string: a bare shell string is treated as CMD and split into arguments; a JSON object `{"entrypoint":[...],"cmd":[...]}` sets either or both. Send `""` to clear; omit to leave unchanged.',
              examples: [
                '--model meta-llama/Llama-3-8B --max-model-len 8192',
                '{"entrypoint":["/bin/bash","-c"],"cmd":["python -u main.py"]}',
                '',
              ],
            },
            cmd: {
              type: 'array',
              items: {
                type: 'string',
              },
              description:
                'Container CMD in exec form: when the image defines an ENTRYPOINT, the argument list passed to it. Encoded into `args`; supply both only when they describe the same command. Send `[]` to clear; omit to leave unchanged.',
              examples: [
                ['--model', 'meta-llama/Llama-3-8B', '--max-model-len', '8192'],
              ],
            },
            entrypoint: {
              type: 'array',
              items: {
                type: 'string',
              },
              description:
                "Container ENTRYPOINT in exec form, overriding the image's own. Encoded into `args` field; supplying both is allowed only when they describe the same command. Send `[]` to clear, omit to leave unchanged.",
              examples: [['/bin/bash', '-c']],
            },
            disk: {
              type: 'integer',
              minimum: 1,
              description: 'Container disk in GB (ephemeral, wiped on restart)',
              examples: [50],
            },
            env: {
              type: 'object',
              additionalProperties: {
                type: 'string',
              },
              description: 'Environment variables as key-value pairs',
              examples: [
                {
                  JUPYTER_PASSWORD: 'hunter2',
                },
              ],
            },
            image: {
              type: 'string',
              description: 'Docker image reference',
              examples: ['runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404'],
            },
            ports: {
              type: 'array',
              description: 'Exposed ports, formatted as port/protocol',
              items: {
                type: 'string',
              },
              examples: [['8888/http', '22/tcp']],
            },
          },
        },
        BaseCpuConfig: {
          type: 'object',
          required: ['id', 'vcpuCount'],
          properties: {
            id: {
              type: 'string',
              description:
                'CPU flavor identifier, as returned by GET /v2/catalog/cpus.',
              examples: ['cpu5c'],
              minLength: 1,
            },
            vcpuCount: {
              type: 'integer',
              minimum: 2,
              description:
                'Number of vCPUs. Must be valid for the selected CPU flavor and must be a power of two.',
              examples: [4],
            },
          },
        },
        BaseEndpointGpuConfig: {
          type: 'object',
          properties: {
            pools: {
              type: 'array',
              minItems: 1,
              description:
                'Serverless GPU pool IDs (the `pool` field of `list-gpu-types`). Workers are placed on whichever listed pool has capacity; narrow to specific cards with `excludedTypes`. On update, `pools` and `excludedTypes` are replaced together, so sending `pools` alone clears the exclusions.',
              items: {
                type: 'string',
              },
              examples: [['ADA_24']],
            },
            excludedTypes: {
              type: 'array',
              uniqueItems: true,
              description:
                'GPU type IDs to subtract from the selected pools — the `id` field of `list-gpu-types`, the same identifiers pods take in `gpu.id`. Workers run on every type in `pools` except these; omit to use the whole pool. A value outside `pools` is rejected. On update, restate them whenever you send `pools`, or they are cleared.',
              items: {
                type: 'string',
                pattern: '^\\s*[^-\\s]',
              },
              examples: [['NVIDIA L40']],
            },
            count: {
              type: 'integer',
              minimum: 1,
              default: 1,
              description: 'GPUs per worker',
              examples: [1],
            },
          },
        },
        ContainerConfig: {
          allOf: [
            {
              $ref: '#/$defs/BaseContainerConfig',
            },
            {
              type: 'object',
              properties: {
                registry: {
                  type: ['string', 'null'],
                  description:
                    'Container registry credential ID (for private images)',
                  examples: [null],
                },
              },
            },
          ],
        },
        CreateCpuConfig: {
          allOf: [
            {
              $ref: '#/$defs/BaseCpuConfig',
            },
          ],
          unevaluatedProperties: false,
        },
        CreateEndpointGpuConfig: {
          description:
            "GPU request for an endpoint create. Carries the CUDA constraints, which live here rather than at the body's top level so they are unrepresentable on a CPU endpoint.",
          allOf: [
            {
              $ref: '#/$defs/BaseEndpointGpuConfig',
            },
            {
              type: 'object',
              required: ['pools'],
              properties: {
                allowedCudaVersions: {
                  type: 'array',
                  items: {
                    type: 'string',
                    pattern: '^\\d+\\.\\d+$',
                  },
                  description:
                    "Acceptable CUDA versions for worker placement, as `major.minor`. Omit to accept any version (or inherit the template's constraint when creating from `templateId`).",
                  examples: [['12.8', '12.6']],
                },
                minCudaVersion: {
                  type: 'string',
                  pattern: '^\\d+\\.\\d+$',
                  description:
                    'Lowest acceptable CUDA version for worker placement, as `major.minor`, compared numerically rather than as a decimal — so 12.11 is above 12.2. Use this for an open-ended floor and allowedCudaVersions for an exact set.',
                  examples: ['12.1'],
                },
              },
            },
          ],
          unevaluatedProperties: false,
        },
        CreateEndpointRequest: {
          allOf: [
            {
              $ref: '#/$defs/ContainerConfig',
            },
            {
              if: {
                not: {
                  required: ['templateId'],
                },
              },
              then: {
                required: ['image'],
              },
            },
            {
              type: 'object',
              required: ['name', 'type', 'scaling'],
              properties: {
                gpu: {
                  $ref: '#/$defs/CreateEndpointGpuConfig',
                },
                name: {
                  type: 'string',
                  minLength: 1,
                  examples: ['my-inference'],
                },
                scaling: {
                  $ref: '#/$defs/EndpointScaling',
                },
                type: {
                  allOf: [
                    {
                      $ref: '#/$defs/EndpointType',
                    },
                  ],
                  description:
                    'Request-routing model. Required — it determines the valid scaler and request URLs, so it must be chosen explicitly on every create.',
                },
                cpu: {
                  type: 'array',
                  minItems: 1,
                  uniqueItems: true,
                  description:
                    "Eligible CPU configurations for each worker. Memory is derived from the selected flavor's catalog RAM multiplier. Exact duplicate configurations are rejected; the same flavor may be listed at different vCPU counts.",
                  items: {
                    $ref: '#/$defs/CreateCpuConfig',
                  },
                },
                dataCenterIds: {
                  type: 'array',
                  items: {
                    type: 'string',
                  },
                  description:
                    'Preferred data centers for placement. Omit or pass an empty array to let the scheduler choose.',
                },
                flashboot: {
                  allOf: [
                    {
                      $ref: '#/$defs/FlashBoot',
                    },
                  ],
                  default: 'OFF',
                },
                networkVolumes: {
                  type: 'array',
                  items: {
                    type: 'string',
                  },
                  description: 'Network volume IDs.',
                  deprecated: true,
                },
                mounts: {
                  $ref: '#/$defs/EndpointMountsInput',
                },
                templateId: {
                  type: 'string',
                  minLength: 1,
                  description:
                    'ID of a serverless template to base this endpoint on (must be serverless). Its container settings (image, args, disk, ports, env, registry) fill in what this body omits; body fields win, and `env` merges per key with body winning. Its allowedCudaVersions seeds `gpu.allowedCudaVersions` when the body omits it; pod-only flags are ignored. Copied once: later edits do not apply.',
                  examples: ['30zmvf89kd'],
                },
                timeout: {
                  type: 'integer',
                  default: 300000,
                },
                workers: {
                  allOf: [
                    {
                      $ref: '#/$defs/EndpointWorkers',
                    },
                  ],
                  properties: {
                    min: {
                      type: 'integer',
                      default: 0,
                    },
                    max: {
                      type: 'integer',
                      default: 3,
                    },
                    idleTimeout: {
                      type: 'integer',
                      default: 10,
                    },
                  },
                },
              },
            },
          ],
          unevaluatedProperties: false,
          if: {
            required: ['type'],
            properties: {
              type: {
                const: 'LOAD_BALANCER',
              },
            },
          },
          then: {
            properties: {
              scaling: {
                $ref: '#/$defs/RequestCountScaling',
              },
            },
          },
        },
        EndpointMount: {
          type: 'object',
          required: ['volumeId'],
          additionalProperties: false,
          description:
            'A volume mounted on every worker, always at `/runpod-volume`. Custom paths are not supported yet.',
          properties: {
            volumeId: {
              type: 'string',
              description:
                'ID of a NetworkVolume (under `network`) or GlobalVolume (under `global`).',
              examples: ['vol_abc'],
            },
          },
        },
        EndpointMountsInput: {
          type: 'object',
          additionalProperties: false,
          description:
            "Volumes to mount on the endpoint's workers. A `network` or `global` list that is present replaces the endpoint's current list of that kind; an empty list detaches it, and an omitted list is left unchanged.",
          properties: {
            network: {
              type: 'array',
              description: 'Network volumes, at most one per data center.',
              items: {
                $ref: '#/$defs/EndpointMount',
              },
            },
            global: {
              type: 'array',
              maxItems: 1,
              items: {
                $ref: '#/$defs/EndpointMount',
              },
            },
          },
        },
        EndpointScaling: {
          description:
            "Autoscaling signal — a discriminated union on `type`: `QUEUE_DELAY` (queue-based endpoints only) or `REQUEST_COUNT`. The scaler is chosen independently of the endpoint's routing `type` and can be switched on update.",
          oneOf: [
            {
              $ref: '#/$defs/QueueDelayScaling',
            },
            {
              $ref: '#/$defs/RequestCountScaling',
            },
          ],
          discriminator: {
            propertyName: 'type',
            mapping: {
              QUEUE_DELAY: '#/$defs/QueueDelayScaling',
              REQUEST_COUNT: '#/$defs/RequestCountScaling',
            },
          },
        },
        EndpointType: {
          type: 'string',
          description:
            'Request-routing semantics for a modern serverless endpoint. `QUEUE` — submit asynchronous or synchronous jobs through the managed queue. `LOAD_BALANCER` — send requests directly to worker-defined HTTP paths.',
          'x-enum-varnames': ['EndpointTypeQueue', 'EndpointTypeLoadBalancer'],
          enum: ['QUEUE', 'LOAD_BALANCER'],
        },
        EndpointWorkers: {
          type: 'object',
          additionalProperties: false,
          properties: {
            min: {
              type: 'integer',
              minimum: 0,
              description: 'Minimum number of workers.',
              examples: [0],
            },
            max: {
              type: 'integer',
              minimum: 0,
              description: 'Maximum number of workers.',
              examples: [5],
            },
            idleTimeout: {
              type: 'integer',
              minimum: 1,
              maximum: 3600,
              description:
                'Seconds before idle workers scale down. Not applicable to queue-based endpoints scaling on `requestCount` — rejected on create/update and omitted from responses for that combination.',
              examples: [5],
            },
          },
        },
        FlashBoot: {
          type: 'string',
          description:
            'FlashBoot cold-start acceleration mode. `OFF` — disabled. `FLASHBOOT` — enabled. `PRIORITY_FLASHBOOT` — enabled with priority capacity',
          enum: ['OFF', 'FLASHBOOT', 'PRIORITY_FLASHBOOT'],
        },
        QueueDelayScaling: {
          type: 'object',
          additionalProperties: false,
          description: 'Scale on queue wait time. Queue-based endpoints only.',
          required: ['type', 'queueDelay'],
          properties: {
            type: {
              type: 'string',
              description:
                'Scaler discriminator. Always `QUEUE_DELAY` for this variant.',
              enum: ['QUEUE_DELAY'],
            },
            queueDelay: {
              type: 'number',
              format: 'float',
              minimum: 0.5,
              description:
                'Adjusts the number of workers based on how long requests wait in the queue.',
              examples: [4],
            },
          },
        },
        RequestCountScaling: {
          type: 'object',
          additionalProperties: false,
          description:
            'Scale on concurrent in-flight requests per worker. Required for load-balancing endpoints; also selectable for queue-based.',
          required: ['type', 'requestCount'],
          properties: {
            type: {
              type: 'string',
              description:
                'Scaler discriminator. Always `REQUEST_COUNT` for this variant.',
              enum: ['REQUEST_COUNT'],
            },
            requestCount: {
              type: 'integer',
              minimum: 1,
              description:
                'Adjusts the number of workers based on active in-flight requests.',
              examples: [4],
            },
          },
        },
      },
    },
  },
  {
    name: 'create-global-volume',
    title: 'Create global volume',
    operationId: 'createGlobalVolume',
    description:
      'Create a global volume. Provisions a new global volume — storage that mounts into workloads in any data center. Only a `name` is required; storage is provisioned for you. Accounts have a cap on how many global volumes they can hold; creating one past it fails with `400`. Returns `201` with the created global volume, including its assigned `id`.',
    method: 'POST',
    path: '/v2/global-volumes',
    params: [],
    hasBody: true,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        body: {
          $ref: '#/$defs/CreateGlobalVolumeRequest',
          type: 'object',
        },
      },
      required: ['body'],
      $defs: {
        CreateGlobalVolumeRequest: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: {
            name: {
              type: 'string',
              minLength: 1,
              maxLength: 191,
              pattern: '[^\\p{Z}\\t-\\r]',
              description:
                'Human-readable name, 1–191 characters with at least one non-whitespace character. Leading and trailing whitespace is trimmed.',
              examples: ['training-data'],
            },
          },
        },
      },
    },
  },
  {
    name: 'create-network-volume',
    title: 'Create network volume',
    operationId: 'createNetworkVolume',
    description:
      'Create a network volume. Provisions a new network volume — persistent, network-attached storage that can be mounted into pods and serverless workers. Required inputs are `name`, `size` (in GB), and `dataCenter`; an optional `type` selects the storage tier and is immutable after creation. See `CreateNetworkVolumeRequest` for the size bounds and tier options. This creates a billable persistent resource that keeps incurring storage charges until it is deleted. Returns `201` with the created network volume, including its assigned `id`.',
    method: 'POST',
    path: '/v2/network-volumes',
    params: [],
    hasBody: true,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        body: {
          $ref: '#/$defs/CreateNetworkVolumeRequest',
          type: 'object',
        },
      },
      required: ['body'],
      $defs: {
        CreateNetworkVolumeRequest: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'size', 'dataCenter'],
          properties: {
            dataCenter: {
              type: 'string',
              minLength: 1,
              description: 'Data center in which to create the volume',
              examples: ['EU-RO-1'],
            },
            name: {
              type: 'string',
              minLength: 1,
              description: 'Human-readable name',
              examples: ['my-dataset'],
            },
            size: {
              type: 'integer',
              minimum: 10,
              maximum: 4096,
              description: 'Storage to allocate in GB',
              examples: [50],
            },
            type: {
              allOf: [
                {
                  $ref: '#/$defs/VolumeType',
                },
              ],
              description:
                "Storage tier for the volume. Optional. When omitted, the volume is provisioned using the requested data center's default (primary) storage tier.",
            },
          },
        },
        VolumeType: {
          type: 'string',
          description: 'Data center network volume storage type.',
          enum: ['STANDARD', 'HIGH_PERFORMANCE'],
        },
      },
    },
  },
  {
    name: 'create-pod',
    title: 'Create Pod',
    operationId: 'createPod',
    description:
      'Rent a GPU/CPU pod. BILLABLE from creation until stop/terminate: state the hourly price before creating. GPU selection is the gpu object: gpu.id takes a catalog GPU type id (e.g. "NVIDIA GeForce RTX 4090"), verified via list-gpu-types, and gpu.count sets the GPU count; cloud/data-center choice constrains stock.',
    directoryDescription:
      'Create a GPU or CPU Pod. Billable from creation until it is stopped or terminated. GPU selection is the gpu object: gpu.id takes a GPU type id such as "NVIDIA GeForce RTX 4090", and gpu.count sets the number of GPUs. Cloud tier and data center choices limit which machines can host it.',
    method: 'POST',
    path: '/v2/pods',
    params: [],
    hasBody: true,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    schemaOnDemand: true,
    inputSchema: {
      type: 'object',
      properties: {
        body: {
          $ref: '#/$defs/CreatePodRequest',
        },
      },
      required: ['body'],
      $defs: {
        BaseContainerConfig: {
          type: 'object',
          properties: {
            args: {
              type: 'string',
              description:
                'The container\'s command as one raw string: a bare shell string is treated as CMD and split into arguments; a JSON object `{"entrypoint":[...],"cmd":[...]}` sets either or both. Send `""` to clear; omit to leave unchanged.',
              examples: [
                '--model meta-llama/Llama-3-8B --max-model-len 8192',
                '{"entrypoint":["/bin/bash","-c"],"cmd":["python -u main.py"]}',
                '',
              ],
            },
            cmd: {
              type: 'array',
              items: {
                type: 'string',
              },
              description:
                'Container CMD in exec form: when the image defines an ENTRYPOINT, the argument list passed to it. Encoded into `args`; supply both only when they describe the same command. Send `[]` to clear; omit to leave unchanged.',
              examples: [
                ['--model', 'meta-llama/Llama-3-8B', '--max-model-len', '8192'],
              ],
            },
            entrypoint: {
              type: 'array',
              items: {
                type: 'string',
              },
              description:
                "Container ENTRYPOINT in exec form, overriding the image's own. Encoded into `args` field; supplying both is allowed only when they describe the same command. Send `[]` to clear, omit to leave unchanged.",
              examples: [['/bin/bash', '-c']],
            },
            disk: {
              type: 'integer',
              minimum: 1,
              description: 'Container disk in GB (ephemeral, wiped on restart)',
              examples: [50],
            },
            env: {
              type: 'object',
              additionalProperties: {
                type: 'string',
              },
              description: 'Environment variables as key-value pairs',
              examples: [
                {
                  JUPYTER_PASSWORD: 'hunter2',
                },
              ],
            },
            image: {
              type: 'string',
              description: 'Docker image reference',
              examples: ['runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404'],
            },
            ports: {
              type: 'array',
              description: 'Exposed ports, formatted as port/protocol',
              items: {
                type: 'string',
              },
              examples: [['8888/http', '22/tcp']],
            },
          },
        },
        BaseCpuConfig: {
          type: 'object',
          required: ['id', 'vcpuCount'],
          properties: {
            id: {
              type: 'string',
              description:
                'CPU flavor identifier, as returned by GET /v2/catalog/cpus.',
              examples: ['cpu5c'],
              minLength: 1,
            },
            vcpuCount: {
              type: 'integer',
              minimum: 2,
              description:
                'Number of vCPUs. Must be valid for the selected CPU flavor and must be a power of two.',
              examples: [4],
            },
          },
        },
        BaseGpuConfig: {
          type: 'object',
          required: ['id'],
          properties: {
            id: {
              type: 'string',
              description: 'GPU type identifier',
              examples: ['NVIDIA GeForce RTX 4090'],
            },
            count: {
              type: 'integer',
              minimum: 1,
              default: 1,
              description: 'Number of GPUs',
              examples: [1],
            },
          },
        },
        BaseMounts: {
          type: 'object',
          properties: {
            persistent: {
              $ref: '#/$defs/PersistentMount',
            },
            network: {
              type: 'array',
              maxItems: 1,
              items: {
                $ref: '#/$defs/NetworkMount',
              },
            },
          },
        },
        Cloud: {
          type: 'string',
          description:
            'Cloud tier. `SECURE` — Runpod-owned datacenter hardware. `COMMUNITY` — community-hosted hardware',
          enum: ['SECURE', 'COMMUNITY'],
        },
        ContainerConfig: {
          allOf: [
            {
              $ref: '#/$defs/BaseContainerConfig',
            },
            {
              type: 'object',
              properties: {
                registry: {
                  type: ['string', 'null'],
                  description:
                    'Container registry credential ID (for private images)',
                  examples: [null],
                },
              },
            },
          ],
        },
        CreateCpuConfig: {
          allOf: [
            {
              $ref: '#/$defs/BaseCpuConfig',
            },
          ],
          unevaluatedProperties: false,
        },
        CreateGpuConfig: {
          description:
            "GPU request for a pod create. Carries the CUDA host constraints, which live here rather than at the body's top level so they are unrepresentable on a CPU pod.",
          allOf: [
            {
              $ref: '#/$defs/BaseGpuConfig',
            },
            {
              type: 'object',
              properties: {
                allowedCudaVersions: {
                  type: 'array',
                  items: {
                    type: 'string',
                    pattern: '^\\d+\\.\\d+$',
                  },
                  description:
                    'Acceptable CUDA versions for the host machine, as `major.minor`. Omit to accept any version.',
                  examples: [['12.8', '12.6']],
                },
                minCudaVersion: {
                  type: 'string',
                  pattern: '^\\d+\\.\\d+$',
                  description:
                    'Lowest acceptable CUDA version for the host machine, as `major.minor`, compared numerically rather than as a decimal — so 12.11 is above 12.2. Use this for an open-ended floor and allowedCudaVersions for an exact set.',
                  examples: ['12.1'],
                },
                minRamPerGpu: {
                  type: 'integer',
                  minimum: 1,
                  description:
                    'Minimum host system RAM in GB per requested GPU. This is a placement filter, not a resource request. The actual total allocated system RAM may be higher and is returned in gpu.memory.',
                  examples: [8],
                },
                minVcpuCountPerGpu: {
                  type: 'integer',
                  minimum: 1,
                  description:
                    'Minimum host vCPU count per requested GPU. This is a placement filter, not a resource request. The actual total allocated vCPU count may be higher and is returned in gpu.vcpuCount.',
                  examples: [2],
                },
              },
            },
          ],
          unevaluatedProperties: false,
        },
        CreatePodRequest: {
          allOf: [
            {
              $ref: '#/$defs/ContainerConfig',
            },
            {
              type: 'object',
              required: ['name'],
              description:
                'Request body for creating a pod. Exactly one of `gpu` or `cpu` must be set — enforced at the handler layer.',
              properties: {
                name: {
                  type: 'string',
                  minLength: 1,
                  examples: ['my-training-pod'],
                },
                cloud: {
                  allOf: [
                    {
                      $ref: '#/$defs/Cloud',
                    },
                  ],
                  default: 'SECURE',
                  description: 'Cloud tier. Defaults to `SECURE` when omitted.',
                },
                cpu: {
                  $ref: '#/$defs/CreateCpuConfig',
                },
                dataCenterIds: {
                  type: 'array',
                  items: {
                    type: 'string',
                  },
                  description:
                    'Preferred data centers for placement. Omit or pass an empty array to let the scheduler choose.',
                  examples: [['US-TX-3']],
                },
                globalNetworking: {
                  type: 'boolean',
                  default: false,
                  description:
                    'Enable global networking, giving the pod a private IP reachable across data centers. Requires an NVIDIA GPU and a global-networking-enabled data center (both enforced upstream).',
                  examples: [false],
                },
                gpu: {
                  $ref: '#/$defs/CreateGpuConfig',
                },
                mounts: {
                  $ref: '#/$defs/Mounts',
                },
                startJupyter: {
                  type: 'boolean',
                  default: false,
                  description:
                    'Create-time flag: starts JupyterLab by injecting a generated `JUPYTER_PASSWORD` environment variable, unless the request sets one. Expose `8888/http` in `ports` to reach it.',
                  examples: [true],
                },
                startSsh: {
                  type: 'boolean',
                  default: false,
                  description:
                    "Create-time flag: sets up SSH access by injecting a `PUBLIC_KEY` environment variable with your account's registered SSH keys (`update-ssh-keys`), unless the request sets one. With no registered keys it does nothing and the pod has no SSH access. Direct SSH also needs a `22/tcp` entry in `ports`.",
                  examples: [true],
                },
                templateId: {
                  type: 'string',
                  minLength: 1,
                  description:
                    "ID of a pod template to base this pod on (not a serverless one). Its container settings (image, args, disk, ports, env, registry, persistent mount) fill in what this body omits; body fields win, and `env` merges per key with body winning. A CUDA field in `gpu` replaces the template's CUDA constraint; CPU pods ignore its mount. Copied once: later template edits do not affect the pod.",
                  examples: ['30zmvf89kd'],
                },
              },
            },
          ],
          unevaluatedProperties: false,
          if: {
            not: {
              required: ['templateId'],
            },
          },
          then: {
            required: ['image'],
          },
        },
        GlobalMount: {
          type: 'object',
          required: ['volumeId'],
          additionalProperties: false,
          description:
            'Reference to a GlobalVolume. Usage-billed, so it has no size. The underlying `volumeId` is immutable post-create; the mount `path` may be changed via PATCH.',
          properties: {
            volumeId: {
              type: 'string',
              description: 'ID of an existing GlobalVolume.',
              examples: ['gsb_abc'],
            },
            path: {
              type: 'string',
              description:
                'Mount path inside the container. Optional on create, where a default is chosen for you; a PATCH that omits it leaves the path unchanged.',
              examples: ['/data'],
            },
          },
        },
        Mounts: {
          description:
            "Storage mounts for the pod: `persistent` (size + path) excludes both `network` and `global`; `network` (volumeId + path) and `global` (volumeId, optional path) take one entry each and can be combined. Every entry needs its full shape. On update, omit the field to leave the mounts as they are; the mount kind and a volume's volumeId cannot change, and mounts cannot be cleared.",
          allOf: [
            {
              $ref: '#/$defs/BaseMounts',
            },
            {
              type: 'object',
              properties: {
                global: {
                  type: 'array',
                  maxItems: 1,
                  description:
                    'At most one global volume, on GPU and CPU pods, with no data center constraint. Combinable with `network` but not with `persistent` (rejected): upstream drops a persistent disk whenever a volume is attached.',
                  items: {
                    $ref: '#/$defs/GlobalMount',
                  },
                },
              },
            },
          ],
          unevaluatedProperties: false,
        },
        NetworkMount: {
          type: 'object',
          required: ['volumeId', 'path'],
          additionalProperties: false,
          description:
            'Reference to a NetworkVolume. Custom paths are honored at runtime on both GPU and CPU pods. The underlying `volumeId` is immutable post-create; the mount `path` may be changed via PATCH.',
          properties: {
            volumeId: {
              type: 'string',
              description:
                'ID of an existing NetworkVolume in the same data center as the pod.',
              examples: ['vol_xyz'],
            },
            path: {
              type: 'string',
              description:
                'Mount path inside the container. No default — must be specified explicitly.',
              examples: ['/runpod-volume'],
            },
          },
        },
        PersistentMount: {
          type: 'object',
          required: ['size', 'path'],
          additionalProperties: false,
          description:
            "Host-local persistent storage. Pinned to the pod's host machine — data does not survive a host failure. Disallowed on CPU pods. Mutually exclusive with NetworkMount. Deprecated: prefer NetworkMount for any data you cannot recreate.",
          properties: {
            size: {
              type: 'integer',
              minimum: 10,
              description:
                'Host-local persistent storage in GB. Upstream enforces a 10 GB floor.',
              examples: [20],
            },
            path: {
              type: 'string',
              description:
                'Mount path inside the container. May be changed via PATCH.',
              examples: ['/workspace'],
            },
          },
        },
      },
    },
  },
  {
    name: 'create-registry',
    title: 'Create registry credential',
    operationId: 'createRegistry',
    description:
      'Create a container registry credential. Stores credentials for a private container registry. Credentials are write-only.',
    method: 'POST',
    path: '/v2/registries',
    params: [],
    hasBody: true,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        body: {
          $ref: '#/$defs/CreateRegistryRequest',
          type: 'object',
        },
      },
      required: ['body'],
      $defs: {
        CreateRegistryRequest: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'username', 'password'],
          properties: {
            name: {
              type: 'string',
              minLength: 1,
              maxLength: 191,
              examples: ['my-private-registry'],
            },
            password: {
              type: 'string',
              minLength: 1,
              maxLength: 16384,
              description:
                'Registry password (write-only, not returned in responses)',
            },
            username: {
              type: 'string',
              minLength: 1,
              maxLength: 191,
              description:
                'Registry username (write-only, not returned in responses)',
            },
          },
        },
      },
    },
  },
  {
    name: 'create-secret',
    title: 'Create secret',
    operationId: 'createSecret',
    description:
      "Create a secret. Stores a new account-scoped encrypted string. `name` must be unique across the account's secrets and is immutable; `value` is write-only and can never be read back through the API. Use the secret from pods, serverless endpoints, and templates by setting an environment variable's value to `{{ RUNPOD_SECRET_<name> }}` — Runpod substitutes the stored value when the pod or worker boots. Returns `201` with the created secret's metadata, or `409` when the name is already taken.",
    method: 'POST',
    path: '/v2/account/secrets',
    params: [],
    hasBody: true,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schemaOnDemand: true,
    inputSchema: {
      type: 'object',
      properties: {
        body: {
          $ref: '#/$defs/CreateSecretRequest',
          type: 'object',
        },
      },
      required: ['body'],
      $defs: {
        CreateSecretRequest: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'value'],
          properties: {
            name: {
              type: 'string',
              minLength: 1,
              maxLength: 191,
              pattern: '^[a-zA-Z_][a-zA-Z0-9_.\\-/]*$',
              description:
                'Unique name for the secret — referenced from environment variables as `{{ RUNPOD_SECRET_<name> }}`; immutable after creation. Maximum 191 characters, must start with a letter or underscore, and may contain letters, digits, and `_.-/`.',
              examples: ['hf-token'],
            },
            value: {
              type: 'string',
              minLength: 1,
              maxLength: 16777216,
              description:
                'The secret value. Write-only — never returned by the API. Must be smaller than 16 MiB of UTF-8 text (strictly under 16,777,216 bytes).',
            },
            description: {
              type: 'string',
              maxLength: 65535,
              description:
                'Optional human-readable description, at most 65,535 bytes of UTF-8 text.',
              examples: ['Hugging Face read token'],
            },
          },
        },
      },
    },
  },
  {
    name: 'create-template',
    title: 'Create template',
    operationId: 'createTemplate',
    description:
      'Create a template. Creates a reusable container-configuration preset — image, disk, ports, env, registry, and mount settings — for pods and serverless endpoints. Pass its ID as `templateId` to `createPod` or `createEndpoint`, or spread its fields into the request body directly. Returns the created template.',
    method: 'POST',
    path: '/v2/templates',
    params: [],
    hasBody: true,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    schemaOnDemand: true,
    inputSchema: {
      type: 'object',
      properties: {
        body: {
          $ref: '#/$defs/CreateTemplateRequest',
        },
      },
      required: ['body'],
      $defs: {
        BaseContainerConfig: {
          type: 'object',
          properties: {
            args: {
              type: 'string',
              description:
                'The container\'s command as one raw string: a bare shell string is treated as CMD and split into arguments; a JSON object `{"entrypoint":[...],"cmd":[...]}` sets either or both. Send `""` to clear; omit to leave unchanged.',
              examples: [
                '--model meta-llama/Llama-3-8B --max-model-len 8192',
                '{"entrypoint":["/bin/bash","-c"],"cmd":["python -u main.py"]}',
                '',
              ],
            },
            cmd: {
              type: 'array',
              items: {
                type: 'string',
              },
              description:
                'Container CMD in exec form: when the image defines an ENTRYPOINT, the argument list passed to it. Encoded into `args`; supply both only when they describe the same command. Send `[]` to clear; omit to leave unchanged.',
              examples: [
                ['--model', 'meta-llama/Llama-3-8B', '--max-model-len', '8192'],
              ],
            },
            entrypoint: {
              type: 'array',
              items: {
                type: 'string',
              },
              description:
                "Container ENTRYPOINT in exec form, overriding the image's own. Encoded into `args` field; supplying both is allowed only when they describe the same command. Send `[]` to clear, omit to leave unchanged.",
              examples: [['/bin/bash', '-c']],
            },
            disk: {
              type: 'integer',
              minimum: 1,
              description: 'Container disk in GB (ephemeral, wiped on restart)',
              examples: [50],
            },
            env: {
              type: 'object',
              additionalProperties: {
                type: 'string',
              },
              description: 'Environment variables as key-value pairs',
              examples: [
                {
                  JUPYTER_PASSWORD: 'hunter2',
                },
              ],
            },
            image: {
              type: 'string',
              description: 'Docker image reference',
              examples: ['runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404'],
            },
            ports: {
              type: 'array',
              description: 'Exposed ports, formatted as port/protocol',
              items: {
                type: 'string',
              },
              examples: [['8888/http', '22/tcp']],
            },
          },
        },
        ContainerConfig: {
          allOf: [
            {
              $ref: '#/$defs/BaseContainerConfig',
            },
            {
              type: 'object',
              properties: {
                registry: {
                  type: ['string', 'null'],
                  description:
                    'Container registry credential ID (for private images)',
                  examples: [null],
                },
              },
            },
          ],
        },
        CreateTemplateRequest: {
          allOf: [
            {
              $ref: '#/$defs/ContainerConfig',
            },
            {
              type: 'object',
              required: ['name', 'image'],
              properties: {
                name: {
                  type: 'string',
                  minLength: 1,
                  examples: ['My PyTorch Template'],
                },
                allowedCudaVersions: {
                  type: 'array',
                  items: {
                    type: 'string',
                    pattern: '^\\d+\\.\\d+$',
                  },
                  description:
                    'Acceptable CUDA versions for containers created from this template, as `major.minor`. Omit to accept any version — see the same field on `createPod` for matching semantics.',
                  examples: [['12.8', '12.6']],
                },
                category: {
                  description: 'Optional. Defaults to `NVIDIA` when omitted.',
                  allOf: [
                    {
                      $ref: '#/$defs/TemplateCategory',
                    },
                  ],
                  default: 'NVIDIA',
                },
                mounts: {
                  $ref: '#/$defs/TemplateMounts',
                },
                public: {
                  type: 'boolean',
                  default: false,
                },
                serverless: {
                  type: 'boolean',
                  default: false,
                },
                startJupyter: {
                  type: 'boolean',
                  default: true,
                  description:
                    'Start JupyterLab in containers created from this template: injects a generated `JUPYTER_PASSWORD` environment variable, unless `env` already sets one.',
                  examples: [false],
                },
                startSsh: {
                  type: 'boolean',
                  default: true,
                  description:
                    "Provision SSH access in containers created from this template: injects a `PUBLIC_KEY` environment variable carrying the deployer's registered SSH public keys (`update-ssh-keys` — with none registered the flag does nothing), unless `env` already sets one.",
                  examples: [true],
                },
              },
            },
          ],
          unevaluatedProperties: false,
        },
        PersistentMount: {
          type: 'object',
          required: ['size', 'path'],
          additionalProperties: false,
          description:
            "Host-local persistent storage. Pinned to the pod's host machine — data does not survive a host failure. Disallowed on CPU pods. Mutually exclusive with NetworkMount. Deprecated: prefer NetworkMount for any data you cannot recreate.",
          properties: {
            size: {
              type: 'integer',
              minimum: 10,
              description:
                'Host-local persistent storage in GB. Upstream enforces a 10 GB floor.',
              examples: [20],
            },
            path: {
              type: 'string',
              description:
                'Mount path inside the container. May be changed via PATCH.',
              examples: ['/workspace'],
            },
          },
        },
        TemplateCategory: {
          type: 'string',
          description:
            'Controls how the template is grouped and filtered in the Runpod console. It does not affect hardware selection, scheduling, or billing. `CPU` — CPU-only workloads. `NVIDIA` — NVIDIA GPU workloads. `AMD` — AMD GPU workloads',
          enum: ['CPU', 'NVIDIA', 'AMD'],
        },
        TemplateMounts: {
          type: 'object',
          additionalProperties: false,
          description:
            'Storage mounts for containers from this template: a single `persistent` mount only (`network` is rejected). On update, omitting `mounts` or sending `{}` leaves the existing mount unchanged.',
          properties: {
            persistent: {
              $ref: '#/$defs/PersistentMount',
            },
          },
        },
      },
    },
  },
  {
    name: 'delete-cluster',
    title: 'Delete cluster',
    operationId: 'deleteCluster',
    description:
      'Delete a cluster permanently: it terminates every member pod. Verify the id with get-cluster, and list-cluster-pods for what the delete takes down, before deleting; delete only clusters your own tool calls created in this conversation, or the one the user asked you to delete by id — a name found by listing is not attribution.',
    directoryDescription:
      'Delete an Instant Cluster permanently. Every member Pod is terminated and its container disk is lost.',
    method: 'DELETE',
    path: '/v2/clusters/{id}',
    params: [
      {
        name: 'id',
        location: 'path',
      },
    ],
    hasBody: false,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Cluster identifier',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete-endpoint',
    title: 'Delete endpoint',
    operationId: 'deleteEndpoint',
    description:
      'Delete a serverless endpoint permanently and immediately. Verify the id belongs to the intended endpoint (get-endpoint) before deleting; delete only endpoints your own tool calls created in this conversation, or the one the user asked you to delete by id — a name found by listing is not attribution.',
    directoryDescription:
      'Delete a Serverless endpoint permanently and immediately.',
    method: 'DELETE',
    path: '/v2/serverless/{id}',
    params: [
      {
        name: 'id',
        location: 'path',
      },
    ],
    hasBody: false,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Serverless endpoint identifier',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete-global-volume',
    title: 'Delete global volume',
    operationId: 'deleteGlobalVolume',
    description:
      'Delete a global volume. Permanently deletes a global volume and its stored data. Fails with `409` while the volume is still mounted: terminate every pod that mounts it (stopped pods count) and detach it from every serverless endpoint first. Nothing is detached or terminated on your behalf.',
    method: 'DELETE',
    path: '/v2/global-volumes/{id}',
    params: [
      {
        name: 'id',
        location: 'path',
      },
    ],
    hasBody: false,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Global volume identifier',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete-network-volume',
    title: 'Delete network volume',
    operationId: 'deleteNetworkVolume',
    description:
      'Delete a network volume. Permanently deletes a network volume and releases its storage.',
    method: 'DELETE',
    path: '/v2/network-volumes/{id}',
    params: [
      {
        name: 'id',
        location: 'path',
      },
    ],
    hasBody: false,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Network volume identifier',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete-pod',
    title: 'Delete Pod',
    operationId: 'deletePod',
    description:
      'Terminate a pod permanently — its container disk is lost. Distinguish from stopping (pod-action stop) which releases the GPU but keeps volume data. Verify the id with get-pod first; terminate only pods your own tool calls created in this conversation, or the one the user asked you to terminate by id — a name found by listing is not attribution.',
    directoryDescription:
      'Terminate a Pod permanently. Its container disk is lost; data on an attached network volume is kept. Stopping a Pod instead releases its compute but keeps its disk.',
    method: 'DELETE',
    path: '/v2/pods/{id}',
    params: [
      {
        name: 'id',
        location: 'path',
      },
    ],
    hasBody: false,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Pod identifier',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete-registry',
    title: 'Delete registry credential',
    operationId: 'deleteRegistry',
    description:
      'Delete a container registry credential. Permanently deletes a container registry credential by ID. Rejected if any pod currently uses this credential to pull its image. Templates that reference it are not part of that check — they silently lose the reference (`registry` becomes null) instead of blocking the delete.',
    method: 'DELETE',
    path: '/v2/registries/{id}',
    params: [
      {
        name: 'id',
        location: 'path',
      },
    ],
    hasBody: false,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete-secret',
    title: 'Delete secret',
    operationId: 'deleteSecret',
    description:
      'Delete a secret permanently. Environment variables referencing its name ({{ RUNPOD_SECRET_<name> }}) stop resolving at the next pod or worker boot; running instances keep the value they started with. Verify the id with get-secret first; delete only secrets your own tool calls created in this conversation, or the one the user asked you to delete by id — a name found by listing is not attribution.',
    directoryDescription:
      'Delete a secret permanently. Environment variables that reference it ({{ RUNPOD_SECRET_<name> }}) stop resolving at the next Pod or worker boot; running instances keep the value they started with.',
    method: 'DELETE',
    path: '/v2/account/secrets/{id}',
    params: [
      {
        name: 'id',
        location: 'path',
      },
    ],
    hasBody: false,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Secret identifier',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete-template',
    title: 'Delete template',
    operationId: 'deleteTemplate',
    description:
      'Delete a template permanently. Verify with get-template first; a template referenced by a live endpoint should not be deleted.',
    directoryDescription:
      'Delete a template permanently. An endpoint that references the template can stop working once it is deleted.',
    method: 'DELETE',
    path: '/v2/templates/{id}',
    params: [
      {
        name: 'id',
        location: 'path',
      },
    ],
    hasBody: false,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'get-cluster',
    title: 'Get cluster',
    operationId: 'getCluster',
    description:
      'Get a cluster. Returns a single cluster by ID. The pods field is an aggregate summary (total + count by status); fetch the member pods themselves from /v2/clusters/{id}/pods.',
    method: 'GET',
    path: '/v2/clusters/{id}',
    params: [
      {
        name: 'id',
        location: 'path',
      },
    ],
    hasBody: false,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Cluster identifier',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'get-cpu-type',
    title: 'Get CPU type',
    operationId: 'getCpuType',
    description:
      'Get a CPU type. Returns a single CPU type with pricing. Availability details are included only when requested with include=AVAILABILITY, which requires `product` — stock differs by product context.',
    method: 'GET',
    path: '/v2/catalog/cpus/{id}',
    params: [
      {
        name: 'id',
        location: 'path',
      },
      {
        name: 'include',
        location: 'query',
        explode: false,
      },
      {
        name: 'product',
        location: 'query',
        explode: false,
      },
      {
        name: 'vcpuCount',
        location: 'query',
      },
    ],
    hasBody: false,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
        },
        include: {
          type: 'array',
          maxItems: 1,
          items: {
            $ref: '#/$defs/CatalogInclude',
          },
          description:
            'Comma-separated optional expansions. Supported value today: AVAILABILITY. This may expand with more include values in the future.',
        },
        product: {
          type: 'array',
          items: {
            $ref: '#/$defs/CpuProduct',
          },
          example: ['POD', 'SERVERLESS'],
          description:
            'Comma-separated availability product contexts. Supported values for CPUs: POD, SERVERLESS. Required with include=AVAILABILITY, and valid only with it (400 either way). There is no default: availability differs by product.',
        },
        vcpuCount: {
          type: 'integer',
          minimum: 2,
          description:
            'Availability vCPU count. Valid only with include=AVAILABILITY. Must be a power of two.',
        },
      },
      required: ['id'],
      $defs: {
        CatalogInclude: {
          type: 'string',
          description:
            'Catalog include expansion. Only AVAILABILITY is supported today; additional include values may be added in the future.',
          enum: ['AVAILABILITY'],
        },
        CpuProduct: {
          type: 'string',
          description:
            'CPU catalog product availability context. Availability is product-specific, so this is required whenever availability is requested.',
          enum: ['POD', 'SERVERLESS'],
        },
      },
    },
  },
  {
    name: 'get-data-center',
    title: 'Get data center',
    operationId: 'getDataCenter',
    description:
      'Get a data center. Returns a single data center. Availability is included only when requested with include=GPU_AVAILABILITY or include=CPU_AVAILABILITY.',
    method: 'GET',
    path: '/v2/catalog/datacenters/{id}',
    params: [
      {
        name: 'id',
        location: 'path',
      },
      {
        name: 'include',
        location: 'query',
        explode: false,
      },
    ],
    hasBody: false,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
        },
        include: {
          type: 'array',
          items: {
            $ref: '#/$defs/DataCenterInclude',
          },
          example: ['GPU_AVAILABILITY'],
          description:
            'Comma-separated optional expansions. Supported value: GPU_AVAILABILITY, CPU_AVAILABILITY.',
        },
      },
      required: ['id'],
      $defs: {
        DataCenterInclude: {
          type: 'string',
          description: 'Data center catalog availability expansion.',
          enum: ['GPU_AVAILABILITY', 'CPU_AVAILABILITY'],
        },
      },
    },
  },
  {
    name: 'get-endpoint',
    title: 'Get endpoint',
    operationId: 'getEndpoint',
    description:
      'Get a serverless endpoint. Returns a single serverless endpoint by ID.',
    method: 'GET',
    path: '/v2/serverless/{id}',
    params: [
      {
        name: 'id',
        location: 'path',
      },
    ],
    hasBody: false,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Serverless endpoint identifier',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'get-endpoint-build',
    title: 'Get endpoint build',
    operationId: 'getEndpointBuild',
    description:
      "Get a serverless endpoint build. Returns one of the endpoint's GitHub builds by id, regardless of age — no need to page through `GET /v2/serverless/{id}/builds` to reach it.",
    method: 'GET',
    path: '/v2/serverless/{id}/builds/{buildId}',
    params: [
      {
        name: 'id',
        location: 'path',
      },
      {
        name: 'buildId',
        location: 'path',
      },
    ],
    hasBody: false,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Serverless endpoint identifier',
        },
        buildId: {
          type: 'string',
          description:
            "GitHub build identifier (from `list-endpoint-builds` or a release's `buildId`)",
        },
      },
      required: ['id', 'buildId'],
    },
  },
  {
    name: 'get-global-volume',
    title: 'Get global volume',
    operationId: 'getGlobalVolume',
    description: 'Get a global volume. Returns a single global volume by ID.',
    method: 'GET',
    path: '/v2/global-volumes/{id}',
    params: [
      {
        name: 'id',
        location: 'path',
      },
    ],
    hasBody: false,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Global volume identifier',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'get-gpu-type',
    title: 'Get GPU type',
    operationId: 'getGpuType',
    description:
      'Get a GPU type. Returns a single GPU type with pricing. Availability details are included only when requested with include=AVAILABILITY, which requires `product` — stock differs by product context.',
    method: 'GET',
    path: '/v2/catalog/gpus/{id}',
    params: [
      {
        name: 'id',
        location: 'path',
      },
      {
        name: 'include',
        location: 'query',
        explode: false,
      },
      {
        name: 'product',
        location: 'query',
        explode: false,
      },
      {
        name: 'count',
        location: 'query',
      },
      {
        name: 'cloud',
        location: 'query',
      },
      {
        name: 'countryCodes',
        location: 'query',
        explode: false,
      },
      {
        name: 'cudaVersions',
        location: 'query',
        explode: false,
      },
      {
        name: 'minCudaVersion',
        location: 'query',
      },
    ],
    hasBody: false,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
        },
        include: {
          type: 'array',
          maxItems: 1,
          items: {
            $ref: '#/$defs/CatalogInclude',
          },
          description:
            'Comma-separated optional expansions. Supported value today: AVAILABILITY. This may expand with more include values in the future.',
        },
        product: {
          type: 'array',
          items: {
            $ref: '#/$defs/Product',
          },
          description:
            'Comma-separated availability product contexts. Supported values: POD, CLUSTER, SERVERLESS. Required with include=AVAILABILITY, and valid only with it (400 either way).',
        },
        count: {
          type: 'integer',
          minimum: 1,
          default: 1,
          description:
            'GPU count for availability and lowest-price calculations. Valid only with include=AVAILABILITY. Defaults to 1.',
        },
        cloud: {
          $ref: '#/$defs/GpuCloudFilter',
          description:
            'Cloud type for availability and lowest-price calculations. Valid only with include=AVAILABILITY. Supported values: SECURE, COMMUNITY. Upstream default when omitted: SECURE.',
          type: 'string',
        },
        countryCodes: {
          type: 'array',
          items: {
            type: 'string',
            pattern: '^[A-Z]{2}$',
          },
          description:
            'Comma-separated ISO 3166-1 alpha-2 country codes, uppercase, to constrain availability to — e.g. FR or FR,DE. Values within this filter use OR semantics. Valid only with include=AVAILABILITY; a malformed entry is a 422.',
        },
        cudaVersions: {
          type: 'array',
          items: {
            type: 'string',
            pattern: '^\\d+\\.\\d+$',
          },
          description:
            'Comma-separated CUDA versions to scope availability and lowest-price calculations to, matched exactly. Format: major.minor, e.g. 12.8 — a bare major is rejected here because it identifies no version.',
        },
        minCudaVersion: {
          type: 'string',
          pattern: '^\\d+(\\.\\d+)?$',
          description:
            'Lowest acceptable CUDA version to scope availability and lowest-price calculations to, compared numerically.',
        },
      },
      required: ['id'],
      $defs: {
        CatalogInclude: {
          type: 'string',
          description:
            'Catalog include expansion. Only AVAILABILITY is supported today; additional include values may be added in the future.',
          enum: ['AVAILABILITY'],
        },
        GpuCloudFilter: {
          type: 'string',
          description: 'GPU availability cloud filter.',
          enum: ['SECURE', 'COMMUNITY'],
        },
        Product: {
          type: 'string',
          description:
            'Catalog product availability context. Availability is product-specific, so this is required whenever availability is requested.',
          enum: ['POD', 'CLUSTER', 'SERVERLESS'],
        },
      },
    },
  },
  {
    name: 'get-network-volume',
    title: 'Get network volume',
    operationId: 'getNetworkVolume',
    description: 'Get a network volume. Returns a single network volume by ID.',
    method: 'GET',
    path: '/v2/network-volumes/{id}',
    params: [
      {
        name: 'id',
        location: 'path',
      },
    ],
    hasBody: false,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Network volume identifier',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'get-organization',
    title: 'Get organization',
    operationId: 'getOrganization',
    description:
      "Get your current organization. Returns the authenticated caller's current organization. Organization context comes from the caller's membership; no organization selector is required. Returns 404 when the caller does not belong to an organization, or 403 when organizations are unavailable to the caller.",
    method: 'GET',
    path: '/v2/organization',
    params: [],
    hasBody: false,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get-pod',
    title: 'Get Pod',
    operationId: 'getPod',
    description: 'Get a pod. Returns a single pod by ID.',
    method: 'GET',
    path: '/v2/pods/{id}',
    params: [
      {
        name: 'id',
        location: 'path',
      },
    ],
    hasBody: false,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Pod identifier',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'get-registry',
    title: 'Get registry credential',
    operationId: 'getRegistry',
    description:
      'Get a container registry credential. Returns a single container registry credential by ID. `username` and `password` are never included in the response — credentials are write-only, matching `createRegistry`.',
    method: 'GET',
    path: '/v2/registries/{id}',
    params: [
      {
        name: 'id',
        location: 'path',
      },
    ],
    hasBody: false,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'get-secret',
    title: 'Get secret',
    operationId: 'getSecret',
    description:
      "Get a secret. Returns a single secret's metadata by ID. The value is write-only and never returned.",
    method: 'GET',
    path: '/v2/account/secrets/{id}',
    params: [
      {
        name: 'id',
        location: 'path',
      },
    ],
    hasBody: false,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Secret identifier',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'get-ssh-keys',
    title: 'Get SSH keys',
    operationId: 'getSshKeys',
    description:
      "List registered SSH public keys. Returns the account's registered SSH public keys — the keys provisioned into pods created with `startSsh` and used to authenticate the SSH connections reported in a pod's `ssh` block.",
    method: 'GET',
    path: '/v2/account/ssh-keys',
    params: [],
    hasBody: false,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get-template',
    title: 'Get template',
    operationId: 'getTemplate',
    description:
      'Get a template. Returns the full configuration of a single template by ID. Serves both templates you own and public catalog templates — everything you can read. Updates and deletes remain restricted to templates you own.',
    method: 'GET',
    path: '/v2/templates/{id}',
    params: [
      {
        name: 'id',
        location: 'path',
      },
    ],
    hasBody: false,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'list-billing',
    title: 'List billing',
    operationId: 'listBilling',
    description:
      "Get aggregated billing history. Returns time-bucketed total spend across all billable Runpod resources for the authenticated user. Use startTime/endTime with bucketSize for an explicit range, or lastN with bucketSize for the most recent buckets. Each record reports one bucket's total plus pod, serverless, storage, public endpoint, and Instant Cluster cost components. The metadata block echoes the resolved query window, record count, and totals across all returned buckets.",
    method: 'GET',
    path: '/v2/billing',
    params: [
      {
        name: 'startTime',
        location: 'query',
      },
      {
        name: 'endTime',
        location: 'query',
      },
      {
        name: 'bucketSize',
        location: 'query',
      },
      {
        name: 'lastN',
        location: 'query',
      },
    ],
    hasBody: false,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        startTime: {
          type: 'string',
          format: 'date-time',
          description:
            'Start of the billing period (RFC 3339). Defaults to 30 days ago.',
        },
        endTime: {
          type: 'string',
          format: 'date-time',
          description:
            'End of the billing period (RFC 3339), exclusive. Defaults to now. Snapped up to the end of the bucketSize bucket it lands in (unless already on a boundary) so the window aligns with the returned records.',
        },
        bucketSize: {
          $ref: '#/$defs/BillingBucketSize',
          description: 'Length of each billing time bucket. Defaults to day.',
          type: 'string',
        },
        lastN: {
          type: 'integer',
          minimum: 1,
          description:
            'Return the last N buckets of bucketSize, ending with the current (in-progress) bucket — e.g. lastN=100 with bucketSize=day is "last 100 days".',
        },
      },
      $defs: {
        BillingBucketSize: {
          type: 'string',
          enum: ['hour', 'day', 'week', 'month', 'year'],
          'x-enum-varnames': [
            'BillingBucketSizeHour',
            'BillingBucketSizeDay',
            'BillingBucketSizeWeek',
            'BillingBucketSizeMonth',
            'BillingBucketSizeYear',
          ],
          default: 'day',
          description: 'Length of each billing time bucket.',
          examples: ['day'],
        },
      },
    },
  },
  {
    name: 'list-cluster-billing',
    title: 'List cluster billing',
    operationId: 'listClusterBilling',
    description:
      'Get cluster billing history. Returns Cluster billing history for the authenticated user, split into time buckets by startTime/endTime with bucketSize or by lastN recent buckets. Use clusterId to filter to one cluster; without it, records are emitted per cluster per bucket. Each record includes GPU compute, disk, inter-node networking, and total amounts. Clusters are GPU-only, so no CPU cost component is returned.',
    method: 'GET',
    path: '/v2/billing/clusters',
    params: [
      {
        name: 'startTime',
        location: 'query',
      },
      {
        name: 'endTime',
        location: 'query',
      },
      {
        name: 'bucketSize',
        location: 'query',
      },
      {
        name: 'lastN',
        location: 'query',
      },
      {
        name: 'clusterId',
        location: 'query',
      },
    ],
    hasBody: false,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        startTime: {
          type: 'string',
          format: 'date-time',
          description:
            'Start of the billing period (RFC 3339). Defaults to 30 days ago.',
        },
        endTime: {
          type: 'string',
          format: 'date-time',
          description:
            'End of the billing period (RFC 3339), exclusive. Defaults to now. Snapped up to the end of the bucketSize bucket it lands in (unless already on a boundary) so the window aligns with the returned records.',
        },
        bucketSize: {
          $ref: '#/$defs/BillingBucketSize',
          description: 'Length of each billing time bucket. Defaults to day.',
          type: 'string',
        },
        lastN: {
          type: 'integer',
          minimum: 1,
          description:
            'Return the last N buckets of bucketSize, ending with the current (in-progress) bucket — e.g. lastN=100 with bucketSize=day is "last 100 days".',
        },
        clusterId: {
          type: 'string',
          description: 'Filter to a specific cluster.',
        },
      },
      $defs: {
        BillingBucketSize: {
          type: 'string',
          enum: ['hour', 'day', 'week', 'month', 'year'],
          'x-enum-varnames': [
            'BillingBucketSizeHour',
            'BillingBucketSizeDay',
            'BillingBucketSizeWeek',
            'BillingBucketSizeMonth',
            'BillingBucketSizeYear',
          ],
          default: 'day',
          description: 'Length of each billing time bucket.',
          examples: ['day'],
        },
      },
    },
  },
  {
    name: 'list-cluster-pods',
    title: 'List cluster Pods',
    operationId: 'listClusterPods',
    description:
      "List a cluster's pods. Returns the full member pods of a cluster. The cluster summary (`GET /v2/clusters/{id}`) carries only aggregate pod counts; this endpoint returns each member as a complete Pod object.",
    method: 'GET',
    path: '/v2/clusters/{id}/pods',
    params: [
      {
        name: 'id',
        location: 'path',
      },
    ],
    hasBody: false,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Cluster identifier',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'list-clusters',
    title: 'List clusters',
    operationId: 'listClusters',
    description:
      'List clusters. Returns clusters owned by the authenticated user, cursor-paginated newest-first; an omitted `limit` defaults to 1000. Follow `pagination.nextCursor` until `hasNextPage` is false.',
    method: 'GET',
    path: '/v2/clusters',
    params: [
      {
        name: 'cursor',
        location: 'query',
      },
      {
        name: 'limit',
        location: 'query',
      },
    ],
    hasBody: false,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        cursor: {
          type: 'string',
          minLength: 1,
          description:
            "Opaque resume cursor — pass the previous response's `pagination.nextCursor` through verbatim; omit for the first page. A cursor is only valid for the operation and parameters that issued it; a malformed or foreign cursor is rejected.",
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 1000,
          description: 'Page size, 1–1000. Defaults to 1000 when omitted.',
        },
      },
    },
  },
  {
    name: 'list-cpu-types',
    title: 'List CPU types',
    operationId: 'listCpuTypes',
    description:
      'List CPU types. Returns available CPU flavors. Availability is included only when requested with include=AVAILABILITY, which requires `product` — stock differs by product context.',
    method: 'GET',
    path: '/v2/catalog/cpus',
    params: [
      {
        name: 'include',
        location: 'query',
        explode: false,
      },
      {
        name: 'product',
        location: 'query',
        explode: false,
      },
      {
        name: 'vcpuCount',
        location: 'query',
      },
    ],
    hasBody: false,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        include: {
          type: 'array',
          maxItems: 1,
          items: {
            $ref: '#/$defs/CatalogInclude',
          },
          description:
            'Comma-separated optional expansions. Supported value today: AVAILABILITY. This may expand with more include values in the future.',
        },
        product: {
          type: 'array',
          items: {
            $ref: '#/$defs/CpuProduct',
          },
          example: ['POD', 'SERVERLESS'],
          description:
            'Comma-separated availability product contexts. Supported values for CPUs: POD, SERVERLESS. Required with include=AVAILABILITY, and valid only with it (400 either way). There is no default: availability differs by product.',
        },
        vcpuCount: {
          type: 'integer',
          minimum: 2,
          description:
            'Availability vCPU count. Valid only with include=AVAILABILITY. Must be a power of two.',
        },
      },
      $defs: {
        CatalogInclude: {
          type: 'string',
          description:
            'Catalog include expansion. Only AVAILABILITY is supported today; additional include values may be added in the future.',
          enum: ['AVAILABILITY'],
        },
        CpuProduct: {
          type: 'string',
          description:
            'CPU catalog product availability context. Availability is product-specific, so this is required whenever availability is requested.',
          enum: ['POD', 'SERVERLESS'],
        },
      },
    },
  },
  {
    name: 'list-data-centers',
    title: 'List data centers',
    operationId: 'listDataCenters',
    description:
      'List data centers. Returns available data center locations with region, compliance, supported network volume tiers, and global networking support. Use include=GPU_AVAILABILITY or include=CPU_AVAILABILITY to add per-resource availability arrays to each data center. The regions, networkVolumeTypes, compliance, and globalNetwork query parameters filter the list before it is returned.',
    method: 'GET',
    path: '/v2/catalog/datacenters',
    params: [
      {
        name: 'include',
        location: 'query',
        explode: false,
      },
      {
        name: 'regions',
        location: 'query',
        explode: false,
      },
      {
        name: 'networkVolumeTypes',
        location: 'query',
        explode: false,
      },
      {
        name: 'compliance',
        location: 'query',
        explode: false,
      },
      {
        name: 'globalNetwork',
        location: 'query',
      },
    ],
    hasBody: false,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        include: {
          type: 'array',
          items: {
            $ref: '#/$defs/DataCenterInclude',
          },
          example: ['GPU_AVAILABILITY'],
          description:
            'Comma-separated optional expansions. Supported value: GPU_AVAILABILITY, CPU_AVAILABILITY.',
        },
        regions: {
          type: 'array',
          items: {
            $ref: '#/$defs/DataCenterRegion',
          },
          example: ['EUROPE', 'ASIA'],
          description:
            'Comma-separated DataCenterRegion enum values. Values within this filter use OR semantics. Different filter families combine with AND.',
        },
        networkVolumeTypes: {
          type: 'array',
          items: {
            $ref: '#/$defs/VolumeType',
          },
          example: ['STANDARD', 'HIGH_PERFORMANCE'],
          description:
            'Comma-separated volume types. Supported values: STANDARD, HIGH_PERFORMANCE. Values within this filter use AND semantics; volumes=STANDARD,HIGH_PERFORMANCE requires both storage types. Different filter families combine with AND.',
        },
        compliance: {
          type: 'array',
          items: {
            $ref: '#/$defs/Compliance',
          },
          example: ['GDPR', 'SOC_2_TYPE_2'],
          description:
            'Comma-separated Compliance enum values. Values within this filter use AND semantics; compliance=GDPR,SOC_2_TYPE_2 requires both certifications. Different filter families combine with AND.',
        },
        globalNetwork: {
          type: 'boolean',
          description:
            'Filter by global networking support. true returns only data centers that support global networking; false only those that do not. Different filter families combine with AND.',
        },
      },
      $defs: {
        Compliance: {
          type: 'string',
          description: 'Compliance certifications.',
          enum: [
            'GDPR',
            'ISO_IEC_27001',
            'ISO_14001',
            'PCI_DSS',
            'HITRUST',
            'SOC_1_TYPE_2',
            'SOC_2_TYPE_2',
            'SOC_3_TYPE_2',
            'ITAR',
            'FISMA_HIGH',
            'HIPAA',
            'RENEWABLE',
          ],
        },
        DataCenterInclude: {
          type: 'string',
          description: 'Data center catalog availability expansion.',
          enum: ['GPU_AVAILABILITY', 'CPU_AVAILABILITY'],
        },
        DataCenterRegion: {
          type: 'string',
          description: 'Continental region containing the data center.',
          examples: ['EUROPE'],
          enum: [
            'NORTH_AMERICA',
            'SOUTH_AMERICA',
            'EUROPE',
            'ASIA',
            'MIDDLE_EAST',
            'AFRICA',
            'OCEANIA',
            'ANTARCTICA',
            'UNKNOWN',
          ],
        },
        VolumeType: {
          type: 'string',
          description: 'Data center network volume storage type.',
          enum: ['STANDARD', 'HIGH_PERFORMANCE'],
        },
      },
    },
  },
  {
    name: 'list-delegations',
    title: 'List ECR delegations',
    operationId: 'listDelegations',
    description: 'List all ECR delegations',
    method: 'GET',
    path: '/v2/registries/delegations',
    params: [],
    hasBody: false,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'list-endpoint-billing',
    title: 'List endpoint billing',
    operationId: 'listEndpointBilling',
    description:
      'Get public endpoint billing history. Returns Runpod public endpoint billing history for the authenticated user, split into time buckets by startTime/endTime with bucketSize or by lastN recent buckets. Each record reports the endpoint total for one bucket, and metadata echoes the resolved query window, record count, and total endpoint amount across all returned records.',
    method: 'GET',
    path: '/v2/billing/endpoints',
    params: [
      {
        name: 'startTime',
        location: 'query',
      },
      {
        name: 'endTime',
        location: 'query',
      },
      {
        name: 'bucketSize',
        location: 'query',
      },
      {
        name: 'lastN',
        location: 'query',
      },
    ],
    hasBody: false,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        startTime: {
          type: 'string',
          format: 'date-time',
          description:
            'Start of the billing period (RFC 3339). Defaults to 30 days ago.',
        },
        endTime: {
          type: 'string',
          format: 'date-time',
          description:
            'End of the billing period (RFC 3339), exclusive. Defaults to now. Snapped up to the end of the bucketSize bucket it lands in (unless already on a boundary) so the window aligns with the returned records.',
        },
        bucketSize: {
          $ref: '#/$defs/BillingBucketSize',
          description: 'Length of each billing time bucket. Defaults to day.',
          type: 'string',
        },
        lastN: {
          type: 'integer',
          minimum: 1,
          description:
            'Return the last N buckets of bucketSize, ending with the current (in-progress) bucket — e.g. lastN=100 with bucketSize=day is "last 100 days".',
        },
      },
      $defs: {
        BillingBucketSize: {
          type: 'string',
          enum: ['hour', 'day', 'week', 'month', 'year'],
          'x-enum-varnames': [
            'BillingBucketSizeHour',
            'BillingBucketSizeDay',
            'BillingBucketSizeWeek',
            'BillingBucketSizeMonth',
            'BillingBucketSizeYear',
          ],
          default: 'day',
          description: 'Length of each billing time bucket.',
          examples: ['day'],
        },
      },
    },
  },
  {
    name: 'list-endpoint-builds',
    title: 'List endpoint builds',
    operationId: 'listEndpointBuilds',
    description:
      "List serverless endpoint builds. Returns the endpoint's GitHub build history, newest first (Runpod GitHub-build integration), cursor-paginated; an omitted `limit` defaults to 100, so a bare request returns at most the 100 most recent builds. Any build can also be fetched by id via `GET /v2/serverless/{id}/builds/{buildId}`. Stream a build's logs via `/v2/serverless/{id}/builds/{buildId}/logs`.",
    method: 'GET',
    path: '/v2/serverless/{id}/builds',
    params: [
      {
        name: 'id',
        location: 'path',
      },
      {
        name: 'cursor',
        location: 'query',
      },
      {
        name: 'limit',
        location: 'query',
      },
    ],
    hasBody: false,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Serverless endpoint identifier',
        },
        cursor: {
          type: 'string',
          minLength: 1,
          description:
            "Opaque resume cursor — pass the previous response's `pagination.nextCursor` through verbatim; omit for the first page. A cursor is only valid for the operation and parameters that issued it; a malformed or foreign cursor is rejected.",
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Page size, 1–100. Defaults to 100 when omitted.',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'list-endpoint-releases',
    title: 'List endpoint releases',
    operationId: 'listEndpointReleases',
    description:
      "List serverless endpoint releases. Returns the endpoint's release history (newest first) plus a rollout summary of how many workers are running the current version. Each release is a versioned configuration snapshot with a `diff` of what changed; build-driven releases carry a `buildId` (fetch build detail via the builds sub-routes). Releases are cursor-paginated newest-first; an omitted `limit` defaults to 1000. The rollout summary always describes the endpoint's current state, independent of the page requested.",
    method: 'GET',
    path: '/v2/serverless/{id}/releases',
    params: [
      {
        name: 'id',
        location: 'path',
      },
      {
        name: 'cursor',
        location: 'query',
      },
      {
        name: 'limit',
        location: 'query',
      },
    ],
    hasBody: false,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Serverless endpoint identifier',
        },
        cursor: {
          type: 'string',
          minLength: 1,
          description:
            "Opaque resume cursor — pass the previous response's `pagination.nextCursor` through verbatim; omit for the first page. A cursor is only valid for the operation and parameters that issued it; a malformed or foreign cursor is rejected.",
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 1000,
          description: 'Page size, 1–1000. Defaults to 1000 when omitted.',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'list-endpoint-workers',
    title: 'List endpoint workers',
    operationId: 'listEndpointWorkers',
    description:
      "List serverless endpoint workers. Lists the active workers for a serverless endpoint. **Returns.** A `200` with a `ListEndpointWorkersResponse`: a `workers` array (one entry per active worker, each carrying its `id`, `status`, and runtime details) plus a `summary` of worker counts grouped by status. Only currently active workers are included; scaled-down workers are not returned. **How `status` is determined.** Each worker's `status` is derived by reconciling the worker pod's lifecycle status with the endpoint's live job-queue view (which workers are actively serving requests). When the job-queue view is unavailable, the response degrades gracefully: the shape is unchanged, but each `status` and the summary counts fall back to pod lifecycle alone.",
    method: 'GET',
    path: '/v2/serverless/{id}/workers',
    params: [
      {
        name: 'id',
        location: 'path',
      },
    ],
    hasBody: false,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Serverless endpoint identifier',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'list-global-volumes',
    title: 'List global volumes',
    operationId: 'listGlobalVolumes',
    description:
      'List global volumes. Returns global volumes owned by the authenticated user, cursor-paginated newest-first; an omitted `limit` defaults to 1000. Follow `pagination.nextCursor` until `hasNextPage` is false.',
    method: 'GET',
    path: '/v2/global-volumes',
    params: [
      {
        name: 'cursor',
        location: 'query',
      },
      {
        name: 'limit',
        location: 'query',
      },
    ],
    hasBody: false,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        cursor: {
          type: 'string',
          minLength: 1,
          description:
            "Opaque resume cursor — pass the previous response's `pagination.nextCursor` through verbatim; omit for the first page. A cursor is only valid for the operation and parameters that issued it; a malformed or foreign cursor is rejected.",
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 1000,
          description: 'Page size, 1–1000. Defaults to 1000 when omitted.',
        },
      },
    },
  },
  {
    name: 'list-gpu-types',
    title: 'List GPU types',
    operationId: 'listGpuTypes',
    description:
      'List GPU types. Returns available GPU types with pricing. Availability is included only when requested with include=AVAILABILITY, which requires `product` — stock differs by product context. With countryCodes, the list is narrowed to GPU types deployable in those countries, so "this geography + this chip" resolves in one read.',
    method: 'GET',
    path: '/v2/catalog/gpus',
    params: [
      {
        name: 'include',
        location: 'query',
        explode: false,
      },
      {
        name: 'product',
        location: 'query',
        explode: false,
      },
      {
        name: 'count',
        location: 'query',
      },
      {
        name: 'cloud',
        location: 'query',
      },
      {
        name: 'countryCodes',
        location: 'query',
        explode: false,
      },
      {
        name: 'cudaVersions',
        location: 'query',
        explode: false,
      },
      {
        name: 'minCudaVersion',
        location: 'query',
      },
    ],
    hasBody: false,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        include: {
          type: 'array',
          maxItems: 1,
          items: {
            $ref: '#/$defs/CatalogInclude',
          },
          description:
            'Comma-separated optional expansions. Supported value today: AVAILABILITY. This may expand with more include values in the future.',
        },
        product: {
          type: 'array',
          items: {
            $ref: '#/$defs/Product',
          },
          description:
            'Comma-separated availability product contexts. Supported values: POD, CLUSTER, SERVERLESS. Required with include=AVAILABILITY, and valid only with it (400 either way).',
        },
        count: {
          type: 'integer',
          minimum: 1,
          default: 1,
          description:
            'GPU count for availability and lowest-price calculations. Valid only with include=AVAILABILITY. Defaults to 1.',
        },
        cloud: {
          $ref: '#/$defs/GpuCloudFilter',
          description:
            'Cloud type for availability and lowest-price calculations. Valid only with include=AVAILABILITY. Supported values: SECURE, COMMUNITY. Upstream default when omitted: SECURE.',
          type: 'string',
        },
        countryCodes: {
          type: 'array',
          items: {
            type: 'string',
            pattern: '^[A-Z]{2}$',
          },
          description:
            'Comma-separated ISO 3166-1 alpha-2 country codes, uppercase, to constrain availability to — e.g. FR or FR,DE. Values within this filter use OR semantics. Valid only with include=AVAILABILITY; a malformed entry is a 422.',
        },
        cudaVersions: {
          type: 'array',
          items: {
            type: 'string',
            pattern: '^\\d+\\.\\d+$',
          },
          description:
            'Comma-separated CUDA versions to scope availability and lowest-price calculations to, matched exactly. Format: major.minor, e.g. 12.8 — a bare major is rejected here because it identifies no version.',
        },
        minCudaVersion: {
          type: 'string',
          pattern: '^\\d+(\\.\\d+)?$',
          description:
            'Lowest acceptable CUDA version to scope availability and lowest-price calculations to, compared numerically.',
        },
      },
      $defs: {
        CatalogInclude: {
          type: 'string',
          description:
            'Catalog include expansion. Only AVAILABILITY is supported today; additional include values may be added in the future.',
          enum: ['AVAILABILITY'],
        },
        GpuCloudFilter: {
          type: 'string',
          description: 'GPU availability cloud filter.',
          enum: ['SECURE', 'COMMUNITY'],
        },
        Product: {
          type: 'string',
          description:
            'Catalog product availability context. Availability is product-specific, so this is required whenever availability is requested.',
          enum: ['POD', 'CLUSTER', 'SERVERLESS'],
        },
      },
    },
  },
  {
    name: 'list-network-volume-billing',
    title: 'List network volume billing',
    operationId: 'listNetworkVolumeBilling',
    description:
      'Get network volume billing history. Returns network volume billing history for the authenticated user, split into time buckets by startTime/endTime with bucketSize or by lastN recent buckets. Use networkVolumeId to filter to one volume; without it, records are emitted per volume per bucket. Each record includes standard storage, high-performance storage, and total amounts, while metadata reports the resolved query, distinct volume count, and totals across the returned records.',
    method: 'GET',
    path: '/v2/billing/network-volumes',
    params: [
      {
        name: 'startTime',
        location: 'query',
      },
      {
        name: 'endTime',
        location: 'query',
      },
      {
        name: 'bucketSize',
        location: 'query',
      },
      {
        name: 'lastN',
        location: 'query',
      },
      {
        name: 'networkVolumeId',
        location: 'query',
      },
    ],
    hasBody: false,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        startTime: {
          type: 'string',
          format: 'date-time',
          description:
            'Start of the billing period (RFC 3339). Defaults to 30 days ago.',
        },
        endTime: {
          type: 'string',
          format: 'date-time',
          description:
            'End of the billing period (RFC 3339), exclusive. Defaults to now. Snapped up to the end of the bucketSize bucket it lands in (unless already on a boundary) so the window aligns with the returned records.',
        },
        bucketSize: {
          $ref: '#/$defs/BillingBucketSize',
          description: 'Length of each billing time bucket. Defaults to day.',
          type: 'string',
        },
        lastN: {
          type: 'integer',
          minimum: 1,
          description:
            'Return the last N buckets of bucketSize, ending with the current (in-progress) bucket — e.g. lastN=100 with bucketSize=day is "last 100 days".',
        },
        networkVolumeId: {
          type: 'string',
          description: 'Filter to a specific network volume.',
        },
      },
      $defs: {
        BillingBucketSize: {
          type: 'string',
          enum: ['hour', 'day', 'week', 'month', 'year'],
          'x-enum-varnames': [
            'BillingBucketSizeHour',
            'BillingBucketSizeDay',
            'BillingBucketSizeWeek',
            'BillingBucketSizeMonth',
            'BillingBucketSizeYear',
          ],
          default: 'day',
          description: 'Length of each billing time bucket.',
          examples: ['day'],
        },
      },
    },
  },
  {
    name: 'list-network-volumes',
    title: 'List network volumes',
    operationId: 'listNetworkVolumes',
    description:
      'List network volumes. Returns network volumes owned by the authenticated user, cursor-paginated newest-first; an omitted `limit` defaults to 1000. Follow `pagination.nextCursor` until `hasNextPage` is false.',
    method: 'GET',
    path: '/v2/network-volumes',
    params: [
      {
        name: 'cursor',
        location: 'query',
      },
      {
        name: 'limit',
        location: 'query',
      },
    ],
    hasBody: false,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        cursor: {
          type: 'string',
          minLength: 1,
          description:
            "Opaque resume cursor — pass the previous response's `pagination.nextCursor` through verbatim; omit for the first page. A cursor is only valid for the operation and parameters that issued it; a malformed or foreign cursor is rejected.",
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 1000,
          description: 'Page size, 1–1000. Defaults to 1000 when omitted.',
        },
      },
    },
  },
  {
    name: 'list-pod-billing',
    title: 'List Pod billing',
    operationId: 'listPodBilling',
    description:
      'Get pod billing history. Returns pod-only billing detail for the authenticated user, split into time buckets by startTime/endTime with bucketSize or by lastN recent buckets. Use podId to narrow the response to one GPU or CPU pod; without it, records are emitted per pod per bucket. Each record includes podId, GPU, CPU, disk, and total amounts, while metadata echoes the resolved query and totals across the pod records. Use listBilling when you need aggregate spend across every billable resource family.',
    method: 'GET',
    path: '/v2/billing/pods',
    params: [
      {
        name: 'startTime',
        location: 'query',
      },
      {
        name: 'endTime',
        location: 'query',
      },
      {
        name: 'bucketSize',
        location: 'query',
      },
      {
        name: 'lastN',
        location: 'query',
      },
      {
        name: 'podId',
        location: 'query',
      },
    ],
    hasBody: false,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        startTime: {
          type: 'string',
          format: 'date-time',
          description:
            'Start of the billing period (RFC 3339). Defaults to 30 days ago.',
        },
        endTime: {
          type: 'string',
          format: 'date-time',
          description:
            'End of the billing period (RFC 3339), exclusive. Defaults to now. Snapped up to the end of the bucketSize bucket it lands in (unless already on a boundary) so the window aligns with the returned records.',
        },
        bucketSize: {
          $ref: '#/$defs/BillingBucketSize',
          description: 'Length of each billing time bucket. Defaults to day.',
          type: 'string',
        },
        lastN: {
          type: 'integer',
          minimum: 1,
          description:
            'Return the last N buckets of bucketSize, ending with the current (in-progress) bucket — e.g. lastN=100 with bucketSize=day is "last 100 days".',
        },
        podId: {
          type: 'string',
          description: 'Filter to a specific pod (GPU or CPU).',
        },
      },
      $defs: {
        BillingBucketSize: {
          type: 'string',
          enum: ['hour', 'day', 'week', 'month', 'year'],
          'x-enum-varnames': [
            'BillingBucketSizeHour',
            'BillingBucketSizeDay',
            'BillingBucketSizeWeek',
            'BillingBucketSizeMonth',
            'BillingBucketSizeYear',
          ],
          default: 'day',
          description: 'Length of each billing time bucket.',
          examples: ['day'],
        },
      },
    },
  },
  {
    name: 'list-pods',
    title: 'List Pods',
    operationId: 'listPods',
    description:
      'List pods. Returns pods owned by the authenticated user. Cluster member pods are excluded by default; set `includeClusterPods=true` to include them (each carries a non-null `cluster` membership block). Results are cursor-paginated newest-first; an omitted `limit` defaults to 1000. The cluster-member exclusion is applied before the page is cut, so a page holds `limit` pods whenever that many remain. Follow `pagination.nextCursor` until `hasNextPage` is false.',
    method: 'GET',
    path: '/v2/pods',
    params: [
      {
        name: 'includeClusterPods',
        location: 'query',
      },
      {
        name: 'cursor',
        location: 'query',
      },
      {
        name: 'limit',
        location: 'query',
      },
    ],
    hasBody: false,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        includeClusterPods: {
          type: 'boolean',
          default: false,
          description:
            'Include cluster member pods in the result. Defaults to false.',
        },
        cursor: {
          type: 'string',
          minLength: 1,
          description:
            "Opaque resume cursor — pass the previous response's `pagination.nextCursor` through verbatim; omit for the first page. A cursor is only valid for the operation and parameters that issued it; a malformed or foreign cursor is rejected.",
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 1000,
          description: 'Page size, 1–1000. Defaults to 1000 when omitted.',
        },
      },
    },
  },
  {
    name: 'list-public-templates',
    title: 'List public templates',
    operationId: 'listPublicTemplates',
    description:
      "List public templates. Returns the public template catalog. `source` selects which slice: `official` (the default) is Runpod-curated templates, `verified` is community templates Runpod has verified, and `community` is everything else other users have shared publicly. Both pod and serverless templates appear — use each entry's `serverless` flag to tell them apart. `registry` is always null for templates you don't own. Your own templates (public or private) are managed under `/v2/templates`; fetch any individual template — catalog or owned — via `/v2/templates/{id}`. At most 100 templates are returned. Cursor pagination is not yet supported here; `pagination` is always the exhausted marker (`nextCursor: null`, `hasNextPage: false`).",
    method: 'GET',
    path: '/v2/catalog/templates',
    params: [
      {
        name: 'source',
        location: 'query',
      },
    ],
    hasBody: false,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          enum: ['official', 'verified', 'community'],
          default: 'official',
          description:
            'Which slice of the catalog to return: `official` for Runpod-curated templates (default), `verified` for Runpod-verified community templates, or `community` for all other publicly shared templates.',
        },
      },
    },
  },
  {
    name: 'list-registries',
    title: 'List registry credentials',
    operationId: 'listRegistries',
    description:
      'List container registries. Returns all container registry credentials owned by the authenticated user.',
    method: 'GET',
    path: '/v2/registries',
    params: [],
    hasBody: false,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'list-secrets',
    title: 'List secrets',
    operationId: 'listSecrets',
    description:
      "List secrets. Returns the account's secrets — encrypted strings referenced from pod, serverless, and template environment variables with the `{{ RUNPOD_SECRET_<name> }}` placeholder syntax, substituted with the secret's value when the pod or worker boots. Secret values are write-only and are never returned.",
    method: 'GET',
    path: '/v2/account/secrets',
    params: [
      {
        name: 'name',
        location: 'query',
      },
    ],
    hasBody: false,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'When provided, returns only the secret with this name (case-insensitive).',
        },
      },
    },
  },
  {
    name: 'list-serverless-billing',
    title: 'List Serverless billing',
    operationId: 'listServerlessBilling',
    description:
      'Get serverless billing history, split into time buckets. SIZE WARNING: with defaults this emits one record per endpoint PER BUCKET — on an account with many endpoints the response overflows the tool-result limit and becomes unusable. Always pass lastN: 1 (or a bucketSize spanning the whole window) for one record per endpoint, and serverlessId when you need one endpoint. Distinct from pod billing, which covers standalone pods.',
    directoryDescription:
      'Get Serverless billing history, split into time buckets. By default the response has one record per endpoint per bucket, which can be very large on accounts with many endpoints; lastN: 1 (or one bucket spanning the whole window) returns one record per endpoint, and serverlessId narrows it to a single endpoint. Pod billing is reported separately.',
    method: 'GET',
    path: '/v2/billing/serverless',
    params: [
      {
        name: 'startTime',
        location: 'query',
      },
      {
        name: 'endTime',
        location: 'query',
      },
      {
        name: 'bucketSize',
        location: 'query',
      },
      {
        name: 'lastN',
        location: 'query',
      },
      {
        name: 'serverlessId',
        location: 'query',
      },
    ],
    hasBody: false,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        startTime: {
          type: 'string',
          format: 'date-time',
          description:
            'Start of the billing period (RFC 3339). Defaults to 30 days ago.',
        },
        endTime: {
          type: 'string',
          format: 'date-time',
          description:
            'End of the billing period (RFC 3339), exclusive. Defaults to now. Snapped up to the end of the bucketSize bucket it lands in (unless already on a boundary) so the window aligns with the returned records.',
        },
        bucketSize: {
          $ref: '#/$defs/BillingBucketSize',
          description: 'Length of each billing time bucket. Defaults to day.',
          type: 'string',
        },
        lastN: {
          type: 'integer',
          minimum: 1,
          description:
            'Return the last N buckets of bucketSize, ending with the current (in-progress) bucket — e.g. lastN=100 with bucketSize=day is "last 100 days".',
        },
        serverlessId: {
          type: 'string',
          description: 'Filter to a specific serverless endpoint.',
        },
      },
      $defs: {
        BillingBucketSize: {
          type: 'string',
          enum: ['hour', 'day', 'week', 'month', 'year'],
          'x-enum-varnames': [
            'BillingBucketSizeHour',
            'BillingBucketSizeDay',
            'BillingBucketSizeWeek',
            'BillingBucketSizeMonth',
            'BillingBucketSizeYear',
          ],
          default: 'day',
          description: 'Length of each billing time bucket.',
          examples: ['day'],
        },
      },
    },
  },
  {
    name: 'pod-action',
    title: 'Start, stop, restart, or terminate a Pod',
    operationId: 'podAction',
    description:
      'Trigger a pod state transition. Triggers a state transition on a pod. Send a JSON body with a single `action` field, e.g. `{ "action": "stop" }`. Valid actions: - `start` — boot a stopped pod (`EXITED` or `ERROR`) back toward `RUNNING`. - `stop` — stop a running or provisioning pod, releasing GPU/CPU compute while keeping its disk. The pod moves to `EXITED`. - `restart` — restart a `RUNNING` pod\'s container in place. - `terminate` — permanently delete the pod and release its resources (equivalent to `deletePod`). Which actions are valid depends on the pod\'s current status, and the currently permitted set is published in the pod\'s `actions` field: `RUNNING` allows `stop`/`restart`/`terminate`; `EXITED` and `ERROR` allow `start`/`terminate`; `PROVISIONING` and `STARTING` allow `stop`/`terminate`. `start`, `stop`, and `restart` return `200` with the updated pod. `terminate` returns `204` with no body. Requesting an action that is not valid for the pod\'s current status returns `409`.',
    method: 'POST',
    path: '/v2/pods/{id}/action',
    params: [
      {
        name: 'id',
        location: 'path',
      },
    ],
    hasBody: true,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
        },
        body: {
          $ref: '#/$defs/PodActionRequest',
          type: 'object',
        },
      },
      required: ['id', 'body'],
      $defs: {
        PodAction: {
          type: 'string',
          description: 'State transition to trigger on a pod.',
          enum: ['start', 'stop', 'restart', 'terminate'],
        },
        PodActionRequest: {
          type: 'object',
          additionalProperties: false,
          required: ['action'],
          properties: {
            action: {
              $ref: '#/$defs/PodAction',
            },
          },
        },
      },
    },
  },
  {
    name: 'revoke-delegation',
    title: 'Revoke ECR delegation',
    operationId: 'revokeDelegation',
    description: 'Revoke an ECR delegation',
    method: 'DELETE',
    path: '/v2/registries/delegations/{id}',
    params: [
      {
        name: 'id',
        location: 'path',
      },
    ],
    hasBody: false,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'update-cluster',
    title: 'Update cluster',
    operationId: 'updateCluster',
    description:
      'Rename a cluster. Renames a cluster. This endpoint only changes the cluster name — compute shape, type, and container configuration are fixed at creation and cannot be updated.',
    method: 'PATCH',
    path: '/v2/clusters/{id}',
    params: [
      {
        name: 'id',
        location: 'path',
      },
    ],
    hasBody: true,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Cluster identifier',
        },
        body: {
          $ref: '#/$defs/UpdateClusterRequest',
          type: 'object',
        },
      },
      required: ['id', 'body'],
      $defs: {
        UpdateClusterRequest: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          description:
            'Request body for updating a cluster. Only the cluster name can be changed — this endpoint is a rename. Compute shape, type, and container configuration are fixed at creation.',
          properties: {
            name: {
              type: 'string',
              minLength: 1,
              examples: ['renamed-cluster'],
            },
          },
        },
      },
    },
  },
  {
    name: 'update-endpoint',
    title: 'Update endpoint',
    operationId: 'updateEndpoint',
    description:
      "Partially update a serverless endpoint (PATCH): only fields present in the body change, omitted ones are untouched, with one exception. DESTRUCTIVE GOTCHA: gpu.pools and gpu.excludedTypes are a single selection, so sending pools without excludedTypes clears any exclusions pinned elsewhere (the console or set-endpoint-gpus) — read the endpoint first with get-endpoint and resend excludedTypes if you still want them. An exclusion naming a type outside pools returns 400. A CUDA-only or count-only change does not need pools at all, so omit it unless you mean to replace the selection. Mutable fields: name, gpu, cpu, workers (min/max/idleTimeout), scaling (type plus queueDelay or requestCount), dataCenterIds, networkVolumes, timeout, flashboot, and the container settings (image, args, disk, ports, env, registry). cpu completely replaces a CPU endpoint's flavor selection. Compute family is immutable: gpu on a CPU endpoint, cpu on a GPU one, or both, returns 400. Effect timing differs by field — workers/scaling/timeout reach the autoscaler promptly, while container changes (image, env) cut a new release that rolls out as workers cycle, so in-flight workers keep the previous version. Track rollout with list-endpoint-releases.",
    directoryDescription:
      "Partially update a Serverless endpoint (PATCH): only fields present in the body change. gpu.pools and gpu.excludedTypes are one selection, so sending pools without excludedTypes clears existing exclusions; an exclusion naming a type outside pools returns 400, and a CUDA-only or count-only change does not need pools. Mutable fields: name, gpu, cpu, workers (min/max/idleTimeout), scaling (type plus queueDelay or requestCount), dataCenterIds, networkVolumes, timeout, flashboot, and the container settings (image, args, disk, ports, env, registry). cpu replaces a CPU endpoint's whole flavor selection. The compute family is fixed: gpu on a CPU endpoint, cpu on a GPU one, or both returns 400. Worker, scaling and timeout changes apply promptly; container changes (image, env) create a new release that rolls out as workers cycle, so in-flight workers keep the previous version.",
    method: 'PATCH',
    path: '/v2/serverless/{id}',
    params: [
      {
        name: 'id',
        location: 'path',
      },
    ],
    hasBody: true,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    schemaOnDemand: true,
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Serverless endpoint identifier',
        },
        body: {
          $ref: '#/$defs/UpdateEndpointRequest',
        },
      },
      required: ['id', 'body'],
      $defs: {
        BaseContainerConfig: {
          type: 'object',
          properties: {
            args: {
              type: 'string',
              description:
                'The container\'s command as one raw string: a bare shell string is treated as CMD and split into arguments; a JSON object `{"entrypoint":[...],"cmd":[...]}` sets either or both. Send `""` to clear; omit to leave unchanged.',
              examples: [
                '--model meta-llama/Llama-3-8B --max-model-len 8192',
                '{"entrypoint":["/bin/bash","-c"],"cmd":["python -u main.py"]}',
                '',
              ],
            },
            cmd: {
              type: 'array',
              items: {
                type: 'string',
              },
              description:
                'Container CMD in exec form: when the image defines an ENTRYPOINT, the argument list passed to it. Encoded into `args`; supply both only when they describe the same command. Send `[]` to clear; omit to leave unchanged.',
              examples: [
                ['--model', 'meta-llama/Llama-3-8B', '--max-model-len', '8192'],
              ],
            },
            entrypoint: {
              type: 'array',
              items: {
                type: 'string',
              },
              description:
                "Container ENTRYPOINT in exec form, overriding the image's own. Encoded into `args` field; supplying both is allowed only when they describe the same command. Send `[]` to clear, omit to leave unchanged.",
              examples: [['/bin/bash', '-c']],
            },
            disk: {
              type: 'integer',
              minimum: 1,
              description: 'Container disk in GB (ephemeral, wiped on restart)',
              examples: [50],
            },
            env: {
              type: 'object',
              additionalProperties: {
                type: 'string',
              },
              description: 'Environment variables as key-value pairs',
              examples: [
                {
                  JUPYTER_PASSWORD: 'hunter2',
                },
              ],
            },
            image: {
              type: 'string',
              description: 'Docker image reference',
              examples: ['runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404'],
            },
            ports: {
              type: 'array',
              description: 'Exposed ports, formatted as port/protocol',
              items: {
                type: 'string',
              },
              examples: [['8888/http', '22/tcp']],
            },
          },
        },
        BaseCpuConfig: {
          type: 'object',
          required: ['id', 'vcpuCount'],
          properties: {
            id: {
              type: 'string',
              description:
                'CPU flavor identifier, as returned by GET /v2/catalog/cpus.',
              examples: ['cpu5c'],
              minLength: 1,
            },
            vcpuCount: {
              type: 'integer',
              minimum: 2,
              description:
                'Number of vCPUs. Must be valid for the selected CPU flavor and must be a power of two.',
              examples: [4],
            },
          },
        },
        BaseEndpointGpuConfig: {
          type: 'object',
          properties: {
            pools: {
              type: 'array',
              minItems: 1,
              description:
                'Serverless GPU pool IDs (the `pool` field of `list-gpu-types`). Workers are placed on whichever listed pool has capacity; narrow to specific cards with `excludedTypes`. On update, `pools` and `excludedTypes` are replaced together, so sending `pools` alone clears the exclusions.',
              items: {
                type: 'string',
              },
              examples: [['ADA_24']],
            },
            excludedTypes: {
              type: 'array',
              uniqueItems: true,
              description:
                'GPU type IDs to subtract from the selected pools — the `id` field of `list-gpu-types`, the same identifiers pods take in `gpu.id`. Workers run on every type in `pools` except these; omit to use the whole pool. A value outside `pools` is rejected. On update, restate them whenever you send `pools`, or they are cleared.',
              items: {
                type: 'string',
                pattern: '^\\s*[^-\\s]',
              },
              examples: [['NVIDIA L40']],
            },
            count: {
              type: 'integer',
              minimum: 1,
              default: 1,
              description: 'GPUs per worker',
              examples: [1],
            },
          },
        },
        ContainerConfig: {
          allOf: [
            {
              $ref: '#/$defs/BaseContainerConfig',
            },
            {
              type: 'object',
              properties: {
                registry: {
                  type: ['string', 'null'],
                  description:
                    'Container registry credential ID (for private images)',
                  examples: [null],
                },
              },
            },
          ],
        },
        CreateCpuConfig: {
          allOf: [
            {
              $ref: '#/$defs/BaseCpuConfig',
            },
          ],
          unevaluatedProperties: false,
        },
        EndpointMount: {
          type: 'object',
          required: ['volumeId'],
          additionalProperties: false,
          description:
            'A volume mounted on every worker, always at `/runpod-volume`. Custom paths are not supported yet.',
          properties: {
            volumeId: {
              type: 'string',
              description:
                'ID of a NetworkVolume (under `network`) or GlobalVolume (under `global`).',
              examples: ['vol_abc'],
            },
          },
        },
        EndpointMountsInput: {
          type: 'object',
          additionalProperties: false,
          description:
            "Volumes to mount on the endpoint's workers. A `network` or `global` list that is present replaces the endpoint's current list of that kind; an empty list detaches it, and an omitted list is left unchanged.",
          properties: {
            network: {
              type: 'array',
              description: 'Network volumes, at most one per data center.',
              items: {
                $ref: '#/$defs/EndpointMount',
              },
            },
            global: {
              type: 'array',
              maxItems: 1,
              items: {
                $ref: '#/$defs/EndpointMount',
              },
            },
          },
        },
        EndpointScaling: {
          description:
            "Autoscaling signal — a discriminated union on `type`: `QUEUE_DELAY` (queue-based endpoints only) or `REQUEST_COUNT`. The scaler is chosen independently of the endpoint's routing `type` and can be switched on update.",
          oneOf: [
            {
              $ref: '#/$defs/QueueDelayScaling',
            },
            {
              $ref: '#/$defs/RequestCountScaling',
            },
          ],
          discriminator: {
            propertyName: 'type',
            mapping: {
              QUEUE_DELAY: '#/$defs/QueueDelayScaling',
              REQUEST_COUNT: '#/$defs/RequestCountScaling',
            },
          },
        },
        EndpointWorkers: {
          type: 'object',
          additionalProperties: false,
          properties: {
            min: {
              type: 'integer',
              minimum: 0,
              description: 'Minimum number of workers.',
              examples: [0],
            },
            max: {
              type: 'integer',
              minimum: 0,
              description: 'Maximum number of workers.',
              examples: [5],
            },
            idleTimeout: {
              type: 'integer',
              minimum: 1,
              maximum: 3600,
              description:
                'Seconds before idle workers scale down. Not applicable to queue-based endpoints scaling on `requestCount` — rejected on create/update and omitted from responses for that combination.',
              examples: [5],
            },
          },
        },
        FlashBoot: {
          type: 'string',
          description:
            'FlashBoot cold-start acceleration mode. `OFF` — disabled. `FLASHBOOT` — enabled. `PRIORITY_FLASHBOOT` — enabled with priority capacity',
          enum: ['OFF', 'FLASHBOOT', 'PRIORITY_FLASHBOOT'],
        },
        QueueDelayScaling: {
          type: 'object',
          additionalProperties: false,
          description: 'Scale on queue wait time. Queue-based endpoints only.',
          required: ['type', 'queueDelay'],
          properties: {
            type: {
              type: 'string',
              description:
                'Scaler discriminator. Always `QUEUE_DELAY` for this variant.',
              enum: ['QUEUE_DELAY'],
            },
            queueDelay: {
              type: 'number',
              format: 'float',
              minimum: 0.5,
              description:
                'Adjusts the number of workers based on how long requests wait in the queue.',
              examples: [4],
            },
          },
        },
        RequestCountScaling: {
          type: 'object',
          additionalProperties: false,
          description:
            'Scale on concurrent in-flight requests per worker. Required for load-balancing endpoints; also selectable for queue-based.',
          required: ['type', 'requestCount'],
          properties: {
            type: {
              type: 'string',
              description:
                'Scaler discriminator. Always `REQUEST_COUNT` for this variant.',
              enum: ['REQUEST_COUNT'],
            },
            requestCount: {
              type: 'integer',
              minimum: 1,
              description:
                'Adjusts the number of workers based on active in-flight requests.',
              examples: [4],
            },
          },
        },
        UpdateEndpointGpuConfig: {
          description:
            'Partial GPU update — every field is optional and an omitted one is left unchanged. `pools` is optional here, so a CUDA-only change does not resend the pool list; `excludedTypes` needs `pools` in the same request, and `pools` sent alone clears the exclusions.',
          allOf: [
            {
              $ref: '#/$defs/BaseEndpointGpuConfig',
            },
            {
              type: 'object',
              dependentRequired: {
                excludedTypes: ['pools'],
              },
              properties: {
                allowedCudaVersions: {
                  type: 'array',
                  items: {
                    type: 'string',
                    pattern: '^\\d+\\.\\d+$',
                  },
                  description:
                    'Acceptable CUDA versions for worker placement, as `major.minor`. An explicit `[]` clears the constraint; omitting the field leaves it unchanged. A non-empty set cannot be sent with minCudaVersion, and setting one does not clear the other: clear the other explicitly in the same patch. Takes effect as workers are replaced.',
                },
                minCudaVersion: {
                  type: 'string',
                  pattern: '^$|^\\d+\\.\\d+$',
                  description:
                    'Lowest acceptable CUDA version for worker placement, as `major.minor`. An explicit `""` clears the floor; omitting the field leaves it unchanged. Cannot be sent with a non-empty allowedCudaVersions (an explicit `[]` there is fine); clear that explicitly in the same patch if the endpoint carries one. Takes effect as workers are replaced.',
                  examples: ['12.1'],
                },
              },
            },
          ],
          unevaluatedProperties: false,
        },
        UpdateEndpointRequest: {
          allOf: [
            {
              $ref: '#/$defs/ContainerConfig',
            },
            {
              type: 'object',
              description: 'Only provided fields are changed.',
              properties: {
                cpu: {
                  type: 'array',
                  minItems: 1,
                  uniqueItems: true,
                  description:
                    'Complete replacement CPU selection. Valid only for an existing CPU endpoint; endpoint compute family cannot be changed.',
                  items: {
                    $ref: '#/$defs/CreateCpuConfig',
                  },
                },
                dataCenterIds: {
                  type: 'array',
                  items: {
                    type: 'string',
                  },
                  description:
                    'Preferred data centers for placement. Omit or pass an empty array to let the scheduler choose.',
                },
                flashboot: {
                  $ref: '#/$defs/FlashBoot',
                },
                gpu: {
                  $ref: '#/$defs/UpdateEndpointGpuConfig',
                },
                name: {
                  type: 'string',
                  minLength: 1,
                },
                networkVolumes: {
                  type: 'array',
                  items: {
                    type: 'string',
                  },
                  description: 'Network volume IDs. Pass `[]` to detach.',
                  deprecated: true,
                },
                mounts: {
                  $ref: '#/$defs/EndpointMountsInput',
                },
                scaling: {
                  $ref: '#/$defs/EndpointScaling',
                },
                templateId: {
                  type: 'string',
                  description:
                    "ID of a serverless template whose container settings (image, args, disk, ports, env, registry) are applied as if sent in this PATCH body; explicit body fields win. `env` merges template and body per key (body wins) and replaces the endpoint's existing env. Applied once; must be a serverless template you can access.",
                  examples: ['30zmvf89kd'],
                },
                timeout: {
                  type: 'integer',
                },
                workers: {
                  $ref: '#/$defs/EndpointWorkers',
                },
              },
            },
          ],
          unevaluatedProperties: false,
        },
      },
    },
  },
  {
    name: 'update-global-volume',
    title: 'Update global volume',
    operationId: 'updateGlobalVolume',
    description:
      'Update a global volume. Updates mutable fields on a global volume. Only provided fields are changed.',
    method: 'PATCH',
    path: '/v2/global-volumes/{id}',
    params: [
      {
        name: 'id',
        location: 'path',
      },
    ],
    hasBody: true,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Global volume identifier',
        },
        body: {
          $ref: '#/$defs/UpdateGlobalVolumeRequest',
          type: 'object',
        },
      },
      required: ['id', 'body'],
      $defs: {
        UpdateGlobalVolumeRequest: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          description:
            'Only the provided fields are updated. At least one field must be present; an empty body is rejected.',
          properties: {
            name: {
              type: 'string',
              minLength: 1,
              maxLength: 191,
              pattern: '[^\\p{Z}\\t-\\r]',
              description:
                'New human-readable name, 1–191 characters with at least one non-whitespace character. Leading and trailing whitespace is trimmed.',
              examples: ['renamed-volume'],
            },
          },
        },
      },
    },
  },
  {
    name: 'update-network-volume',
    title: 'Update network volume',
    operationId: 'updateNetworkVolume',
    description:
      'Update a network volume. Updates mutable fields on a network volume. Only provided fields are changed. Note: `size` may only increase; attempts to reduce size will be rejected.',
    method: 'PATCH',
    path: '/v2/network-volumes/{id}',
    params: [
      {
        name: 'id',
        location: 'path',
      },
    ],
    hasBody: true,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Network volume identifier',
        },
        body: {
          $ref: '#/$defs/UpdateNetworkVolumeRequest',
          type: 'object',
        },
      },
      required: ['id', 'body'],
      $defs: {
        UpdateNetworkVolumeRequest: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          description:
            'Only the provided fields are updated. At least one field must be present; an empty body is rejected.',
          properties: {
            name: {
              type: 'string',
              minLength: 1,
              description: 'New human-readable name',
              examples: ['renamed-volume'],
            },
            size: {
              type: 'integer',
              minimum: 10,
              maximum: 4096,
              description:
                'New size in GB. Must be greater than or equal to the current size — network volume storage cannot be reduced.',
              examples: [100],
            },
          },
        },
      },
    },
  },
  {
    name: 'update-pod',
    title: 'Update Pod',
    operationId: 'updatePod',
    description:
      "Update a pod. Partially updates a pod's configuration. This is a PATCH: only the fields present in the body are changed, and omitted fields are left untouched. Use empty values only when you explicitly mean to clear a field (for example, set `registry` to `null` or set `ports` to `[]`). See `UpdatePodRequest` for the full body. Mutable fields: `name`, `image`, `args`, `disk`, `ports`, `env`, `registry`, `mounts`, `locked`, and `globalNetworking`. Some changes apply immediately while others (e.g. `globalNetworking`) take effect on the pod's next start/restart, as noted on the individual fields. Pods that belong to a Cluster cannot be updated here — manage them through `/v2/clusters/{id}`. Returns `200` with the full updated pod.",
    method: 'PATCH',
    path: '/v2/pods/{id}',
    params: [
      {
        name: 'id',
        location: 'path',
      },
    ],
    hasBody: true,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    schemaOnDemand: true,
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Pod identifier',
        },
        body: {
          $ref: '#/$defs/UpdatePodRequest',
        },
      },
      required: ['id', 'body'],
      $defs: {
        BaseContainerConfig: {
          type: 'object',
          properties: {
            args: {
              type: 'string',
              description:
                'The container\'s command as one raw string: a bare shell string is treated as CMD and split into arguments; a JSON object `{"entrypoint":[...],"cmd":[...]}` sets either or both. Send `""` to clear; omit to leave unchanged.',
              examples: [
                '--model meta-llama/Llama-3-8B --max-model-len 8192',
                '{"entrypoint":["/bin/bash","-c"],"cmd":["python -u main.py"]}',
                '',
              ],
            },
            cmd: {
              type: 'array',
              items: {
                type: 'string',
              },
              description:
                'Container CMD in exec form: when the image defines an ENTRYPOINT, the argument list passed to it. Encoded into `args`; supply both only when they describe the same command. Send `[]` to clear; omit to leave unchanged.',
              examples: [
                ['--model', 'meta-llama/Llama-3-8B', '--max-model-len', '8192'],
              ],
            },
            entrypoint: {
              type: 'array',
              items: {
                type: 'string',
              },
              description:
                "Container ENTRYPOINT in exec form, overriding the image's own. Encoded into `args` field; supplying both is allowed only when they describe the same command. Send `[]` to clear, omit to leave unchanged.",
              examples: [['/bin/bash', '-c']],
            },
            disk: {
              type: 'integer',
              minimum: 1,
              description: 'Container disk in GB (ephemeral, wiped on restart)',
              examples: [50],
            },
            env: {
              type: 'object',
              additionalProperties: {
                type: 'string',
              },
              description: 'Environment variables as key-value pairs',
              examples: [
                {
                  JUPYTER_PASSWORD: 'hunter2',
                },
              ],
            },
            image: {
              type: 'string',
              description: 'Docker image reference',
              examples: ['runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404'],
            },
            ports: {
              type: 'array',
              description: 'Exposed ports, formatted as port/protocol',
              items: {
                type: 'string',
              },
              examples: [['8888/http', '22/tcp']],
            },
          },
        },
        BaseMounts: {
          type: 'object',
          properties: {
            persistent: {
              $ref: '#/$defs/PersistentMount',
            },
            network: {
              type: 'array',
              maxItems: 1,
              items: {
                $ref: '#/$defs/NetworkMount',
              },
            },
          },
        },
        ContainerConfig: {
          allOf: [
            {
              $ref: '#/$defs/BaseContainerConfig',
            },
            {
              type: 'object',
              properties: {
                registry: {
                  type: ['string', 'null'],
                  description:
                    'Container registry credential ID (for private images)',
                  examples: [null],
                },
              },
            },
          ],
        },
        GlobalMount: {
          type: 'object',
          required: ['volumeId'],
          additionalProperties: false,
          description:
            'Reference to a GlobalVolume. Usage-billed, so it has no size. The underlying `volumeId` is immutable post-create; the mount `path` may be changed via PATCH.',
          properties: {
            volumeId: {
              type: 'string',
              description: 'ID of an existing GlobalVolume.',
              examples: ['gsb_abc'],
            },
            path: {
              type: 'string',
              description:
                'Mount path inside the container. Optional on create, where a default is chosen for you; a PATCH that omits it leaves the path unchanged.',
              examples: ['/data'],
            },
          },
        },
        Mounts: {
          description:
            "Storage mounts for the pod: `persistent` (size + path) excludes both `network` and `global`; `network` (volumeId + path) and `global` (volumeId, optional path) take one entry each and can be combined. Every entry needs its full shape. On update, omit the field to leave the mounts as they are; the mount kind and a volume's volumeId cannot change, and mounts cannot be cleared.",
          allOf: [
            {
              $ref: '#/$defs/BaseMounts',
            },
            {
              type: 'object',
              properties: {
                global: {
                  type: 'array',
                  maxItems: 1,
                  description:
                    'At most one global volume, on GPU and CPU pods, with no data center constraint. Combinable with `network` but not with `persistent` (rejected): upstream drops a persistent disk whenever a volume is attached.',
                  items: {
                    $ref: '#/$defs/GlobalMount',
                  },
                },
              },
            },
          ],
          unevaluatedProperties: false,
        },
        NetworkMount: {
          type: 'object',
          required: ['volumeId', 'path'],
          additionalProperties: false,
          description:
            'Reference to a NetworkVolume. Custom paths are honored at runtime on both GPU and CPU pods. The underlying `volumeId` is immutable post-create; the mount `path` may be changed via PATCH.',
          properties: {
            volumeId: {
              type: 'string',
              description:
                'ID of an existing NetworkVolume in the same data center as the pod.',
              examples: ['vol_xyz'],
            },
            path: {
              type: 'string',
              description:
                'Mount path inside the container. No default — must be specified explicitly.',
              examples: ['/runpod-volume'],
            },
          },
        },
        PersistentMount: {
          type: 'object',
          required: ['size', 'path'],
          additionalProperties: false,
          description:
            "Host-local persistent storage. Pinned to the pod's host machine — data does not survive a host failure. Disallowed on CPU pods. Mutually exclusive with NetworkMount. Deprecated: prefer NetworkMount for any data you cannot recreate.",
          properties: {
            size: {
              type: 'integer',
              minimum: 10,
              description:
                'Host-local persistent storage in GB. Upstream enforces a 10 GB floor.',
              examples: [20],
            },
            path: {
              type: 'string',
              description:
                'Mount path inside the container. May be changed via PATCH.',
              examples: ['/workspace'],
            },
          },
        },
        UpdatePodRequest: {
          allOf: [
            {
              $ref: '#/$defs/ContainerConfig',
            },
            {
              type: 'object',
              properties: {
                globalNetworking: {
                  type: 'boolean',
                  description:
                    'Enable (true) or disable (false) global networking. Takes effect on the next pod start/restart, not live. Requires an NVIDIA GPU and a global-networking-enabled data center (both enforced upstream).',
                },
                locked: {
                  type: 'boolean',
                  description:
                    'Lock the pod (true) or unlock it (false). Locked pods cannot be stopped or reset.',
                },
                mounts: {
                  $ref: '#/$defs/Mounts',
                },
                name: {
                  type: 'string',
                  minLength: 1,
                },
                templateId: {
                  type: 'string',
                  description:
                    "ID of a pod template whose container settings (image, args, disk, ports, env, registry; not mounts) are applied as if sent in this PATCH body; explicit body fields win. `env` merges template and body per key (body wins) and replaces the pod's existing env. Applied once; must be a non-serverless template you can access.",
                  examples: ['30zmvf89kd'],
                },
              },
            },
          ],
          unevaluatedProperties: false,
        },
      },
    },
  },
  {
    name: 'update-secret',
    title: 'Update secret',
    operationId: 'updateSecret',
    description:
      "Update a secret. Rotates a secret's value and/or updates its description. Only the provided fields are changed and at least one field is required; the `name` is immutable. Pods and workers receive the new value at their next boot — running instances keep the value they were started with. When both fields are sent, the value is applied first, then the description. The two updates are not atomic: if the description update fails after the value was rotated, the response is an error but the new value has already taken effect. Send the fields in separate requests when that partial outcome matters.",
    method: 'PATCH',
    path: '/v2/account/secrets/{id}',
    params: [
      {
        name: 'id',
        location: 'path',
      },
    ],
    hasBody: true,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    schemaOnDemand: true,
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Secret identifier',
        },
        body: {
          $ref: '#/$defs/UpdateSecretRequest',
          type: 'object',
        },
      },
      required: ['id', 'body'],
      $defs: {
        UpdateSecretRequest: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          description:
            "Only the provided fields are updated; at least one field is required. The secret's `name` is immutable.",
          properties: {
            value: {
              type: 'string',
              minLength: 1,
              maxLength: 16777216,
              description:
                'New secret value, replacing the current one. Write-only. Must be smaller than 16 MiB of UTF-8 text (strictly under 16,777,216 bytes).',
            },
            description: {
              type: 'string',
              maxLength: 65535,
              description:
                'New human-readable description, at most 65,535 bytes of UTF-8 text. Send `""` to clear.',
            },
          },
        },
      },
    },
  },
  {
    name: 'update-ssh-keys',
    title: 'Update SSH keys',
    operationId: 'updateSshKeys',
    description:
      "Replace registered SSH public keys. Replaces the account's full set of registered SSH public keys. Existing keys not present in the request are removed; send `[]` to remove all keys. Keys take effect for pods created afterwards with `startSsh` — running pods are not updated.",
    method: 'PUT',
    path: '/v2/account/ssh-keys',
    params: [],
    hasBody: true,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        body: {
          $ref: '#/$defs/UpdateSshKeysRequest',
          type: 'object',
        },
      },
      required: ['body'],
      $defs: {
        UpdateSshKeysRequest: {
          type: 'object',
          additionalProperties: false,
          required: ['keys'],
          properties: {
            keys: {
              type: 'array',
              items: {
                type: 'string',
                pattern: '^(ssh|ecdsa|sk)-[^\\s]+ [^\\s]+([ \\t][^\\n\\r]*)?$',
              },
              description:
                'The full set of SSH public keys to register — this is a complete replacement, not a merge. Each entry is an authorized_keys-style line: `<type> <base64-key> [comment]`, e.g. from `~/.ssh/id_ed25519.pub`. Send `[]` to remove all keys.',
              examples: [
                [
                  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILXGDN/SclOozk1xsDztpmhGiKkkrfQB9SKoO8dSIQQZ me@example.com',
                ],
              ],
            },
          },
        },
      },
    },
  },
  {
    name: 'update-template',
    title: 'Update template',
    operationId: 'updateTemplate',
    description:
      "Update a template. Partially updates a template. This is a PATCH: only the fields present in the body are changed; omitted fields are left untouched. See `UpdateTemplateRequest` for the full body. Mutable fields: `name`, `image`, `args`, `disk`, `ports`, `env`, `registry`, `mounts`, `serverless`, `public`, and `category`. Only the template's owner can update it (authenticated via the request's API key); public catalog templates are readable via GET but return `404` here. Returns `200` with the full updated template. Pods and endpoints already created from this template are not changed retroactively — the template is a snapshot applied at creation time.",
    method: 'PATCH',
    path: '/v2/templates/{id}',
    params: [
      {
        name: 'id',
        location: 'path',
      },
    ],
    hasBody: true,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schemaOnDemand: true,
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
        },
        body: {
          $ref: '#/$defs/UpdateTemplateRequest',
        },
      },
      required: ['id', 'body'],
      $defs: {
        BaseContainerConfig: {
          type: 'object',
          properties: {
            args: {
              type: 'string',
              description:
                'The container\'s command as one raw string: a bare shell string is treated as CMD and split into arguments; a JSON object `{"entrypoint":[...],"cmd":[...]}` sets either or both. Send `""` to clear; omit to leave unchanged.',
              examples: [
                '--model meta-llama/Llama-3-8B --max-model-len 8192',
                '{"entrypoint":["/bin/bash","-c"],"cmd":["python -u main.py"]}',
                '',
              ],
            },
            cmd: {
              type: 'array',
              items: {
                type: 'string',
              },
              description:
                'Container CMD in exec form: when the image defines an ENTRYPOINT, the argument list passed to it. Encoded into `args`; supply both only when they describe the same command. Send `[]` to clear; omit to leave unchanged.',
              examples: [
                ['--model', 'meta-llama/Llama-3-8B', '--max-model-len', '8192'],
              ],
            },
            entrypoint: {
              type: 'array',
              items: {
                type: 'string',
              },
              description:
                "Container ENTRYPOINT in exec form, overriding the image's own. Encoded into `args` field; supplying both is allowed only when they describe the same command. Send `[]` to clear, omit to leave unchanged.",
              examples: [['/bin/bash', '-c']],
            },
            disk: {
              type: 'integer',
              minimum: 1,
              description: 'Container disk in GB (ephemeral, wiped on restart)',
              examples: [50],
            },
            env: {
              type: 'object',
              additionalProperties: {
                type: 'string',
              },
              description: 'Environment variables as key-value pairs',
              examples: [
                {
                  JUPYTER_PASSWORD: 'hunter2',
                },
              ],
            },
            image: {
              type: 'string',
              description: 'Docker image reference',
              examples: ['runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404'],
            },
            ports: {
              type: 'array',
              description: 'Exposed ports, formatted as port/protocol',
              items: {
                type: 'string',
              },
              examples: [['8888/http', '22/tcp']],
            },
          },
        },
        ContainerConfig: {
          allOf: [
            {
              $ref: '#/$defs/BaseContainerConfig',
            },
            {
              type: 'object',
              properties: {
                registry: {
                  type: ['string', 'null'],
                  description:
                    'Container registry credential ID (for private images)',
                  examples: [null],
                },
              },
            },
          ],
        },
        PersistentMount: {
          type: 'object',
          required: ['size', 'path'],
          additionalProperties: false,
          description:
            "Host-local persistent storage. Pinned to the pod's host machine — data does not survive a host failure. Disallowed on CPU pods. Mutually exclusive with NetworkMount. Deprecated: prefer NetworkMount for any data you cannot recreate.",
          properties: {
            size: {
              type: 'integer',
              minimum: 10,
              description:
                'Host-local persistent storage in GB. Upstream enforces a 10 GB floor.',
              examples: [20],
            },
            path: {
              type: 'string',
              description:
                'Mount path inside the container. May be changed via PATCH.',
              examples: ['/workspace'],
            },
          },
        },
        TemplateCategory: {
          type: 'string',
          description:
            'Controls how the template is grouped and filtered in the Runpod console. It does not affect hardware selection, scheduling, or billing. `CPU` — CPU-only workloads. `NVIDIA` — NVIDIA GPU workloads. `AMD` — AMD GPU workloads',
          enum: ['CPU', 'NVIDIA', 'AMD'],
        },
        TemplateMounts: {
          type: 'object',
          additionalProperties: false,
          description:
            'Storage mounts for containers from this template: a single `persistent` mount only (`network` is rejected). On update, omitting `mounts` or sending `{}` leaves the existing mount unchanged.',
          properties: {
            persistent: {
              $ref: '#/$defs/PersistentMount',
            },
          },
        },
        UpdateTemplateRequest: {
          allOf: [
            {
              $ref: '#/$defs/ContainerConfig',
            },
            {
              type: 'object',
              properties: {
                allowedCudaVersions: {
                  type: 'array',
                  items: {
                    type: 'string',
                    pattern: '^\\d+\\.\\d+$',
                  },
                  description:
                    'Acceptable CUDA versions for pods created from this template. An explicit `[]` clears the constraint; omitting the field leaves it unchanged.',
                },
                category: {
                  $ref: '#/$defs/TemplateCategory',
                },
                mounts: {
                  $ref: '#/$defs/TemplateMounts',
                },
                name: {
                  type: 'string',
                  minLength: 1,
                },
                public: {
                  type: 'boolean',
                },
                serverless: {
                  type: 'boolean',
                },
                startJupyter: {
                  type: 'boolean',
                  description:
                    'Start JupyterLab at container startup (`JUPYTER_PASSWORD` env injection). See the create-time field for details.',
                },
                startSsh: {
                  type: 'boolean',
                  description:
                    'Provision SSH access at container startup (`PUBLIC_KEY` env injection). See the create-time field for details.',
                },
              },
            },
          ],
          unevaluatedProperties: false,
        },
      },
    },
  },
];
