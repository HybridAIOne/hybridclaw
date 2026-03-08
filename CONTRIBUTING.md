# Contributing

This document is the fast path for humans contributing to HybridClaw.

Use these docs by audience:

- `README.md` for product overview and end-user setup
- `AGENTS.md` for the canonical repo-level agent instructions
- `CLAUDE.md` as a thin Claude shim that points back to `AGENTS.md`
- `docs/development/` for deeper maintainer and runtime reference docs

## Prerequisites

- Node.js 22
- npm
- Docker if you need to build or debug the container runtime
- Optional credentials for live flows such as HybridAI auth or Discord

## Development Setup

```bash
npm install
npm run setup
npm run build
```

Notes:

- `npm install` runs the `prepare` script and installs Husky git hooks when the
  checkout is writable.
- `npm run setup` installs the container runtime dependencies under
  `container/`.
- `npm run build` compiles both the root package and the container runtime.

## Everyday Commands

```bash
# TypeScript checks
npm run typecheck
npm run lint

# Biome
npm run check

# Tests
npm run test:unit
npm run test:integration
npm run test:e2e
npm run test:live

# Runtime and packaging
npm run build
npm run release:check
npm --prefix container run lint
npm --prefix container run release:check
```

## Choose The Right Checks

- Docs-only changes: verify links, commands, and examples; tests are usually not
  needed.
- `src/` changes: run `npm run typecheck`, `npm run lint`, and targeted Vitest
  coverage.
- `container/` changes: run `npm --prefix container run lint`, `npm run build`,
  and tests that cross the host/container boundary.
- CLI, packaging, or release changes: run both release checks.
- Live tests may require credentials or external services. Skip them unless your
  change needs them, and say so in the PR or handoff.

## Git Hooks

This repo uses Husky with a pre-commit hook that runs:

```bash
npx biome check --write --staged
```

Stage files before committing so the hook can validate and auto-format the
staged diff.

## Repository Map

- `src/` main application code for the CLI, gateway, auth, providers, audit,
  scheduler, and runtime plumbing
- `container/` sandboxed runtime that executes tools and model calls
- `skills/` bundled skills shipped with the package
- `templates/` bootstrap files copied into HybridClaw agent workspaces at
  runtime
- `tests/` Vitest suites
- `docs/` static assets plus maintainer/development docs

## Pull Request Expectations

- Keep changes scoped and explain the user-visible or maintainer-visible impact.
- Update docs when commands, config, release flow, or architecture assumptions
  change.
- Add or update tests when behavior changes.
- Say which checks you ran. If you skipped a relevant check, say why.
- Keep unrelated local changes out of the diff.

## Deeper Reference Docs

- [Development Docs Index](./docs/development/README.md)
- [Architecture](./docs/development/architecture.md)
- [Runtime Internals](./docs/development/runtime.md)
- [Testing Reference](./docs/development/testing.md)
- [Release and Publishing](./docs/development/releasing.md)
- [Skills Internals](./docs/development/skills.md)
