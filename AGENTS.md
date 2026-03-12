# AGENTS.md — HybridClaw Engineering Protocol

This file is the canonical repo-level instruction set for coding agents working
in HybridClaw. Read it before any code change.

## Scope

- Follow this file first.
- If a deeper directory contains its own `AGENTS.md`, that file overrides this
  one for its subtree.
- Keep `CLAUDE.md` aligned with this file. `CLAUDE.md` should only carry
  tool-specific deltas.
- `templates/*.md` are product runtime workspace bootstrap files, not repo
  contributor onboarding docs.

---

## 1) Project Snapshot

HybridClaw is a personal AI assistant bot for Discord, powered by HybridAI.
Enterprise-grade Node.js 22 application with gateway service, TUI client, and
Docker-sandboxed container runtime.

**Version:** 0.6.0 &ensp;|&ensp; **Package:** `@hybridaione/hybridclaw`
&ensp;|&ensp; **License:** see `LICENSE`

Architecture: gateway (core runtime, SQLite persistence, REST API, Discord
integration) → container (Docker-sandboxed tool execution via file-based IPC) →
TUI (thin HTTP client). Agent workspaces are bootstrapped from `templates/` and
seeded with identity, memory, and context files managed by `src/workspace.ts`.

---

## 2) Project Map

```
src/
  cli.ts                CLI entry point and command dispatch
  types.ts              Core type definitions (ChatMessage, ContainerInput, ToolExecution, etc.)
  workspace.ts          Workspace bootstrap (SOUL.md, IDENTITY.md, USER.md, etc.)
  logger.ts             Structured logging (pino)
  tui.ts                Terminal UI
  onboarding.ts         Interactive onboarding
  model-selection.ts    Model selection logic
  agent/                Agent execution: conversation loop, tool executor, prompt hooks, delegation
  audit/                Append-only audit trail, approval tracking, hash-chain integrity
  auth/                 HybridAI and OpenAI Codex authentication flows
  channels/discord/     Discord integration and delivery logic
  config/               CLI flag parsing, runtime config management
  gateway/              Core gateway service: HTTP APIs, health, session mgmt, approvals
  infra/                Container setup, IPC (file-based), worker signatures, runners
  memory/               SQLite database, semantic memory, compaction, consolidation, chunking
  providers/            Model providers (HybridAI, Anthropic, OpenAI, Ollama, LM Studio, vLLM)
  scheduler/            Scheduled task execution and cron management
  security/             Mount allowlists, approval policies, secret redaction, instruction audit
  session/              Session transcripts, token tracking, compaction, export
  skills/               Skill resolution, installation, trust-aware guard
  utils/                Shared utilities
  media/                Media handling and context management

container/              Sandboxed runtime (separate npm package)
  src/                  Container agent runtime, tool execution, provider adapters, MCP client
  Dockerfile            Container build definition
  package.json          Container-specific deps (Playwright, agent-browser, PDF, MCP SDK)

skills/                 Bundled SKILL.md skills (pdf, docx, xlsx, pptx, office, personality, etc.)
templates/              Runtime workspace bootstrap files seeded into agent workspaces
tests/                  Vitest suites: unit, integration, e2e, live
docs/                   Static site assets, development reference docs
console/                Web console workspace package
```

### Key Data Flows

```
User message → Gateway (HTTP/Discord) → ContainerInput (JSON)
  → Container spawns (Docker sandbox, file-based IPC)
    → Agent loop (tool calls, approvals, MCP)
  → ContainerOutput (JSON) → Gateway → User
  → Session persisted (SQLite), audit logged (wire.jsonl, hash-chained)
```

### Extension Points

| Extension     | Interface / Registration                                     | Playbook |
|---------------|--------------------------------------------------------------|----------|
| Skill         | `skills/<name>/SKILL.md` frontmatter                         | §7.1     |
| Provider      | `src/providers/<name>.ts` + factory                          | §7.2     |
| MCP Server    | `~/.hybridclaw/config.json` (`mcpServers.*`) → tool namespace | §7.3     |
| Approval rule | `.hybridclaw/policy.yaml`                                    | §7.4     |
| Template      | `templates/<name>.md` + `src/workspace.ts`                   | §7.5     |

