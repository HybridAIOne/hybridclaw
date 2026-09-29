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
These samples all fell below the default 0.8 confidence threshold; this is a
latency check, not a routing-accuracy benchmark. Laya reports entropy-derived
confidence, which is not the selected option probability. Evaluate a realistic
held-out task set before relying on live recommendations. The integration keeps
the existing confidence threshold and configured-route fallback.

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
