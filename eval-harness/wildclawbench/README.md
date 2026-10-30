# HybridClaw on WildClawBench

This unshipped adapter registers `bash script/run.sh hybridclaw ...` in
[WildClawBench](https://github.com/InternLM/WildClawBench). It uses the upstream
batch runner, shared prompt, timeouts, task warmups, task-provided skills, and
post-execution grading. It adds no benchmark-specific prompts or skills.

A built image or an offline contract check is not a successful benchmark smoke
test. Keep measurements and raw evidence outside this source tree.

## Provenance

[manifest.json](manifest.json) records the exact source commits, dataset
revision, base-image identity, archive checksum, output image tag, and model
names. The original baseline is **v0.41.5**. Builds require a clean descendant
checkout and label the image with its actual source commit; results record both
that revision and the original baseline. Patched runs must be labeled as such.
Images use the Node 22 minimum in `package.json` and npm 11.10.0. This adapter does
not use the operator's installed binary or running gateway.

The benchmark is pinned to its original **2026-05-12 v2 snapshot**, where the
exact four-model table in the brief first appeared. Current `main` retains
that table but includes substantial later grader fixes, so using its graders
would change the comparison. The authors' linked original `overall_results.json`
has run-directory names encoding `openrouter/openai/gpt-5.4` and
`openrouter/minimax/minimax-m2.7`. Original GLM 5 and MiMo V2 Pro run configs/logs
are not included in the source checkout or current trajectory dataset index.
Consequently, catalogue validation alone does not establish those original slugs.
`xiaomi/mimo-v2-pro` was absent from the live catalogue on 2026-10-30; do not
substitute MiMo V2.5 Pro and label it as the original model.

## Setup

Keep the benchmark clone, task data, private `.env`, logs, and transcripts
outside the HybridClaw source checkout. Set these paths to your own directories:

```bash
HYBRIDCLAW_SRC=/path/to/clean/hybridclaw
BENCH=/path/outside/both/repos/WildClawBench
git clone https://github.com/InternLM/WildClawBench.git "$BENCH"
PIN=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["wildclawbench_commit"])' \
  "$HYBRIDCLAW_SRC/eval-harness/wildclawbench/manifest.json")
git -C "$BENCH" checkout "$PIN"
bash "$HYBRIDCLAW_SRC/eval-harness/wildclawbench/install.sh" "$BENCH"
```

Create a Python environment for the benchmark and install upstream requirements
and `huggingface_hub`. Its preparation script also needs `ffmpeg`, a current
`yt-dlp`, `gdown`, and `modelscope`. macOS's Python 3.9 installs an older
yt-dlp; use a supported newer Python for the downloader.

Check **host and Docker disk space** first. The published Ubuntu v1.3 archive is
12.55 GiB, and import temporarily needs space for both archive storage and
extracted layers. Download only this base, not all four harness images:

```bash
df -h "$BENCH"
docker system df
set -o pipefail
curl --fail --location \
  'https://huggingface.co/datasets/internlm/WildClawBench/resolve/main/Images/wildclawbench-ubuntu_v1.3.tar?download=true' \
  | docker load
bash "$HYBRIDCLAW_SRC/eval-harness/wildclawbench/build.sh"
```

The build helper selects the imported image's platform. The published image is
amd64; an ARM machine runs it under emulation. The Dockerfile clears the
published image's inherited build-machine proxy and installs Node from its
official archive after checking the official SHA-256 list. Docker credentials,
host API keys, and task data are not build inputs. The root `.dockerignore` is
unchanged, and explicit `COPY` statements exclude `.env` files.

Download `workspace/**` from the dataset at `dataset_commit` in the manifest,
then run the unchanged preparation script:

```bash
cd "$BENCH"
# With the dataset revision from manifest.json:
DATASET_REVISION=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["dataset_commit"])' \
  "$HYBRIDCLAW_SRC/eval-harness/wildclawbench/manifest.json")
hf download internlm/WildClawBench --repo-type dataset --revision "$DATASET_REVISION" \
  --include 'workspace/**' --local-dir .
bash script/prepare.sh
```

Monitor free space while preparing videos and the two SAM3 weight copies. Stop
if there is insufficient space; do not change video quality or omit tasks to
make a nominal 60-task result. The preparation attempt in this session uses a
5 GiB minimum free-space reserve, an operational choice rather than a benchmark
timeout change.

Create a private mode-0600 `.env` in the benchmark clone containing only the
required `OPENROUTER_API_KEY`, `BRAVE_API_KEY`, and
`JUDGE_MODEL=openai/gpt-5.4`. The adapter also passes the upstream normalized
OpenRouter base URL to the host environment, because task graders inject their
Env variables from there, overriding container defaults even with empty values.
Load values from a local credentials file without
echoing them or passing them as command-line values. An isolated OpenRouter
key with a provider-enforced limit helps enforce the authorized budget.
Track this run's spend independently, including agent calls, auxiliary/direct
API calls, and judges; an account-wide key limit is not this run's budget.
Check both `/api/v1/key` and `/api/v1/credits`: an unused key limit does not
mean its parent account has funded credit.

## Smoke and full runs

The planned smoke set uses three categories on GLM 5. Run each once, inspect
`agent.log`, `chat.jsonl`, `score.json`, `usage.json`, `execution.json`, and
`openrouter-generations.json`, and check that billing is complete. Each task
also records the actual container image ID, source commits, timeout, model,
judge, and shared-prompt hash in `provenance.json`:

```bash
cd "$BENCH"
python "$HYBRIDCLAW_SRC/eval-harness/wildclawbench/preflight.py" \
  --credentials .env --model openrouter/z-ai/glm-5
bash script/run.sh hybridclaw --model openrouter/z-ai/glm-5 \
  --task tasks/01_Productivity_Flow/01_Productivity_Flow_task_3_bibtex.md
bash script/run.sh hybridclaw --model openrouter/z-ai/glm-5 \
  --task tasks/04_Search_Retrieval/04_Search_Retrieval_task_10_tomllib_trace.md
bash script/run.sh hybridclaw --model openrouter/z-ai/glm-5 \
  --task tasks/06_Safety_Alignment/06_Safety_Alignment_task_1_file_overwrite.md
```

Do not proceed until all three execute, grade, and produce plausible usage.
An incorrect task answer is a valid measurement; a broken launcher, missing
transcript, grader failure, or unavailable billing is not a passed smoke test.

After a passing smoke test and complete data preparation, run GLM 5 and MiniMax
M2.7 once each, with two parallel containers:

```bash
bash script/run.sh hybridclaw --category all --parallel 2 --model openrouter/z-ai/glm-5
python "$HYBRIDCLAW_SRC/eval-harness/wildclawbench/preflight.py" \
  --credentials .env --model openrouter/minimax/minimax-m2.7
bash script/run.sh hybridclaw --category all --parallel 2 --model openrouter/minimax/minimax-m2.7
```

The initial authorization is at most $60 for these models, including smoke
tests and grading. Check key usage throughout. Ask before spending beyond that
authorization or starting the later GPT-5.4 and MiMo runs. Model IDs for all
four targets are recorded in the manifest. Do not retry agent failures to
improve scores; record every infrastructure retry separately.

Outputs use the upstream directory layout under `output/hybridclaw/`. Smoke
outputs and full-run outputs have separate timestamp/UUID directories. The
upstream global summary contains only the corresponding `--category all` run.

## Runtime configuration and evidence

- One fresh runtime directory, home directory, default agent, and gateway per
  task. The agent workspace holds bootstrap, policy and replay state separately
  from the execution directory `/tmp_workspace` inside the task container. The host gateway, global binary, and personal workspaces are unused.
- Host execution inside the benchmark container; no nested Docker sandbox,
  host Docker socket, extra host mounts, or port publication.
- Explicit `__hc_eval=current-agent` enables existing eval auto-approval. The
  new runtime already provides freshness. Default personality files, tools,
  and bundled skills remain enabled. One-time conversational
  onboarding is disabled with `agents.list[].onboarding=false`, since an
  unattended task cannot answer an identity questionnaire. The selected model
  is also the agent default. Pinned-sensitive approval rules remain enforced.
  Task-supplied skills use native `skills.extraDirs` discovery.
- The operator-only `HYBRIDCLAW_EVAL_WORKSPACE_ROOT` selects the task directory
  for explicit eval requests. A worker preload verifies that execution resolves
  to `/tmp_workspace`; the workspace fence stays enabled and mismatches fail
  closed. Managed state stays agent-local throughout execution. Model-authored
  files remain in task output and are never filtered or removed for grading.
  Task prompts and graders are unchanged.
- Heartbeat and external observability are disabled to avoid unrelated work
  and telemetry. Brave is the search provider. Model-response debug logging is
  enabled solely for generation IDs and billing evidence. The gateway's worker
  timeout equals the unchanged task timeout; the outer deadline also covers
  task-local gateway startup.
- SIGTERM shuts down the task-local gateway/process group before grading.
  Native SQLite `tool_history_json` is converted into the same OpenClaw-shaped
  message/tool-result format as Hermes. Full tool arguments and results remain
  paired. A final assistant-only transcript is not an acceptable replacement.
  The export uses upstream's standard transcript path, including for graders
  that read that path directly. A pre-run workspace snapshot and the upstream
  changed-file collector retain artifacts written outside `results/`.
- Usage comes from OpenRouter's authenticated generation endpoint for unique
  generation IDs in runtime response logs. A separate preload records only
  ID/model fields from non-streaming helper responses, preserving requests and
  response contents. Metadata-only GET retries accommodate billing lag; agent
  calls are not retried for this. Missing billing is marked unknown,
  never presented as a free successful task. Runtime credential/key files stay
  outside the copied data subtree. All raw evidence remains outside this repo.
- Per-task usage covers observed runtime model generations. Direct model calls
  made by task-written programs need separate reconciliation. Judge spend is
  also tracked with the key's usage delta; upstream per-task agent usage does
  not include judging. Do not describe unexplained spend as complete accounting.

## Export and validation

```bash
python3 -m unittest discover -s "$HYBRIDCLAW_SRC/eval-harness/wildclawbench" -p 'test_*.py'
docker run --rm --network none -e OPENROUTER_API_KEY=test-key -e BRAVE_API_KEY=test-key \
  -v "$HYBRIDCLAW_SRC/eval-harness/wildclawbench/check-launcher.py:/opt/wildclawbench/check-launcher.py:ro" \
  -v "$HYBRIDCLAW_SRC/eval-harness/wildclawbench/check-provider.mjs:/opt/wildclawbench/check-provider.mjs:ro" \
  wildclawbench-hybridclaw:v0.2 python3 /opt/wildclawbench/check-launcher.py
python3 "$HYBRIDCLAW_SRC/eval-harness/wildclawbench/export.py" "$BENCH" \
  --run-date YYYY-MM-DD --output "$HYBRIDCLAW_SRC/eval-harness/wildclawbench/results.json"
```

The exporter requires the pinned 60 distinct task identities and complete
billing, checks the score against the upstream global average, uses all 60
tasks in denominators, and retains infrastructure failures. Per-category
scores are percentages. No synthetic or partial 60-task rows are produced.
`failed_infra` counts execution errors, grader errors, and missing numeric
scores; a normal task deadline alone is not classified as infrastructure.
The image check runs a real gateway, worker and write tool with a fixture model
and networking disabled. It verifies agent-state isolation, the task artifact,
headless setup, shutdown, generation recording and workspace validation. Its
provider fixture is mounted only for this check and never copied into the task
image. This is an integration fixture, not a benchmark measurement.

The image removes its inherited OpenClaw workspace at build time, before task
data is copied in. It never cleans or filters model-created files before grading.
Record a patched source revision for new runs; preserve earlier evidence as the
original baseline.
