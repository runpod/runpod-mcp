/**
 * runpod-mcp hosted service — platform infrastructure.
 *
 * Resources:
 *   1. Pod (CPU) — stateless HTTP MCP server on port 3000
 *
 * No network volume or persistent storage needed — the service is purely
 * a stateless proxy between MCP clients and the RunPod API.
 *
 * Deploy pattern: stop→edit→resume preserves pod ID so the proxy URL never changes.
 */
import * as runpod from "pulumi-runpod";
import { runpodApiKey, registryAuthId, imageTag, ddApiKey } from "./secrets";
import { tunnelToken } from "./tunnel";
import { config, CPU_INSTANCES } from "./config";

const stage = $app.stage;

const runpodProvider = new runpod.Provider(
  "runpod-provider",
  {
    apiKey: runpodApiKey.value,
    apiUrl: config.runpodApiUrl,
  },
  {
    pluginDownloadURL: "github://api.github.com/runpod/pulumi-runpod",
  },
);

export const servicePod = new runpod.Pod(
  "McpPod",
  {
    name: `runpod-mcp-${stage}`,
    imageName: $interpolate`${config.serviceImage}:${imageTag.value}`,
    computeType: "CPU",
    gpuTypeId: "CPU",
    instanceIds: [config.cpuInstance],
    cloudType: "SECURE",
    deployCost: CPU_INSTANCES[config.cpuInstance],
    dataCenterId: config.dataCenterId,
    ports: "3000/http,22/tcp",
    containerRegistryAuthId: registryAuthId.value,
    env: {
      PORT: "3000",
      DD_API_KEY: ddApiKey.value,
      // Cloudflare tunnel — cloudflared connects outbound to Cloudflare
      CLOUDFLARE_TUNNEL_TOKEN: tunnelToken || "",
      // SSH access
      PUBLIC_KEY:
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIUCndgYpV4/wfVkTxpaQHiZAGYp73AHWi+SCdny/Tel runpod-access",
    },
  },
  { provider: runpodProvider },
);

export const serviceUrl = $interpolate`https://${servicePod.id}-3000.${config.proxyDomain}`;
