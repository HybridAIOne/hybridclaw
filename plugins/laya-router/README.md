# Laya local routing

Optional Apple silicon decision model alongside the local chat model. It selects
from three or four configured routing tiers and runs in this plugin's isolated
Python/MLX environment.

```bash
hybridclaw plugin install ./plugins/laya-router
```

Enable/reload the plugin in Extensions → Plugins (or `/plugin reload`). Install
[uv](https://docs.astral.sh/uv/getting-started/installation/), then choose
**Download & set up decision model** in **Labs → Local Models**. Setup installs
the frozen Python 3.12 environment, downloads the pinned multilingual
checkpoint, verifies its weights/config/tokenizer hashes and loads it before marking setup complete.
Select **Laya · Multilingual 322M · Routing head** under **Models → Routing** as the live or
comparison router. An installation containing an earlier experimental checkpoint
needs setup again before loading this source version.

The plugin is source-only and optional. Its resident process runs independently
of the chat model; start it again after a gateway restart. Stop it in Labs to free
memory. Cancellation and inference timeouts terminate the process. The live
configuration and gateway are not changed by installing this source update.

## Decision contract

The selected [Laya MLX](https://github.com/mizorewww/laya-mlx) checkpoint has a
1,024-token total budget. Core ML's fastest ANE path has a 96-token budget, which
is too short for this routing rubric.

The state is JSON containing the current eligible user task. The choice question
asks which activity category describes it, with four distinct capability bands:
simple facts/calculations, routine language/planning, practical technical work,
and specialist proofs/research/architecture. Three-tier configurations combine
the two middle bands by summing their probabilities. Custom tier names map by
configured order. The plugin rejects unsupported tier counts or changed shared
capability rubrics instead of applying a fit to a different task.

A trained linear routing head reads the mean encoder features of the task state,
rather than the original decision head's four scores. Separate temperature
calibration supplies the class probabilities and selected-class confidence.
This is a specialized routing classifier using Laya's frozen encoder, not the
checkpoint's zero-shot predictions or entropy-derived confidence. Neither
probabilities nor confidence are accuracy guarantees. It classifies in a forward
pass and generates zero output tokens. The configured 0.8 acceptance gate remains
in force.

The generated [calibration artifact](runtime/routing-calibration.json) pins the
checkpoint, wording and coefficients. It is reproduced by the unshipped
[evaluation exporter](../../eval-harness/routing/tuning/export.py), rather than
maintained by hand. The 3,076-parameter head is fitted on 520 synthetic development
prompts; one temperature is fitted on 120 separate calibration prompts. The
original encoder weights are unchanged. All three checkpoints and 36 fixed
representation/regularization combinations were compared before fresh testing.

## Training and evaluation

The unshipped [training workflow](../../eval-harness/routing/tuning/README.md)
retains datasets, checkpoint pins, feature extraction, fitting, calibration and
artifact export. [Comparison runners](../../eval-harness/routing/README.md)
exercise the actual plugin pipe and JEV/Gemma under the shared routing gates.
Generated reports, caches and prediction logs stay outside version control.
Retained test cases are regression inputs; new fits need a fresh labelled test
before claiming improved accuracy. Synthetic rubric labels do not establish
quality on all real traffic or downstream answers.

## Boundaries and verification

Only explicit setup downloads packages or model files. Serving uses offline
weights and a private child pipe. Existing administrative authentication,
loopback restrictions, disclosure guards, response validation and execution-model
privacy constraints remain in force. History and attachments are not classifier
input. Invalid distributions, unavailable processes, unknown tiers, changed
rubrics, oversized contexts and low confidence preserve the configured route.
Inputs are never silently truncated; concurrent requests fail busy.

```bash
npx vitest run tests/laya-router-plugin.test.ts tests/local-classifier-routing.test.ts tests/local-classifier-admin.test.ts
python3 -m unittest discover -s plugins/laya-router/runtime -p 'test_*.py'
```

Requires Apple silicon, a supported MLX/macOS environment and enough memory for
both local models. Runtime/model licenses are Apache-2.0; dependencies are frozen
in `runtime/uv.lock`. See `THIRD_PARTY_NOTICES.md`.
