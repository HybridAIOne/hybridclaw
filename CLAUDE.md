# CLAUDE.md

Follow [AGENTS.md](./AGENTS.md) as the canonical repo instruction set for this
repository.

Claude-specific notes:

- There are currently no Claude-only workflow deltas.
- For gateway/runtime diagnostics, follow `AGENTS.md`: inspect
  `hybridclaw gateway status`, logs, runtime state, and the actual running
  process before diagnosing stale state; do not restart the gateway without
  explicit user approval.
- Before creating, editing, or optimizing a skill, read
  `docs/content/extensibility/skills.md` and follow its helper, command-surface,
  approval, credential, gateway, and testing guidance.
- For new, unreleased features, do not preserve compatibility with previous
  internal states. Remove provisional names, aliases, and workflows instead of
  carrying them forward.
- If this file grows beyond a short shim, move the shared guidance back into
  `AGENTS.md`.
- `templates/*.md` are runtime workspace bootstrap files for HybridClaw itself,
  not repo contributor onboarding docs.

Useful entry points:

- [CONTRIBUTING.md](./CONTRIBUTING.md) for contributor setup and PR workflow
- [docs/content/README.md](./docs/content/README.md) for deeper
  maintainer and runtime reference docs
