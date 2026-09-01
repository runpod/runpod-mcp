// Code generated from spec/openapi.yaml by generator/generate-tools.ts; DO NOT EDIT.

export interface GeneratedToolParam {
  name: string;
  location: 'path' | 'query';
}

export interface GeneratedTool {
  name: string;
  operationId: string;
  description: string;
  method: string;
  path: string;
  params: GeneratedToolParam[];
  hasBody: boolean;
  inputSchema: Record<string, unknown>;
}

export const generatedTools: GeneratedTool[] = [
  {
    name: 'create-cluster',
    operationId: 'createCluster',
    description:
      'Create an instant cluster (multiple pods with high-speed interconnect). BILLABLE from creation for every pod in the cluster: state the total hourly price before creating. Verify GPU stock first via the catalog tools; delete with delete-cluster when finished.',
    method: 'POST',
    path: '/v2/clusters',
    params: [],
    hasBody: true,
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
          description:
            'Container configuration universal to every containerized resource. Compose ContainerConfig instead unless the resource cannot support private registries (clusters, until the upstream input accepts a registry credential).\n',
          properties: {
            args: {
              type: 'string',
              description: 'Arguments passed to the container entrypoint',
              examples: [''],
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
                'Request body for creating a cluster. `compute` defines the\nhomogeneous pod shape; the container configuration (image, env, ports,\n…) applies to every pod and can be spread from a template response.\nPrivate registries are not yet supported for clusters — there is no\n`registry` field here, unlike the other create requests.\n',
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
                dataCenterIds: {
                  type: 'array',
                  items: {
                    type: 'string',
                  },
                  description:
                    'Preferred data centers for placement. Omit or pass an empty\narray to let the scheduler choose. A cluster is always placed\nwithin a single data center.\n',
                  example: ['US-TX-3'],
                },
                mounts: {
                  $ref: '#/$defs/Mounts',
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
        Mounts: {
          type: 'object',
          additionalProperties: false,
          description:
            'Storage mounts attached to a pod. At-most-one of `persistent` or\n`network` may be set today (mutually exclusive, enforced at the\nhandler with 400 if both are present). The `network` field is an\narray for forward compatibility with eventual multi-network-volume\nsupport, but `maxItems` is 1 today.\n\nPATCH semantics:\n- Omitting `mounts` or sending `{}` leaves the existing mount\n  unchanged.\n- An explicit `network: []` is rejected with 400 (clearing mounts\n  is not supported).\n- Mount kind is fixed at create — a PATCH that introduces a kind\n  not present at create (persistent on a network pod, network on\n  a persistent pod, or any mount on a previously-mountless pod)\n  is rejected with 400.\n- The `volumeId` of a network mount is immutable; a PATCH that\n  names a different `volumeId` is rejected with 400.\n- Partial mounts are not supported — every mount entry must\n  include the full schema (`size` + `path` for persistent,\n  `volumeId` + `path` for network). Missing required fields → 422.\n',
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
        NetworkMount: {
          type: 'object',
          required: ['volumeId', 'path'],
          additionalProperties: false,
          description:
            'Reference to a NetworkVolume. Custom paths are honored at runtime on\nboth GPU and CPU pods. The underlying `volumeId` is immutable\npost-create; the mount `path` may be changed via PATCH.\n',
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
            "Host-local persistent storage. Pinned to the pod's host machine — data\ndoes not survive a host failure. Disallowed on CPU pods. Mutually\nexclusive with NetworkMount. Deprecated: prefer NetworkMount for any\ndata you cannot recreate.\n",
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
    operationId: 'createDelegation',
    description: 'Register an ECR delegation',
    method: 'POST',
    path: '/v2/registries/delegations',
    params: [],
    hasBody: true,
    inputSchema: {
      type: 'object',
      properties: {
        body: {
          $ref: '#/$defs/CreateDelegationRequest',
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
    operationId: 'createEndpoint',
    description:
      "Create a serverless endpoint. BILLABLE: state the GPU class's hourly price (from the catalog tools) before creating. GPU selection is the required gpu object: gpu.pools takes serverless pool ids from the catalog (e.g. ADA_24), never display names, and gpu.count sets GPUs per worker. type and scaling are required and fix the request-routing model. Workers cold-start on the first job: expect minutes, poll with get-job-status wait.",
    method: 'POST',
    path: '/v2/serverless',
    params: [],
    hasBody: true,
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
          description:
            'Container configuration universal to every containerized resource. Compose ContainerConfig instead unless the resource cannot support private registries (clusters, until the upstream input accepts a registry credential).\n',
          properties: {
            args: {
              type: 'string',
              description: 'Arguments passed to the container entrypoint',
              examples: [''],
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
                'Serverless GPU pool IDs (as returned by `GET /v2/catalog/gpus` in\n`pool`). Workers are placed on whichever listed pool has capacity.\nNarrow a pool down to specific cards with `excludedTypes`.\n',
              items: {
                type: 'string',
              },
              examples: [['ADA_24']],
            },
            excludedTypes: {
              type: 'array',
              uniqueItems: true,
              description:
                'GPU **type** IDs to subtract from the selected pools — the `id`\nfield of `GET /v2/catalog/gpus`, the same identifiers pods take in\n`gpu.id`. Workers run on every type in `pools` except these. Omit to\nuse the whole pool.\n\nPools stay the unit of selection; types are the unit of\nsubtraction. There is no inclusive allowlist: a card later added to\none of your pools becomes eligible, which is the honest reading of\n"this pool, minus these".\n\nTied to `pools`, because the two together are one selection:\nsupplying `pools` replaces that selection wholesale, so a `PATCH`\nsending `pools` **without `excludedTypes`** **clears** them —\nrestate them to keep them. A `PATCH` that omits `pools` leaves both\nthe pools and the exclusions untouched, so changing only a CUDA\nconstraint cannot widen a pinned endpoint.\n\nRejected with 400 if a value is not a GPU type in one of `pools`;\nupstream accepts unrecognized exclusions silently, so a typo would\notherwise produce a filter that does nothing. Surrounding whitespace\nis trimmed, so `" NVIDIA L40"` and `"NVIDIA L40"` mean the same card.\n',
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
          description:
            'Reusable container configuration shared across templates, pods, and serverless endpoints. Adding a field here automatically propagates to all three resources.\n',
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
            "GPU request for an endpoint create. Carries the CUDA constraints, which\nlive here rather than at the body's top level so they are\nunrepresentable on a CPU endpoint.\n",
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
                    "Acceptable CUDA versions for worker placement, as\n`major.minor`. Omit to accept any version (or inherit the\ntemplate's constraint when creating from `templateId`).\nMatching is exact — discover valid values per GPU type via\n`GET /v2/catalog/gpus?include=AVAILABILITY&product=SERVERLESS`\n(`cudaVersions`).\n\nA non-empty set is mutually exclusive with minCudaVersion (400\nif both are sent). An explicit `[]` states no constraint, so it\nmay accompany a floor.\n",
                  examples: [['12.8', '12.6']],
                },
                minCudaVersion: {
                  type: 'string',
                  pattern: '^\\d+\\.\\d+$',
                  description:
                    'Lowest acceptable CUDA version for worker placement, as\n`major.minor`, compared numerically rather than as a decimal —\nso 12.11 is above 12.2. Use this for an open-ended floor and\nallowedCudaVersions for an exact set.\n\nMutually exclusive with a non-empty allowedCudaVersions (400 if\nboth are sent); an explicit `[]` there states no constraint and\nmay accompany this floor.\n',
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
                    'Request-routing model. Required — it determines the valid scaler\nand request URLs, so it must be chosen explicitly on every create.\n',
                },
                cpu: {
                  type: 'array',
                  minItems: 1,
                  uniqueItems: true,
                  description:
                    "Eligible CPU configurations for each worker. Memory is derived from the\nselected flavor's catalog RAM multiplier. Exact duplicate configurations\nare rejected; the same flavor may be listed at different vCPU counts.\n",
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
                },
                templateId: {
                  type: 'string',
                  minLength: 1,
                  description:
                    "ID of a serverless template to base this endpoint on. The\ntemplate is resolved at create time into the same container\nsettings you could otherwise spread into this body (image,\nargs, disk, ports, env, registry); explicit body fields\noverride the template's, except `env`, which is merged per\nkey with body values winning. The template's\nallowedCudaVersions seeds `gpu.allowedCudaVersions` when the\nbody omits it — but only for a GPU create, since a CPU endpoint\nhas no gpu block to seed into, and not when the body sets\n`gpu.minCudaVersion`, since seeding a set beside a floor would\nmanufacture the mutual-exclusion 400 from a valid request. Its\npod-specific startSsh/startJupyter flags are\nignored. Later template edits do not affect the endpoint.\nThe template may be one of your own or a public catalog\ntemplate — see `GET /v2/catalog/templates` (unknown or\ninaccessible ID → 404) — and must be a serverless template\n(→ 422).\n",
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
        EndpointScaling: {
          description:
            "Autoscaling signal — a discriminated union on `type`: `QUEUE_DELAY`\n(queue-based endpoints only) or `REQUEST_COUNT`. The scaler is chosen\nindependently of the endpoint's routing `type` and can be switched on\nupdate.\n",
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
            'Request-routing semantics for a modern serverless endpoint.\n- `QUEUE` — submit asynchronous or synchronous jobs through the managed queue.\n- `LOAD_BALANCER` — send requests directly to worker-defined HTTP paths.\n  Configure via `env`: `PORT` (server port, default 80), `PORT_HEALTH`\n  (health-check port, default 80), and `HEALTH_CHECK_PATH` (path the\n  load balancer polls for worker health, default `/ping`).\n',
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
                'Seconds before idle workers scale down. Not applicable to queue-based\nendpoints scaling on `requestCount` — rejected on create/update and\nomitted from responses for that combination.\n',
              examples: [5],
            },
          },
        },
        FlashBoot: {
          type: 'string',
          description:
            'FlashBoot cold-start acceleration mode.\n- `OFF`                — disabled\n- `FLASHBOOT`          — enabled\n- `PRIORITY_FLASHBOOT` — enabled with priority capacity\n',
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
            'Scale on concurrent in-flight requests per worker. Required for\nload-balancing endpoints; also selectable for queue-based.\n',
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
    name: 'create-network-volume',
    operationId: 'createNetworkVolume',
    description:
      'Create a network volume. Provisions a new network volume — persistent, network-attached storage that can be mounted into pods and serverless workers. Required inputs are `name`, `size` (in GB), and `dataCenter`; an optional `type` selects the storage tier and is immutable after creation. See `CreateNetworkVolumeRequest` for the size bounds and tier options. This creates a billable persistent resource that keeps incurring storage charges until it is deleted. Returns `201` with the created network volume, including its assigned `id`.',
    method: 'POST',
    path: '/v2/network-volumes',
    params: [],
    hasBody: true,
    inputSchema: {
      type: 'object',
      properties: {
        body: {
          $ref: '#/$defs/CreateNetworkVolumeRequest',
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
                "Storage tier for the volume. Optional. When omitted, the volume is\nprovisioned using the requested data center's default (primary)\nstorage tier. HIGH_PERFORMANCE provisions a high-performance (HPS)\nvolume; STANDARD provisions a standard volume. A volume's tier is\nimmutable after creation.\n",
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
    operationId: 'createPod',
    description:
      'Rent a GPU/CPU pod. BILLABLE from creation until stop/terminate: state the hourly price before creating. GPU selection is the gpu object: gpu.id takes a catalog GPU type id (e.g. "NVIDIA GeForce RTX 4090"), verified via list-gpu-types, and gpu.count sets the GPU count; cloud/data-center choice constrains stock.',
    method: 'POST',
    path: '/v2/pods',
    params: [],
    hasBody: true,
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
          description:
            'Container configuration universal to every containerized resource. Compose ContainerConfig instead unless the resource cannot support private registries (clusters, until the upstream input accepts a registry credential).\n',
          properties: {
            args: {
              type: 'string',
              description: 'Arguments passed to the container entrypoint',
              examples: [''],
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
        Cloud: {
          type: 'string',
          description:
            'Cloud tier.\n- `SECURE`    — Runpod-owned datacenter hardware\n- `COMMUNITY` — community-hosted hardware\n',
          enum: ['SECURE', 'COMMUNITY'],
        },
        ContainerConfig: {
          description:
            'Reusable container configuration shared across templates, pods, and serverless endpoints. Adding a field here automatically propagates to all three resources.\n',
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
            "GPU request for a pod create. Carries the CUDA host constraints, which\nlive here rather than at the body's top level so they are\nunrepresentable on a CPU pod.\n",
          allOf: [
            {
              $ref: '#/$defs/GpuConfig',
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
                    'Acceptable CUDA versions for the host machine, as `major.minor`.\nOmit to accept any version. Matching is exact, so a version no\nmachine reports yields a capacity error rather than a fallback —\ndiscover valid values per GPU type via\n`GET /v2/catalog/gpus?include=AVAILABILITY&product=POD`\n(`cudaVersions`).\n\nA non-empty set is mutually exclusive with minCudaVersion (400\nif both are sent). An explicit `[]` states no constraint, so it\nmay accompany a floor.\n',
                  examples: [['12.8', '12.6']],
                },
                minCudaVersion: {
                  type: 'string',
                  pattern: '^\\d+\\.\\d+$',
                  description:
                    'Lowest acceptable CUDA version for the host machine, as\n`major.minor`, compared numerically rather than as a decimal —\nso 12.11 is above 12.2. Use this for an open-ended floor and\nallowedCudaVersions for an exact set.\n\nMutually exclusive with a non-empty allowedCudaVersions (400 if\nboth are sent); an explicit `[]` there states no constraint and\nmay accompany this floor.\n',
                  examples: ['12.1'],
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
                "Request body for creating a pod. Exactly one of `gpu` or `cpu`\nmust be set — enforced at the handler layer. For CPU pods, memory\nis derived by the API from the selected flavor's RAM multiplier;\nclients provide only CPU flavor and vCPU count. CPU pods support\ncontainer disk and network volumes only; `mounts.persistent` is\ninvalid when `cpu` is set.\n\n`image` is required unless `templateId` is set.\n",
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
                    'Preferred data centers for placement. Omit or pass an empty\narray to let the scheduler choose.\n',
                  examples: [['US-TX-3']],
                },
                globalNetworking: {
                  type: 'boolean',
                  default: false,
                  description:
                    'Enable global networking, giving the pod a private IP reachable across data centers. Requires an NVIDIA GPU and a global-networking-enabled data center (both enforced upstream). See `GET /v2/catalog/datacenters` (`globalNetwork`) for eligible data centers.',
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
                    "Create-time flag telling the provisioner to start JupyterLab:\ninjects a generated `JUPYTER_PASSWORD` environment variable,\nunless the request already sets one. Only images that honor\nthe convention start Jupyter from it (RunPod official images\ndo); expose `8888/http` in `ports` to reach it.\n\nNot part of the pod's readable config — never returned by\nGET and not changeable by PATCH.\n",
                  examples: [true],
                },
                startSsh: {
                  type: 'boolean',
                  default: false,
                  description:
                    "Create-time flag telling the provisioner to set up SSH\naccess: injects a `PUBLIC_KEY` environment variable carrying\nyour account's registered SSH public keys, unless the request\nalready sets one. **Requires registered keys** (`PUT\n/v2/account/ssh-keys`) — with none registered the flag does\nnothing and the pod has no SSH access. Only images that honor\nthe convention start sshd from it (all RunPod official images\ndo). Connect using the pod's `ssh` block; the `ssh.direct`\nvariant additionally needs a `22/tcp` entry in `ports`.\n\nNot part of the pod's readable config — never returned by\nGET and not changeable by PATCH.\n",
                  examples: [true],
                },
                templateId: {
                  type: 'string',
                  minLength: 1,
                  description:
                    "ID of a pod template to base this pod on. The template is\nresolved at create time into the same container settings you\ncould otherwise spread into this body (image, args, disk,\nports, env, registry, persistent mount, startSsh,\nstartJupyter, allowedCudaVersions); explicit body fields\noverride the template's, except `env`, which is merged per\nkey with body values winning. Sending either CUDA field\n(`gpu.allowedCudaVersions` or `gpu.minCudaVersion`) replaces\nthe template's CUDA constraint entirely, and CPU pods ignore\nit (like the persistent mount). The template is a one-time\nsource of settings: later template edits do not affect the\npod, and the created pod does not retain a link to the\ntemplate (`template` stays null). The template may be one\nof your own or a public catalog template — see\n`GET /v2/catalog/templates` (unknown or inaccessible ID →\n404) — and must not be a serverless template (→ 422). CPU\npods do not inherit a template's persistent mount.\n",
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
        GpuConfig: {
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
        Mounts: {
          type: 'object',
          additionalProperties: false,
          description:
            'Storage mounts attached to a pod. At-most-one of `persistent` or\n`network` may be set today (mutually exclusive, enforced at the\nhandler with 400 if both are present). The `network` field is an\narray for forward compatibility with eventual multi-network-volume\nsupport, but `maxItems` is 1 today.\n\nPATCH semantics:\n- Omitting `mounts` or sending `{}` leaves the existing mount\n  unchanged.\n- An explicit `network: []` is rejected with 400 (clearing mounts\n  is not supported).\n- Mount kind is fixed at create — a PATCH that introduces a kind\n  not present at create (persistent on a network pod, network on\n  a persistent pod, or any mount on a previously-mountless pod)\n  is rejected with 400.\n- The `volumeId` of a network mount is immutable; a PATCH that\n  names a different `volumeId` is rejected with 400.\n- Partial mounts are not supported — every mount entry must\n  include the full schema (`size` + `path` for persistent,\n  `volumeId` + `path` for network). Missing required fields → 422.\n',
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
        NetworkMount: {
          type: 'object',
          required: ['volumeId', 'path'],
          additionalProperties: false,
          description:
            'Reference to a NetworkVolume. Custom paths are honored at runtime on\nboth GPU and CPU pods. The underlying `volumeId` is immutable\npost-create; the mount `path` may be changed via PATCH.\n',
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
            "Host-local persistent storage. Pinned to the pod's host machine — data\ndoes not survive a host failure. Disallowed on CPU pods. Mutually\nexclusive with NetworkMount. Deprecated: prefer NetworkMount for any\ndata you cannot recreate.\n",
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
    operationId: 'createRegistry',
    description:
      'Create a container registry credential. Stores credentials for a private container registry. Credentials are write-only.',
    method: 'POST',
    path: '/v2/registries',
    params: [],
    hasBody: true,
    inputSchema: {
      type: 'object',
      properties: {
        body: {
          $ref: '#/$defs/CreateRegistryRequest',
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
              examples: ['my-private-registry'],
            },
            password: {
              type: 'string',
              minLength: 1,
              description:
                'Registry password (write-only, not returned in responses)',
            },
            username: {
              type: 'string',
              minLength: 1,
              description:
                'Registry username (write-only, not returned in responses)',
            },
          },
        },
      },
    },
  },
  {
    name: 'create-template',
    operationId: 'createTemplate',
    description:
      'Create a template. Creates a reusable container-configuration preset — image, disk, ports, env, registry, and mount settings — for pods and serverless endpoints. Pass its ID as `templateId` to `createPod` or `createEndpoint`, or spread its fields into the request body directly. Returns the created template.',
    method: 'POST',
    path: '/v2/templates',
    params: [],
    hasBody: true,
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
          description:
            'Container configuration universal to every containerized resource. Compose ContainerConfig instead unless the resource cannot support private registries (clusters, until the upstream input accepts a registry credential).\n',
          properties: {
            args: {
              type: 'string',
              description: 'Arguments passed to the container entrypoint',
              examples: [''],
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
          description:
            'Reusable container configuration shared across templates, pods, and serverless endpoints. Adding a field here automatically propagates to all three resources.\n',
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
                    'Acceptable CUDA versions for containers created from this\ntemplate, as `major.minor`. Omit to accept any version — see\nthe same field on `createPod` for matching semantics.\nExpanded into GPU pod and serverless endpoint creates; CPU\npods ignore it.\n',
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
                    'Start JupyterLab in containers created from this template:\ninjects a generated `JUPYTER_PASSWORD` environment variable,\nunless `env` already sets one. Only images that honor the\nconvention start Jupyter from it (RunPod official images do);\nexpose `8888/http` in `ports` to reach it. Defaults to `true`\nwhen omitted, matching console-created templates.\n',
                  examples: [false],
                },
                startSsh: {
                  type: 'boolean',
                  default: true,
                  description:
                    "Provision SSH access in containers created from this template:\ninjects a `PUBLIC_KEY` environment variable carrying the\ndeployer's registered SSH public keys (`PUT\n/v2/account/ssh-keys` — with none registered the flag does\nnothing), unless `env` already sets one. Only images that\nhonor the convention start sshd from it (all RunPod official\nimages do); direct SSH also needs a `22/tcp` entry in\n`ports`. Defaults to `true` when omitted, matching\nconsole-created templates.\n",
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
            "Host-local persistent storage. Pinned to the pod's host machine — data\ndoes not survive a host failure. Disallowed on CPU pods. Mutually\nexclusive with NetworkMount. Deprecated: prefer NetworkMount for any\ndata you cannot recreate.\n",
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
            'Controls how the template is grouped and filtered in the Runpod console.\nIt does not affect hardware selection, scheduling, or billing.\n- `CPU`    — CPU-only workloads\n- `NVIDIA` — NVIDIA GPU workloads\n- `AMD`    — AMD GPU workloads\n',
          enum: ['CPU', 'NVIDIA', 'AMD'],
        },
        TemplateMounts: {
          type: 'object',
          additionalProperties: false,
          description:
            'Storage mounts attached to a template. Templates support only a\nsingle persistent mount today; any `network` property is rejected\nwith 422 by the schema validator.\n\nPATCH semantics: omitting `mounts` or sending `{}` leaves the\nexisting mount unchanged.\n',
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
    operationId: 'deleteCluster',
    description:
      'Delete a cluster. Permanently deletes a cluster and terminates all of its member pods.',
    method: 'DELETE',
    path: '/v2/clusters/{id}',
    params: [
      {
        name: 'id',
        location: 'path',
      },
    ],
    hasBody: false,
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
    operationId: 'deleteEndpoint',
    description:
      'Delete a serverless endpoint permanently and immediately. Verify the id belongs to the intended endpoint (get-endpoint) before deleting; delete only endpoints your own tool calls created in this conversation — a name is not attribution.',
    method: 'DELETE',
    path: '/v2/serverless/{id}',
    params: [
      {
        name: 'id',
        location: 'path',
      },
    ],
    hasBody: false,
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
    name: 'delete-network-volume',
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
    operationId: 'deletePod',
    description:
      'Terminate a pod permanently — its container disk is lost. Distinguish from stopping (pod-action stop) which releases the GPU but keeps volume data. Verify the id with get-pod first; terminate only pods your own tool calls created in this conversation — a name is not attribution.',
    method: 'DELETE',
    path: '/v2/pods/{id}',
    params: [
      {
        name: 'id',
        location: 'path',
      },
    ],
    hasBody: false,
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
    name: 'delete-template',
    operationId: 'deleteTemplate',
    description:
      'Delete a template permanently. Verify with get-template first; a template referenced by a live endpoint should not be deleted.',
    method: 'DELETE',
    path: '/v2/templates/{id}',
    params: [
      {
        name: 'id',
        location: 'path',
      },
    ],
    hasBody: false,
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
      },
      {
        name: 'product',
        location: 'query',
      },
      {
        name: 'vcpuCount',
        location: 'query',
      },
    ],
    hasBody: false,
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
      },
    ],
    hasBody: false,
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
    name: 'get-gpu-type',
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
      },
      {
        name: 'product',
        location: 'query',
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
      },
      {
        name: 'cudaVersions',
        location: 'query',
      },
      {
        name: 'minCudaVersion',
        location: 'query',
      },
    ],
    hasBody: false,
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
            'Comma-separated availability product contexts. Supported values: POD, CLUSTER, SERVERLESS. Required with include=AVAILABILITY, and valid only with it (400 either way). There is no default: the same GPU type can be scarce for pods and plentiful for serverless, so the context has to be stated rather than assumed.',
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
        },
        countryCodes: {
          type: 'array',
          items: {
            type: 'string',
            pattern: '^[A-Z]{2}$',
          },
          description:
            'Comma-separated ISO 3166-1 alpha-2 country codes, uppercase, to constrain availability to — e.g. FR or FR,DE. Values within this filter use OR semantics. Valid only with include=AVAILABILITY (400 otherwise); a malformed entry is a 422. Scopes availability, lowest-price calculations and the dataCenters array to those countries, so a listed data center outside them is omitted rather than returned with availability NONE. On the list endpoint a GPU type with no data center in those countries drops out entirely; the single-GPU endpoint still returns the requested type, with availability NONE and dataCenters omitted, so a 404 keeps meaning the GPU type does not exist. Read the NONE on availability rather than the absence of dataCenters, which is also absent when availability was not requested.',
        },
        cudaVersions: {
          type: 'array',
          items: {
            type: 'string',
            pattern: '^\\d+\\.\\d+$',
          },
          description:
            'Comma-separated CUDA versions to scope availability and lowest-price calculations to, matched exactly. Format: major.minor, e.g. 12.8 — a bare major is rejected here because it identifies no version. Valid only with include=AVAILABILITY (400 otherwise) and mutually exclusive with minCudaVersion (400 if both are sent); a malformed entry is a 422. Also narrows the returned cudaVersions array; omit it to enumerate every version offered.',
        },
        minCudaVersion: {
          type: 'string',
          pattern: '^\\d+(\\.\\d+)?$',
          description:
            'Lowest acceptable CUDA version to scope availability and lowest-price calculations to, compared numerically. Format: integer major or major.minor, e.g. 12 or 12.1 — unlike the `gpu.minCudaVersion` body field on pod and endpoint create, a bare major is accepted here and means any release of that major, because this filter only widens a read. Valid only with include=AVAILABILITY (400 otherwise) and mutually exclusive with cudaVersions (400 if both are sent); a malformed value is a 422. Use this for an open-ended floor and cudaVersions for an exact set.',
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
    name: 'get-pod',
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
    name: 'get-ssh-keys',
    operationId: 'getSshKeys',
    description:
      "List registered SSH public keys. Returns the account's registered SSH public keys — the keys provisioned into pods created with `startSsh` and used to authenticate the SSH connections reported in a pod's `ssh` block.",
    method: 'GET',
    path: '/v2/account/ssh-keys',
    params: [],
    hasBody: false,
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get-template',
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
    inputSchema: {
      type: 'object',
      properties: {
        startTime: {
          type: 'string',
          format: 'date-time',
          description:
            'Start of the billing period (RFC 3339). Defaults to 30 days ago. Snapped down to the start of its bucketSize bucket so the window aligns with the returned records; provide a boundary-aligned value (e.g. midnight for bucketSize=day) to avoid widening.\n',
        },
        endTime: {
          type: 'string',
          format: 'date-time',
          description:
            'End of the billing period (RFC 3339), exclusive. Defaults to now. Snapped up to the end of the bucketSize bucket it lands in (unless already on a boundary) so the window aligns with the returned records.\n',
        },
        bucketSize: {
          $ref: '#/$defs/BillingBucketSize',
          description: 'Length of each billing time bucket. Defaults to day.',
        },
        lastN: {
          type: 'integer',
          minimum: 1,
          description:
            'Return the last N buckets of bucketSize, ending with the current (in-progress) bucket — e.g. lastN=100 with bucketSize=day is "last 100 days". The resolved window is aligned to bucket boundaries: startTime is the start of the earliest bucket (e.g. midnight of the earliest day) and endTime is the end of the current bucket. Mutually exclusive with startTime/endTime; provide one or the other, not both.\n',
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
    inputSchema: {
      type: 'object',
      properties: {
        startTime: {
          type: 'string',
          format: 'date-time',
          description:
            'Start of the billing period (RFC 3339). Defaults to 30 days ago. Snapped down to the start of its bucketSize bucket so the window aligns with the returned records; provide a boundary-aligned value (e.g. midnight for bucketSize=day) to avoid widening.\n',
        },
        endTime: {
          type: 'string',
          format: 'date-time',
          description:
            'End of the billing period (RFC 3339), exclusive. Defaults to now. Snapped up to the end of the bucketSize bucket it lands in (unless already on a boundary) so the window aligns with the returned records.\n',
        },
        bucketSize: {
          $ref: '#/$defs/BillingBucketSize',
          description: 'Length of each billing time bucket. Defaults to day.',
        },
        lastN: {
          type: 'integer',
          minimum: 1,
          description:
            'Return the last N buckets of bucketSize, ending with the current (in-progress) bucket — e.g. lastN=100 with bucketSize=day is "last 100 days". The resolved window is aligned to bucket boundaries: startTime is the start of the earliest bucket (e.g. midnight of the earliest day) and endTime is the end of the current bucket. Mutually exclusive with startTime/endTime; provide one or the other, not both.\n',
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
    operationId: 'listClusters',
    description:
      'List clusters. Returns all clusters owned by the authenticated user.',
    method: 'GET',
    path: '/v2/clusters',
    params: [],
    hasBody: false,
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'list-cpu-types',
    operationId: 'listCpuTypes',
    description:
      'List CPU types. Returns available CPU flavors. Availability is included only when requested with include=AVAILABILITY, which requires `product` — stock differs by product context.',
    method: 'GET',
    path: '/v2/catalog/cpus',
    params: [
      {
        name: 'include',
        location: 'query',
      },
      {
        name: 'product',
        location: 'query',
      },
      {
        name: 'vcpuCount',
        location: 'query',
      },
    ],
    hasBody: false,
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
    operationId: 'listDataCenters',
    description:
      'List data centers. Returns available data center locations with region, compliance, supported network volume tiers, and global networking support. Use include=GPU_AVAILABILITY or include=CPU_AVAILABILITY to add per-resource availability arrays to each data center. The regions, networkVolumeTypes, compliance, and globalNetwork query parameters filter the list before it is returned.',
    method: 'GET',
    path: '/v2/catalog/datacenters',
    params: [
      {
        name: 'include',
        location: 'query',
      },
      {
        name: 'regions',
        location: 'query',
      },
      {
        name: 'networkVolumeTypes',
        location: 'query',
      },
      {
        name: 'compliance',
        location: 'query',
      },
      {
        name: 'globalNetwork',
        location: 'query',
      },
    ],
    hasBody: false,
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
    operationId: 'listDelegations',
    description: 'List all ECR delegations',
    method: 'GET',
    path: '/v2/registries/delegations',
    params: [],
    hasBody: false,
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'list-endpoint-billing',
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
    inputSchema: {
      type: 'object',
      properties: {
        startTime: {
          type: 'string',
          format: 'date-time',
          description:
            'Start of the billing period (RFC 3339). Defaults to 30 days ago. Snapped down to the start of its bucketSize bucket so the window aligns with the returned records; provide a boundary-aligned value (e.g. midnight for bucketSize=day) to avoid widening.\n',
        },
        endTime: {
          type: 'string',
          format: 'date-time',
          description:
            'End of the billing period (RFC 3339), exclusive. Defaults to now. Snapped up to the end of the bucketSize bucket it lands in (unless already on a boundary) so the window aligns with the returned records.\n',
        },
        bucketSize: {
          $ref: '#/$defs/BillingBucketSize',
          description: 'Length of each billing time bucket. Defaults to day.',
        },
        lastN: {
          type: 'integer',
          minimum: 1,
          description:
            'Return the last N buckets of bucketSize, ending with the current (in-progress) bucket — e.g. lastN=100 with bucketSize=day is "last 100 days". The resolved window is aligned to bucket boundaries: startTime is the start of the earliest bucket (e.g. midnight of the earliest day) and endTime is the end of the current bucket. Mutually exclusive with startTime/endTime; provide one or the other, not both.\n',
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
    name: 'list-endpoint-releases',
    operationId: 'listEndpointReleases',
    description:
      "List serverless endpoint releases. Returns the endpoint's release history (newest first) plus a rollout summary of how many workers are running the current version. Each release is a versioned configuration snapshot with a `diff` of what changed; build-driven releases carry a `buildId` (fetch build detail via the builds sub-routes).",
    method: 'GET',
    path: '/v2/serverless/{id}/releases',
    params: [
      {
        name: 'id',
        location: 'path',
      },
    ],
    hasBody: false,
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
    name: 'list-endpoint-workers',
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
    name: 'list-gpu-types',
    operationId: 'listGpuTypes',
    description:
      'List GPU types. Returns available GPU types with pricing. Availability is included only when requested with include=AVAILABILITY, which requires `product` — stock differs by product context. With countryCodes, the list is narrowed to GPU types deployable in those countries, so "this geography + this chip" resolves in one read.',
    method: 'GET',
    path: '/v2/catalog/gpus',
    params: [
      {
        name: 'include',
        location: 'query',
      },
      {
        name: 'product',
        location: 'query',
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
      },
      {
        name: 'cudaVersions',
        location: 'query',
      },
      {
        name: 'minCudaVersion',
        location: 'query',
      },
    ],
    hasBody: false,
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
            'Comma-separated availability product contexts. Supported values: POD, CLUSTER, SERVERLESS. Required with include=AVAILABILITY, and valid only with it (400 either way). There is no default: the same GPU type can be scarce for pods and plentiful for serverless, so the context has to be stated rather than assumed.',
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
        },
        countryCodes: {
          type: 'array',
          items: {
            type: 'string',
            pattern: '^[A-Z]{2}$',
          },
          description:
            'Comma-separated ISO 3166-1 alpha-2 country codes, uppercase, to constrain availability to — e.g. FR or FR,DE. Values within this filter use OR semantics. Valid only with include=AVAILABILITY (400 otherwise); a malformed entry is a 422. Scopes availability, lowest-price calculations and the dataCenters array to those countries, so a listed data center outside them is omitted rather than returned with availability NONE. On the list endpoint a GPU type with no data center in those countries drops out entirely; the single-GPU endpoint still returns the requested type, with availability NONE and dataCenters omitted, so a 404 keeps meaning the GPU type does not exist. Read the NONE on availability rather than the absence of dataCenters, which is also absent when availability was not requested.',
        },
        cudaVersions: {
          type: 'array',
          items: {
            type: 'string',
            pattern: '^\\d+\\.\\d+$',
          },
          description:
            'Comma-separated CUDA versions to scope availability and lowest-price calculations to, matched exactly. Format: major.minor, e.g. 12.8 — a bare major is rejected here because it identifies no version. Valid only with include=AVAILABILITY (400 otherwise) and mutually exclusive with minCudaVersion (400 if both are sent); a malformed entry is a 422. Also narrows the returned cudaVersions array; omit it to enumerate every version offered.',
        },
        minCudaVersion: {
          type: 'string',
          pattern: '^\\d+(\\.\\d+)?$',
          description:
            'Lowest acceptable CUDA version to scope availability and lowest-price calculations to, compared numerically. Format: integer major or major.minor, e.g. 12 or 12.1 — unlike the `gpu.minCudaVersion` body field on pod and endpoint create, a bare major is accepted here and means any release of that major, because this filter only widens a read. Valid only with include=AVAILABILITY (400 otherwise) and mutually exclusive with cudaVersions (400 if both are sent); a malformed value is a 422. Use this for an open-ended floor and cudaVersions for an exact set.',
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
    inputSchema: {
      type: 'object',
      properties: {
        startTime: {
          type: 'string',
          format: 'date-time',
          description:
            'Start of the billing period (RFC 3339). Defaults to 30 days ago. Snapped down to the start of its bucketSize bucket so the window aligns with the returned records; provide a boundary-aligned value (e.g. midnight for bucketSize=day) to avoid widening.\n',
        },
        endTime: {
          type: 'string',
          format: 'date-time',
          description:
            'End of the billing period (RFC 3339), exclusive. Defaults to now. Snapped up to the end of the bucketSize bucket it lands in (unless already on a boundary) so the window aligns with the returned records.\n',
        },
        bucketSize: {
          $ref: '#/$defs/BillingBucketSize',
          description: 'Length of each billing time bucket. Defaults to day.',
        },
        lastN: {
          type: 'integer',
          minimum: 1,
          description:
            'Return the last N buckets of bucketSize, ending with the current (in-progress) bucket — e.g. lastN=100 with bucketSize=day is "last 100 days". The resolved window is aligned to bucket boundaries: startTime is the start of the earliest bucket (e.g. midnight of the earliest day) and endTime is the end of the current bucket. Mutually exclusive with startTime/endTime; provide one or the other, not both.\n',
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
    operationId: 'listNetworkVolumes',
    description:
      'List network volumes. Returns all network volumes owned by the authenticated user.',
    method: 'GET',
    path: '/v2/network-volumes',
    params: [],
    hasBody: false,
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'list-pod-billing',
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
    inputSchema: {
      type: 'object',
      properties: {
        startTime: {
          type: 'string',
          format: 'date-time',
          description:
            'Start of the billing period (RFC 3339). Defaults to 30 days ago. Snapped down to the start of its bucketSize bucket so the window aligns with the returned records; provide a boundary-aligned value (e.g. midnight for bucketSize=day) to avoid widening.\n',
        },
        endTime: {
          type: 'string',
          format: 'date-time',
          description:
            'End of the billing period (RFC 3339), exclusive. Defaults to now. Snapped up to the end of the bucketSize bucket it lands in (unless already on a boundary) so the window aligns with the returned records.\n',
        },
        bucketSize: {
          $ref: '#/$defs/BillingBucketSize',
          description: 'Length of each billing time bucket. Defaults to day.',
        },
        lastN: {
          type: 'integer',
          minimum: 1,
          description:
            'Return the last N buckets of bucketSize, ending with the current (in-progress) bucket — e.g. lastN=100 with bucketSize=day is "last 100 days". The resolved window is aligned to bucket boundaries: startTime is the start of the earliest bucket (e.g. midnight of the earliest day) and endTime is the end of the current bucket. Mutually exclusive with startTime/endTime; provide one or the other, not both.\n',
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
    operationId: 'listPods',
    description:
      'List pods. Returns pods owned by the authenticated user. Cluster member pods are excluded by default; set `includeClusterPods=true` to include them (each carries a non-null `cluster` membership block).',
    method: 'GET',
    path: '/v2/pods',
    params: [
      {
        name: 'includeClusterPods',
        location: 'query',
      },
    ],
    hasBody: false,
    inputSchema: {
      type: 'object',
      properties: {
        includeClusterPods: {
          type: 'boolean',
          default: false,
          description:
            'Include cluster member pods in the result. Defaults to false.',
        },
      },
    },
  },
  {
    name: 'list-public-templates',
    operationId: 'listPublicTemplates',
    description:
      "List public templates. Returns the public template catalog. `source` selects which slice: `official` (the default) is Runpod-curated templates, `verified` is community templates Runpod has verified, and `community` is everything else other users have shared publicly. Both pod and serverless templates appear — use each entry's `serverless` flag to tell them apart. `registry` is always null for templates you don't own. Your own templates (public or private) are managed under `/v2/templates`; fetch any individual template — catalog or owned — via `/v2/templates/{id}`. At most 100 templates are returned. Pagination is not yet supported.",
    method: 'GET',
    path: '/v2/catalog/templates',
    params: [
      {
        name: 'source',
        location: 'query',
      },
    ],
    hasBody: false,
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          enum: ['official', 'verified', 'community'],
          default: 'official',
          description:
            'Which slice of the catalog to return: `official` for\nRunpod-curated templates (default), `verified` for\nRunpod-verified community templates, or `community` for all other\npublicly shared templates.\n',
        },
      },
    },
  },
  {
    name: 'list-registries',
    operationId: 'listRegistries',
    description:
      'List container registries. Returns all container registry credentials owned by the authenticated user.',
    method: 'GET',
    path: '/v2/registries',
    params: [],
    hasBody: false,
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'list-serverless-billing',
    operationId: 'listServerlessBilling',
    description:
      'Get serverless billing history, split into time buckets. SIZE WARNING: with defaults this emits one record per endpoint PER BUCKET — on an account with many endpoints the response overflows the tool-result limit and becomes unusable. Always pass lastN: 1 (or a bucketSize spanning the whole window) for one record per endpoint, and serverlessId when you need one endpoint. Distinct from pod billing, which covers standalone pods.',
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
    inputSchema: {
      type: 'object',
      properties: {
        startTime: {
          type: 'string',
          format: 'date-time',
          description:
            'Start of the billing period (RFC 3339). Defaults to 30 days ago. Snapped down to the start of its bucketSize bucket so the window aligns with the returned records; provide a boundary-aligned value (e.g. midnight for bucketSize=day) to avoid widening.\n',
        },
        endTime: {
          type: 'string',
          format: 'date-time',
          description:
            'End of the billing period (RFC 3339), exclusive. Defaults to now. Snapped up to the end of the bucketSize bucket it lands in (unless already on a boundary) so the window aligns with the returned records.\n',
        },
        bucketSize: {
          $ref: '#/$defs/BillingBucketSize',
          description: 'Length of each billing time bucket. Defaults to day.',
        },
        lastN: {
          type: 'integer',
          minimum: 1,
          description:
            'Return the last N buckets of bucketSize, ending with the current (in-progress) bucket — e.g. lastN=100 with bucketSize=day is "last 100 days". The resolved window is aligned to bucket boundaries: startTime is the start of the earliest bucket (e.g. midnight of the earliest day) and endTime is the end of the current bucket. Mutually exclusive with startTime/endTime; provide one or the other, not both.\n',
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
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
        },
        body: {
          $ref: '#/$defs/PodActionRequest',
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
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Cluster identifier',
        },
        body: {
          $ref: '#/$defs/UpdateClusterRequest',
        },
      },
      required: ['id', 'body'],
      $defs: {
        UpdateClusterRequest: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          description:
            'Request body for updating a cluster. Only the cluster name can be\nchanged — this endpoint is a rename. Compute shape, type, and container\nconfiguration are fixed at creation.\n',
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
    operationId: 'updateEndpoint',
    description:
      "Update a serverless endpoint. Partially updates a serverless endpoint. This is a PATCH: only the fields present in the body are changed; omitted fields are left untouched. See `UpdateEndpointRequest` for the full body. Mutable fields: `name`, `gpu`, `cpu`, `workers` (`min`/`max`), `scaling` (`type`/`value`/`idleTimeout`), `dataCenterIds`, `networkVolumes`, `timeout`, `flashboot`, and the container settings (`image`, `args`, `disk`, `ports`, `env`, `registry`). Omitted compute preserves the current selection. `cpu` completely replaces a CPU endpoint's selection; compute family is immutable. `gpu` on CPU, `cpu` on GPU, or both fields returns 400. Returns `200` with the full updated endpoint. Effect timing differs by field: scaling and worker-bound settings (`workers`, `scaling`, `timeout`) are applied to the autoscaler promptly, while container-affecting changes (e.g. `image`, `env`) create a new endpoint release that rolls out as workers cycle — in-flight workers keep the previous version until they are replaced. Track rollout via `listEndpointReleases`.",
    method: 'PATCH',
    path: '/v2/serverless/{id}',
    params: [
      {
        name: 'id',
        location: 'path',
      },
    ],
    hasBody: true,
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
          description:
            'Container configuration universal to every containerized resource. Compose ContainerConfig instead unless the resource cannot support private registries (clusters, until the upstream input accepts a registry credential).\n',
          properties: {
            args: {
              type: 'string',
              description: 'Arguments passed to the container entrypoint',
              examples: [''],
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
                'Serverless GPU pool IDs (as returned by `GET /v2/catalog/gpus` in\n`pool`). Workers are placed on whichever listed pool has capacity.\nNarrow a pool down to specific cards with `excludedTypes`.\n',
              items: {
                type: 'string',
              },
              examples: [['ADA_24']],
            },
            excludedTypes: {
              type: 'array',
              uniqueItems: true,
              description:
                'GPU **type** IDs to subtract from the selected pools — the `id`\nfield of `GET /v2/catalog/gpus`, the same identifiers pods take in\n`gpu.id`. Workers run on every type in `pools` except these. Omit to\nuse the whole pool.\n\nPools stay the unit of selection; types are the unit of\nsubtraction. There is no inclusive allowlist: a card later added to\none of your pools becomes eligible, which is the honest reading of\n"this pool, minus these".\n\nTied to `pools`, because the two together are one selection:\nsupplying `pools` replaces that selection wholesale, so a `PATCH`\nsending `pools` **without `excludedTypes`** **clears** them —\nrestate them to keep them. A `PATCH` that omits `pools` leaves both\nthe pools and the exclusions untouched, so changing only a CUDA\nconstraint cannot widen a pinned endpoint.\n\nRejected with 400 if a value is not a GPU type in one of `pools`;\nupstream accepts unrecognized exclusions silently, so a typo would\notherwise produce a filter that does nothing. Surrounding whitespace\nis trimmed, so `" NVIDIA L40"` and `"NVIDIA L40"` mean the same card.\n',
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
          description:
            'Reusable container configuration shared across templates, pods, and serverless endpoints. Adding a field here automatically propagates to all three resources.\n',
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
        EndpointScaling: {
          description:
            "Autoscaling signal — a discriminated union on `type`: `QUEUE_DELAY`\n(queue-based endpoints only) or `REQUEST_COUNT`. The scaler is chosen\nindependently of the endpoint's routing `type` and can be switched on\nupdate.\n",
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
                'Seconds before idle workers scale down. Not applicable to queue-based\nendpoints scaling on `requestCount` — rejected on create/update and\nomitted from responses for that combination.\n',
              examples: [5],
            },
          },
        },
        FlashBoot: {
          type: 'string',
          description:
            'FlashBoot cold-start acceleration mode.\n- `OFF`                — disabled\n- `FLASHBOOT`          — enabled\n- `PRIORITY_FLASHBOOT` — enabled with priority capacity\n',
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
            'Scale on concurrent in-flight requests per worker. Required for\nload-balancing endpoints; also selectable for queue-based.\n',
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
            'Partial GPU update — every field is optional and an omitted one is left\nunchanged. Unlike create, `pools` is optional, so changing only a CUDA\nconstraint does not require resending the pool list.\n\n`excludedTypes` requires `pools`, because the two are one selection and\nonly a supplied `pools` replaces it — an exclusion on its own would\notherwise be silently dropped.\n',
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
                    'Acceptable CUDA versions for worker placement, as\n`major.minor`. An explicit `[]` clears the constraint;\nomitting the field leaves it unchanged. Takes effect as\nworkers are replaced.\n\nA non-empty set is mutually exclusive with minCudaVersion (400\nif both are sent). An explicit `[]` states no constraint, so it\nmay accompany a floor.\nSetting one does not clear the other — clear it explicitly in\nthe same patch if the endpoint already carries it.\n',
                },
                minCudaVersion: {
                  type: 'string',
                  pattern: '^$|^\\d+\\.\\d+$',
                  description:
                    'Lowest acceptable CUDA version for worker placement, as\n`major.minor`. An explicit `""` clears the floor; omitting the\nfield leaves it unchanged. Takes effect as workers are\nreplaced.\n\nMutually exclusive with a non-empty allowedCudaVersions (400 if\nboth are sent); an explicit `[]` there states no constraint and\nmay accompany this floor.\n',
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
                    'Complete replacement CPU selection. Valid only for an existing CPU\nendpoint; endpoint compute family cannot be changed.\n',
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
                },
                scaling: {
                  $ref: '#/$defs/EndpointScaling',
                },
                templateId: {
                  type: 'string',
                  description:
                    "ID of a serverless template whose container settings are\napplied as if they were provided in this PATCH body (image,\nargs, disk, ports, env, registry). Explicit body fields\noverride the template's; `env` merges template and body per\nkey (body wins) and, per PATCH semantics, replaces the\nendpoint's env. One-time application — no link to the\ntemplate is retained. Must be one of your templates or a\npublic template (unknown or inaccessible ID → 404); must be\na serverless template (→ 422).\n",
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
    name: 'update-network-volume',
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
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Network volume identifier',
        },
        body: {
          $ref: '#/$defs/UpdateNetworkVolumeRequest',
        },
      },
      required: ['id', 'body'],
      $defs: {
        UpdateNetworkVolumeRequest: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          description:
            'Only the provided fields are updated. At least one field must be\npresent; an empty body is rejected.\n',
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
                'New size in GB. Must be greater than or equal to the current size —\nnetwork volume storage cannot be reduced.\n',
              examples: [100],
            },
          },
        },
      },
    },
  },
  {
    name: 'update-pod',
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
          description:
            'Container configuration universal to every containerized resource. Compose ContainerConfig instead unless the resource cannot support private registries (clusters, until the upstream input accepts a registry credential).\n',
          properties: {
            args: {
              type: 'string',
              description: 'Arguments passed to the container entrypoint',
              examples: [''],
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
          description:
            'Reusable container configuration shared across templates, pods, and serverless endpoints. Adding a field here automatically propagates to all three resources.\n',
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
        Mounts: {
          type: 'object',
          additionalProperties: false,
          description:
            'Storage mounts attached to a pod. At-most-one of `persistent` or\n`network` may be set today (mutually exclusive, enforced at the\nhandler with 400 if both are present). The `network` field is an\narray for forward compatibility with eventual multi-network-volume\nsupport, but `maxItems` is 1 today.\n\nPATCH semantics:\n- Omitting `mounts` or sending `{}` leaves the existing mount\n  unchanged.\n- An explicit `network: []` is rejected with 400 (clearing mounts\n  is not supported).\n- Mount kind is fixed at create — a PATCH that introduces a kind\n  not present at create (persistent on a network pod, network on\n  a persistent pod, or any mount on a previously-mountless pod)\n  is rejected with 400.\n- The `volumeId` of a network mount is immutable; a PATCH that\n  names a different `volumeId` is rejected with 400.\n- Partial mounts are not supported — every mount entry must\n  include the full schema (`size` + `path` for persistent,\n  `volumeId` + `path` for network). Missing required fields → 422.\n',
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
        NetworkMount: {
          type: 'object',
          required: ['volumeId', 'path'],
          additionalProperties: false,
          description:
            'Reference to a NetworkVolume. Custom paths are honored at runtime on\nboth GPU and CPU pods. The underlying `volumeId` is immutable\npost-create; the mount `path` may be changed via PATCH.\n',
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
            "Host-local persistent storage. Pinned to the pod's host machine — data\ndoes not survive a host failure. Disallowed on CPU pods. Mutually\nexclusive with NetworkMount. Deprecated: prefer NetworkMount for any\ndata you cannot recreate.\n",
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
                    'Enable (true) or disable (false) global networking. Takes effect on the next pod start/restart, not live. Requires an NVIDIA GPU and a global-networking-enabled data center (both enforced upstream). See `GET /v2/catalog/datacenters` (`globalNetwork`) for eligible data centers.',
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
                    "ID of a pod template whose container settings are applied as\nif they were provided in this PATCH body (image, args, disk,\nports, env, registry — mounts are not applied on update).\nExplicit body fields override the template's; `env` merges\ntemplate and body per key (body wins) and, per PATCH\nsemantics, replaces the pod's env. One-time application —\nno link to the template is retained. Must be one of your\ntemplates or a public template (unknown or inaccessible ID\n→ 404); must not be a serverless template (→ 422).\n",
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
    name: 'update-ssh-keys',
    operationId: 'updateSshKeys',
    description:
      "Replace registered SSH public keys. Replaces the account's full set of registered SSH public keys. Existing keys not present in the request are removed; send `[]` to remove all keys. Keys take effect for pods created afterwards with `startSsh` — running pods are not updated.",
    method: 'PUT',
    path: '/v2/account/ssh-keys',
    params: [],
    hasBody: true,
    inputSchema: {
      type: 'object',
      properties: {
        body: {
          $ref: '#/$defs/UpdateSshKeysRequest',
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
                "The full set of SSH public keys to register — this is a complete\nreplacement, not a merge. Each entry is an authorized_keys-style\nline: `<type> <base64-key> [comment]`, e.g. from\n`~/.ssh/id_ed25519.pub`. Send `[]` to remove all keys. These keys\nare provisioned into pods created with `startSsh` and\nauthenticate both SSH paths reported in the pod's `ssh` block.\n",
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
          description:
            'Container configuration universal to every containerized resource. Compose ContainerConfig instead unless the resource cannot support private registries (clusters, until the upstream input accepts a registry credential).\n',
          properties: {
            args: {
              type: 'string',
              description: 'Arguments passed to the container entrypoint',
              examples: [''],
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
          description:
            'Reusable container configuration shared across templates, pods, and serverless endpoints. Adding a field here automatically propagates to all three resources.\n',
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
            "Host-local persistent storage. Pinned to the pod's host machine — data\ndoes not survive a host failure. Disallowed on CPU pods. Mutually\nexclusive with NetworkMount. Deprecated: prefer NetworkMount for any\ndata you cannot recreate.\n",
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
            'Controls how the template is grouped and filtered in the Runpod console.\nIt does not affect hardware selection, scheduling, or billing.\n- `CPU`    — CPU-only workloads\n- `NVIDIA` — NVIDIA GPU workloads\n- `AMD`    — AMD GPU workloads\n',
          enum: ['CPU', 'NVIDIA', 'AMD'],
        },
        TemplateMounts: {
          type: 'object',
          additionalProperties: false,
          description:
            'Storage mounts attached to a template. Templates support only a\nsingle persistent mount today; any `network` property is rejected\nwith 422 by the schema validator.\n\nPATCH semantics: omitting `mounts` or sending `{}` leaves the\nexisting mount unchanged.\n',
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
