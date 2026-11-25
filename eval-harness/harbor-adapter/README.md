# Harbor adapter

Runs HybridClaw as the agent in [Harbor](https://github.com/harbor-framework/harbor)
task sandboxes, and registers it as the `hybridclaw` harness in
[OpenEnv](https://github.com/openenv/OpenEnv). OpenEnv's capture proxy records
the token IDs and log probabilities of every model call, which is what TRL's
[`async_grpo_harbor`](https://github.com/huggingface/trl/tree/main/examples/async_grpo_harbor)
example trains a harness-specific LoRA adapter on.

The adapter is unshipped tooling. It was written against Harbor 0.25.0 and
OpenEnv 0.7.0.

## How it works

- `build-runtime.sh` packs this checkout, installs it beside its own Node in a
  Linux amd64 image, and archives `/opt/hybridclaw-node` and
  `/opt/hybridclaw-install`. A manifest beside the archive records the
  HybridClaw version, Git commit and archive digest.
- `hybridclaw_harbor.py` is the Harbor agent. It uploads the archive and
  `task-runner.mjs` into the sandbox, checks that the gateway starts, then runs
  one turn with the task instruction.
- `task-runner.mjs` starts the gateway with a host-mode worker in the task's
  working directory. It configures one vLLM endpoint from the adapter's
  `intercept_config`, auto-approves tools and turns thinking off.
  In a task sandbox with cgroup v2 memory counters, a new out-of-memory kill
  interrupts an active shell call and reports the memory failure to the agent.
  The unattended trial denies operations that need a human and lets the agent
  continue with permitted alternatives, up to three times per turn.
- Running `hybridclaw_harbor.py` as a script registers the seam and then hands
  over to the stock `openenv` CLI.

A trained adapter is tied to the prompt and tool set of the HybridClaw version
in the manifest. Local models get the starter tool set plus `tool_catalog`.

## Setup

Use Python 3.12, Node from `.nvmrc`, and Docker.

```sh
uv venv --python 3.12 /tmp/hybridclaw-harbor-venv
uv pip install --python /tmp/hybridclaw-harbor-venv/bin/python 'openenv[harbor]==0.7.0'
npm ci && npm run setup
eval-harness/harbor-adapter/build-runtime.sh /tmp/hybridclaw-harbor-runtime
export HYBRIDCLAW_HARBOR_RUNTIME=/tmp/hybridclaw-harbor-runtime/hybridclaw-runtime.tgz
```

The process that runs Harbor trials reads these variables:

| Variable | Purpose |
|---|---|
| `HYBRIDCLAW_HARBOR_RUNTIME` | Path to the runtime archive. Required. |
| `HYBRIDCLAW_HARBOR_CONTEXT_WINDOW` | Context window of the served model, in tokens. HybridClaw assumes 128,000 when it is unset. |
| `HYBRIDCLAW_HARBOR_PROXY_HOST` | Host name or address under which a sandbox reaches this machine. `--expose direct` advertises it instead of `127.0.0.1`; local Docker sandboxes need it. |
| `HYBRIDCLAW_HARBOR_SYSTEM_WRITES` | Set to `1` for system administration tasks in an unprivileged Docker sandbox with no extra mounts. This turns off the workspace fence for that trial. Sensitive paths and other approval and safety rules still apply. |

## One rollout

```sh
/tmp/hybridclaw-harbor-venv/bin/python eval-harness/harbor-adapter/hybridclaw_harbor.py \
  harbor rollout --llm-url http://<vllm-host>:8000 --model <served-model-id> \
  --dataset <harbor-task-dataset> --harness hybridclaw --sandbox docker \
  --expose direct --out /tmp/hybridclaw-harbor-rollout.json
```

The trial's agent log folder holds `install.log`, `hybridclaw.log`,
`hybridclaw-result.json`, `progress.jsonl` and the audit trail (`live-audit/`).

## Training

Follow the TRL example with `--harness hybridclaw`, starting the OpenEnv server
through the adapter so the seam is registered:

```sh
MAX_CONCURRENT_ENVS=9 /tmp/hybridclaw-harbor-venv/bin/python \
  eval-harness/harbor-adapter/hybridclaw_harbor.py \
  harbor serve --dataset <hf-dataset> --port 8200 --capture-port 8300
```

Training capture needs a vLLM started with `--return-tokens-as-token-ids` and
`--logprobs-mode processed_logprobs`, and the trainer and vLLM on separate GPUs
of one host. The trainer loads the unquantised base model.

## Limits

- No ATIF trajectory is written, so OpenEnv has no second record to check its
  capture against. A side call to the model is kept out of training only when
  OpenEnv's conversation graph discards it as a branch that led nowhere. The
  session-title call is switched off; context compression is not.
- HybridClaw has no step limit the seam can set. OpenEnv's proxy enforces the
  model-call budget, and Harbor's agent timeout ends the run.
- Thinking is always off.

## Checks

```sh
/tmp/hybridclaw-harbor-venv/bin/python -m unittest discover \
  -s eval-harness/harbor-adapter -v
```

The tests use the real Harbor and OpenEnv classes with a recording fake
sandbox. They make no model calls.
