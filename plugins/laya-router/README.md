# Laya local routing

Optional Apple silicon decision model alongside the existing local chat model.
It selects from the configured routing tiers; it cannot chat, execute tools or
choose arbitrary model IDs. Python/MLX stays in this plugin's isolated environment.

From a source checkout:

```bash
hybridclaw plugin install ./plugins/laya-router
```

Enable/reload the plugin in Extensions → Plugins (or `/plugin reload`). In
**Labs → Local Models**, choose **Download & set up decision model**. Install
[uv](https://docs.astral.sh/uv/getting-started/installation/) first. Setup uses a
frozen Python 3.12 environment, downloads a pinned multilingual checkpoint,
checks its weight hash and loads it before marking the installation ready.
The plugin is optional source, not included in the default npm package.

Select **Laya · Multilingual 322M** under **Models → Routing**, either as the live
router or comparison router. **Labs → Routing Evaluator** can compare it with
JEV on an explicitly approved public sample. JEV still requires its API key and
cloud disclosure permission. The Laya process runs independently of the local
chat model, and must be started again after gateway restart. Stop it in Labs to
free memory. Cancellation or a decision timeout stops its process; restart it
before retrying. No automatic cloud fallback is made.

## Mac runtime choice

[Laya MLX](https://github.com/mizorewww/laya-mlx) provides preconverted weights
and native Apple GPU inference. The selected 322M multilingual checkpoint
supports German and English with a 1,024-token total budget. Core ML's fastest
[ANE variant](https://github.com/mizorewww/laya-coreml) has a 96-token total
budget, too small for our shared tier question. Ollama's text-generation API
is not needed for this typed-decision model.

An initial Mac smoke test on 2026-09-29 measured 7.6–8.1 ms warm inference on
three short English/German prompts, excluding model load and gateway overhead.
This is a latency check, not a routing-accuracy benchmark.

The adapter exposes the selected option's probability as routing confidence,
matching upstream's `answer_confidence` gating semantics. It does not use
`laya-mlx`'s entropy confidence. The 0.8 threshold is unchanged; uncertain choices
still preserve the configured route. These probabilities are not calibrated
accuracy guarantees. See [upstream confidence gating](https://github.com/NandhaKishorM/laya#automated-confidence-gating).

## Boundaries and failure behavior

- Only explicit setup has network access for package/model downloads. Serving
  loads the pinned local model with Hugging Face offline mode.
- The gateway owns this process. Disposable conversation workers hold no state.
- Administrative setup/start/stop requires authenticated loopback access. No
  HTTP inference port is opened; predictions use a private child-process pipe.
- Existing disclosure guards remain in force, including private context,
  sensitive text, unapproved playground samples and input size limits.
- Unknown tiers, invalid probability distributions, model errors, oversized
  token contexts and low confidence preserve the configured route. Input is
  never silently truncated. Concurrent predictions fail busy instead of queuing
  indefinitely. Process output and errors are not persisted or exposed verbatim.
- A local decision model does not weaken execution-model privacy constraints.
- Requires Apple silicon, a supported MLX/macOS environment and Python 3.12.
  Leave memory headroom for both models; this plugin does not reserve GPU memory.

## Verification

```bash
npx vitest run tests/laya-router-plugin.test.ts tests/local-classifier-routing.test.ts tests/local-classifier-admin.test.ts
python3 -m unittest discover -s plugins/laya-router/runtime -p 'test_*.py'
```

Upstream model/runtime: Apache-2.0. Runtime dependencies are frozen in
`runtime/uv.lock`; see `THIRD_PARTY_NOTICES.md`.

### Routing tier descriptions

Laya and JEV receive the same capability descriptions, assigned by configured
order rather than tier name. Four tiers separate simple facts and arithmetic,
routine writing/translation/summarization, programming/debugging/multi-step
analysis, and specialist reasoning/proofs/system design. Three tiers combine the
two middle groups. Custom tier names retain this ordering.

Typed classifiers receive the short question “How difficult is this task?”
and concise descriptions without tier-number prefixes. Chat classifiers retain
the explicit instruction-handling policy. Only the current eligible user text
is state; conversation history and attachments are not disclosed to classifiers.

### Repeatable routing evaluation

A small English/German evaluation on 2026-09-29 used 16 development examples to
compare prompts, then 16 fresh validation examples without further tuning:

| Prompt | Development correct | Validation correct | Validation accepted at 0.8 | Correct among accepted |
| --- | --- | --- | --- | --- |
| Previous verbose prompt | 7/16 | 11/16 | 2/16 | 1/2 |
| Short typed question | 12/16 | 14/16 | 9/16 | 9/9 |

Both rows use selected-option probability for a fair comparison. The production
worker was exercised with the installed FP16 multilingual model. The revised
prompt selected basic for `Calculate 1+1` (96.77%) and `Calculate 2+4` (92.72%).
This small, authored set is a regression check, not evidence of production
accuracy or calibration. The committed validation set is no longer held out
for future prompt changes. Do not tune temperatures or lower the gate to improve
coverage on this set.

To repeat after setup, from the checkout root, export the actual shared question:

```bash
node --import tsx --input-type=module -e '
import { routingTierCriteria, TIER_CLASSIFICATION_QUESTION } from "./src/routing/policy.ts";
console.log(JSON.stringify({ tier: {
  type: "choice", instructions: TIER_CLASSIFICATION_QUESTION,
  criteria: routingTierCriteria(["basic", "economy", "general", "advanced"].map(name => ({ name })))
} }));' > /tmp/laya-routing-questions.json
HF_HUB_OFFLINE=1 ~/.hybridclaw/laya/venv/bin/python plugins/laya-router/runtime/evaluate.py \
  --model ~/.hybridclaw/laya/model --questions /tmp/laya-routing-questions.json
```

This runs a separate temporary inference process; it does not change the live
router or its settings.
