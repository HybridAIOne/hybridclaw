# Code Provenance And IP Statement

Status: 2026-07-21. Maintained alongside the compliance tooling
(`THIRD_PARTY_NOTICES.md`, `npm run sbom`, DCO workflow); update this document
when the facts below change.

## Summary

HybridClaw is an independent, from-scratch implementation. All first-party
code is copyright HybridAIOne and the project contributors, licensed under the
MIT License (`LICENSE`). It is not a fork of, and contains no code derived
from, OpenClaw or any other assistant runtime.

## Origin And Authorship

- The repository begins with commit `7a3c9f929` (2026-02-24): 41 files,
  5,405 lines — a small Discord-bot skeleton described in the commit message
  ("Host process manages Discord, SQLite, scheduling, and IPC"). Every later
  capability (gateway, TUI, console, container runtime, channels, skills,
  plugins) was added incrementally on top of it; the full history is organic
  and reviewable commit by commit.
- Authorship is concentrated: ~3,860 commits from four individuals — two core
  maintainers (Benedikt Koehler, Maximilian Noller), one occasional
  contributor (Stephan Noller), and two external single-commit contributors.
- Contributions are accepted under inbound=outbound MIT; since 2026-07-21
  every commit additionally requires a Developer Certificate of Origin
  sign-off, enforced by CI (see CONTRIBUTING.md, "Licensing And Sign-Off").
- AI-assisted authorship is disclosed via `Co-Authored-By` trailers and
  governed by CONTRIBUTING.md: the human author owns and reviews the diff.

## Relationship To OpenClaw

HybridClaw and OpenClaw are both MIT-licensed personal-AI-assistant runtimes,
which explains the category resemblance (gateway process, chat channels,
skills, TypeScript on Node 22) and the shared GitHub topics. The concrete
relationship:

- **Not a fork.** The git histories are unrelated; HybridClaw's history starts
  from an empty repository, not from an OpenClaw commit.
- **No derived code.** Verified empirically on 2026-07-21 by hashing every
  substantive source line (trimmed lines of at least 40 characters, imports
  and comments excluded) of both `src/` trees: 433 of 56,914 unique HybridClaw
  lines (0.76%) also occur in OpenClaw's ~267k-line tree, and inspection shows
  they are generic TypeScript idioms (`error instanceof Error ?
  error.message : String(error)` and similar). No file-level or block-level
  correspondence exists. The check is reproducible with a ~30-line script;
  rerun it against a current OpenClaw checkout if this question resurfaces.
- **`hybridclaw migrate openclaw` is a user-migration importer.** It reads an
  existing OpenClaw installation's configuration, secrets, and workspace
  layout and converts them into HybridClaw's own formats
  (`src/migration/agent-home-migration.ts`). It links against no OpenClaw
  code and vendors none.

Because no OpenClaw code is included, the MIT attribution obligation toward
the OpenClaw Foundation does not attach; `LICENSE` correctly names only
HybridAIOne. If OpenClaw code is ever incorporated, its copyright notice must
be added to `THIRD_PARTY_NOTICES.md` at that time.

## Third-Party Code

All third-party code enters exclusively as npm dependencies pinned by
committed lockfiles:

- `THIRD_PARTY_NOTICES.md` — full inventory, license texts, and NOTICE files
  for every production dependency of all distributed components; regenerated
  by `npm run notices` and gated in CI.
- `npm run sbom` — per-component CycloneDX and SPDX SBOMs; attached to
  releases. Container images additionally carry BuildKit SBOM and provenance
  attestations; npm publishes with `--provenance`.
- `scripts/check-dependency-policy.mjs` — CI license gate: GPL/AGPL/SSPL
  dependencies fail unless explicitly baselined after review. Core has no
  strong-copyleft exceptions. The optional WhatsApp transport is developed,
  audited, and released separately under GPL-3.0-only from
  [`HybridAIOne/hybridclaw-whatsapp`](https://github.com/HybridAIOne/hybridclaw-whatsapp).

## License Header Policy

First-party source files carry no per-file copyright or SPDX headers; the
root `LICENSE` plus the `license` field in every `package.json` govern the
entire tree. This is intentional — MIT does not require per-file notices, and
headerless files keep diffs and generated-code tooling simple. Do not add
headers piecemeal; if the policy ever changes, apply it mechanically across
the tree in one commit.
