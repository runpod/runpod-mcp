/**
 * runpod-mcp Lambda function.
 *
 * Stateless HTTP MCP server — no storage, no persistent state.
 * Users supply their RunPod API key per-request via Bearer token.
 *
 * Lambda Function URL provides the HTTPS endpoint.
 * Custom domain is wired up in dns.ts via Cloudflare + Route53.
 */
import { ddApiKey } from "./secrets";

export const mcpFunction = new sst.aws.Function("McpFunction", {
  handler: "src/lambda.handler",
  runtime: "nodejs20.x",
  architecture: "x86_64",
  memory: "256 MB",
  timeout: "30 seconds",
  url: {
    cors: {
      allowOrigins: ["*"],
      allowHeaders: ["Authorization", "Content-Type"],
      allowMethods: ["POST", "GET"],
    },
  },
  environment: {
    DD_API_KEY: ddApiKey.value,
  },
  build: {
    esbuild: {
      target: "node20",
      format: "esm",
    },
  },
});

export const functionUrl = mcpFunction.url;
