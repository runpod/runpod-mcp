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

The **SDK release** workflow runs on pushes to `main` and has a manual
**Run workflow** button. It uses Changesets to create or update a version/changelog
PR, then explicitly dispatches SDK CI on that PR. Review the Node 20/22/24 checks
and manually squash-merge the release PR when ready to release.

Publication requires the workflow commit to be the merge commit of a release PR
from `changeset-release/main` or `automation/production-spec` in the same
repository. The daily spec update PR carries its own minor bump and changelog,
so merging it releases without a separate version PR, even if changesets from
other PRs landed on `main` after the bot last refreshed the branch. Those go
into the next version PR. Ordinary commits, the
initial repository import, and open release PRs do not publish. The workflow
revalidates Node 20/22/24, checks the packed package, publishes to npm, and creates
a `v<version>` tag and GitHub release. A failure stops the remaining steps.

The package identity is `@runpod/typescript-api-sdk`. The initial source version
is **0.0.0** solely so the included minor changeset prepares **0.1.0** in the first
release PR. The publisher rejects 0.0.0. Creating the repository therefore prepares
the first release for review instead of publishing it immediately.

For a manual retry, select `main` in **Run workflow** while its HEAD is still the
merged release commit. Select `dry_run` to validate without publishing or tagging.
If main has advanced, use **Re-run failed jobs** on the original release run so
it retains the approved commit. A manual trigger does not bypass release approval.
An identical already-published npm artifact is skipped, allowing a failed GitHub
tag/release step to be retried. Different contents at that version cause failure.

## Repository and npm setup

Before the first release-PR merge:

1. Create the target repository and verify `package.json` repository metadata
   matches it. The configured destination is `runpod/typescript-api-sdk`; a test
   repository needs matching metadata and its own authorized npm package name.
2. Allow GitHub Actions to create pull requests. Require SDK `verify (20)`,
   `verify (22)`, and `verify (24)` checks plus human review on `main`.
3. Create the GitHub environment `npm` and restrict it to `main`. An environment
   reviewer is optional if the release-PR merge is the desired approval step.
4. Confirm publish access to the `@runpod` npm scope and the package name.
   For an initial package that cannot yet have a trusted publisher configured,
   provide an appropriately scoped granular npm token as the environment secret
   `NPM_TOKEN`, with the permissions needed for CI publishing. Never commit it.
5. Configure npm trusted publishing for the final GitHub owner, repository,
   workflow **version.yml**, and environment **npm** as soon as the package setup
   permits. Remove the bootstrap token after OIDC is verified. See
   [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
6. Verify a dry run and then merge the first release PR to publish 0.1.0.
   Before approval, the dry-run step can be exercised in a disposable test repo;
   on the real repository it requires the release-PR merge commit, like publishing.

The version job needs contents/PR/actions write permissions. The publishing job
uses contents write for GitHub releases, PR read for approval verification, and
`id-token: write` for npm OIDC. Publishing uses npm 11.6.2 on Node 24 directly;
pnpm 11 remains the dependency/build tool. Package publication is public with
provenance and the `latest` dist-tag. A provenance-backed publish requires a
public source repository; use dry runs while testing in a private repository.

If the primary branch is renamed, update the workflows, release gate, and
`.changeset/config.json`. Package credentials and live npm authentication cannot
be verified by an offline dry run.

## Generated spec updates

The daily spec workflow does not automatically choose release bumps. Its branch
is regenerated and manual additions there can be overwritten. Review and merge
the spec update, then add the corresponding changeset in a follow-up PR before
merging the next version PR. Check that all SDK changes since the previous
release are represented, including generated changes.
