import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fetch, { type RequestInit as NodeFetchRequestInit } from 'node-fetch';

// Base URL for RunPod API
const API_BASE_URL = 'https://rest.runpod.io/v1';

// Get API key from environment variable
const API_KEY = process.env.RUNPOD_API_KEY;
if (!API_KEY) {
  console.error('RUNPOD_API_KEY environment variable is required');
  process.exit(1);
}

// Create an MCP server
const server = new McpServer({
  name: 'RunPod API Server',
  version: '1.0.0',
  capabilities: {
    resources: {},
    tools: {},
  },
});

// Helper function to make authenticated API requests to RunPod
async function runpodRequest(
  endpoint: string,
  method: string = 'GET',
  body?: Record<string, unknown>
) {
  const url = `${API_BASE_URL}${endpoint}`;
  const headers = {
    Authorization: `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
  };

  const options: NodeFetchRequestInit = {
    method,
    headers,
  };

  if (body && (method === 'POST' || method === 'PATCH')) {
    options.body = JSON.stringify(body);
  }

  try {
    const response = await fetch(url, options);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`RunPod API Error: ${response.status} - ${errorText}`);
    }

    // Some endpoints might not return JSON
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      return await response.json();
    }

    return { success: true, status: response.status };
  } catch (error) {
    console.error('Error calling RunPod API:', error);
    throw error;
  }
}

// Serverless API base URL for endpoint runtime operations (run, status, cancel, etc.)
const SERVERLESS_API_BASE_URL = 'https://api.runpod.ai/v2';

// Helper function to make authenticated requests to the Serverless runtime API
async function serverlessRequest(
  endpointId: string,
  path: string,
  method: string = 'GET',
  body?: Record<string, unknown>
) {
  const url = `${SERVERLESS_API_BASE_URL}/${endpointId}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
  };

  const options: NodeFetchRequestInit = {
    method,
    headers,
  };

  if (body && (method === 'POST' || method === 'PATCH')) {
    options.body = JSON.stringify(body);
  }

  try {
    const response = await fetch(url, options);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `RunPod Serverless API Error: ${response.status} - ${errorText}`
      );
    }

    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      return await response.json();
    }

    return { success: true, status: response.status };
  } catch (error) {
    console.error('Error calling RunPod Serverless API:', error);
    throw error;
  }
}

// ============== POD MANAGEMENT TOOLS ==============

