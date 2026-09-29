# JevBench public evaluation

Unshipped evaluation of JEV, Gemma 4 E4B, and the three Laya MLX checkpoints against [JevBench](https://github.com/fstandhartinger/jevbench). [Results](results/2026-09-29/report.md) complement the [routing-specific experiments](../routing/README.md).

Uses upstream task validation, adapters, serial runner, probability scoring and allowlisted aggregate exporter. The local adapter changes only model loading from PyTorch to MLX and adds context diagnostics. Canonical state and typed questions are unchanged. Gemma uses upstream strict JSON-schema prompting to verbalize probabilities; it is a different protocol from the label-only routing evaluation.

## Run

Requires an existing HybridClaw provider configuration, stored JEV credential, Node with `tsx`, and a Python environment containing `laya-mlx==0.2.0`. No package installation or gateway restart is performed by these scripts.

```sh
git clone https://github.com/fstandhartinger/jevbench /tmp/jevbench
git -C /tmp/jevbench checkout bb05a335bc809e61b20c0f745d25499a82b326fc

node --import tsx eval-harness/jevbench/run-remote.mjs /path/to/venv/bin/python \
  --source /tmp/jevbench --engine jev \
  --private-dir /tmp/jevbench-evidence --output /tmp/jevbench-summary
```

Repeat with `--engine gemma`. Credentials pass directly to the child environment. Gemma resolves the configured `haigpu2/google/gemma-4-e4b-it` endpoint; for a configured endpoint without authentication, a nonsecret placeholder satisfies upstream's required API-key argument. Endpoint URLs and keys are not exported.

```sh
/path/to/venv/bin/python eval-harness/jevbench/run.py \
  --source /tmp/jevbench --engine laya-english \
  --model-dir /path/to/english-checkpoint \
  --checkpoint aac6fef/laya-mlx@20aed815fc6acde75733882e7ec0e3f28aeb9717 \
  --private-dir /tmp/jevbench-evidence --output /tmp/jevbench-summary
```

Repeat for `laya-multilingual` and `laya-typed-decisions`, using the checkpoint revisions and weight hashes in the committed metadata. Run local models sequentially with Metal available. Add `--smoke` to run four cases before the full run; smoke evidence has separate names. Use a fresh evidence/output directory for a repeat: upstream refuses to overwrite raw results.

```sh
python3 eval-harness/jevbench/report.py /tmp/jevbench-summary
cd /tmp/jevbench
python3 -m unittest tests.test_protocol
```

The shared ledger caps reservations at $10, reserving $0.02 per remote request and zero for local inference. Unknown remote cost retains the reservation; it is not measured spending. There are no retries. Authentication/rate-limit responses or three consecutive infrastructure errors stop a run and produce an incomplete summary with exit code 2.

Only aggregates and reproducibility metadata belong in this checkout. Raw responses, prompts and per-item decisions must remain outside it. The 231 public cases are not the complete official leaderboard benchmark. No actual session histories are sent to providers.
