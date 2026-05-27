---
title: Harness Evolution
description: Run controlled eval-driven evolution loops for HybridClaw coworker workspaces.
sidebar_position: 9
---

# Harness Evolution

Harness evolution is a local, eval-driven loop for improving one coworker
workspace at a time. It starts from a minimal bash-only seed or an existing
workspace, runs an eval suite, distills failures into an F11.4-style debugger
report, asks the evolve-agent for F12-governed edits, applies only allowed
workspace edits, and records the result for review.

Use it when you want to measure whether changes to memory, tools, middleware,
sub-agents, config, or prompts actually improve task success. Do not use it as
a blind production optimizer. The loop is useful only when the eval suite
captures behavior you are willing to optimize for.

## Practical Use In HybridClaw

The highest-value use case is a recurring workflow failure:

> This agent keeps failing this task. Encode the task as an eval, run
> harness-evolve against a copy of the agent workspace, inspect the F12
> manifest, then promote only the useful edits.

Use the harness differently depending on the target:

- personal coworkers: improve long-term memory, workflow notes, small tool
  wrappers, and narrow prompt instructions
- business skills: evolve examples, helper scripts, eval-specific memory,
  verifier-backed behavior notes, or skill-local tool wiring
- core product behavior: use harness output as candidate evidence only; product
  code changes still need normal code review, tests, and security review
- SOUL or personality files: avoid casual mutation; personality affects broad
  behavior and is easy to overfit, so prefer memory or skill instructions first

The loop is intentionally biased toward lower-blast-radius surfaces first:
long-term memory, tools, and middleware usually make better first edits than
rewriting the main system prompt.

## Editable Surfaces

The evolve-agent can write only these seven target-workspace surfaces:

- `system_prompt.md`
- `tools.yaml`
- `tools/`
- `middleware/`
- `sub_agents/`
- `config/`
- `long_term_memory/`

The loop rejects writes outside those surfaces and treats `runs/`, `verifier/`,
and `model_config/` as read-only. Path traversal and symlink escapes are
blocked before writes are applied.

## Commands

```bash
hybridclaw harness-evolve init --target <dir>
hybridclaw harness-evolve validate-seed --target <dir>
hybridclaw harness-evolve run --target <dir> --suite <suite.json>
hybridclaw harness-evolve status --summary <runs/.../summary.json>
hybridclaw harness-evolve contract
```

`run` defaults to 10 rounds and three rollouts per task. Use `--rounds` and
`--k` for shorter local checks:

```bash
hybridclaw harness-evolve run \
  --target /tmp/hc-evolve-agent \
  --suite /tmp/hc-evals/scenarios.json \
  --rounds 2 \
  --k 1 \
  --fresh-seed
```

Add `--dry-run` to test eval execution, metrics, summaries, and admin display
without applying evolve-agent edits. Add `--commit` only when the target
workspace is a Git checkout and you want one commit per confirmed round.

## Eval Suite Format

A harness evolution suite is a JSON file, or a skill directory containing
`evals/scenarios.json`. The top-level array can be named `tasks` or
`scenarios`.

Each task needs a stable `id` and a concrete command. The command is split into
argv and is not run through a shell, so shell operators, redirects, and pipes
belong in a script file.

```json
{
  "id": "memory-smoke",
  "name": "Memory Smoke",
  "costBudgetUsd": 0.05,
  "tasks": [
    {
      "id": "remember-stderr",
      "command": "node /tmp/hc-evals/check-memory.mjs /tmp/hc-evolve-agent",
      "timeoutMs": 30000
    }
  ]
}
```

The verifier command determines success from its exit code. `stdout` and
`stderr` are captured, cleaned, and passed into the debugger report. During a
run, the command also receives these environment variables:

- `HYBRIDCLAW_EVOLUTION_TASK_ID`
- `HYBRIDCLAW_EVOLUTION_ROLLOUT`
- `HYBRIDCLAW_EVOLUTION_SUITE_ID`

## Minimal Example Suite

This example creates a target workspace and one verifier that fails until the
workspace long-term memory records how to handle stderr-heavy tasks.

```bash
mkdir -p /tmp/hc-evals

cat > /tmp/hc-evals/check-memory.mjs <<'EOF'
import fs from 'node:fs';
import path from 'node:path';

const targetRoot = process.argv[2];
const memoryPath = path.join(
  targetRoot,
  'long_term_memory',
  'stderr-debugging.md',
);

const text = fs.existsSync(memoryPath)
  ? fs.readFileSync(memoryPath, 'utf-8')
  : '';

if (!/stderr/i.test(text)) {
  console.error('expected long_term_memory/stderr-debugging.md to mention stderr');
  process.exit(1);
}
EOF

cat > /tmp/hc-evals/scenarios.json <<'EOF'
{
  "id": "stderr-memory-smoke",
  "name": "stderr memory smoke",
  "costBudgetUsd": 0.05,
  "tasks": [
    {
      "id": "remember-stderr",
      "command": "node /tmp/hc-evals/check-memory.mjs /tmp/hc-evolve-agent",
      "timeoutMs": 30000
    }
  ]
}
EOF

hybridclaw harness-evolve init --target /tmp/hc-evolve-agent
hybridclaw harness-evolve validate-seed --target /tmp/hc-evolve-agent
hybridclaw harness-evolve run \
  --target /tmp/hc-evolve-agent \
  --suite /tmp/hc-evals/scenarios.json \
  --rounds 2 \
  --k 1 \
  --fresh-seed
```

After the run, copy the printed `summaryPath` into:

```bash
hybridclaw harness-evolve status --summary <summaryPath>
```

Check the status output for `pass@1`, `Succ/Mtok`, `Seed delta`, per-surface
edits, and the evolve-agent source. The run directory also contains
`evolve-agent-output.md`, distilled debugger reports, per-round manifests, and
the summary JSON.

## Admin Console

The admin console can inspect completed harness evolution runs through
`/admin/harness-evolution`. The API is allowlist-gated. Set
`HYBRIDCLAW_HARNESS_EVOLUTION_ROOTS` to a comma-separated list of target roots
that the gateway may read:

```bash
HYBRIDCLAW_HARNESS_EVOLUTION_ROOTS=/tmp/hc-evolve-agent hybridclaw gateway restart
```

The page shows run summaries, round metrics, pass@1 trajectory, seed delta,
evolve-agent source, and F12 manifest entries.

## Candidate External Benchmarks

The easiest external benchmark family to adapt is terminal-native or
command-verifiable work, because harness evolution already expects commands
that exit zero or nonzero.

- [Terminal-Bench](https://github.com/harbor-framework/terminal-bench) is the
  best structural fit for the bash-only seed. Its tasks are terminal
  environments with verifier scripts, which maps cleanly to harness evolution
  commands and `pass@1`.
- [tau2-bench](https://github.com/sierra-research/tau2-bench) is the best fit
  for customer-service and tool-policy agents. HybridClaw already exposes a
  managed `hybridclaw eval tau2` helper, so a harness suite can wrap small
  tau2 runs when the goal is conversational tool use.
- [OSWorld](https://os-world.github.io/) and
  [WebArena](https://webarena.dev/) are useful for computer-use or browser
  agents, but they need heavier environment setup than a simple command-backed
  suite. Treat them as follow-up integrations rather than the first smoke test.

Start with a small local suite that mirrors your actual coworker workflow.
Only move to a public benchmark after the local verifier is deterministic and
cheap enough to run repeatedly.
