# @runpod/typescript-api-sdk

## 0.5.0

### Minor Changes

- 4c51d2a: Resync the vendored v2 OpenAPI spec with production as of 2026-10-27 and regenerate the SDK schema and the tools. Adds `list-organization-users` and `get-organization-user`, documents the 413 response on list operations, and requires a non-empty mount `path`.

## 0.4.0

### Minor Changes

- a274524: Generate the tools from the TypeScript SDK's patched copy of the v2 spec, now that the SDK lives in this repository. Argument examples use a placeholder AWS account ID and `changeme` instead of `hunter2` as the example Jupyter password, several argument descriptions drop internal or version-relative wording, and input schemas no longer carry the `x-enum-varnames` code-generation hint.

  Resync the shared spec with production after rebasing, adding the audit logs operation to the SDK's generated types.

## 0.3.0

### Minor Changes

- 5f36649: Resync the vendored production spec and regenerate the types. Adds the global-volume operations (`/v2/global-volumes` list, create, get, update, delete) and `GET /v2/organization`, `global` mounts on pods, `mounts` on endpoints, and the `pagination` block on the cluster and network-volume list responses. All additive upstream, so existing calls keep their current types. `listClusters` and `listNetworkVolumes` now return one page (default `limit` 1000) instead of every resource; follow `pagination.nextCursor` until `hasNextPage` is false.

## 0.2.0

### Minor Changes

- 71be666: Resync the vendored production spec and regenerate the types. Adds cursor
  pagination on the list endpoints (`cursor` and `limit` query parameters, and a
  `pagination` block carrying `nextCursor` and `hasNextPage` on the response) and
  the account-secrets paths. Both are additive upstream, so existing calls keep
  their current types.

## 0.1.1

### Patch Changes

- Update the README installation instructions now that the SDK is available on npm.

## 0.1.0

### Minor Changes

- 23de1a8: Initial TypeScript SDK for Runpod REST API v2, with generated request and response types, configurable retries, and ESM and CommonJS support. Includes whole-operation deadlines, structured rate-limit metadata, and a bounded SSE log-event iterator.