---

## 3) Engineering Principles

These are implementation constraints, not suggestions.

### 3.1 KISS

- Prefer straightforward control flow over abstraction.
- Keep error paths obvious and localized.
- Three similar lines of code is better than a premature helper.

### 3.2 YAGNI

- Do not add config keys, interfaces, or feature flags without a concrete caller.
- Do not add error handling for scenarios that cannot happen.
- Do not design for hypothetical future requirements.

### 3.3 DRY — Rule of Three

- Duplicate small local logic when it preserves clarity.
- Extract shared helpers only after three repeated, stable patterns.
- When extracting, preserve module boundaries.

### 3.4 Fail Fast

- Prefer explicit errors for unsupported or unsafe states.
- Never silently broaden permissions or capabilities.
- Validate at system boundaries (user input, external APIs, IPC); trust internal
  code.

### 3.5 Secure by Default

- LLM output is untrusted by default.
- Defaults are deny-by-default (mount allowlists, approval tiers, sandbox).
- Never log secrets, raw tokens, or sensitive payloads.
- Read `SECURITY.md` and `TRUST_MODEL.md` before touching security surfaces.

---

## 4) Risk Tiers by Path

Classify changes by blast radius. When uncertain, classify higher.

| Tier   | Paths                                                                       |
|--------|-----------------------------------------------------------------------------|
| High   | `src/security/`, `src/gateway/`, `src/infra/`, `src/audit/`, `container/src/approval-policy.ts`, `container/src/extensions.ts`, `.hybridclaw/policy.yaml` |
| Medium | `src/agent/`, `src/providers/`, `src/session/`, `src/memory/`, `src/skills/`, `container/src/`, `templates/` |
| Low    | `docs/`, `skills/` (bundled SKILL.md), test additions, comments, formatting |

**High-risk changes** must include threat/risk notes and boundary/failure-mode
tests. **Medium-risk changes** need targeted test coverage. **Low-risk changes**
should verify no broken references.

---

## 5) Setup and Commands

### Prerequisites

- Node.js 22 (matches CI and `engines` field)
- npm
- Docker when working on container-mode behavior or image builds

### Common Commands

```bash
npm install                          # install deps + Husky hooks
npm run setup                        # install container/ deps
npm run build                        # compile root + container TypeScript
npm run typecheck                    # tsc --noEmit
npm run lint                         # tsc --noEmit with unused detection
npm run check                        # biome check src
npm run format                       # biome check --write src
npm run test:unit                    # vitest unit suite
npm run test:integration             # integration tests
npm run test:e2e                     # end-to-end tests
npm run test:live                    # live tests (requires credentials)
npm run release:check                # verify release readiness
npm --prefix container run lint      # container lint
npm --prefix container run release:check  # container release check
npm run build:container              # build Docker image
```

### Dev Mode

```bash
npm run dev                          # tsx src/cli.ts gateway (hot reload)
npm run tui                          # tsx src/cli.ts tui
```

---

## 6) Working Rules

### Code Changes

- Keep changes focused. Prefer targeted fixes over broad refactors unless the
  task requires wider movement.
- Match the existing TypeScript + ESM patterns in the touched area.
- Update tests and docs when behavior, commands, or repo workflows change.
- Do not rename or relocate files in `templates/` without updating
  `src/workspace.ts` and the workspace bootstrap tests.
- Do not mix container and gateway changes in one commit unless they are
  tightly coupled.

### Coding Style

- **Language:** TypeScript (strict mode, ES2022 target, NodeNext modules, ESM).
- **Formatting:** Biome is authoritative. Run `npm run format` before
  committing. The Husky pre-commit hook runs `npx biome check --write --staged`.
