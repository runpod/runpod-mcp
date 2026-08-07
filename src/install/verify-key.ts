// Split out of wizard.ts, which imports @clack/prompts — and @clack/core reaches
// for `styleText` from node:util, which does not exist on Node 18. Importing the
// wizard from a test therefore fails to load the whole file on our oldest
// supported runtime. This has no interactive dependencies, so the deadline below
// can be tested directly.

// Interactive: the user is watching a spinner, so fail fast enough to retype a
// key rather than wait out a network stall.
export const VERIFY_API_KEY_TIMEOUT_MS = 10_000;

// Verify the API key works by calling a read-only REST endpoint. Returns true
// on success, false on auth failure, and null when the check itself failed
// (offline, timed out, etc.) so we can warn without blocking. The deadline is a
// parameter so a test can drive the stall in milliseconds; the wizard always
// takes the default.
export async function verifyApiKey(
  apiKey: string,
  timeoutMs: number = VERIFY_API_KEY_TIMEOUT_MS
): Promise<boolean | null> {
  try {
    const base = process.env.RUNPOD_REST_API_URL ?? 'https://rest.runpod.io/v1';
    const response = await fetch(`${base}/pods`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      // Without this the wizard sits at "Verifying…" forever against a host
      // that accepts the connection and goes quiet, with no way out but ^C.
      // An abort lands in the catch below and is reported as "check failed",
      // which is exactly what it is.
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) return true;
    if (response.status === 401 || response.status === 403) return false;
    return null;
  } catch {
    return null;
  }
}
