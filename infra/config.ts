/**
 * Per-environment infrastructure config for runpod-mcp hosted service.
 *
 * Stage "dev"  → RunPod dev account  → mcp-dev.runpod.dev
 * Stage "prod" → RunPod prod account → mcp.runpod.dev
 */

export const CPU_INSTANCES = {
  "cpu5c-2-4": 0.04, // dev — small, AMD-1 datacenter
  "cpu3c-2-4": 0.06, // prod — standard
} as const;

export type CpuInstance = keyof typeof CPU_INSTANCES;

interface EnvConfig {
  runpodApiUrl: string;
  proxyDomain: string;
  cpuInstance: CpuInstance;
  dataCenterId: string;
  serviceImage: string;
  cloudflare: {
    accountId: string;
    zoneId: string;
    domain: string;
  };
}

const dev: EnvConfig = {
  runpodApiUrl: process.env.RUNPOD_API_URL ?? "https://api.runpod.dev/graphql",
  proxyDomain: "dev-proxy.runpod.net",
  cpuInstance: "cpu5c-2-4",
  dataCenterId: "CPU-2",
  serviceImage: "ghcr.io/runpod/runpod-mcp",
  cloudflare: {
    accountId: "14068d66ba387efac9ce5e4b1741bcf2",
    zoneId: "d96cbc35506fe0784b60a079db7cd882",
    domain: "mcp-dev.runpod.dev",
  },
};

const prod: EnvConfig = {
  runpodApiUrl: "https://api.runpod.io/graphql",
  proxyDomain: "proxy.runpod.net",
  cpuInstance: "cpu3c-2-4",
  dataCenterId: "CPU-2",
  serviceImage: "ghcr.io/runpod/runpod-mcp",
  cloudflare: {
    accountId: "14068d66ba387efac9ce5e4b1741bcf2",
    zoneId: "d96cbc35506fe0784b60a079db7cd882",
    domain: "mcp.runpod.dev",
  },
};

export const config: EnvConfig = $app.stage === "prod" ? prod : dev;
