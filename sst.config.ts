/// <reference path="./.sst/platform/config.d.ts" />
/**
 * SST v3 Configuration for runpod-mcp hosted service.
 *
 * Manages:
 *   - Secrets (RunPod API key for pod deploy, image tag, registry auth)
 *   - RunPod CPU pod — stateless HTTP MCP server
 *   - Cloudflare tunnel — stable domain (mcp.runpod.dev / mcp-dev.runpod.dev)
 *
 * State stored in AWS (us-east-1).
 *
 * Deploy:
 *   npx sst deploy --stage dev
 *   npx sst deploy --stage prod
 *
 * Secrets (set once per stage):
 *   npx sst secret set RunpodApiKey <value> --stage dev
 *   npx sst secret set RegistryAuthId <value> --stage dev
 *   npx sst secret set ImageTag <tag> --stage dev
 *
 * Import existing pod (if already running):
 *   npx sst import runpod:index:Pod McpPod <podId> --stage dev
 */
export default $config({
  app(input) {
    return {
      name: "runpod-mcp",
      removal: input?.stage === "prod" ? "retain" : "remove",
      home: "aws",
      providers: {
        aws: { region: "us-east-1" },
        runpod: {
          version: "0.1.5",
          apiUrl:
            process.env.RUNPOD_API_URL ??
            (input?.stage === "prod"
              ? "https://api.runpod.io/graphql"
              : "https://api.runpod.dev/graphql"),
        },
        cloudflare: {
          version: "6.13.0",
        },
      },
    };
  },
  async run() {
    const { servicePod, serviceUrl } = await import("./infra/platform");
    const { tunnelUrl } = await import("./infra/tunnel");

    return {
      Stage: $app.stage,
      PodId: servicePod.id,
      ServiceUrl: serviceUrl,
      ...(tunnelUrl ? { McpUrl: tunnelUrl + "/mcp" } : {}),
    };
  },
});
