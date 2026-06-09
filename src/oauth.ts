import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import fetch from 'node-fetch';

interface OAuthServerMetadata {
  issuer: string;
  jwks_uri: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  revocation_endpoint?: string;
  introspection_endpoint?: string;
  userinfo_endpoint?: string;
  scopes_supported?: string[];
  response_types_supported?: string[];
  response_modes_supported?: string[];
  grant_types_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  code_challenge_methods_supported?: string[];
}

export interface OAuthUser {
  subject: string;
  issuer: string;
  payload: JWTPayload;
}

let metadataPromise: Promise<OAuthServerMetadata> | null = null;
let jwksPromise: Promise<ReturnType<typeof createRemoteJWKSet>> | null = null;

async function loadMetadata(): Promise<OAuthServerMetadata> {
  const discoveryUrl = process.env.CLERK_OAUTH_DISCOVERY_URL;
  if (!discoveryUrl) {
    throw new Error('CLERK_OAUTH_DISCOVERY_URL is required for OAuth mode');
  }

  const response = await fetch(discoveryUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch OAuth discovery metadata: ${response.status} ${response.statusText}`
    );
  }

  const metadata = (await response.json()) as Partial<OAuthServerMetadata>;
  if (!metadata.issuer || !metadata.jwks_uri) {
    throw new Error('OAuth discovery metadata is missing issuer or jwks_uri');
  }

  return {
    issuer: metadata.issuer,
    jwks_uri: metadata.jwks_uri,
    authorization_endpoint: metadata.authorization_endpoint,
    token_endpoint: metadata.token_endpoint,
    revocation_endpoint: metadata.revocation_endpoint,
    introspection_endpoint: metadata.introspection_endpoint,
    userinfo_endpoint: metadata.userinfo_endpoint,
    scopes_supported: metadata.scopes_supported,
    response_types_supported: metadata.response_types_supported,
    response_modes_supported: metadata.response_modes_supported,
    grant_types_supported: metadata.grant_types_supported,
    token_endpoint_auth_methods_supported:
      metadata.token_endpoint_auth_methods_supported,
    code_challenge_methods_supported: metadata.code_challenge_methods_supported,
  };
}

export async function getOAuthMetadata(): Promise<OAuthServerMetadata> {
  metadataPromise ??= loadMetadata();
  return metadataPromise;
}

async function getRemoteJwks() {
  jwksPromise ??= getOAuthMetadata().then((metadata) =>
    createRemoteJWKSet(new URL(metadata.jwks_uri))
  );
  return jwksPromise;
}

export function isLikelyJwt(token: string): boolean {
  return token.split('.').length === 3;
}

export async function verifyClerkOAuthToken(token: string): Promise<OAuthUser> {
  const metadata = await getOAuthMetadata();
  const jwks = await getRemoteJwks();
  const { payload } = await jwtVerify(token, jwks, {
    issuer: metadata.issuer,
  });

  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new Error('OAuth token is missing a subject');
  }

  return {
    subject: payload.sub,
    issuer: metadata.issuer,
    payload,
  };
}
