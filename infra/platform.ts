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
    // Controls which RunPod API keys are accepted.
    // Dev stage → api.runpod.dev (dev keys only, safe for internal testing)
    // Prod stage → api.runpod.io (prod keys)
    RUNPOD_GRAPHQL_URL:
      $app.stage === "prod"
        ? "https://api.runpod.io/graphql"
        : "https://api.runpod.dev/graphql",
    RUNPOD_API_BASE_URL:
      $app.stage === "prod"
        ? "https://rest.runpod.io/v1"
        : "https://rest.runpod.dev/v1",
  },
  build: {
    esbuild: {
      target: "node20",
      format: "esm",
    },
  },
});

export const functionUrl = mcpFunction.url;
