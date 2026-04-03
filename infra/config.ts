/**
 * Per-environment config for runpod-mcp hosted service.
 *
 * dev  → mcp-dev.runpod.dev
 * prod → mcp.runpod.dev
 */

interface EnvConfig {
  domain: string;
  cloudflare: {
    accountId: string;
    zoneId: string;
  };
}

const dev: EnvConfig = {
  domain: "mcp-dev.runpod.dev",
  cloudflare: {
    accountId: "14068d66ba387efac9ce5e4b1741bcf2",
    zoneId: "d96cbc35506fe0784b60a079db7cd882",
  },
};

const prod: EnvConfig = {
  domain: "mcp.runpod.dev",
  cloudflare: {
    accountId: "14068d66ba387efac9ce5e4b1741bcf2",
    zoneId: "d96cbc35506fe0784b60a079db7cd882",
  },
};

export const config: EnvConfig = $app.stage === "prod" ? prod : dev;
