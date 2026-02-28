# SECURITY

## Policy Version

- Version: `2026-02-28`
- Applies to: all `hybridclaw` runtime modes (`gateway`, `tui`, onboarding, scheduled tasks, heartbeat)

## Trust Model

HybridClaw runs an LLM-driven agent that can execute tools in a container and read/write files in mounted workspaces.

Core assumptions:

- LLM output is **untrusted by default** and can be incorrect, over-confident, or unsafe.
- Tool output and file contents are **untrusted input** and must be validated before high-impact actions.
- Secrets and credentials (`.env`, API keys, cloud credentials, SSH keys, auth tokens) are **sensitive** and must never be exposed unless explicitly required and approved by policy.

## Security Boundaries

- Runtime code executes on the host; agent tool execution is isolated in Docker containers.
- Mount access is restricted by allowlist policy (`~/.config/hybridclaw/mount-allowlist.json`).
- Additional mounts are denied when allowlist validation fails.
- Network/API access is governed by configured endpoints and bearer tokens.

## Operator Responsibilities

By accepting this policy, operators agree to:

- Use least privilege for API keys, tokens, and mounts.
- Review prompts, outputs, and tool plans before high-impact operations.
- Keep production secrets out of general workspaces whenever possible.
- Require explicit human approval for destructive operations.
- Monitor and rotate compromised credentials immediately.

## Data Handling

HybridClaw may persist:

- Conversation history in SQLite (`data/hybridclaw.db`)
- Session transcripts in workspace logs (`.session-transcripts`)
- Agent memory files (`MEMORY.md`, `memory/*.md`)

Operators are responsible for data retention, backup, and deletion requirements.

## Explicit Acceptance Requirement

On first run (or when policy version changes), onboarding requires explicit acceptance:

- User must confirm review of this document.
- User must type the acceptance token (`ACCEPT`).
- Acceptance metadata is saved in `config.json`:
  - `security.trustModelAccepted`
  - `security.trustModelAcceptedAt`
  - `security.trustModelVersion`
  - `security.trustModelAcceptedBy`

Runtime startup is blocked until acceptance is present.

## Incident Guidance

If compromise is suspected:

1. Stop gateway and active containers.
2. Rotate API keys/tokens.
3. Review mount allowlist and workspace files.
4. Audit recent session transcripts and task runs.
5. Re-onboard and re-accept policy after remediation.
