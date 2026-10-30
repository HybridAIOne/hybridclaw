---
title: Eval Harness
description: Benchmark and eval runs against a local gateway from a source checkout.
sidebar_position: 10
---

# Eval Harness

The eval harness lives in `eval-harness/`, a workspace that is not compiled
into `dist/` or published in the npm package. Run it from a source checkout
with `npm install` done; it drives a running gateway through the loopback
OpenAI-compatible API.

The gateway side stays in core: the OpenAI-compatible endpoint decodes eval
model profiles (`src/evals/eval-profile.ts`), so any external harness can pin
an agent, ablate the system prompt, or pick prompt parts per request.

```bash
npm run eval -- list
npm run eval -- env
npm run eval -- locomo setup
npm run eval -- locomo run --budget 4000 --max-questions 20
npm run eval -- locomo run --mode retrieval --budget 4000 --max-questions 20
npm run eval -- locomo run --mode retrieval --retrieval-query raw --budget 4000 --max-questions 20
npm run eval -- locomo run --mode retrieval --retrieval-backend full-text --budget 4000 --max-questions 20
npm run eval -- locomo run --mode retrieval --retrieval-backend hybrid --budget 4000 --max-questions 20
npm run eval -- locomo run --mode retrieval --retrieval-rerank bm25 --budget 4000 --max-questions 20
npm run eval -- locomo run --mode retrieval --retrieval-tokenizer porter --budget 4000 --max-questions 20
npm run eval -- locomo run --mode retrieval --retrieval-tokenizer trigram --budget 4000 --max-questions 20
npm run eval -- locomo run --mode retrieval --retrieval-embedding transformers --budget 4000 --max-questions 20
npm run eval -- locomo run --mode retrieval --matrix --budget 4000
npm run eval -- locomo run --mode retrieval --matrix backend --budget 4000
npm run eval -- locomo run --mode retrieval --matrix rerank --budget 4000
npm run eval -- locomo run --mode retrieval --matrix tokenizer --budget 4000
npm run eval -- locomo run --mode retrieval --matrix embedding --budget 4000
npm run eval -- trace-judge run
npm run eval -- agent-risk run
npm run eval -- agent-risk run --scenario data-privacy
npm run eval -- trace-judge run --live --model "$HYBRIDCLAW_EVAL_MODEL"
npm run eval -- trace-judge run --criterion risk
npm run eval -- tau2 setup
npm run eval -- tau2 run --domain telecom --num-trials 1 --num-tasks 10
npm run eval -- terminal-bench-2.0 setup
npm run eval -- terminal-bench-2.0 run --num-tasks 10
npm run eval -- hybridai-skills setup
npm run eval -- hybridai-skills list --skill code-review
npm run eval -- hybridai-skills run --dry-run
npm run eval -- hybridai-skills run --max 3
npm run eval -- hybridai-skills run --live --skill apple-music --max 1
npm run eval -- --fresh-agent --omit-prompt=bootstrap inspect eval inspect_evals/gaia --model "$HYBRIDCLAW_EVAL_MODEL" --log-dir ./logs
```

- managed suites today: `locomo`, `trace-judge`, `agent-risk`, `tau2`, `terminal-bench-2.0`, and `hybridai-skills`
- `npm run eval -- harness-evolve <subcommand>` runs the R10a harness-evolution loop against a coworker workspace on disk; it needs no running gateway. See [Harness Evolution](./harness-evolution.md).
- `agent-risk` runs synthetic canary scenarios through the local
  OpenAI-compatible gateway for every top-level NIST AI RMF function, NIST AI
  600-1 GAI risk, and OWASP LLM Top 10 2025 item. It is automated eval
  coverage, not a formal compliance attestation.
- `trace-judge` evaluates the judge against a packaged 150-example labeled dataset of `(trace, criteria, expected verdict)` records across `risk`, `leak`, `brand-voice`, `tool-use`, and `task-completion` criteria. Results include macro precision, recall, and F1 per criterion type plus the overall gate status. The default `run` uses a deterministic offline judge fixture that parses the prepared judge prompt and returns JSON through the same judge result parser used by live mode; `run --live --model <judge-model>` measures the actual configured judge model.
- CI runs `npm run eval:trace-judge:gate` to block prompt-preparation, parser, metric, and dataset regressions without live secrets. PR runs execute `npm run eval:trace-judge:gate:live` when both `HYBRIDAI_API_KEY` and `HYBRIDAI_CHATBOT_ID` are available; otherwise they are explicitly harness-only. Pushes to `main` require both live credentials and fail before promotion when either secret is missing. With those secrets present, CI runs `npm run eval:trace-judge:gate:live` against the configured judge model (`HYBRIDCLAW_TRACE_JUDGE_EVAL_MODEL`, or `hybridai/gpt-4.1-mini` by default) and blocks promotion when judge precision, recall, or F1 regresses below the configured threshold.
- add a new judge criterion by adding examples to `eval-harness/src/trace-judge-eval-dataset.ts` with a stable `criterionType`, clear criteria text, representative traces for `pass`, `partial`, and `fail`, and then running `npm run eval:trace-judge:gate`. Keep each criterion balanced enough that precision, recall, and F1 are meaningful.
- `hybridai-skills` harvests the 🎯 *Try it yourself* prompts from
  `docs/content/guides/skills/*.md` into a fixture set, then grades
  whether each prompt activates its documented skill. `setup` writes the
  fixture JSONL, `list` inspects it, `run --dry-run` validates fixtures
  without calling the model, and `run` (default `--live`, `--max 3`) posts
  each prompt to the local OpenAI endpoint and grades the tool trace with
  the same `resolveObservedSkillName` oracle the gateway uses
