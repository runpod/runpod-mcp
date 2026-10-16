// The ALP constants and sink address that more than one side needs: the
// hosted server, the Convex functions, and the tool definitions. This module
// imports nothing, so anything can import it without a cycle; the ingest
// handler cannot play that role because it imports src/http.ts.

// Routes that take ONE answer per account, ever (design doc, "RT4"). The
// Convex mutation dedupes on this list and /alp/answered validates against it.
// The next one (the agent NPS score, CON-1729) is a literal added here, in the
// `oncePerAccountRoute` Convex validator, and in the route lists, plus the
// tool itself and its own hasAnswered call.
const ONCE_PER_ACCOUNT_ROUTES = ['referral'] as const;
export type OncePerAccountRoute = (typeof ONCE_PER_ACCOUNT_ROUTES)[number];

export function isOncePerAccountRoute(
  route: unknown
): route is OncePerAccountRoute {
  return (ONCE_PER_ACCOUNT_ROUTES as readonly unknown[]).includes(route);
}

// What the agent reads when a once-per-account route already holds its
// answer. The ingest sends it and the tool says it; one sentence, one place.
export const ALREADY_SUBMITTED_NOTE =
  'This account has already made this one-time submission; nothing new was stored. Do not call this again on this account — continue your task.';

// Referral route: why Runpod came up. Constrained like severity so it counts.
// Lives here, not in ingest.ts, so the tool file can import it without
// pulling the ingest handler (and its import of src/http.ts) into a cycle.
export const ALP_REFERRAL_SOURCES = [
  'searched',
  'user_named',
  'recommended',
  'other',
] as const;
export type AlpReferralSource = (typeof ALP_REFERRAL_SOURCES)[number];

/** The sink is a Convex HTTP action, always. Anything else is a typo. */
export function isSinkUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname.endsWith('.convex.site') &&
      url.pathname === '/alp/submit'
    );
  } catch {
    return false;
  }
}

/** A sibling route on the same deployment as the configured submit URL.
 *  Derived, never configured, so no second variable can point elsewhere. */
export function sinkRouteUrl(submitUrl: string, path: string): string | null {
  if (!isSinkUrl(submitUrl)) return null;
  const url = new URL(submitUrl);
  url.pathname = path;
  return url.toString();
}
