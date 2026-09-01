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
                'arn:aws:ecr:us-east-2:123456789012:repository/runpod/deployment',
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
        ContainerConfig: {
          type: 'object',
          description:
            'Reusable container configuration shared across templates, pods, and serverless endpoints. Adding a field here automatically propagates to all three resources.\n',
          properties: {
            image: {
              type: 'string',
              description: 'Docker image reference',
              examples: ['runpod/pytorch:2.8.0-py3.11-cuda12.8.1'],
            },
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
            ports: {
              type: 'array',
              description: 'Exposed ports, formatted as port/protocol',
              items: {
                type: 'string',
              },
              examples: [['8888/http', '22/tcp']],
            },
            env: {
              type: 'object',
              additionalProperties: {
                type: 'string',
              },
              description: 'Environment variables as key-value pairs',
              examples: [
                {
                  JUPYTER_PASSWORD: 'changeme',
                },
              ],
            },
            registry: {
              type: ['string', 'null'],
              description:
                'Container registry credential ID (for private images)',
              examples: [null],
            },
          },
        },
        CreateEndpointRequest: {
          allOf: [
            {
              $ref: '#/$defs/ContainerConfig',
            },
            {
              type: 'object',
              required: ['name', 'image', 'gpu', 'type', 'scaling'],
              properties: {
                name: {
                  type: 'string',
                  minLength: 1,
                  examples: ['my-inference'],
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
                gpu: {
                  allOf: [
                    {
                      $ref: '#/$defs/EndpointGpuConfig',
                    },
                  ],
                  unevaluatedProperties: false,
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
                scaling: {
                  $ref: '#/$defs/EndpointScaling',
                },
                dataCenterIds: {
                  type: 'array',
                  items: {
                    type: 'string',
                  },
                  description:
                    'Preferred data centers for placement. Omit or pass an empty array to let the scheduler choose.',
                },
                networkVolumes: {
                  type: 'array',
                  items: {
                    type: 'string',
                  },
                },
                timeout: {
                  type: 'integer',
                  default: 300000,
                },
                flashboot: {
                  allOf: [
                    {
                      $ref: '#/$defs/FlashBoot',
                    },
                  ],
                  default: 'OFF',
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
        EndpointGpuConfig: {
          type: 'object',
          required: ['pools'],
          properties: {
            pools: {
              type: 'array',
              minItems: 1,
              description:
                'Serverless GPU pool IDs (as returned by `GET /v2/catalog/gpus` in\n`pool`). Workers are placed on whichever listed pool has capacity.\n',
              items: {
                type: 'string',
              },
              examples: [['ADA_24']],
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
            'Request-routing semantics for a serverless endpoint.\n- `QUEUE` — submit asynchronous or synchronous jobs through the managed queue.\n- `LOAD_BALANCER` — send requests directly to worker-defined HTTP paths.\n',
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
          'x-enum-varnames': [
            'FlashBootOff',
            'FlashBootEnabled',
            'FlashBootPriority',
          ],
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
              'x-enum-varnames': ['QueueDelayScalingTypeQueueDelay'],
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
              'x-enum-varnames': ['RequestCountScalingTypeRequestCount'],
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
            dataCenter: {
              type: 'string',
              minLength: 1,
              description: 'Data center in which to create the volume',
              examples: ['EU-RO-1'],
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
          'x-enum-varnames': [
            'VolumeTypeStandard',
            'VolumeTypeHighPerformance',
          ],
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
          'x-enum-varnames': ['CloudSecure', 'CloudCommunity'],
          enum: ['SECURE', 'COMMUNITY'],
        },
        ContainerConfig: {
          type: 'object',
          description:
            'Reusable container configuration shared across templates, pods, and serverless endpoints. Adding a field here automatically propagates to all three resources.\n',
          properties: {
            image: {
              type: 'string',
              description: 'Docker image reference',
              examples: ['runpod/pytorch:2.8.0-py3.11-cuda12.8.1'],
            },
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
            ports: {
              type: 'array',
              description: 'Exposed ports, formatted as port/protocol',
              items: {
                type: 'string',
              },
              examples: [['8888/http', '22/tcp']],
            },
            env: {
              type: 'object',
              additionalProperties: {
                type: 'string',
              },
              description: 'Environment variables as key-value pairs',
              examples: [
                {
                  JUPYTER_PASSWORD: 'changeme',
                },
              ],
            },
            registry: {
              type: ['string', 'null'],
              description:
                'Container registry credential ID (for private images)',
              examples: [null],
            },
          },
        },
        CreateCpuConfig: {
          allOf: [
            {
              $ref: '#/$defs/BaseCpuConfig',
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
              required: ['name', 'image'],
              description:
                "Request body for creating a pod. Exactly one of `gpu` or `cpu`\nmust be set. For CPU pods, memory is derived by the API from the\nselected flavor's RAM multiplier; clients provide only CPU flavor\nand vCPU count. CPU pods support container disk and network\nvolumes only; `mounts.persistent` is invalid when `cpu` is set.\n",
              properties: {
                name: {
                  type: 'string',
                  minLength: 1,
                  examples: ['my-training-pod'],
                },
                mounts: {
                  $ref: '#/$defs/Mounts',
                },
                gpu: {
                  allOf: [
                    {
                      $ref: '#/$defs/GpuConfig',
                    },
                  ],
                  unevaluatedProperties: false,
                },
                cpu: {
                  $ref: '#/$defs/CreateCpuConfig',
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
                    'Enable global networking, giving the pod a private IP reachable across data centers. Requires an NVIDIA GPU and a global-networking-enabled data center. See `GET /v2/catalog/datacenters` (`globalNetwork`) for eligible data centers.',
                  examples: [false],
                },
              },
            },
          ],
          unevaluatedProperties: false,
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
            'Storage mounts attached to a pod. At most one of `persistent` or\n`network` may be set: sending both is rejected with 400. The\n`network` field is an array for forward compatibility with\nmulti-network-volume support; `maxItems` is 1.\n\nPATCH semantics:\n- Omitting `mounts` or sending `{}` leaves the existing mount\n  unchanged.\n- An explicit `network: []` is rejected with 400 (clearing mounts\n  is not supported).\n- Mount kind is fixed at create — a PATCH that introduces a kind\n  not present at create (persistent on a network pod, network on\n  a persistent pod, or any mount on a previously-mountless pod)\n  is rejected with 400.\n- The `volumeId` of a network mount is immutable; a PATCH that\n  names a different `volumeId` is rejected with 400.\n- Partial mounts are not supported — every mount entry must\n  include the full schema (`size` + `path` for persistent,\n  `volumeId` + `path` for network). Missing required fields → 422.\n',
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
            username: {
              type: 'string',
              minLength: 1,
              description:
                'Registry username (write-only, not returned in responses)',
            },
            password: {
              type: 'string',
              minLength: 1,
              description:
                'Registry password (write-only, not returned in responses)',
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
      "Create a template. Creates a reusable container-configuration preset — image, disk, ports, env, registry, and mount settings — for pods and serverless endpoints. `createPod` and `createEndpoint` don't take a template ID; instead, spread a template's fields into the request body directly. Returns the created template.",
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
        ContainerConfig: {
          type: 'object',
          description:
            'Reusable container configuration shared across templates, pods, and serverless endpoints. Adding a field here automatically propagates to all three resources.\n',
          properties: {
            image: {
              type: 'string',
              description: 'Docker image reference',
              examples: ['runpod/pytorch:2.8.0-py3.11-cuda12.8.1'],
            },
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
            ports: {
              type: 'array',
              description: 'Exposed ports, formatted as port/protocol',
              items: {
                type: 'string',
              },
              examples: [['8888/http', '22/tcp']],
            },
            env: {
              type: 'object',
              additionalProperties: {
                type: 'string',
              },
              description: 'Environment variables as key-value pairs',
              examples: [
                {
                  JUPYTER_PASSWORD: 'changeme',
                },
              ],
            },
            registry: {
              type: ['string', 'null'],
              description:
                'Container registry credential ID (for private images)',
              examples: [null],
            },
          },
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
                mounts: {
                  $ref: '#/$defs/TemplateMounts',
                },
                serverless: {
                  type: 'boolean',
                  default: false,
                },
                public: {
                  type: 'boolean',
                  default: false,
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
          'x-enum-varnames': [
            'TemplateCategoryCPU',
            'TemplateCategoryNVIDIA',
            'TemplateCategoryAMD',
          ],
          enum: ['CPU', 'NVIDIA', 'AMD'],
        },
        TemplateMounts: {
          type: 'object',
          additionalProperties: false,
          description:
            'Storage mounts attached to a template. Templates support a single\npersistent mount; any `network` property is rejected with 422.\n\nPATCH semantics: omitting `mounts` or sending `{}` leaves the\nexisting mount unchanged.\n',
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
    name: 'get-cpu-type',
    operationId: 'getCpuType',
    description:
      'Get a CPU type. Returns a single CPU type with pricing. Availability details are included only when requested with include=AVAILABILITY.',
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
            'Comma-separated optional expansions; see `CatalogInclude` for the supported values.',
        },
        product: {
          type: 'array',
          items: {
            $ref: '#/$defs/CpuProduct',
          },
          example: ['POD', 'SERVERLESS'],
          description:
            'Comma-separated availability product context. Valid only with include=AVAILABILITY. Supported values for CPUs: POD, SERVERLESS. Defaults to POD when omitted.',
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
            'Catalog include expansion. `AVAILABILITY` is the only supported value.',
          'x-enum-varnames': ['CatalogIncludeAvailability'],
          enum: ['AVAILABILITY'],
        },
        CpuProduct: {
          type: 'string',
          description: 'CPU catalog product availability context.',
          'x-enum-varnames': ['CpuProductPod', 'CpuProductServerless'],
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
          'x-enum-varnames': [
            'DataCenterIncludeGpuAvailability',
            'DataCenterIncludeCpuAvailability',
          ],
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
      'Get a GPU type. Returns a single GPU type with pricing. Availability details are included only when requested with include=AVAILABILITY.',
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
            'Comma-separated optional expansions; see `CatalogInclude` for the supported values.',
        },
        product: {
          type: 'array',
          items: {
            $ref: '#/$defs/Product',
          },
          description:
            'Comma-separated availability product contexts. Supported values: POD, CLUSTER, SERVERLESS. Valid only with include=AVAILABILITY. Upstream default when omitted: POD.',
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
        minCudaVersion: {
          type: 'string',
          description:
            'Minimum CUDA version for availability and lowest-price calculations. Valid only with include=AVAILABILITY. Format: integer major or major.minor, e.g. 12 or 12.1.',
        },
      },
      required: ['id'],
      $defs: {
        CatalogInclude: {
          type: 'string',
          description:
            'Catalog include expansion. `AVAILABILITY` is the only supported value.',
          'x-enum-varnames': ['CatalogIncludeAvailability'],
          enum: ['AVAILABILITY'],
        },
        GpuCloudFilter: {
          type: 'string',
          description: 'GPU availability cloud filter.',
          'x-enum-varnames': [
            'GpuCloudFilterSecure',
            'GpuCloudFilterCommunity',
          ],
          enum: ['SECURE', 'COMMUNITY'],
        },
        Product: {
          type: 'string',
          description: 'Catalog product availability context.',
          'x-enum-varnames': [
            'ProductPod',
            'ProductCluster',
            'ProductServerless',
          ],
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
    name: 'get-template',
    operationId: 'getTemplate',
    description:
      'Get a template. Returns the full configuration of a single template by ID.',
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
      'Get Instant Cluster billing history. Returns Instant Cluster billing history for the authenticated user, split into time buckets by startTime/endTime with bucketSize or by lastN recent buckets. Use clusterId to filter to one cluster; without it, records are emitted per cluster per bucket. Each record includes GPU compute, disk, inter-node networking, and total amounts. Instant Clusters are GPU-only, so no CPU cost component is returned.',
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
          description: 'Filter to a specific Instant Cluster.',
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
    name: 'list-cpu-types',
    operationId: 'listCpuTypes',
    description:
      'List CPU types. Returns available CPU flavors. Availability is included only when requested with include=AVAILABILITY.',
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
            'Comma-separated optional expansions; see `CatalogInclude` for the supported values.',
        },
        product: {
          type: 'array',
          items: {
            $ref: '#/$defs/CpuProduct',
          },
          example: ['POD', 'SERVERLESS'],
          description:
            'Comma-separated availability product context. Valid only with include=AVAILABILITY. Supported values for CPUs: POD, SERVERLESS. Defaults to POD when omitted.',
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
            'Catalog include expansion. `AVAILABILITY` is the only supported value.',
          'x-enum-varnames': ['CatalogIncludeAvailability'],
          enum: ['AVAILABILITY'],
        },
        CpuProduct: {
          type: 'string',
          description: 'CPU catalog product availability context.',
          'x-enum-varnames': ['CpuProductPod', 'CpuProductServerless'],
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
          'x-enum-varnames': [
            'ComplianceGDPR',
            'ComplianceISOIEC27001',
            'ComplianceISO14001',
            'CompliancePCIDSS',
            'ComplianceHITRUST',
            'ComplianceSOC1Type2',
            'ComplianceSOC2Type2',
            'ComplianceSOC3Type2',
            'ComplianceITAR',
            'ComplianceFISMAHigh',
            'ComplianceHIPAA',
            'ComplianceRenewable',
          ],
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
          'x-enum-varnames': [
            'DataCenterIncludeGpuAvailability',
            'DataCenterIncludeCpuAvailability',
          ],
          enum: ['GPU_AVAILABILITY', 'CPU_AVAILABILITY'],
        },
        DataCenterRegion: {
          type: 'string',
          description: 'Continental region containing the data center.',
          examples: ['EUROPE'],
          'x-enum-varnames': [
            'DataCenterRegionNorthAmerica',
            'DataCenterRegionSouthAmerica',
            'DataCenterRegionEurope',
            'DataCenterRegionAsia',
            'DataCenterRegionMiddleEast',
            'DataCenterRegionAfrica',
            'DataCenterRegionOceania',
            'DataCenterRegionAntarctica',
            'DataCenterRegionUnknown',
          ],
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
          'x-enum-varnames': [
            'VolumeTypeStandard',
            'VolumeTypeHighPerformance',
          ],
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
    name: 'list-endpoints',
    operationId: 'listEndpoints',
    description:
      'List serverless endpoints. Returns all serverless endpoints owned by the authenticated user.',
    method: 'GET',
    path: '/v2/serverless',
    params: [],
    hasBody: false,
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'list-gpu-types',
    operationId: 'listGpuTypes',
    description:
      'List GPU types. Returns available GPU types with pricing. Availability is included only when requested with include=AVAILABILITY.',
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
            'Comma-separated optional expansions; see `CatalogInclude` for the supported values.',
        },
        product: {
          type: 'array',
          items: {
            $ref: '#/$defs/Product',
          },
          description:
            'Comma-separated availability product contexts. Supported values: POD, CLUSTER, SERVERLESS. Valid only with include=AVAILABILITY. Upstream default when omitted: POD.',
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
        minCudaVersion: {
          type: 'string',
          description:
            'Minimum CUDA version for availability and lowest-price calculations. Valid only with include=AVAILABILITY. Format: integer major or major.minor, e.g. 12 or 12.1.',
        },
      },
      $defs: {
        CatalogInclude: {
          type: 'string',
          description:
            'Catalog include expansion. `AVAILABILITY` is the only supported value.',
          'x-enum-varnames': ['CatalogIncludeAvailability'],
          enum: ['AVAILABILITY'],
        },
        GpuCloudFilter: {
          type: 'string',
          description: 'GPU availability cloud filter.',
          'x-enum-varnames': [
            'GpuCloudFilterSecure',
            'GpuCloudFilterCommunity',
          ],
          enum: ['SECURE', 'COMMUNITY'],
        },
        Product: {
          type: 'string',
          description: 'Catalog product availability context.',
          'x-enum-varnames': [
            'ProductPod',
            'ProductCluster',
            'ProductServerless',
          ],
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
    path: '/v2/billing/networkvolumes',
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
    description: 'List pods. Returns all pods owned by the authenticated user.',
    method: 'GET',
    path: '/v2/pods',
    params: [],
    hasBody: false,
    inputSchema: {
      type: 'object',
      properties: {},
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
          'x-enum-varnames': [
            'PodActionStart',
            'PodActionStop',
            'PodActionRestart',
            'PodActionTerminate',
          ],
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
    name: 'update-endpoint',
    operationId: 'updateEndpoint',
    description:
      'Update a serverless endpoint. Partially updates a serverless endpoint. This is a PATCH: only the fields present in the body are changed; omitted fields are left untouched. See `UpdateEndpointRequest` for the full body. Mutable fields: `name`, `gpu`, `workers` (`min`/`max`), `scaling` (`type`/`value`/`idleTimeout`), `dataCenterIds`, `networkVolumes`, `timeout`, `flashboot`, and the container settings (`image`, `args`, `disk`, `ports`, `env`, `registry`). Returns `200` with the full updated endpoint. Effect timing differs by field: scaling and worker-bound settings (`workers`, `scaling`, `timeout`) are applied to the autoscaler promptly, while container-affecting changes (e.g. `image`, `env`) create a new endpoint release that rolls out as workers cycle — in-flight workers keep the previous version until they are replaced. Track rollout via `listEndpointReleases`.',
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
        ContainerConfig: {
          type: 'object',
          description:
            'Reusable container configuration shared across templates, pods, and serverless endpoints. Adding a field here automatically propagates to all three resources.\n',
          properties: {
            image: {
              type: 'string',
              description: 'Docker image reference',
              examples: ['runpod/pytorch:2.8.0-py3.11-cuda12.8.1'],
            },
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
            ports: {
              type: 'array',
              description: 'Exposed ports, formatted as port/protocol',
              items: {
                type: 'string',
              },
              examples: [['8888/http', '22/tcp']],
            },
            env: {
              type: 'object',
              additionalProperties: {
                type: 'string',
              },
              description: 'Environment variables as key-value pairs',
              examples: [
                {
                  JUPYTER_PASSWORD: 'changeme',
                },
              ],
            },
            registry: {
              type: ['string', 'null'],
              description:
                'Container registry credential ID (for private images)',
              examples: [null],
            },
          },
        },
        EndpointGpuConfig: {
          type: 'object',
          required: ['pools'],
          properties: {
            pools: {
              type: 'array',
              minItems: 1,
              description:
                'Serverless GPU pool IDs (as returned by `GET /v2/catalog/gpus` in\n`pool`). Workers are placed on whichever listed pool has capacity.\n',
              items: {
                type: 'string',
              },
              examples: [['ADA_24']],
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
          'x-enum-varnames': [
            'FlashBootOff',
            'FlashBootEnabled',
            'FlashBootPriority',
          ],
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
              'x-enum-varnames': ['QueueDelayScalingTypeQueueDelay'],
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
              'x-enum-varnames': ['RequestCountScalingTypeRequestCount'],
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
        UpdateEndpointRequest: {
          allOf: [
            {
              $ref: '#/$defs/ContainerConfig',
            },
            {
              type: 'object',
              description: 'Only provided fields are changed.',
              properties: {
                name: {
                  type: 'string',
                  minLength: 1,
                },
                gpu: {
                  allOf: [
                    {
                      $ref: '#/$defs/EndpointGpuConfig',
                    },
                  ],
                  unevaluatedProperties: false,
                },
                workers: {
                  $ref: '#/$defs/EndpointWorkers',
                },
                scaling: {
                  $ref: '#/$defs/EndpointScaling',
                },
                dataCenterIds: {
                  type: 'array',
                  items: {
                    type: 'string',
                  },
                  description:
                    'Preferred data centers for placement. Omit or pass an empty array to let the scheduler choose.',
                },
                networkVolumes: {
                  type: 'array',
                  items: {
                    type: 'string',
                  },
                },
                timeout: {
                  type: 'integer',
                },
                flashboot: {
                  $ref: '#/$defs/FlashBoot',
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
      "Update a pod. Partially updates a pod's configuration. This is a PATCH: only the fields present in the body are changed, and omitted fields are left untouched. Use empty values only when you explicitly mean to clear a field (for example, set `registry` to `null` or set `ports` to `[]`). See `UpdatePodRequest` for the full body. Mutable fields: `name`, `image`, `args`, `disk`, `ports`, `env`, `registry`, `mounts`, `locked`, and `globalNetworking`. Some changes apply immediately while others (e.g. `globalNetworking`) take effect on the pod's next start/restart, as noted on the individual fields. Returns `200` with the full updated pod.",
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
        ContainerConfig: {
          type: 'object',
          description:
            'Reusable container configuration shared across templates, pods, and serverless endpoints. Adding a field here automatically propagates to all three resources.\n',
          properties: {
            image: {
              type: 'string',
              description: 'Docker image reference',
              examples: ['runpod/pytorch:2.8.0-py3.11-cuda12.8.1'],
            },
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
            ports: {
              type: 'array',
              description: 'Exposed ports, formatted as port/protocol',
              items: {
                type: 'string',
              },
              examples: [['8888/http', '22/tcp']],
            },
            env: {
              type: 'object',
              additionalProperties: {
                type: 'string',
              },
              description: 'Environment variables as key-value pairs',
              examples: [
                {
                  JUPYTER_PASSWORD: 'changeme',
                },
              ],
            },
            registry: {
              type: ['string', 'null'],
              description:
                'Container registry credential ID (for private images)',
              examples: [null],
            },
          },
        },
        Mounts: {
          type: 'object',
          additionalProperties: false,
          description:
            'Storage mounts attached to a pod. At most one of `persistent` or\n`network` may be set: sending both is rejected with 400. The\n`network` field is an array for forward compatibility with\nmulti-network-volume support; `maxItems` is 1.\n\nPATCH semantics:\n- Omitting `mounts` or sending `{}` leaves the existing mount\n  unchanged.\n- An explicit `network: []` is rejected with 400 (clearing mounts\n  is not supported).\n- Mount kind is fixed at create — a PATCH that introduces a kind\n  not present at create (persistent on a network pod, network on\n  a persistent pod, or any mount on a previously-mountless pod)\n  is rejected with 400.\n- The `volumeId` of a network mount is immutable; a PATCH that\n  names a different `volumeId` is rejected with 400.\n- Partial mounts are not supported — every mount entry must\n  include the full schema (`size` + `path` for persistent,\n  `volumeId` + `path` for network). Missing required fields → 422.\n',
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
                name: {
                  type: 'string',
                  minLength: 1,
                },
                mounts: {
                  $ref: '#/$defs/Mounts',
                },
                locked: {
                  type: 'boolean',
                  description:
                    'Lock the pod (true) or unlock it (false). Locked pods cannot be stopped or reset.',
                },
                globalNetworking: {
                  type: 'boolean',
                  description:
                    'Enable (true) or disable (false) global networking. Takes effect on the next pod start/restart, not live. Requires an NVIDIA GPU and a global-networking-enabled data center. See `GET /v2/catalog/datacenters` (`globalNetwork`) for eligible data centers.',
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
    name: 'update-template',
    operationId: 'updateTemplate',
    description:
      "Update a template. Partially updates a template. This is a PATCH: only the fields present in the body are changed; omitted fields are left untouched. See `UpdateTemplateRequest` for the full body. Mutable fields: `name`, `image`, `args`, `disk`, `ports`, `env`, `registry`, `mounts`, `serverless`, `public`, and `category`. Only the template's owner can update it (authenticated via the request's API key); other users' templates are neither visible nor mutable. Returns `200` with the full updated template. Pods and endpoints already created from this template are not changed retroactively — the template is a snapshot applied at creation time.",
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
        ContainerConfig: {
          type: 'object',
          description:
            'Reusable container configuration shared across templates, pods, and serverless endpoints. Adding a field here automatically propagates to all three resources.\n',
          properties: {
            image: {
              type: 'string',
              description: 'Docker image reference',
              examples: ['runpod/pytorch:2.8.0-py3.11-cuda12.8.1'],
            },
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
            ports: {
              type: 'array',
              description: 'Exposed ports, formatted as port/protocol',
              items: {
                type: 'string',
              },
              examples: [['8888/http', '22/tcp']],
            },
            env: {
              type: 'object',
              additionalProperties: {
                type: 'string',
              },
              description: 'Environment variables as key-value pairs',
              examples: [
                {
                  JUPYTER_PASSWORD: 'changeme',
                },
              ],
            },
            registry: {
              type: ['string', 'null'],
              description:
                'Container registry credential ID (for private images)',
              examples: [null],
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
        TemplateCategory: {
          type: 'string',
          description:
            'Controls how the template is grouped and filtered in the Runpod console.\nIt does not affect hardware selection, scheduling, or billing.\n- `CPU`    — CPU-only workloads\n- `NVIDIA` — NVIDIA GPU workloads\n- `AMD`    — AMD GPU workloads\n',
          'x-enum-varnames': [
            'TemplateCategoryCPU',
            'TemplateCategoryNVIDIA',
            'TemplateCategoryAMD',
          ],
          enum: ['CPU', 'NVIDIA', 'AMD'],
        },
        TemplateMounts: {
          type: 'object',
          additionalProperties: false,
          description:
            'Storage mounts attached to a template. Templates support a single\npersistent mount; any `network` property is rejected with 422.\n\nPATCH semantics: omitting `mounts` or sending `{}` leaves the\nexisting mount unchanged.\n',
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
                name: {
                  type: 'string',
                  minLength: 1,
                },
                mounts: {
                  $ref: '#/$defs/TemplateMounts',
                },
                serverless: {
                  type: 'boolean',
                },
                public: {
                  type: 'boolean',
                },
                category: {
                  $ref: '#/$defs/TemplateCategory',
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
