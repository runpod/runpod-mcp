// The ALP contract shared with the Convex sink: route names, the
// once-per-account rule and the scrubber with its version. Pure, so a Convex
// function can bundle it without pulling the HTTP handler in.
export {
  ALP_ROUTES,
  ALP_FEEDBACK_TAGS,
  ALP_REFERRAL_SOURCES,
  ALP_REFERRAL_USE_CASES,
  ALREADY_SUBMITTED_NOTE,
  ONCE_PER_ACCOUNT_ROUTES,
  isOncePerAccountRoute,
  isSinkUrl,
  npsScore,
  sinkRouteUrl,
} from './alp/sink.js';
export type {
  AlpFeedbackTag,
  AlpReferralSource,
  AlpReferralUseCase,
  AlpRoute,
  OncePerAccountRoute,
} from './alp/sink.js';
export { SCRUB_VERSION, scrubSubmission } from './alp/scrub.js';
