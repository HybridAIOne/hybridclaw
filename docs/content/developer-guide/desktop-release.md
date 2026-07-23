---
title: Desktop Release Builds
description: Build, sign, notarize, and upload the macOS Electron desktop wrapper.
sidebar_position: 9
---

# Desktop Release Builds

HybridClaw's desktop app is an Electron wrapper around the existing `/chat`,
`/apps`, `/agents`, and `/admin` gateway surfaces. The release build bundles the
compiled gateway, console, container runtime files, production dependencies,
and a Node.js runtime into the app package.

The current desktop packaging flow builds signed macOS app artifacts when
`electron-builder` can find a valid signing identity. Notarization is not wired
as an automatic build hook yet, so maintainers should notarize and staple the
DMG explicitly before uploading it to GitHub Releases.

## Prerequisites

- macOS build host for DMG creation and Apple notarization.
- Node.js 22 and npm 11.10+.
- Xcode Command Line Tools: `xcode-select --install`.
- A clean release checkout at the tag or release commit.
- Installed root and container dependencies.
- Apple Developer Program access with a `Developer ID Application` certificate.
- GitHub CLI authenticated with permission to edit releases.

For local keychain signing, install the certificate in the login keychain.
For CI or an isolated build host, provide the certificate through
`electron-builder` code-signing environment variables:

```bash
export CSC_LINK="/absolute/path/to/developer-id-application.p12"
export CSC_KEY_PASSWORD="<p12 password>"
```

If the build host has multiple signing identities, set `CSC_NAME` to the exact
`Developer ID Application: ...` identity. Do not publish artifacts built with
`CSC_IDENTITY_AUTO_DISCOVERY=false` or ad-hoc signing.

For notarization with `notarytool`, provide:

```bash
export APPLE_ID="apple-id@example.com"
export APPLE_TEAM_ID="TEAMID12345"
export APPLE_APP_SPECIFIC_PASSWORD="<app-specific password>"
```

Use an app-specific password or an equivalent keychain profile. Do not commit
these values or store them in release notes.

## Prepare Release Metadata

Set the new version in the root `package.json`, then synchronize every product
manifest and generated lockfile entry:

```bash
npm run version:sync
```

Always update `console/src/release-notes.ts` in the same release commit. Set its
version to the new product version and replace the previous release copy with
up to four ultra-short highlights for the console's What's New dialog. The
console test suite rejects release notes whose version does not match
`console/package.json`.

Review the four generated lockfile diffs before approving them. A normal
version-only release changes only the product `version` fields; dependency
versions, resolved artifacts, integrity values, and lifecycle-script entries
must remain unchanged.

Because the dependency policy hashes complete lockfiles, even version-only
edits require refreshed entries in
`scripts/dependency-policy-baseline.json`. Calculate the final hashes with:

```bash
shasum -a 256 \
  package-lock.json \
  npm-shrinkwrap.json \
  container/package-lock.json \
  container/npm-shrinkwrap.json
```

Copy those four hashes into the matching baseline entries, preserve unrelated
lockfile entries, and verify the approval before committing:

```bash
npm run deps:policy
npm run release:check
npm --prefix container run release:check
```

`HYBRIDCLAW_ALLOW_LOCKFILE_CHANGES=1` only lets the pre-commit hook proceed
after a maintainer has reviewed the diff. It does not update or replace the
baseline, and CI rejects stale hashes.

## Release Order

Do not publish the public GitHub Release first and then start building the
desktop app. The safer order is:

1. Finalize the release commit with version, What's New highlights, changelog,
   README, and docs.
2. Create the annotated version tag and make sure the desktop build host is
   building from that exact tag or commit.
3. Build, sign, notarize, staple, and verify the macOS artifacts.
4. Create the GitHub Release as a draft if the release entry is needed before
   asset upload.
5. Upload the DMG, ZIP, and blockmap to the same version tag.
6. Publish the GitHub Release only after the npm/package release notes and
   desktop assets are all present and verified.

This keeps the public release page from advertising a version before the
signed desktop artifact is attached. If a release has already been published,
upload the desktop assets to that same tag rather than creating a second
desktop-only release.

## Build

From the repository root:

```bash
npm ci
npm --prefix container ci
npm run version:check
npm run typecheck
npm run test:unit
npm run desktop:mac
```

`npm run desktop:mac` runs the root build first, then the desktop workspace
build. The desktop build stages runtime dependencies and packages the app,
ZIP, block map, and DMG with `electron-builder --mac dir zip dmg`.

Expected outputs are under `desktop/release/`:

```text
desktop/release/mac-arm64/HybridClaw.app
desktop/release/HybridClaw-<version>-arm64.dmg
desktop/release/HybridClaw-<version>-arm64-mac.zip
desktop/release/HybridClaw-<version>-arm64-mac.zip.blockmap
```

The architecture follows the build host unless you explicitly run a different
`electron-builder` architecture target. Build Apple Silicon artifacts on an
arm64 Mac. If an Intel artifact is needed, build it on an x64 Mac or add an
explicit x64 packaging step and verify the resulting `mac-x64` output before
release.

## Verify Signing

Check the packaged app before notarization:

```bash
codesign --verify --deep --strict --verbose=2 \
  desktop/release/mac-arm64/HybridClaw.app

spctl --assess --type execute --verbose=4 \
  desktop/release/mac-arm64/HybridClaw.app
```

`codesign` must report a valid signature. `spctl` can still reject the app
before notarization; that is expected. If `codesign` shows ad-hoc signing or no
Developer ID identity, stop and rebuild with the correct certificate.

## Notarize And Staple

Set the release version once to avoid uploading the wrong file:

```bash
VERSION="$(node -p "require('./desktop/package.json').version")"
DMG="desktop/release/HybridClaw-${VERSION}-arm64.dmg"
```

Submit the DMG to Apple and wait for the result:

```bash
xcrun notarytool submit "$DMG" \
  --apple-id "$APPLE_ID" \
  --team-id "$APPLE_TEAM_ID" \
  --password "$APPLE_APP_SPECIFIC_PASSWORD" \
  --wait
```

Staple the notarization ticket:

```bash
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"
spctl --assess --type open --verbose=4 "$DMG"
```

For a final user-flow check, copy the DMG to a clean macOS account or VM,
mount it, drag `HybridClaw.app` to `/Applications`, launch it, and verify that
the bundled gateway opens the chat surface.

## Upload To GitHub Releases

Desktop artifacts belong on the GitHub Release for the same version tag as the
npm package. Prefer a draft release while assets are still being prepared:

```bash
TAG="v${VERSION}"

gh release create "$TAG" \
  --draft \
  --verify-tag \
  --title "HybridClaw ${TAG}" \
  --notes-file /path/to/curated-release-notes.md

gh release upload "$TAG" \
  "$DMG" \
  "desktop/release/HybridClaw-${VERSION}-arm64-mac.zip" \
  "desktop/release/HybridClaw-${VERSION}-arm64-mac.zip.blockmap"

gh release view "$TAG"
gh release edit "$TAG" --draft=false --latest
```

Use `--clobber` only when intentionally replacing an asset after a failed or
incorrect upload:

```bash
gh release upload "$TAG" "$DMG" --clobber
```

After upload, confirm the public asset list:

```bash
gh release view "$TAG" --web
```

## README And Docs Links

User-facing install links should point at the latest release page rather than a
hardcoded asset name:

```text
https://github.com/HybridAIOne/hybridclaw/releases/latest
```

Use hardcoded asset links only in a specific release note after the artifact is
uploaded, because asset filenames include the version and architecture.
