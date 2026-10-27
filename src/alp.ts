// The ALP contract shared with the Convex sink: route names, the
// once-per-account rule and the scrubber. Pure, so a Convex function can
// bundle it without pulling the HTTP handler in.
export {
  ALP_ROUTES,
  ALP_REFERRAL_SOURCES,
  ALP_REFERRAL_USE_CASES,
  ALREADY_SUBMITTED_NOTE,
  ONCE_PER_ACCOUNT_ROUTES,
  isOncePerAccountRoute,
  isSinkUrl,
  sinkRouteUrl,
} from './alp/sink.js';
export type {
  AlpReferralSource,
  AlpReferralUseCase,
  AlpRoute,
  OncePerAccountRoute,
} from './alp/sink.js';
export { scrubSubmission } from './alp/scrub.js';
