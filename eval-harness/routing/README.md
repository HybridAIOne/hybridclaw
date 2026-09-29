# Local routing training and evaluation

This unshipped workspace retains the synthetic datasets and tools needed to
refresh Laya training, calibrate confidence and compare routing with JEV/Gemma.
Generated predictions, feature caches, summaries and reports are ignored by Git.
Earlier experimental outputs remain available in commit `56aec1229`.

The current pipeline is documented in [tuning](tuning/README.md). It keeps the
three [checkpoint pins](tuning/checkpoints.json), four development/calibration
datasets, the latest regression set and the frozen candidate required to
regenerate the production plugin artifact. No real session text is included.

## Compare the production routers

Requires an existing HybridClaw provider configuration and an installed local
Laya model. This starts a separate classifier child process and stops it on exit;
it does not restart the gateway, change settings or execute benchmark tasks.

```sh
node --import tsx eval-harness/routing/run.mjs \
  --dataset eval-harness/routing/tuning/test.json \
  --output eval-harness/routing/results/comparison
python3 eval-harness/routing/report.py eval-harness/routing/results/comparison
```

Add `--smoke` for four cases. The dataset must have 200 unique prompts, balanced
across four tiers and English/German. The provider configuration must permit
cloud comparisons and use those tier names. Only public synthetic prompts are
submitted; no history or attachments are included. The configured confidence
gate and timeout stay in force, with no retries.

For explicit temporary-model pipe verification, use
`prompting/production.mjs --python /path/to/python --model /path/to/checkpoint
--dataset /path/to/dataset.json --output /path/to/results/production.jsonl`.
It verifies three/four-tier decisions and writes worker/artifact/input hashes.
Its temporary model home is removed on exit.

[JevBench](../jevbench/README.md) remains available for canonical typed decisions,
using the pinned upstream public subset. Its protocol differs from tier routing.
