# Local routing alternatives

Compare jeff/GLiFormer, GLiClass Multilang Mini and Horizon multilingual zeroshot small against the best previously observed Laya choice variants. [Results](results/report.md), [frozen protocol](PROTOCOL.md), [fresh authored holdout](holdout.json).

This is an unshipped evaluation workspace. It does not install a plugin, start a server, change routing configuration or restart the gateway. The existing 200-prompt dataset is development-only. The new 120-prompt holdout has no exact overlap; both sets use authored rubric labels, not downstream model performance labels.

## Reproduce

Use Python 3.12 and an isolated environment, not the installed Laya environment. `requirements-recorded.txt` records the exact new-model environment used. Laya uses the existing separate environment with `laya-mlx==0.2.0`.

```sh
uv venv --python 3.12 /tmp/router-eval-venv
uv pip install --python /tmp/router-eval-venv/bin/python -r eval-harness/routing/alternatives/requirements-recorded.txt
git clone https://github.com/logan-markewich/jeff /tmp/hybridclaw-jeff-eval
git -C /tmp/hybridclaw-jeff-eval checkout 34b32f99a727c47b679adde33f4702a001e02979
```

Download each repository at the pinned revision in its `results/*-dev.metadata.json` file. Verify weight SHA-256 against the recorded hashes before loading. jeff needs `pytorch_model.bin`, `gliner_config.json` and tokenizer files; the other two models use safetensors and their configuration/tokenizer files. Do not download optional ONNX exports for this PyTorch comparison. Write the corresponding metadata `model` object into a temporary provenance JSON file.

```sh
HF_HOME=/tmp/router-eval-hf /tmp/router-eval-venv/bin/python \
  eval-harness/routing/alternatives/run.py \
  --engine horizon --phase dev --device mps \
  --model /path/to/pinned-checkpoint --provenance /tmp/horizon-provenance.json \
  --output /tmp/router-eval-results
```

Repeat with `--engine jeff` and `--engine gliclass`; jeff accepts `--jeff-source` if its clone is elsewhere. `--phase smoke` runs four development examples. Development writes all six variants and the selected configuration. After all selections are frozen, repeat with `--phase test` for the holdout. CPU use must be explicit via `--device cpu` and documented as a different runtime. Existing output files are never overwritten.

For Laya use the Laya Python environment, `--phase test`, and `--engine laya-english`, `laya-typed-decisions` or `laya-multilingual`. Their fixed best-choice selections are defined in the protocol and runner; checkpoint provenance comes from the earlier Laya ablation metadata.

The fixed remote references use the existing provider configuration/credential store and only send synthetic holdout prompts:

```sh
node --import tsx eval-harness/routing/alternatives/remote.mjs
python3 eval-harness/routing/alternatives/report.py
```

These two commands target the checked-in `results/` directory and refuse to overwrite remote evidence. Use a fresh checkout/output location for replication. Per-call records include IDs, predictions, distributions, failures and timing; model inputs are reconstructed from the recorded variant, criteria and dataset. No actual session text or credentials are included.

## Sources

- [jeff](https://github.com/logan-markewich/jeff): upstream engine and default temperature; MIT code.
- [GLiFormer weights](https://huggingface.co/knowledgator/gliformer-large-v1).
- [GLiClass Mini](https://huggingface.co/knowledgator/gliclass-multilang-mini): single-label classification with task prompts and described labels.
- [Horizon small](https://huggingface.co/Horizon-Labs/multilingual-zeroshot-small): exclusive NLI scoring across candidate labels.

No inference result here establishes a calibrated 80% correctness probability, production latency guarantee, or reliable processing of attachments/history. No winner is automatically promoted.
