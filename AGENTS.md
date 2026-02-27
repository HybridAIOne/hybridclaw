# AGENTS.md

## Bump Release

When the user says "bump release":

1. Bump the requested semantic version (if unspecified, default to patch).
2. Update version strings in:
   - `package.json`
   - `package-lock.json` (root `version` and `packages[""]`)
   - `container/package.json`
   - `container/package-lock.json` (root `version` and `packages[""]`)
   - any user-facing version text (for example `src/tui.ts` banner).
3. Move `CHANGELOG.md` release notes from `Unreleased` to the new version heading (or create one).
4. Update `README.md` "latest tag" link/text if present.
5. Commit with a release chore message (for example `chore: release vX.Y.Z`).
6. Create annotated git tag `vX.Y.Z`.
7. Push commit and tag.
8. If the user expects a GitHub Release entry, create/publish a release object for the tag (tags alone do not update the Releases list).
