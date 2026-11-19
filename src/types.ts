import type { CredentialChecker } from './_shared/credential-check.js';
import type { CreationTool, OncePerAccountRoute } from './alp/sink.js';

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
  /** Creation counter behind the agent NPS ask (src/alp/created.ts).
   *  Resolve, never reject: a rejection is treated as an unknown count. */
  recordCreation?: (
    identity: string,
    tool: CreationTool
  ) => Promise<number | null>;
}

export interface RpcSummary {
  rpc?: string;
  client?: string;
}
