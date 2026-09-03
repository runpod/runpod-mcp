// Client for the Serverless runtime plane (job submission and lifecycle at
// api.runpod.ai/v2/{endpointId}/...). This is a separate API from the v2
// management spec the generated tools cover — RunPod publishes no OpenAPI
// document for it, so the tools that use it are curated (src/specgen/tools/jobs.ts).

import { HttpError, missingKeyError } from './http-error.js';
import { withRateLimitHint } from '../../_shared/rate-limit.js';

export const DEFAULT_SERVERLESS_BASE_URL = 'https://api.runpod.ai/v2';
const DEFAULT_TIMEOUT_MS = 30_000;

export interface RuntimeRequestOptions {
  method?: string;
  body?: Record<string, unknown>;
  timeoutMs?: number;
}

export type RuntimeClient = (
  endpointId: string,
  path: string,
  options?: RuntimeRequestOptions
) => Promise<unknown>;

export interface RuntimeClientOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export function createRuntimeClient(
  options: RuntimeClientOptions = {}
): RuntimeClient {
  const apiKey = options.apiKey ?? process.env.RUNPOD_API_KEY;
  const baseUrl =
    options.baseUrl ??
    process.env.RUNPOD_SERVERLESS_API_URL ??
    DEFAULT_SERVERLESS_BASE_URL;
  const fetchImpl = options.fetchImpl ?? fetch;

  return async (endpointId, path, opts = {}) => {
    if (!apiKey) throw missingKeyError();
    const response = await fetchImpl(`${baseUrl}/${endpointId}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });

    const text = await response.text();
    let payload: unknown = text;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      // non-JSON body stays verbatim
    }
    if (!response.ok) {
      // 429: turn the RateLimit/Retry-After headers into a wait instruction.
      const detail =
        response.status === 429
          ? withRateLimitHint(payload, response.headers)
          : payload;
      throw new HttpError(
        `Runpod runtime API error (${response.status})`,
        response.status,
        detail
      );
    }
    return payload;
  };
}
