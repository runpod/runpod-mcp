/**
 * SST secrets for runpod-mcp.
 * Set per stage: npx sst secret set <Name> <value> --stage dev
 *
 * Note: no RunPod API key needed here — users supply their own
 * key per-request via Authorization: Bearer header.
 */

// Datadog API key for metrics/logs (optional)
export const ddApiKey = new sst.Secret("DdApiKey", "");
