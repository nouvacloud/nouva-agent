# Releasing Nouva Agent

Production agent images are published only when a GitHub Release is published in
[`nouvacloud/nouva-agent`](https://github.com/nouvacloud/nouva-agent). Merges to `main` and
plain tag pushes do not publish container images.

## Prerequisites

Set these repository or organization secrets before publishing a release:

- `NOUVA_CONTROL_PLANE_URL`
- `NOUVA_AGENT_RELEASE_WEBHOOK_SECRET`

The release workflow fails before build and push if either secret is missing.

## Publish `v0.1.0`

1. Ensure `main` is in the state you want to ship and that CI is green.
2. Create tag `v0.1.0` from `main`.
3. Publish a GitHub Release for `v0.1.0` targeting that tag.
4. Wait for the `Release` workflow to complete successfully.

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
