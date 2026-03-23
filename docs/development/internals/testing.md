---
title: Testing Reference
description: Local test commands, suite boundaries, and validation expectations for HybridClaw changes.
sidebar_position: 5
---

# Testing Reference

## Code Quality Checks

```bash
# TypeScript checks
npm run typecheck
npm run lint

# Biome
npm run check

# Apply Biome fixes
npm run format
```

## Git Hooks

This repo uses Husky with a pre-commit hook:

```bash
npx biome check --write --staged
```

Stage files before committing so the hook can validate and auto-format the
staged diff.

## Test Suites

```bash
npm run test:unit
npm run test:integration
npm run test:e2e
npm run test:live
```

Guidance:

- `test:unit` is the default suite for normal code changes.
- `test:integration` covers multi-component paths and may still be empty for
  some areas.
- `test:e2e` and `test:live` are opt-in and may require extra services or
  credentials.
- `npm run test` currently aliases `npm run test:unit`.

## CI Coverage

CI currently runs:

- `npm install`
- `npm run setup`
- Biome on changed `src/**` files
- `npm run lint`
- `npm --prefix container run lint`
- `npm run build`
- `npm run release:check`
- `npm --prefix container run release:check`
- unit tests with coverage
- coverage badge publication to `gh-pages/badge/coverage.json` for README/docs badges

## Repository Structure For Testing

```text
tests/                  Vitest suites
tests/unit/             Unit-only suites when a narrower split is useful
src/                    Main runtime code under test
container/src/          Sandboxed runtime code under test
templates/              Runtime bootstrap inputs with dedicated tests
```

When you change bootstrap behavior, release packaging, or host/container
coordination, prefer targeted tests close to the touched behavior instead of
adding broad regression suites by default.
