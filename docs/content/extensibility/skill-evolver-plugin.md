---
title: Skill Evolver Plugin
description: Evolve SKILL.md descriptions and bodies with DSPy + GEPA, validated against synthetic, golden, and real trace data.
sidebar_position: 12
---

# Skill Evolver Plugin

HybridClaw ships a bundled skill evolver at
[`plugins/skill-evolver`](https://github.com/HybridAIOne/hybridclaw/tree/main/plugins/skill-evolver).

The plugin applies reflective prompt evolution (DSPy + [GEPA](https://arxiv.org/abs/2507.01234))
to two distinct optimization targets on any installed SKILL.md:

- **description** — the short frontmatter field that drives skill routing.
  Fitness is measured as the trigger-classification F1 of a judge LM that
  picks which skill (from the real installed pool) should fire for a given
  prompt.
- **body** — the Markdown instructions that actually run after the skill is
  selected. Fitness is measured by an LLM-judge scoring a follower LM's
  execution against a task rubric (correctness / procedure / conciseness).

Both targets can be evolved separately or jointly (body first, then
description, then cross-validated for drift).

## When to use it

Use it for a skill that is **already measurable** — you must have at least
one of:

- enough real traces in the HybridClaw SQLite DB (default minimum: 10
  observations)
- curated golden examples under `datasets/skills/<skill>/{triggers,tasks}.json`
- a stable enough description/body that synthetic generation can derive
  meaningful triggers and tasks from it

Unlike the adaptive-skills amendments flow — which makes *conservative*
single-point edits inside HybridClaw at runtime — this plugin runs a full
reflective search offline, proposes a new SKILL.md, validates it against
size/shape/test constraints, and opens a PR if asked. Adaptive skills
continue to own the lightweight, in-process edits; the evolver owns the
offline, multi-iteration, PR-gated edits.

## Three dataset ingredients

Every evolution run assembles its evaluation set from up to three sources,
controllable with `--sources`:

| Source | Where from | What it becomes |
| --- | --- | --- |
| `synthetic` | LLM generates positives + adversarial negatives from the skill's own description/body | trigger prompts and execution tasks |
| `golden` | `datasets/skills/<skill>/triggers.json` and `datasets/skills/<skill>/tasks.json` | human-curated ground truth |
| `traces` | `skill_observations` rows in the HybridClaw SQLite DB joined with session transcripts | real-world triggers and tasks with observed outcomes |

Trace extraction walks the `.session-transcripts/` JSONL files in the
HybridClaw data dir, correlating them with `skill_observations` entries via
`session_id` + timestamp proximity to recover the user prompt that
originally invoked each skill run.

## Commands

```
hybridclaw skill-evolver list                        # rank skills by failure rate
hybridclaw skill-evolver extract <skill>             # write datasets/skills/<skill>/traces.json
hybridclaw skill-evolver evolve <skill> --target description
hybridclaw skill-evolver evolve <skill> --target body --iterations 20
hybridclaw skill-evolver evolve <skill> --target both --open-pr
hybridclaw skill-evolver show <skill>                # Rich-rendered report of last run
hybridclaw skill-evolver watch <skill>               # live dashboard while running
hybridclaw skill-evolver tui                         # interactive skill browser
```

`evolve` requires `--target` explicitly — there is no silent default — because
the evaluation shape differs materially between description and body.

## Configuration

Per-plugin config (set in `config.json` under `plugins.skill-evolver`):

| Key | Default | Notes |
| --- | --- | --- |
| `optimizerModel` | `openai/gpt-4.1` | reflection LM used by GEPA |
| `evalModel` | `openai/gpt-4.1-mini` | task/judge LM used to score candidates |
| `maxSkillBodyBytes` | `15360` | hard cap; candidates over this are rejected |
| `maxDescriptionChars` | `1024` | hard cap |
| `defaultIterations` | `10` | overridable via `--iterations` |
| `defaultSources` | `synthetic,golden,traces` | overridable via `--sources` |
| `minTraceObservations` | `10` | below this the `traces` source is auto-dropped |
| `datasetsDir` | `datasets/skills` | repo-relative golden dataset root |
| `workBranchPrefix` | `evolve/skill` | branch name prefix for PR mode |
| `runTests` | `true` | run `testCommand` before committing |
| `testCommand` | `npm test --silent` | test command to invoke on the variant |

## Safety gates

Before any variant is applied, it must pass a set of pure constraint
checks (`plugins/skill-evolver/python/skill_evolver/constraints.py`):

- size limits on description and body
- description must be non-empty and fit on a few lines
- body must keep a top-level heading
- frontmatter must not leak into the body
- the body must not grow more than 1.5× the baseline

If `runTests` is true, the applied variant is written, tested, and rolled
back on failure before the commit. The PR mode additionally pushes the
branch and runs `gh pr create` with the evolution report as the body.

## Python runtime

The plugin declares its Python deps (`dspy`, `gepa`, `click`, `rich`,
`pyyaml`, `pydantic`) in `hybridclaw.plugin.yaml`. HybridClaw's plugin
install flow provisions the per-plugin `.venv` and installs the declared
pip deps — preferring `uv` if available, otherwise `python3 -m venv`.

Before the first `skill-evolver` command, run the install flow once so the
venv exists and its dependencies are resolved:

```bash
hybridclaw plugin install ./plugins/skill-evolver --yes
```

(You can also use `hybridclaw plugin check` + `hybridclaw plugin install
--yes` to see the approval prompts first.) If the venv is missing at run
time the TS bridge throws an actionable error pointing you at this command
rather than silently falling back to the system `python3` and failing on
the first `import dspy`.

All LLM traffic goes through the DSPy-configured models, which inherit
whichever provider keys are set in the HybridClaw environment
(`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`).

## Typical flow

1. `hybridclaw skill-evolver list` — pick a skill with elevated failure rate.
2. `hybridclaw skill-evolver extract <skill>` — materialize its traces dataset.
3. `hybridclaw skill-evolver evolve <skill> --target description` — iterate
   routing.
4. `hybridclaw skill-evolver show <skill>` — review score deltas, constraint
   gates, and the unified diff.
5. If the result looks good, re-run with `--open-pr` to commit, test, and
   open a PR. Otherwise curate `datasets/skills/<skill>/triggers.json` with
   the failures and iterate.
