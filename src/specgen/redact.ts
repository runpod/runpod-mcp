// Tool results never echo secret-looking environment values. Pods, templates
// and endpoints return their `env` map in full, and some of it is a live
// credential (JUPYTER_PASSWORD, tokens, API keys) that has no business in a
// model's context or a transcript. Values whose key looks secret are replaced;
// `{{ RUNPOD_SECRET_<name> }}` references are kept, since they name a secret
// rather than carry it.

export const REDACTED = '[redacted]';

const SECRET_KEY =
  /pass(word|wd)?|secret|token|api_?key|private_?key|credential|auth/i;
const SECRET_REFERENCE = /^\s*\{\{\s*RUNPOD_SECRET_[^}]+\}\}\s*$/;

function redactEnv(env: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      typeof value === 'string' &&
      value !== '' &&
      SECRET_KEY.test(key) &&
      !SECRET_REFERENCE.test(value)
        ? REDACTED
        : value,
    ])
  );
}

/** Returns a copy of `payload` with every `env` map's secret-looking values
 *  replaced by REDACTED; anything else passes through unchanged. */
export function redactSecretEnv(payload: unknown): unknown {
  if (Array.isArray(payload)) return payload.map(redactSecretEnv);
  if (!payload || typeof payload !== 'object') return payload;
  return Object.fromEntries(
    Object.entries(payload as Record<string, unknown>).map(([key, value]) => [
      key,
      key === 'env' &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
        ? redactEnv(value as Record<string, unknown>)
        : redactSecretEnv(value),
    ])
  );
}