- **Single quotes** for strings (configured in `biome.json`).
- **No `any`** without strong justification. No `@ts-nocheck`.
- **File size:** aim for ~500 LOC; split when it improves clarity or
  testability. `src/skills/skills-guard.ts` and `src/skills/skills.ts` are
  current large exceptions — do not grow them further without splitting.
- **Comments:** brief comments for tricky or non-obvious logic only. Do not add
  comments, docstrings, or type annotations to code you did not change.
- **Imports:** let Biome organize imports. Do not mix dynamic
  `await import()` and static `import` for the same module in production paths.
- **Dependencies:** root `package.json` is for gateway/CLI deps. Container-only
  deps go in `container/package.json`. Never add container deps to root.

### Git Discipline

- Treat existing uncommitted changes as user work unless you created them.
- Conventional Commits preferred: `feat:`, `fix:`, `test:`, `refactor:`,
  `chore:`, `docs:`.
- Group related changes; avoid bundling unrelated refactors.
- Never commit real API keys, tokens, credentials, or personal data. Use
  neutral placeholders in tests: `"test-key"`, `"example.com"`, `"user_a"`.

---

## 7) Change Playbooks

### 7.1 Adding a Skill

1. Create `skills/<name>/SKILL.md` with required frontmatter:
   ```yaml
   ---
   name: my-skill
   description: One-line description
   user-invocable: true  # optional, enables /<name> invocation
   ---
   ```
2. Add markdown instructions and working rules in the body.
3. If the skill needs supporting scripts, place them alongside `SKILL.md`.
4. Bundled script paths are mirrored into `/workspace/skills/<name>` at runtime.
5. Test: `hybridclaw skill list` should show the new skill.

Skill resolution order (first match wins):
1. `config.skills.extraDirs[]`
2. Bundled: `skills/<name>`
3. `$CODEX_HOME/skills`
4. `~/.codex/skills`, `~/.claude/skills`, `~/.agents/skills`
5. Project/workspace: `./.agents/skills`, `./skills`

### 7.2 Adding a Provider

1. Create `src/providers/<name>.ts` implementing the provider interface.
2. Register in the provider factory (`src/providers/`).
3. Add config section in `src/config/` if new credentials or endpoints needed.
4. Add tests for factory wiring, error paths, and config parsing.
5. Update `docs/` if the provider is user-facing.

### 7.3 Adding an MCP Server

1. Add the server config to `config.json` under `mcp.servers`:
   ```json
   { "command": "...", "args": [...], "transport": "stdio" }
   ```
2. Tools are auto-discovered at startup and merged into the tool namespace.
3. Test with `hybridclaw` running in dev mode.

### 7.4 Modifying Approval Policy

1. Edit `.hybridclaw/policy.yaml` (or `.claude/policy.yaml` for dev).
2. Approval tiers: green (silent) → yellow (narrated) → red (explicit approval).
3. `pinned_red` patterns are never auto-promoted.
4. Test approval flows with integration tests that exercise the boundary.

### 7.5 Modifying Templates

1. Edit the file in `templates/`.
2. **Always** update `src/workspace.ts` if you add, remove, or rename a
   template file.
3. Run workspace bootstrap tests to verify.
4. Remember: templates are seeded into agent workspaces at runtime — changes
   only apply to new sessions or after workspace reset.

### 7.6 Bump Release

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
5. Commit with `chore: release vX.Y.Z`.
6. Create an annotated git tag `vX.Y.Z`.
7. Push the commit and tag.
8. Create or publish a GitHub Release entry for the tag.

---

## 8) Testing Expectations

### What to Run

| Change scope        | Required checks                                             |
|---------------------|-------------------------------------------------------------|
| Docs only           | Verify links, commands, examples                            |
| `src/` changes      | `npm run typecheck`, `npm run lint`, targeted Vitest suites |
| `container/` changes| `npm --prefix container run lint`, `npm run build`, IPC boundary tests |
| `skills/` changes   | `hybridclaw skill list`, targeted skill tests               |
| Release/packaging   | Both `release:check` scripts, verify versioned docs         |
| Security surfaces   | Include boundary and failure-mode tests                     |

