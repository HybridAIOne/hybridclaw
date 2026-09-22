# Agentic TPM

An installable agent for evidence-based project coordination and follow-ups.
See [research and attribution](../../skills/agentic-tpm/references/research.md)
for Steve Yegge's motivating proposal, supporting practices, and limits.

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

Pasted notes and local files are enough to start. Optional integrations,
communication mandates, and recurring reviews follow the
[skill's operating rules](../../skills/agentic-tpm/SKILL.md).

## Validation

Use [behavioral scenarios](../../skills/agentic-tpm/references/evaluation.md) to
exercise kickoff, conflicts, follow-up limits, uncertain sends, restricted
knowledge, revoked authorization, and closure with synthetic data before a pilot.
These scenarios are a manual evaluation guide, not automated behavioral tests.

After changes, rebuild and inspect the archive, check skill discovery with
`hybridclaw skill list`, and run the repository's skill-manifest,
skill-invocation, and claw-archive tests. Keep run-specific results in the PR.
