# Versioning and releases

Changesets records the release impact of a change independently of commit
messages. Manual squash merges are supported.

## Contributor workflow

1. Run `pnpm changeset` for changes to the published SDK.
2. Select the package, choose a bump, and describe the user-visible change.
3. Commit the generated `.changeset/*.md` file with your implementation.
4. Review the compatibility impact and changeset before merging the PR.

Use `pnpm changeset:status` to inspect pending releases. It needs the local `main`
ref and reports an error when package changes have no changeset. For an intentional
change without a release, `pnpm changeset --empty` records that decision.
Repository-only documentation, CI, and tests normally need no package release.
The version workflow validates changesets when preparing the release PR; ordinary
SDK CI does not require a changeset on every PR.

## Choosing a version bump

The SDK version describes client compatibility, independently of REST API v2.
API v2 does not mean this package must start at version 2.

| Bump | Use for |
| --- | --- |
| Patch | Compatible bug fixes and corrections to shipped documentation |
| Minor | Compatible new endpoints, options, or capabilities |
| Major | Removed or renamed exports/endpoints, incompatible type changes, new required inputs, or dropping a supported Node version |

Review generated TypeScript changes as part of the public interface. A schema
correction can break existing consumers even when the server behavior has not
changed. Enum and union changes also need compatibility review; do not assign a
patch simply because the change came from generation.

During 0.x development, select **minor** for breaking changes and new features,
and **patch** for compatible fixes. Document breaking changes and migration steps
in the changeset. Select **major** only for the deliberate transition to 1.0.0.
After 1.0.0, follow the table above. The publisher currently accepts normal
three-part versions only; prerelease publishing requires a separate reviewed
change to select a version suffix and a non-`latest` npm tag.

## Release flow

The SDK is released from the
[runpod-mcp repository](https://github.com/runpod/runpod-mcp), alongside
`@runpod/mcp-server`, by that repository's **Release** workflow
(`.github/workflows/release.yml`). On every push to `main`, Changesets opens or
updates one "Version Packages" PR covering every package with pending
changesets. Merging that PR runs `changeset publish`, which publishes each
workspace package whose version is not yet on npm and tags it
`<package>@<version>` (for example `@runpod/typescript-api-sdk@0.4.0`). Tags
from before the move are plain `v<version>`, in the archived
`runpod/typescript-api-sdk` repository.

Publishing authenticates with npm trusted publishing (OIDC) through
`pnpm publish`. The SDK package therefore needs `runpod/runpod-mcp`,
workflow `release.yml`, as its trusted publisher on npmjs.com; see
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

The MCP bundles this package into its own build, so an SDK change reaches the
MCP without an SDK release. Release the SDK when its npm consumers need the
change.

## Generated spec updates

The runpod-mcp **Production spec update** workflow pulls the production spec
daily, regenerates this package's `src/generated/schema.ts` and the MCP tools,
and opens one PR on `automation/production-spec`. When the spec changed, that
PR carries a changeset with a minor bump for both packages. Edit it before
merging if the SDK change needs a different bump (see the table above).
