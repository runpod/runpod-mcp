import type { CredentialChecker } from './_shared/credential-check.js';
import type { OncePerAccountRoute } from './alp/sink.js';

export interface HandleMcpRequestOptions {
  serverVersion?: string;
  // Test seams — production uses the shared default checker.
  verifyCredential?: CredentialChecker;
  invalidateCredential?: (token: string) => void;
  /** Once-per-account lookup behind the referral ask (src/alp/answered.ts).
   *  Resolve, never reject: a rejection is treated as an unknown verdict. */
  hasAnswered?: (
    identity: string,
    route: OncePerAccountRoute
  ) => Promise<boolean | null>;
}

export interface RpcSummary {
  rpc?: string;
  client?: string;
}
