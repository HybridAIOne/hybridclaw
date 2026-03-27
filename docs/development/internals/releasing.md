---
title: Release And Publishing
description: Release checklist, publishing flow, and versioned documentation expectations for HybridClaw releases.
sidebar_position: 6
---

# Release And Publishing

The root
[AGENTS.md](https://github.com/HybridAIOne/hybridclaw/blob/main/AGENTS.md)
contains the canonical "bump release" procedure used by coding agents. This
document covers the packaging and publish side of a release.

## Release Prep

Before creating the release commit or tag:

1. Update `CHANGELOG.md` and move the shipped notes out of `Unreleased`.
2. Refresh `README.md`, `docs/index.html`, and any affected
   `docs/development/**/*.md` pages so the published docs describe the current
   shipped state instead of the previous release.
3. Bump the root and container package versions plus both lockfiles.
4. Run the release validation commands from the repo root:

   ```bash
   npm run build
   npm run release:check
   npm --prefix container run release:check
   ```

5. Only then create the release commit, annotated tag, push, and GitHub
   release entry.

## Container Publishing

Container publishing is automated by GitHub Actions on release tags and can
also be re-run manually for an existing release:

- workflow: `.github/workflows/publish-container.yml`
- trigger: push tag `v*`
- manual trigger: `workflow_dispatch` with optional `version` input such as
  `vX.Y.Z`
- destinations:
  - GHCR: `ghcr.io/<org>/hybridclaw-agent`
  - Docker Hub mirror: `hybridaione/hybridclaw-agent` when Docker Hub
    credentials are configured
- tags:
  - always: `vX.Y.Z`
  - stable tags only, meaning no `-rc` or `-beta` suffix: `latest`

The workflow fails if the resolved release tag does not match `package.json`
version. GHCR publishing is unconditional for a valid release tag. Docker Hub
publishing is optional and only runs when repository secrets
`DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` are configured.

## GitHub Actions Manual Re-publish

Use the workflow dispatch path before falling back to a fully manual local
Docker push:

1. Open the `publish-container` workflow in GitHub Actions.
2. Run it with `version=vX.Y.Z` for the release you want to republish, or leave
   the input blank to use the current `package.json` version.
3. The workflow checks out that tag ref, validates the tag/package match, and
   then pushes GHCR images plus Docker Hub images when Docker Hub credentials
   are present.
4. If the repository has `GHCR_USERNAME` and `GHCR_TOKEN` secrets configured,
   the workflow uses them for GHCR pushes. Otherwise it falls back to the
   workflow `GITHUB_TOKEN`.
5. After each image push, the workflow verifies that every published tag is
   readable from GHCR before the job completes.

## Manual Publish Fallback

If GitHub Actions is unavailable, build and push locally:

```bash
VERSION="v$(node -p \"require('./package.json').version\")"
DOCKERHUB_IMAGE="hybridaione/hybridclaw-agent"
GHCR_IMAGE="ghcr.io/hybridaione/hybridclaw-agent"

docker build \
  -t "${DOCKERHUB_IMAGE}:${VERSION}" \
  -t "${DOCKERHUB_IMAGE}:latest" \
  -t "${GHCR_IMAGE}:${VERSION}" \
  -t "${GHCR_IMAGE}:latest" \
  ./container

docker login -u <dockerhub-username>
docker push "${DOCKERHUB_IMAGE}:${VERSION}"
docker push "${DOCKERHUB_IMAGE}:latest"

docker login ghcr.io -u <github-username>
docker push "${GHCR_IMAGE}:${VERSION}"
docker push "${GHCR_IMAGE}:latest"
```

## Manual GHCR-Only Publish

1. Create a GitHub token that can publish packages.
2. Authenticate Docker to GHCR.
3. Build and push the versioned image and, for stable releases, `latest`.

```bash
export GHCR_USER="<github-username>"
export GHCR_TOKEN="<github-token>"
echo "${GHCR_TOKEN}" | docker login ghcr.io -u "${GHCR_USER}" --password-stdin

VERSION="v$(node -p \"require('./package.json').version\")"
GHCR_IMAGE="ghcr.io/hybridaione/hybridclaw-agent"

docker build \
  -t "${GHCR_IMAGE}:${VERSION}" \
  -t "${GHCR_IMAGE}:latest" \
  ./container

docker push "${GHCR_IMAGE}:${VERSION}"
docker push "${GHCR_IMAGE}:latest"
```
