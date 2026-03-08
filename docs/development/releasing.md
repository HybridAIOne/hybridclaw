# Release And Publishing

The root [AGENTS.md](../../AGENTS.md) contains the canonical "bump release"
procedure used by coding agents. This document covers the packaging and publish
side of a release.

## Container Publishing

Container publishing is automated by GitHub Actions on release tags:

- workflow: `.github/workflows/publish-container.yml`
- trigger: push tag `v*`
- destinations:
  - GHCR: `ghcr.io/<org>/hybridclaw-agent`
  - Docker Hub mirror: `hybridaione/hybridclaw-agent` when Docker Hub
    credentials are configured
- tags:
  - always: `vX.Y.Z`
  - stable tags only, meaning no `-rc` or `-beta` suffix: `latest`

The workflow fails if the pushed git tag does not match `package.json` version.
GHCR publishing is unconditional on release tags. Docker Hub publishing is
optional and only runs when repository secrets `DOCKERHUB_USERNAME` and
`DOCKERHUB_TOKEN` are configured.

## Manual Publish Fallback

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
