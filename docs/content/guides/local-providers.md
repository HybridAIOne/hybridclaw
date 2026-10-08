---
title: Local Providers
description: Configure HybridClaw for LM Studio, llama.cpp, Ollama, or vLLM and run the gateway in host mode.
sidebar_position: 2
---

# Local Providers

For managed Apple-silicon inference, use [Mac Local Model Setup](./mac-local-models.md).
The authenticated MLX service supports Docker through a local IPC relay.

If LM Studio is serving `qwen/qwen3.5-9b` on `http://127.0.0.1:1234`, the
quickstart looks like this:

```bash
hybridclaw auth login local lmstudio qwen/qwen3.5-9b --base-url http://127.0.0.1:1234
hybridclaw gateway restart --foreground --sandbox=host
hybridclaw gateway status
hybridclaw tui
```

Inside the TUI:

```text
/model list
/model set lmstudio/qwen/qwen3.5-9b
/model info
```

## Other Backends

```bash
hybridclaw auth login local ollama llama3.2
hybridclaw auth login local llamacpp Meta-Llama-3-8B-Instruct --base-url http://127.0.0.1:8081
hybridclaw auth login local vllm mistralai/Mistral-7B-Instruct-v0.3 --base-url http://127.0.0.1:8000 --api-key secret
```

## Multiple vLLM Endpoints

Use `--name` to configure additional endpoints of the same backend type. The
endpoint name becomes the model prefix:

```bash
hybridclaw auth login local vllm Qwen/Qwen3.6-27B-FP8 --name haigpu1 --base-url http://haigpu1:8000 --api-key qwen-secret --thinking-format qwen
hybridclaw auth login local vllm mistralai/Mistral-7B-Instruct-v0.3 --name haigpu2 --base-url http://haigpu2:8000 --api-key mistral-secret --no-default
```

Then select or route models by endpoint name:

```text
/model set haigpu1/Qwen/Qwen3.6-27B-FP8
/config set auxiliaryModels.compression.provider vllm
/config set auxiliaryModels.compression.model haigpu2/mistralai/Mistral-7B-Instruct-v0.3
```

Named endpoints are stored in `local.endpoints[]` with `name`, `type`,
`enabled`, `baseUrl`, optional `apiKey`, optional `modelBehavior`, a privacy
`zone`, and optional `pricing.inputEurPerMillion` and
`pricing.outputEurPerMillion`. An omitted or invalid zone defaults to `cloud`
so routing cannot silently widen the data boundary; omitted pricing is shown
as unknown rather than zero. Use
`modelBehavior.thinkingFormat: "qwen"` for Qwen thinking markup handling. API
keys provided through the CLI are stored in the encrypted runtime secret store
and referenced from config.

In the default container sandbox, the agent reaches a `localhost` or
`127.0.0.1` base URL as `host.docker.internal`. On Linux that name is the
Docker bridge gateway (usually `172.17.0.1`), so the model server must listen
on that address; listening on `0.0.0.0` also works but exposes it to your
network. A server bound only to loopback, the Ollama and LM Studio default, is
unreachable from the container: rebind it or restart the gateway with
`--sandbox=host`.

## Notes

- LM Studio should generally be configured with a `/v1` base URL.
- The model id is optional on `hybridclaw auth login local <backend> [model-id]`.
  If you omit it, HybridClaw enables the backend and you can choose a model
  later with `/model list <backend>`.
- Interactive onboarding can skip remote-provider auth completely when you plan
  to use a local backend only.
- For longer agent sessions, `16k` context is a minimum and `32k` is safer.
- Ollama models run with a `32k` context window (`num_ctx`), or their trained
  window when that is smaller. Ollama reserves memory for the whole window. To
  use another size, set `PARAMETER num_ctx <tokens>` in the model's Modelfile
  and create the model from it; HybridClaw uses that value, up to the model's
  trained window.
- The TUI, web chat, and Discord model pickers come from the live gateway model
  list, so restart the gateway after enabling a new backend or loading a
  different local model.
