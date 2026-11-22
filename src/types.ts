import type { CredentialChecker } from './_shared/credential-check.js';

export interface HandleMcpRequestOptions {
  serverVersion?: string;
  // Test seams — production uses the shared default checker.
  verifyCredential?: CredentialChecker;
  invalidateCredential?: (token: string) => void;
}

export interface RpcSummary {
  rpc?: string;
  client?: string;
}