// List Pods
server.tool(
  'list-pods',
  {
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
  async (params) => {
    // Construct query parameters
    const queryParams = new URLSearchParams();

    if (params.computeType)
      queryParams.append('computeType', params.computeType);
    if (params.gpuTypeId)
      params.gpuTypeId.forEach((type) => queryParams.append('gpuTypeId', type));
    if (params.dataCenterId)
      params.dataCenterId.forEach((dc) =>
        queryParams.append('dataCenterId', dc)
      );
    if (params.name) queryParams.append('name', params.name);
    if (params.includeMachine)
      queryParams.append('includeMachine', params.includeMachine.toString());
    if (params.includeNetworkVolume)
      queryParams.append(
        'includeNetworkVolume',
        params.includeNetworkVolume.toString()
      );

    const queryString = queryParams.toString()
      ? `?${queryParams.toString()}`
      : '';
    const result = await runpodRequest(`/pods${queryString}`);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// Get Pod Details
server.tool(
  'get-pod',
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
  async (params) => {
    // Construct query parameters
    const queryParams = new URLSearchParams();

    if (params.includeMachine)
      queryParams.append('includeMachine', params.includeMachine.toString());
    if (params.includeNetworkVolume)
      queryParams.append(
        'includeNetworkVolume',
        params.includeNetworkVolume.toString()
      );

    const queryString = queryParams.toString()
      ? `?${queryParams.toString()}`
      : '';
    const result = await runpodRequest(`/pods/${params.podId}${queryString}`);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// Create Pod
server.tool(
  'create-pod',
  {
    name: z.string().optional().describe('Name for the pod'),
    imageName: z.string().describe('Docker image to use'),
    cloudType: z
      .enum(['SECURE', 'COMMUNITY'])
      .optional()
      .describe('SECURE or COMMUNITY cloud'),
    gpuTypeIds: z
      .array(z.string())
      .optional()
      .describe('List of acceptable GPU types'),
    gpuCount: z.number().optional().describe('Number of GPUs'),
    containerDiskInGb: z
      .number()
      .optional()
      .describe('Container disk size in GB'),
    volumeInGb: z.number().optional().describe('Volume size in GB'),
    volumeMountPath: z.string().optional().describe('Path to mount the volume'),
    ports: z
      .array(z.string())
      .optional()
      .describe("Ports to expose (e.g., '8888/http', '22/tcp')"),
    env: z.record(z.string()).optional().describe('Environment variables'),
    dataCenterIds: z
      .array(z.string())
      .optional()
      .describe('List of data centers'),
  },
  async (params) => {
    const result = await runpodRequest('/pods', 'POST', params);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// Update Pod
server.tool(
  'update-pod',
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
    env: z.record(z.string()).optional().describe('New environment variables'),
  },
  async (params) => {
    const { podId, ...updateParams } = params;
    const result = await runpodRequest(`/pods/${podId}`, 'PATCH', updateParams);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// Start Pod
server.tool(
  'start-pod',
  {
    podId: z.string().describe('ID of the pod to start'),
  },
  async (params) => {
    const result = await runpodRequest(`/pods/${params.podId}/start`, 'POST');

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// Stop Pod
server.tool(
  'stop-pod',
  {
    podId: z.string().describe('ID of the pod to stop'),
  },
  async (params) => {
    const result = await runpodRequest(`/pods/${params.podId}/stop`, 'POST');

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// Delete Pod
server.tool(
  'delete-pod',
  {
    podId: z.string().describe('ID of the pod to delete'),
  },
  async (params) => {
    const result = await runpodRequest(`/pods/${params.podId}`, 'DELETE');

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// ============== ENDPOINT MANAGEMENT TOOLS ==============

// List Endpoints
server.tool(
  'list-endpoints',
  {
    includeTemplate: z
      .boolean()
      .optional()
      .describe('Include template information'),
    includeWorkers: z
      .boolean()
      .optional()
      .describe('Include information about workers'),
  },
  async (params) => {
    // Construct query parameters
    const queryParams = new URLSearchParams();

    if (params.includeTemplate)
      queryParams.append('includeTemplate', params.includeTemplate.toString());
    if (params.includeWorkers)
      queryParams.append('includeWorkers', params.includeWorkers.toString());

    const queryString = queryParams.toString()
      ? `?${queryParams.toString()}`
      : '';
    const result = await runpodRequest(`/endpoints${queryString}`);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// Get Endpoint Details
server.tool(
  'get-endpoint',
  {
    endpointId: z.string().describe('ID of the endpoint to retrieve'),
    includeTemplate: z
      .boolean()
      .optional()
      .describe('Include template information'),
    includeWorkers: z
      .boolean()
      .optional()
      .describe('Include information about workers'),
  },
  async (params) => {
    // Construct query parameters
    const queryParams = new URLSearchParams();

    if (params.includeTemplate)
      queryParams.append('includeTemplate', params.includeTemplate.toString());
    if (params.includeWorkers)
      queryParams.append('includeWorkers', params.includeWorkers.toString());

    const queryString = queryParams.toString()
      ? `?${queryParams.toString()}`
      : '';
    const result = await runpodRequest(
      `/endpoints/${params.endpointId}${queryString}`
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// Create Endpoint
server.tool(
  'create-endpoint',
  {
    name: z.string().optional().describe('Name for the endpoint'),
    templateId: z.string().describe('Template ID to use'),
    computeType: z
      .enum(['GPU', 'CPU'])
      .optional()
      .describe('GPU or CPU endpoint'),
    gpuTypeIds: z
      .array(z.string())
      .optional()
      .describe('List of acceptable GPU types'),
    gpuCount: z.number().optional().describe('Number of GPUs per worker'),
    workersMin: z.number().optional().describe('Minimum number of workers'),
    workersMax: z.number().optional().describe('Maximum number of workers'),
    dataCenterIds: z
      .array(z.string())
      .optional()
      .describe('List of data centers'),
  },
  async (params) => {
    const result = await runpodRequest('/endpoints', 'POST', params);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// Update Endpoint
server.tool(
  'update-endpoint',
  {
    endpointId: z.string().describe('ID of the endpoint to update'),
    name: z.string().optional().describe('New name for the endpoint'),
    workersMin: z.number().optional().describe('New minimum number of workers'),
    workersMax: z.number().optional().describe('New maximum number of workers'),
    idleTimeout: z.number().optional().describe('New idle timeout in seconds'),
    scalerType: z
      .enum(['QUEUE_DELAY', 'REQUEST_COUNT'])
      .optional()
      .describe('Scaler type'),
    scalerValue: z.number().optional().describe('Scaler value'),
  },
  async (params) => {
    const { endpointId, ...updateParams } = params;
    const result = await runpodRequest(
      `/endpoints/${endpointId}`,
      'PATCH',
      updateParams
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// Delete Endpoint
server.tool(
  'delete-endpoint',
  {
    endpointId: z.string().describe('ID of the endpoint to delete'),
  },
  async (params) => {
    const result = await runpodRequest(
      `/endpoints/${params.endpointId}`,
      'DELETE'
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// ============== SERVERLESS RUNTIME TOOLS ==============

// Run Endpoint (Async)
server.tool(
  'run-endpoint',
  'Submit an asynchronous job to a Serverless endpoint. Returns a job ID immediately — use get-job-status to poll for results. Async results are available for 30 minutes after completion.',
  {
    endpointId: z.string().describe('ID of the Serverless endpoint to run'),
    input: z
      .record(z.unknown())
      .describe(
        'Input payload for the worker handler. The expected fields depend on the deployed model or worker.'
      ),
    webhook: z
      .string()
      .optional()
      .describe(
        'Webhook URL to receive job completion notifications instead of polling'
      ),
    policy: z
      .object({
        executionTimeout: z
          .number()
          .optional()
          .describe('Maximum execution time in milliseconds'),
        lowPriority: z
          .boolean()
          .optional()
          .describe('Submit as a low-priority job'),
        ttl: z
          .number()
          .optional()
          .describe('Time-to-live for the job result in milliseconds'),
      })
      .optional()
      .describe('Execution policy options'),
    s3Config: z
      .object({
        accessId: z.string().describe('S3 access key ID'),
        accessSecret: z.string().describe('S3 secret access key'),
        bucketName: z.string().describe('S3 bucket name'),
        endpointUrl: z.string().describe('S3 endpoint URL'),
      })
      .optional()
      .describe('S3-compatible storage config for large outputs'),
  },
  async (params) => {
    const { endpointId, ...body } = params;
    const result = await serverlessRequest(
      endpointId,
      '/run',
      'POST',
      body as Record<string, unknown>
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// Run Endpoint Sync
server.tool(
  'runsync-endpoint',
  'Submit a synchronous job to a Serverless endpoint and wait for the result. Best for tasks completing within 90 seconds. If processing exceeds 90 seconds, the response returns a job ID to poll with get-job-status. Max payload: 20 MB. Results expire after 1 minute (up to 5 minutes with the wait parameter).',
  {
    endpointId: z
      .string()
      .describe('ID of the Serverless endpoint to run synchronously'),
    input: z
      .record(z.unknown())
      .describe(
        'Input payload for the worker handler. The expected fields depend on the deployed model or worker.'
      ),
    webhook: z
      .string()
      .optional()
      .describe('Webhook URL to receive completion notifications'),
    policy: z
      .object({
        executionTimeout: z
          .number()
          .optional()
          .describe('Maximum execution time in milliseconds'),
        lowPriority: z
          .boolean()
          .optional()
          .describe('Submit as a low-priority job'),
        ttl: z
          .number()
          .optional()
          .describe('Time-to-live for the job result in milliseconds'),
      })
      .optional()
      .describe('Execution policy options'),
    s3Config: z
      .object({
        accessId: z.string().describe('S3 access key ID'),
        accessSecret: z.string().describe('S3 secret access key'),
        bucketName: z.string().describe('S3 bucket name'),
        endpointUrl: z.string().describe('S3 endpoint URL'),
      })
      .optional()
      .describe('S3-compatible storage config for large outputs'),
  },
  async (params) => {
    const { endpointId, ...body } = params;
    const result = await serverlessRequest(
      endpointId,
      '/runsync',
      'POST',
      body as Record<string, unknown>
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// Get Job Status
server.tool(
  'get-job-status',
  'Check the status of an asynchronous Serverless job. Returns the current status and output when complete. Job statuses: IN_QUEUE, IN_PROGRESS, COMPLETED, FAILED, CANCELLED, TIMED_OUT.',
  {
    endpointId: z
      .string()
      .describe('ID of the Serverless endpoint the job belongs to'),
    jobId: z.string().describe('ID of the job to check'),
  },
  async (params) => {
    const result = await serverlessRequest(
      params.endpointId,
      `/status/${params.jobId}`
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// Stream Job Results
server.tool(
  'stream-job',
  'Retrieve incremental streaming results from a Serverless job. The worker must support streaming output. Each chunk is up to 1 MB.',
  {
    endpointId: z
      .string()
      .describe('ID of the Serverless endpoint the job belongs to'),
    jobId: z.string().describe('ID of the job to stream results from'),
  },
  async (params) => {
    const result = await serverlessRequest(
      params.endpointId,
      `/stream/${params.jobId}`
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// Cancel Job
server.tool(
  'cancel-job',
  'Cancel a Serverless job that is queued or in progress.',
  {
    endpointId: z
      .string()
      .describe('ID of the Serverless endpoint the job belongs to'),
    jobId: z.string().describe('ID of the job to cancel'),
  },
  async (params) => {
    const result = await serverlessRequest(
      params.endpointId,
      `/cancel/${params.jobId}`,
      'POST'
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// Retry Job
server.tool(
  'retry-job',
  'Retry a failed or timed-out Serverless job. Only works for jobs with FAILED or TIMED_OUT status. The previous output is removed and the job is requeued.',
  {
    endpointId: z
      .string()
      .describe('ID of the Serverless endpoint the job belongs to'),
    jobId: z.string().describe('ID of the job to retry'),
  },
  async (params) => {
    const result = await serverlessRequest(
      params.endpointId,
      `/retry/${params.jobId}`,
      'POST'
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// Endpoint Health
server.tool(
  'endpoint-health',
  'Get the health and operational status of a Serverless endpoint, including worker counts and job statistics.',
  {
    endpointId: z
      .string()
      .describe('ID of the Serverless endpoint to check health for'),
  },
  async (params) => {
    const result = await serverlessRequest(params.endpointId, '/health');

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// Purge Endpoint Queue
server.tool(
  'purge-endpoint-queue',
  'Remove all pending jobs from a Serverless endpoint queue. Only affects queued jobs — in-progress jobs continue running. Use this for error recovery or clearing outdated requests.',
  {
    endpointId: z
      .string()
      .describe('ID of the Serverless endpoint to purge the queue for'),
  },
  async (params) => {
    const result = await serverlessRequest(
      params.endpointId,
      '/purge-queue',
      'POST'
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// ============== TEMPLATE MANAGEMENT TOOLS ==============

// List Templates
server.tool('list-templates', {}, async () => {
  const result = await runpodRequest('/templates');

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
});

// Get Template Details
server.tool(
  'get-template',
  {
    templateId: z.string().describe('ID of the template to retrieve'),
  },
  async (params) => {
    const result = await runpodRequest(`/templates/${params.templateId}`);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// Create Template
server.tool(
  'create-template',
  {
    name: z.string().describe('Name for the template'),
    imageName: z.string().describe('Docker image to use'),
    isServerless: z
      .boolean()
      .optional()
      .describe('Is this a serverless template'),
    ports: z.array(z.string()).optional().describe('Ports to expose'),
    dockerEntrypoint: z
      .array(z.string())
      .optional()
      .describe('Docker entrypoint commands'),
    dockerStartCmd: z
      .array(z.string())
      .optional()
      .describe('Docker start commands'),
    env: z.record(z.string()).optional().describe('Environment variables'),
    containerDiskInGb: z
      .number()
      .optional()
      .describe('Container disk size in GB'),
    volumeInGb: z.number().optional().describe('Volume size in GB'),
    volumeMountPath: z.string().optional().describe('Path to mount the volume'),
    readme: z.string().optional().describe('README content in markdown format'),
  },
  async (params) => {
    const result = await runpodRequest('/templates', 'POST', params);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// Update Template
server.tool(
  'update-template',
  {
    templateId: z.string().describe('ID of the template to update'),
    name: z.string().optional().describe('New name for the template'),
    imageName: z.string().optional().describe('New Docker image'),
    ports: z.array(z.string()).optional().describe('New ports to expose'),
    env: z.record(z.string()).optional().describe('New environment variables'),
    readme: z
      .string()
      .optional()
      .describe('New README content in markdown format'),
  },
  async (params) => {
    const { templateId, ...updateParams } = params;
    const result = await runpodRequest(
      `/templates/${templateId}`,
      'PATCH',
      updateParams
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// Delete Template
server.tool(
  'delete-template',
  {
    templateId: z.string().describe('ID of the template to delete'),
  },
  async (params) => {
    const result = await runpodRequest(
      `/templates/${params.templateId}`,
      'DELETE'
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// ============== NETWORK VOLUME MANAGEMENT TOOLS ==============

// List Network Volumes
server.tool('list-network-volumes', {}, async () => {
  const result = await runpodRequest('/networkvolumes');

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
});

// Get Network Volume Details
server.tool(
  'get-network-volume',
  {
    networkVolumeId: z
      .string()
      .describe('ID of the network volume to retrieve'),
  },
  async (params) => {
    const result = await runpodRequest(
      `/networkvolumes/${params.networkVolumeId}`
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// Create Network Volume
server.tool(
  'create-network-volume',
  {
    name: z.string().describe('Name for the network volume'),
    size: z.number().describe('Size in GB (1-4000)'),
    dataCenterId: z.string().describe('Data center ID'),
  },
  async (params) => {
    const result = await runpodRequest('/networkvolumes', 'POST', params);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// Update Network Volume
server.tool(
  'update-network-volume',
  {
    networkVolumeId: z.string().describe('ID of the network volume to update'),
    name: z.string().optional().describe('New name for the network volume'),
    size: z
      .number()
      .optional()
      .describe('New size in GB (must be larger than current)'),
  },
  async (params) => {
    const { networkVolumeId, ...updateParams } = params;
    const result = await runpodRequest(
      `/networkvolumes/${networkVolumeId}`,
      'PATCH',
      updateParams
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// Delete Network Volume
server.tool(
  'delete-network-volume',
  {
    networkVolumeId: z.string().describe('ID of the network volume to delete'),
  },
  async (params) => {
    const result = await runpodRequest(
      `/networkvolumes/${params.networkVolumeId}`,
      'DELETE'
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// ============== CONTAINER REGISTRY AUTH TOOLS ==============

// List Container Registry Auths
server.tool('list-container-registry-auths', {}, async () => {
  const result = await runpodRequest('/containerregistryauth');

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
});

// Get Container Registry Auth Details
server.tool(
  'get-container-registry-auth',
  {
    containerRegistryAuthId: z
      .string()
      .describe('ID of the container registry auth to retrieve'),
  },
  async (params) => {
    const result = await runpodRequest(
      `/containerregistryauth/${params.containerRegistryAuthId}`
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// Create Container Registry Auth
server.tool(
  'create-container-registry-auth',
  {
    name: z.string().describe('Name for the container registry auth'),
    username: z.string().describe('Registry username'),
    password: z.string().describe('Registry password'),
  },
  async (params) => {
    const result = await runpodRequest(
      '/containerregistryauth',
      'POST',
      params
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// Delete Container Registry Auth
server.tool(
  'delete-container-registry-auth',
  {
    containerRegistryAuthId: z
      .string()
      .describe('ID of the container registry auth to delete'),
  },
  async (params) => {
    const result = await runpodRequest(
      `/containerregistryauth/${params.containerRegistryAuthId}`,
      'DELETE'
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// Start receiving messages on stdin and sending messages on stdout
const transport = new StdioServerTransport();
server.connect(transport);
