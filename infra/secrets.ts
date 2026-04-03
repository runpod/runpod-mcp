/**
 * SST secrets for runpod-mcp hosted service.
 * Set per stage: npx sst secret set <Name> <value> --stage dev
 */

// RunPod API key for the Pulumi provider (deploys the pod itself)
export const runpodApiKey = new sst.Secret("RunpodApiKey");

// Container image tag — set by CI on each release
export const imageTag = new sst.Secret("ImageTag", "latest");

// Container registry auth ID (for pulling ghcr.io/runpod/runpod-mcp)
export const registryAuthId = new sst.Secret("RegistryAuthId");

// Datadog API key for metrics/logs (optional)
export const ddApiKey = new sst.Secret("DdApiKey", "");
