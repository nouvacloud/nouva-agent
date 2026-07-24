# Releasing Nouva Agent

Production agent images are published automatically after the mirrored public repository's `CI`
workflow succeeds on `main`. The automation reads `agent/package.json`, creates or reuses a draft
`v${version}` release, and dispatches the image publication workflow for the exact tested commit.

If that version is already published from the same commit, the automation exits without changing
the release. If the version points to another commit, it fails and requires a new package version.

## Prerequisites

Set these repository or organization secrets before publishing a release:

- `NOUVA_CONTROL_PLANE_URL`
- `NOUVA_AGENT_RELEASE_WEBHOOK_SECRET`

The release workflow fails before build and push if either secret is missing.

## Publish `v0.1.0`

1. Update `agent/package.json` in the monorepo to the version you intend to release, without a `v`
   prefix.
2. Merge the monorepo change to `main`.
3. Wait for `Sync Agent Public Repo`, public-repository `CI`, `Auto Release`, and `Release` to
   complete successfully.

`Auto Release` keeps the GitHub Release as a draft until the image is built and signed. If
publication fails, rerun the failed `Release` workflow or dispatch it with the draft tag and exact
commit SHA. If release preparation must be repeated, dispatch `Auto Release` with the exact public
repository commit SHA. The release workflow also supports manually published releases and rejects
tags that do not match `v${agent/package.json version}`.

## Verify the published artifacts

After the workflow finishes, confirm it published all expected tags:

- `ghcr.io/nouvacloud/nouva-agent:v0.1.0`
- `ghcr.io/nouvacloud/nouva-agent:<release-commit-sha>`
- `ghcr.io/nouvacloud/nouva-agent:latest`

Then verify the control-plane notification step succeeded. The webhook payload remains:

```json
{
  "version": "v0.1.0",
  "imageRef": "ghcr.io/nouvacloud/nouva-agent@sha256:...",
  "digest": "sha256:...",
  "gitSha": "<release-commit-sha>",
  "githubReleaseId": "<github-release-id>",
  "githubReleaseUrl": "https://github.com/nouvacloud/nouva-agent/releases/tag/v0.1.0",
  "publishedAt": "<timestamp>"
}
```

## GHCR visibility

After the first successful publish, inspect the GitHub Packages entry for
`ghcr.io/nouvacloud/nouva-agent`. If GitHub created the package with private visibility, change it
to `public` so unauthenticated installs can pull both `v0.1.0` and `latest`.
