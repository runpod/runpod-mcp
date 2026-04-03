/**
 * DNS wiring for mcp.runpod.dev / mcp-dev.runpod.dev.
 *
 * Pattern (same as context service):
 *   Route53 CNAME → Cloudflare proxied CNAME → Lambda Function URL
 *
 * Cloudflare sits in front as a proxy — handles SSL termination,
 * hides the raw Lambda URL, and gives a stable custom domain even
 * if the Lambda URL changes.
 *
 * Route53 delegates to Cloudflare via the partial domain migration
 * pattern already in use for runpod.dev.
 */
import * as cloudflare from "@pulumi/cloudflare";
import * as aws from "@pulumi/aws";
import { config } from "./config";
import { functionUrl } from "./platform";

const { accountId, zoneId } = config.cloudflare;

// Strip https:// and trailing slash from the Lambda Function URL
// e.g. "https://abc123.lambda-url.us-east-1.on.aws/" → "abc123.lambda-url.us-east-1.on.aws"
const lambdaHostname = functionUrl.apply((url) =>
  url.replace(/^https?:\/\//, "").replace(/\/$/, ""),
);

// Subdomain portion only (Cloudflare partial zones reject the full FQDN on PUT)
// e.g. "mcp-dev.runpod.dev" → "mcp-dev"
const dnsName = config.domain.replace(/\.runpod\.dev$/, "");

// ── 1. Cloudflare CNAME → Lambda URL ─────────────────────────────────────
// Proxied = Cloudflare handles SSL and hides the raw Lambda URL.
export const cfRecord = new cloudflare.Record("McpCfDns", {
  zoneId,
  name: dnsName,
  type: "CNAME",
  content: lambdaHostname,
  proxied: true,
  ttl: 1,
});

// ── 2. Route53 CNAME → Cloudflare CDN ────────────────────────────────────
// runpod.dev nameservers are in Route53. This delegates the subdomain
// to Cloudflare via the cdn.cloudflare.net CNAME pattern.
export const route53Record = (() => {
  const hostedZone = aws.route53.getZone({ name: "runpod.dev" });
  return new aws.route53.Record("McpRoute53Dns", {
    zoneId: hostedZone.then((z) => z.zoneId),
    name: config.domain,
    type: "CNAME",
    ttl: 300,
    records: [`${config.domain}.cdn.cloudflare.net`],
  });
})();

export const serviceUrl = `https://${config.domain}`;
