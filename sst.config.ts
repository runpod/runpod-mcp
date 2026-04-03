/// <reference path="./.sst/platform/config.d.ts" />
/**
 * SST v3 Configuration for runpod-mcp hosted service.
 *
 * Manages:
 *   - Lambda function (stateless HTTP MCP server)
 *   - Cloudflare CNAME → Lambda Function URL
 *   - Route53 CNAME → Cloudflare (partial domain migration pattern)
 *
 * State stored in AWS (us-east-1).
 *
 * Deploy:
 *   npx sst deploy --stage dev
 *   npx sst deploy --stage prod
 *
 * Secrets (optional):
 *   npx sst secret set DdApiKey <value> --stage dev
 *
 * Required GitHub secrets:
 *   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY  — SST state + Lambda deploy
 *   CLOUDFLARE_API_TOKEN                        — DNS management
 */
export default $config({
  app(input) {
    return {
      name: "runpod-mcp",
      removal: input?.stage === "prod" ? "retain" : "remove",
      home: "aws",
      providers: {
        aws: { region: "us-east-1" },
        cloudflare: { version: "6.13.0" },
      },
    };
  },
  async run() {
    const { mcpFunction, functionUrl } = await import("./infra/platform");
    const { serviceUrl } = await import("./infra/dns");

    return {
      Stage: $app.stage,
      FunctionUrl: functionUrl,
      McpUrl: serviceUrl + "/mcp",
      SetupCommand: `claude mcp add --transport http --scope user runpod "${serviceUrl}/mcp?token=YOUR_API_KEY"`,
    };
  },
});