- filter `hybridai-skills` runs with `--skill <name>`, `--kind
  try-it|conversation`, and `--max N`; results land at
  `~/.hybridclaw/data/evals/hybridai-skills/latest-run.json` and are also
  shown via `npm run eval -- hybridai-skills results`
- `hybridai-skills run --explicit` rewrites each prompt to start with
  `/<skill>` to force invocation, and live summaries show the observed skill,
  whether artifacts were produced, and counted tool-call totals per fixture
- eval-profiled loopback requests auto-approve tools and return
  execution-session plus artifact-count headers so detached and profiled eval
  runs can finish unattended while still being easy to correlate later;
  pinned-sensitive actions, shell writes outside the workspace, and fetched
  code still stop for approval (see
  [Full-Auto](./approvals.md#full-auto))
- `locomo --mode qa` runs a native HybridClaw QA harness against the official
  LoCoMo conversations, generates answers through the local OpenAI-compatible
  gateway, and scores those answers with LoCoMo-style question metrics
- `locomo --mode retrieval` skips model generation, ingests each conversation
  into an isolated native memory session, and scores evidence hit-rate from
  recalled semantic memories
- `locomo --mode retrieval --matrix` runs the default retrieval sweep across
  backend, rerank, and tokenizer combinations and renders one comparison table
- `locomo --mode retrieval --matrix backend|rerank|tokenizer|embedding` runs a
  single-dimension sweep and keeps the other retrieval settings at their
  defaults
- retrieval-mode knobs are benchmark-only: `--retrieval-query
  raw|no-stopwords`, `--retrieval-backend cosine|full-text|hybrid`,
  `--retrieval-rerank none|bm25` (default: `bm25`),
  `--retrieval-tokenizer unicode61|porter|trigram`, and
  `--retrieval-embedding hashed|transformers`
- `locomo --num-samples` limits conversation records; use `--max-questions`
  for quick smoke tests over a small question slice
- by default, `locomo --mode qa` creates one fresh template-seeded agent
  workspace per conversation sample; use `--current-agent` to reuse the current
  agent workspace
- `swebench-verified`, `agentbench`, and `gaia` currently print starter
  recipes and setup guidance rather than a native managed runner
- outside suite-specific overrides, the default eval mode keeps the current
  agent workspace but opens a fresh OpenAI-compatible session per request
- `--fresh-agent` uses a temporary template-seeded agent workspace for each
  eval request
- detached run logs and summaries are stored under
  `~/.hybridclaw/data/evals/`

## Terminal-Bench resource admission

Terminal-Bench shares the Docker engine with other services. Its native runner
checks host and engine capacity before loading the dataset or building/pulling
task images. Cache the small monitoring image separately before running:

```bash
docker pull busybox:1.37
npm run eval -- terminal-bench-2.0 run --num-tasks 2 --n-concurrent 1
```

The default per-task estimates are 2 GiB RAM, 1 GiB additional swap, 8 GiB disk
for images, build cache, extracted environments and writable layers, and 1 GiB
for retained workspace/verifier artifacts. Adjust these estimates for the tasks:

```bash
npm run eval -- terminal-bench-2.0 run --num-tasks 2 --n-concurrent 1 \
  --task-memory-gib 4 --task-swap-gib 0 \
  --task-disk-gib 12 --artifact-disk-gib 2
```

Admission includes every concurrent task's RAM and swap allowance, another
1 GiB RAM per host agent, and cumulative disk demand across **all** tasks.
Swap also reserves disk space. It keeps at least 2 GiB available RAM on both
the host and engine, and 20 GiB free disk on both. Existing host or engine
swap use above 2 GiB refuses a run. Zero task swap is supported; other budgets
must be positive. Task containers receive the corresponding memory and
memory-plus-swap limits.

The runner measures the install, runtime data, temporary and home filesystems,
plus the OrbStack backing-data filesystem when present on macOS. A cached,
read-only probe measures engine memory, swap and storage. Missing telemetry,
an unavailable engine, or unsupported memory/swap limits refuse admission.
An exclusive lock permits one native benchmark run per engine on this host;
ordinary services continue to run. After an unclean process exit, verify the
PID in the reported lock has exited before removing that lock manually.

Checks run before each task and every five seconds during builds, execution,
copies and verification. Crossing a resource floor or losing engine health
cancels benchmark commands and sessions and removes only the runner's own
containers. It never prunes shared images, volumes or build caches, or restarts
the engine. Metrics are appended to the job's `resources.jsonl` and detached
stdout log. An interrupted run records `infrastructureError` and a null mean
in `result.json`, exits with failure, and is excluded from scored results.

These estimates and polling are orchestration safeguards, not a filesystem
quota: unusually fast disk growth or underestimated build demand can outpace
them. Size budgets from observed tasks and use a dedicated engine for heavy
runs. Resource exhaustion is an infrastructure failure; it does not establish
a core-runtime defect.
