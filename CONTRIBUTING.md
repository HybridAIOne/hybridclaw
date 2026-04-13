# Contributing To HybridClaw

This document is the fast path for humans contributing to HybridClaw.

## Start Here

Use the right document for the job:

- `README.md` for product overview and end-user setup
- `SUPPORT.md` for where to ask questions, get setup help, or report bugs
- `SECURITY.md` for private vulnerability reporting
- `AGENTS.md` for the canonical repo-level coding-agent rules
- `CLAUDE.md` as a thin Claude shim that points back to `AGENTS.md`
- `docs/content/` for the browsable docs source and maintainer reference docs

## What We Want Most

Highest-signal contributions usually look like this:

- reproducible bug fixes with targeted tests
- docs fixes that remove setup ambiguity or stale instructions
- onboarding, diagnostics, and workflow improvements that help users self-serve
- focused runtime hardening with clear boundary tests
- release/tooling improvements that reduce maintainer toil without broad refactors

Please discuss large feature work or architectural changes in
[GitHub Discussions](https://github.com/HybridAIOne/hybridclaw/discussions)
before opening a large PR. Keep refactor-only changes out of the queue unless
they are required to land a concrete fix.

## Where To Ask What

- Confirmed bugs or regressions: open a GitHub issue with the bug report form
- Setup and installation problems: use the setup-help issue form or Discord
- Feature ideas and design questions: start in GitHub Discussions
- Docs gaps or broken examples: open a docs issue or send a PR directly
- Security issues: do not file a public issue; follow [SECURITY.md](./SECURITY.md)

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
npm run format

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

## Validation Expectations

Choose the smallest set of checks that actually covers your change:

| Change scope | Minimum checks |
| --- | --- |
| Docs-only | Verify links, commands, and examples |
| `src/` changes | `npm run typecheck`, `npm run lint`, and targeted Vitest coverage |
| `container/` changes | `npm --prefix container run lint`, `npm run build`, and host/container boundary tests |
| `skills/` changes | `hybridclaw skill list` plus targeted coverage |
| Release or packaging | Both `release:check` scripts |
| Security-sensitive paths | Boundary and failure-mode tests |

Live tests may require credentials or external services. Skip them unless your
change needs them, and say so in the PR.

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
- `docs/` static site assets and published entrypoints
- `docs/content/` browsable markdown source for user, operator, and developer docs

## Pull Request Expectations

- Keep changes scoped and explain the user-visible or maintainer-visible impact.
- Update docs when commands, config, release flow, or architecture assumptions
  change.
- Add or update tests when behavior changes.
- Say which checks you ran. If you skipped a relevant check, say why.
- Keep unrelated local changes out of the diff.
- Include screenshots or recordings for UI or visual workflow changes.
- Call out riskier surfaces explicitly when touching security, audit, approval,
  gateway, or container boundaries.

The repository includes issue forms and a PR template to keep bug reports,
feature requests, docs fixes, and validation details consistent. Use them.

## AI-Assisted Contributions

AI-assisted contributions are acceptable, but the author owns the diff:

- review generated code before asking for review
- verify that tests and docs match the actual behavior
- disclose meaningful AI assistance in the PR description
- never paste real secrets, tokens, or personal data into prompts

## A Few Easy Ways To Help

- improve setup docs where a new operator could get stuck
- add missing edge-case tests for bugs that were hard to reproduce
- tighten examples, diagnostics, or error messages
- improve release and maintainer workflow docs when you find ambiguity

## Community Standards

Participation in this repository is covered by [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
Use [SUPPORT.md](./SUPPORT.md) when you are not sure whether something belongs
in Issues, Discussions, Discord, or a private security channel.

## Deeper Reference Docs

- [Development Docs Index](./docs/content/README.md)
- [Getting Started Docs](./docs/content/getting-started/README.md)
- [Architecture](./docs/content/developer-guide/architecture.md)
- [Runtime Internals](./docs/content/developer-guide/runtime.md)
- [Reference Docs](./docs/content/reference/README.md)
- [Extensibility Docs](./docs/content/extensibility/README.md)
