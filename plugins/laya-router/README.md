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
the frozen Python 3.12 environment, downloads the pinned typed-decisions
checkpoint, verifies its weight hash and loads it before marking setup complete.
Select **Laya · Typed decisions 421M** under **Models → Routing** as the live or
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

A frozen affine calibration adjusts the four class scores, addressing systematic
label bias. A separately fitted monotone map estimates correctness of the chosen
tier. The displayed confidence is this estimate; the displayed class distribution
is the normalized adjusted distribution. Neither is an accuracy guarantee. Laya
classifies in a forward pass and generates zero output tokens. The configured
0.8 acceptance gate remains in force.

The generated [calibration artifact](runtime/routing-calibration.json) pins the
checkpoint, wording and coefficients. It is reproduced by the unshipped
[evaluation exporter](../../eval-harness/routing/prompting/export.py), rather than
maintained by hand. Training uses 200 development prompts for class calibration
and 120 old calibration prompts for correctness confidence. Neural model weights
are unchanged.

## Evaluation

The frozen candidate was compared with JEV on 200 fresh English/German rubric
prompts, then exercised through the actual plugin pipe and gateway:

| Router | Overall label accuracy | Accepted precision | Coverage | Median gateway time |
| --- | --- | --- | --- | --- |
| Laya | 87.0% | 94.9% (131/138) | 69.0% | 15 ms |
| JEV | 96.5% | 100% (170/170) | 85.0% | 242 ms |

Accepted precision, macro class precision and overall accuracy were within 10%
of JEV on this dataset. The same disclosure guards exclude two prompts for both
routers. Three-tier grouping is a separate regression check. These are small,
same-author synthetic rubric cases with correlated bilingual scenarios; they do
not establish quality on real traffic or downstream answers. Economy remains
the weakest class. See the [full report](../../eval-harness/routing/prompting/results/report.md)
for per-class metrics, coverage, model selection and limitations.

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
