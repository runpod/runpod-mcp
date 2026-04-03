/**
 * Cloudflare Tunnel — stable domain for the runpod-mcp hosted service.
 *
 * dev  → mcp-dev.runpod.dev
 * prod → mcp.runpod.dev
 *
 * PR stages skip all Cloudflare resources and use the RunPod proxy URL directly.
 */
import * as cloudflare from "@pulumi/cloudflare";
import * as aws from "@pulumi/aws";
import { config } from "./config";

const stage = $app.stage;
const isPrStage = stage.startsWith("pr-");
const { accountId, zoneId, domain } = config.cloudflare;

const tunnelSecret = isPrStage
  ? ""
  : Buffer.from(crypto.randomUUID() + crypto.randomUUID()).toString("base64");

export const tunnel = isPrStage
  ? null
  : new cloudflare.ZeroTrustTunnelCloudflared("McpTunnel", {
      accountId,
      name: `runpod-mcp-${stage}`,
      configSrc: "cloudflare",
      tunnelSecret,
    });

export const tunnelConfig =
  tunnel == null
    ? null
    : new cloudflare.ZeroTrustTunnelCloudflaredConfig("McpTunnelConfig", {
        accountId,
        tunnelId: tunnel.id,
        config: {
          ingresses: [
            { hostname: domain, service: "http://localhost:3000" },
            { service: "http_status:404" },
          ],
        },
      });

const dnsName = domain.replace(/\.runpod\.dev$/, "");

export const tunnelDns =
  tunnel == null
    ? null
    : new cloudflare.Record("McpTunnelDns", {
        zoneId,
        name: dnsName,
        type: "CNAME",
        content: $interpolate`${tunnel.id}.cfargotunnel.com`,
        proxied: true,
        ttl: 1,
      });

export const route53Dns = isPrStage
  ? null
  : (() => {
      const hostedZone = aws.route53.getZone({ name: "runpod.dev" });
      return new aws.route53.Record("McpRoute53Dns", {
        zoneId: hostedZone.then((z) => z.zoneId),
        name: domain,
        type: "CNAME",
        ttl: 300,
        records: [`${domain}.cdn.cloudflare.net`],
      });
    })();

export const tunnelToken =
  tunnel == null
    ? ""
    : $interpolate`${tunnel.id}`.apply((tunnelId) =>
        Buffer.from(
          JSON.stringify({ a: accountId, t: tunnelId, s: tunnelSecret }),
        ).toString("base64"),
      );

export const tunnelUrl = isPrStage ? null : `https://${domain}`;
