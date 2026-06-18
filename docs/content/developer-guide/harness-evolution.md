---
title: Harness Evolution
description: Run controlled eval-driven evolution loops for HybridClaw coworker workspaces.
sidebar_position: 9
---

# Harness Evolution

Harness evolution is a local, eval-driven loop for improving one coworker
workspace at a time. It starts from a minimal bash-only seed or an existing
workspace, runs an eval suite, distills failures into a debugger report, asks
the evolve-agent for bounded, verifiable edits, applies only allowed workspace
edits, keeps a candidate only when a selection gate improves, and records the
result for review.

The workflow is inspired by
[SkillOpt](https://microsoft.github.io/SkillOpt/): keep the target agent fixed,
treat the coworker harness as the trainable artifact, use rollout evidence to
propose bounded text edits, and validate changes before promoting them.
HybridClaw stores those steps as local run artifacts so operators can inspect
and roll back edits.

Use it when you want to measure whether changes to memory, tools, middleware,
sub-agents, config, or prompts actually improve task success. Do not use it as
a blind production optimizer. The loop is useful only when the eval suite
captures behavior you are willing to optimize for.

## Practical Use In HybridClaw

The highest-value use case is a recurring workflow failure:

> This agent keeps failing this task. Encode the task as an eval, run
> harness-evolve against a copy of the agent workspace, inspect the change
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
  --suite /tmp/hc-evals/train.json \
  --selection-suite /tmp/hc-evals/selection.json \
  --rounds 2 \
  --k 1 \
  --max-edits 4 \
  --fresh-seed
```

Add `--dry-run` to test eval execution, metrics, summaries, and admin display
without applying evolve-agent edits. Add `--commit` only when the target
workspace is a Git checkout and you want one commit per confirmed round.

In the admin console, `/admin/harness-evolution` can generate starter suites
for a target workspace. Click **Create starter suites** to write
`evals/train-suite.json`, `evals/selection-suite.json`, and
`verifier/check-starter-memory.mjs` into the target, then start from those
filled-in paths.

For real workflows, use **Build train and selection suites** on the same page.
Paste one command per line for the train split and one command per line for the
selection split, then click **Save suites and fill fields**. Lines can be plain
commands or `task-id: command` entries. The page writes JSON suite files under
`evals/` and fills both suite path inputs. Commands can include `{targetRoot}`
as an argv placeholder; the runner replaces it with the selected target
workspace path and also sets `HYBRIDCLAW_EVOLUTION_TARGET_ROOT`.

Click **Create SpreadsheetBench example** for a concrete spreadsheet-oriented
demo. It writes a SpreadsheetBench-style formula-repair task with train and
selection CSV fixtures, suite JSON files, and
`verifier/check-spreadsheetbench-formula.mjs`. The verifier fails until the
target harness contains reusable spreadsheet procedure memory such as deriving
formulas from headers, writing formulas instead of constants, and verifying on
held-out rows. It is a local example inspired by the public SkillOpt
spreadsheet experiments, not a vendored copy of Microsoft benchmark data.

`--selection-suite` provides the held-out gate. If you omit it, tasks with
`"split": "selection"` in the main suite are held out. If neither is present,
the same suite is reused as a shared gate, which is useful for smoke tests but
does not provide true held-out selection. `--max-edits` is the textual learning
rate: it caps how many bounded edits the optimizer may apply in one round.

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
      "split": "train",
      "command": "node /tmp/hc-evals/check-memory.mjs /tmp/hc-evolve-agent",
      "timeoutMs": 30000
    },
    {
      "id": "remember-stderr-selection",
      "split": "selection",
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
- `HYBRIDCLAW_EVOLUTION_TARGET_ROOT`

Use `{targetRoot}` in a command when the target path should be passed as an
argument without hard-coding one machine's directory:

```json
{
  "id": "selection-smoke",
  "command": "node verifier/check-selection.mjs {targetRoot}"
}
```

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
      "split": "train",
      "command": "node /tmp/hc-evals/check-memory.mjs /tmp/hc-evolve-agent",
      "timeoutMs": 30000
    },
    {
      "id": "remember-stderr-selection",
      "split": "selection",
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
  --max-edits 4 \
  --fresh-seed
```

After the run, copy the printed `summaryPath` into:

```bash
hybridclaw harness-evolve status --summary <summaryPath>
```

Check the status output for `pass@1`, `Succ/Mtok`, `Seed delta`, per-surface
edits, and the evolve-agent source. The run directory also contains
`evolve-agent-output.md`, distilled debugger reports, per-round manifests,
cleaned rollout artifacts, `optimizer-memory.md`, `rejected-edits.json`, and
the summary JSON.

## Example: SpreadsheetBench-Style Formula Repair

The admin console can generate a spreadsheet task that mirrors the shape of
SkillOpt's SpreadsheetBench examples without bundling external benchmark data.
Open `/admin/harness-evolution`, set a target workspace, and click **Create
SpreadsheetBench example**.

The target receives:

- `evals/spreadsheetbench-formula-train.json`
- `evals/spreadsheetbench-formula-selection.json`
- `evals/spreadsheetbench-style/train-orders.csv`
- `evals/spreadsheetbench-style/selection-orders.csv`
- `verifier/check-spreadsheetbench-formula.mjs`

The generated verifier checks whether the target harness has reusable
spreadsheet procedure memory in
`long_term_memory/spreadsheet-formula-repair.md`. The memory must tell the
agent to derive formulas from headers, write formulas instead of hard-coded
constants, and verify recalculation on held-out or changed rows. The selection
split uses a different fixture so accepted edits need to generalize beyond the
train rows.

This is a good first demo because the failure is clear, the verifier is cheap,
and the expected improvement belongs in the harness rather than in product
code.

## Example: Improve PDF Creation

Harness evolution is useful when a coworker repeatedly chooses the wrong tool
path inside a larger workflow. For example, an agent may receive:

> Create a PDF with an image of a dog.

A good eval does not just check whether the agent wrote a file named `.pdf`.
It should verify the behavioral contract:

- a PDF file exists in the expected output directory
- the file starts with `%PDF-`
- the PDF contains an embedded image object such as `/Subtype /Image`
- optional: a vision or classifier step confirms that the image is dog-like

Start with structural checks before adding vision checks. They are cheaper,
deterministic, and catch common failures such as writing Markdown, renaming a
text file, or creating a PDF with no image.

An example suite can wrap both the agent invocation and the verifier:

```json
{
  "id": "pdf-dog",
  "name": "PDF dog creation",
  "costBudgetUsd": 0.25,
  "tasks": [
    {
      "id": "pdf-dog",
      "command": "node /tmp/hc-pdf-dog-eval/run-and-check.mjs",
      "timeoutMs": 120000
    }
  ]
}
```

The verifier should make failures actionable. For example:

```text
FAIL: create a real PDF file under output/.
FAIL: output file must be a real PDF beginning with %PDF-.
FAIL: PDF must contain an embedded dog image; use a PDF-generation path that embeds an image object.
```

Those messages give the evolve-agent evidence it can translate into workspace
edits. Useful edits for this workflow usually look like:

- `long_term_memory/pdf-generation.md` with the reliable PDF-generation
  procedure and verification checklist
- `tools/create_image_pdf.mjs` or another helper that embeds an image into a
  real PDF
- `tools.yaml` registration for that helper
- narrow prompt guidance that says not to rename text files as PDFs

Run the loop against a copy of the target workspace:

```bash
hybridclaw harness-evolve init --target /tmp/hc-pdf-dog-agent
hybridclaw harness-evolve validate-seed --target /tmp/hc-pdf-dog-agent
hybridclaw harness-evolve run \
  --target /tmp/hc-pdf-dog-agent \
  --suite /tmp/hc-pdf-dog-eval/scenarios.json \
  --rounds 5 \
  --k 1 \
  --fresh-seed
```

Inspect the change manifest before promoting any edit. The harness can improve
workspace instructions and helper tools, but product code changes still need
normal review and tests.

## Admin Console

The admin console can initialize targets, start SkillOpt-style optimization
runs, and inspect completed runs through `/admin/harness-evolution`. The API is
allowlist-gated. Set `HYBRIDCLAW_HARNESS_EVOLUTION_ROOTS` to a comma-separated
list of target roots that the gateway may read and write:

```bash
HYBRIDCLAW_HARNESS_EVOLUTION_ROOTS=/tmp/hc-evolve-agent hybridclaw gateway restart
```

The page exposes the same run settings as the CLI: target workspace, train
suite, optional selection suite, rounds, rollouts per task, max edits per round,
fresh-seed mode, dry-run mode, and per-round commits. It also shows run
summaries, train and selection scores, gate decisions, starting-state
differences, edit source, SkillOpt stage telemetry, optimizer memory, and
change manifest entries. Accepted candidates are exported under the run's
`best-harness/`; rejected candidates are recorded in `rejected-edits.json` and
rolled back from the target harness.

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
