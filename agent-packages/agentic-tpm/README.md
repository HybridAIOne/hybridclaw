# Agentic TPM

An installable project coordinator inspired by Steve Yegge's Agentic TPM
proposal. The agent maintains evidence-backed commitments, dependencies, risks,
decisions, and follow-up drafts. Humans retain delivery decisions and authority.

The canonical skill lives in `skills/agentic-tpm/` at the repository root. The
package bundles that skill without maintaining a second copy. It includes no
credentials, connector dependencies, model pin, runtime policy override, live
project data, or active schedule. Prompt instructions are not tool enforcement;
operators must configure appropriate host permissions before enabling outreach.

## Build and inspect

From the repository root, using Python 3.9+ and the HybridClaw CLI:

```sh
python3 agent-packages/agentic-tpm/build.py --output /tmp/agentic-tpm.claw
hybridclaw agent inspect /tmp/agentic-tpm.claw
```

The build uses only the Python standard library and deterministic ZIP metadata.
It reads this manifest/workspace and the canonical skill. It does not export
anything from an existing agent or user account.

## Install and start

Install explicitly into a new agent ID:

```sh
hybridclaw agent install /tmp/agentic-tpm.claw --id agentic-tpm
```

Select the installed agent in your normal HybridClaw client. Example first message:

> Coordinate Project Example. Our goal is a vendor pilot accepted by the sponsor
> by October 30. Start from these project notes. Draft follow-ups only. Show the
> dependency map, ownership gaps, and decisions the sponsor needs to make.

For the standalone skill, use `/skill agentic-tpm` in a checkout where it is
bundled, or import the skill directory into another installation:

```sh
hybridclaw skill import ./skills/agentic-tpm
```

Chat alternative: `/skill import <path-to-skill-directory>` where that directory
is available to the gateway. Then invoke `/skill agentic-tpm`.

Email, Slack, and tracker integrations are optional and configured separately.
Pasted notes and local files are enough for the first project. To enable outreach,
provide an explicit mandate covering recipients, purposes, channels, information,
frequency, time zone/quiet hours, escalation, and expiry. Recurring reviews need
an explicit request and a configured scheduler; installing the archive does not
start monitoring or send messages.

## Research and validation

Read [research and attribution](../../skills/agentic-tpm/references/research.md)
for sources and limits. The primary-source research informed decision ownership
and dependency mapping; the user-supplied proposal is credited to Steve Yegge.

Use [behavioral scenarios](../../skills/agentic-tpm/references/evaluation.md) to
exercise kickoff, conflicts, follow-up limits, uncertain sends, restricted
knowledge, revoked authorization, and closure with synthetic data before a pilot.
These scenarios are a manual evaluation guide, not automated behavioral tests.

Validation (2026-09-22): the checkout archive validator accepted the built
archive; the community skill guard returned safe with no findings; the checkout
CLI discovered the skill as enabled. Build reproducibility, source/archive
parity, frontmatter parsing, and local Markdown references passed. Repository
formatting and lint passed, as did 50 tests across the skill-manifest,
skill-invocation, and claw-archive suites.

The generic Codex Python skill validator requires unavailable PyYAML and omits
HybridClaw's supported `user-invocable` field; HybridClaw's own parser and guard
were used instead. No live messaging, scheduled runs, or model behavioral
evaluations were performed. No runtime implementation was changed.
