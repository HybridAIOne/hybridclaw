# AGENTS.md

## Scope

This file is the canonical repo-level instruction set for coding agents working
in HybridClaw.

- Follow this file first.
- If a deeper directory contains its own `AGENTS.md`, that file overrides this
  one for its subtree.
- Keep `CLAUDE.md` aligned with this file. `CLAUDE.md` should only carry
  tool-specific deltas.

## Project Map

- `src/` core CLI, gateway, providers, auth, audit, scheduler, and runtime
  wiring
- `container/` sandboxed runtime, tool executor, provider adapters, and
  container build inputs
- `skills/` bundled `SKILL.md` skills plus any supporting scripts or reference
  material
- `templates/` runtime workspace bootstrap files seeded into agent workspaces
- `tests/` Vitest suites across unit, integration, e2e, and live coverage
- `docs/` static site assets and maintainer/development reference docs

## Working Rules

- Keep changes focused. Prefer targeted fixes over broad refactors unless the
  task requires wider movement.
- Match the existing TypeScript + ESM patterns already used in the touched area.
- Update tests and docs when behavior, commands, or repo workflows change.
- Treat existing uncommitted changes as user work unless you created them.
- Do not rename or relocate files in `templates/` without updating
  `src/workspace.ts` and the workspace bootstrap tests.

## Setup And Commands

Prerequisites:

- Node.js 22 (matches CI)
- npm
- Docker when working on container-mode behavior or image builds

Common commands:

```bash
npm install
npm run setup
npm run build
npm run typecheck
npm run lint
npm run check
npm run test:unit
npm run test:integration
npm run test:e2e
npm run test:live
npm run release:check
npm --prefix container run lint
npm --prefix container run release:check
```

## Testing Expectations

- Docs-only changes: keep links and commands accurate; runtime tests are usually
  unnecessary.
- `src/` changes: run `npm run typecheck`, `npm run lint`, and the relevant
  Vitest suites.
- `container/` changes: run `npm --prefix container run lint`, `npm run build`,
  and targeted tests that exercise the runtime boundary.
- Release or packaging changes: run both release checks and verify versioned
  docs stay aligned.
- If you skip a relevant check, state that explicitly in your handoff.

## Documentation Hierarchy

- `README.md` is the end-user and product entry point.
- `CONTRIBUTING.md` is the human contributor quickstart.
- `docs/development/` holds deeper maintainer and runtime reference docs.
- `templates/*.md` are product runtime workspace seed files, not repo
  contributor onboarding docs.

## Bump Release

When the user says "bump release":

1. Bump the requested semantic version (if unspecified, default to patch).
2. Update version strings in:
   - `package.json`
   - `package-lock.json` (root `version` and `packages[""]`)
   - `container/package.json`
   - `container/package-lock.json` (root `version` and `packages[""]`)
   - any user-facing version text (for example `src/tui.ts` banner)
3. Move `CHANGELOG.md` release notes from `Unreleased` to the new version
   heading (or create one).
4. Update `README.md` "latest tag" link/text if present.
5. Commit with a release chore message (for example `chore: release vX.Y.Z`).
6. Create an annotated git tag `vX.Y.Z`.
7. Push the commit and tag.
8. Always create or publish a GitHub Release entry for the tag. Tags alone do
   not update the Releases list.