### Conventions

- Test files: `tests/*.test.ts`, `*.integration.test.ts`, `*.e2e.test.ts`,
  `*.live.test.ts`.
- Live tests require credentials. Skip them unless your change needs them,
  and state that explicitly in your handoff.
- If you skip a relevant check, state what you skipped and why.
- Never hardcode real credentials in tests. Use env vars or test fixtures.

---

## 9) Anti-Patterns (Do Not)

- Do not rename or relocate `templates/` files without updating
  `src/workspace.ts`.
- Do not add container-only deps to root `package.json`.
- Do not grow `src/skills/skills-guard.ts` or `src/skills/skills.ts` further
  without splitting.
- Do not use `@ts-nocheck` or disable lint rules without strong justification.
- Do not silently weaken security policy, approval tiers, or mount allowlists.
- Do not log secrets, tokens, or sensitive payloads — even at debug level.
- Do not modify unrelated modules "while here".
- Do not include personal identity, real phone numbers, or live config values
  in tests, examples, docs, or commits.
- Do not edit `node_modules/` or vendored files.
- Do not break prompt caching: do not alter past context, change toolsets, or
  rebuild system prompts mid-conversation.
- Do not return stale or mocked data for security/audit paths.

---

## 10) Multi-Agent Safety

When multiple agents may be working on this repo concurrently:

- **Do not** create, apply, or drop `git stash` entries unless explicitly
  requested (including `git pull --rebase --autostash`).
- **Do not** switch branches or check out a different branch unless explicitly
  requested.
- **Do not** create, remove, or modify `git worktree` checkouts unless
  explicitly requested.
- When the user says "commit", scope to **your changes only**. When the user
  says "commit all", commit everything in grouped chunks.
- When the user says "push", you may `git pull --rebase` to integrate latest
  changes. Never discard other agents' work.
- When you see unrecognized files, keep going. Focus on your changes and commit
  only those.
- Focus reports on your edits. End with a brief "other files present" note only
  if relevant.
- Lint/format churn: if diffs are formatting-only, auto-resolve without asking.
  Only ask when changes are semantic (logic/data/behavior).

---

## 11) Documentation Hierarchy

| Document                    | Audience            | Purpose                         |
|-----------------------------|---------------------|---------------------------------|
| `README.md`                 | End users           | Product overview, setup         |
| `AGENTS.md` (this file)     | Coding agents       | Canonical repo instructions     |
| `CLAUDE.md`                 | Claude Code          | Thin shim → `AGENTS.md`        |
| `CONTRIBUTING.md`           | Human contributors  | Quickstart, PR workflow         |
| `SECURITY.md`               | Security reviewers  | Runtime security controls       |
| `TRUST_MODEL.md`            | Operators           | Trust acceptance policy         |
| `docs/development/`         | Maintainers         | Architecture, runtime, testing  |
| `templates/*.md`            | Product runtime     | Agent workspace bootstrap       |

---

## 12) Handoff Template

When handing off work (agent → agent or agent → maintainer), include:

1. **What changed** — files touched and why.
2. **What did not change** — scope boundaries you respected.
3. **Validation** — which checks you ran and their results.
4. **Skipped checks** — what you did not run and why.
5. **Remaining risks / unknowns** — open questions or edge cases.
6. **Next recommended action** — what to do next.

---

## 13) Vibe Coding Guardrails

When working in fast iterative mode:

- Keep each iteration reversible (small commits, clear rollback path).
- Validate assumptions with code search before implementing.
- Prefer deterministic behavior over clever shortcuts.
- Do not "ship and hope" on security-sensitive paths.
- If uncertain about an internal API, search `src/` for existing usage patterns
  before guessing.
- If uncertain about architecture, read the type definitions in `src/types.ts`
  and the workspace bootstrap in `src/workspace.ts` before implementing.
