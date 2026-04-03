#!/bin/bash
set -e

# SSH setup (for RunPod pod access)
if [ -n "$PUBLIC_KEY" ]; then
  mkdir -p /root/.ssh
  echo "$PUBLIC_KEY" >> /root/.ssh/authorized_keys
  chmod 700 /root/.ssh && chmod 600 /root/.ssh/authorized_keys
  service ssh start 2>/dev/null || true
fi

# Start Cloudflare tunnel if token is provided
if [ -n "$CLOUDFLARE_TUNNEL_TOKEN" ]; then
  cloudflared tunnel --no-autoupdate run --token "$CLOUDFLARE_TUNNEL_TOKEN" &
fi

# Start the MCP HTTP server
exec node dist/index.js
