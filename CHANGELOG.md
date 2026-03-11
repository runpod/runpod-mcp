# @runpod/mcp-server

## 1.2.0

### Minor Changes

- 7b715eb: Add list-gpu-types and list-data-centers tools using public GraphQL API for hardware and region discovery. Enhance list-templates with filter params (includeRunpodTemplates, includePublicTemplates, includeEndpointBoundTemplates). Add tool descriptions to create-pod and list-templates recommending Pytorch 2.8.0 as default template.
- ea2451b: Add Serverless endpoint runtime tools for invoking deployed workers. New tools: run-endpoint (async), runsync-endpoint (sync), get-job-status, stream-job, cancel-job, retry-job, endpoint-health, and purge-endpoint-queue. These use the Serverless API at api.runpod.ai/v2 with a new serverlessRequest helper.

## 1.1.0

### Minor Changes

- c49b2cc: Add npx support for running the MCP server directly without installation. Includes bin field in package.json, shebang in build output, and updated README with npx command. Also fixes branding consistency (RunPod -> Runpod) and adds development conventions documentation.
