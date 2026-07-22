---
title: Diagnostics
description: Diagnose runtime issues, apply safe fixes, and capture turn-level request logs.
sidebar_position: 4
---

# Diagnostics

Use `hybridclaw doctor` when setup, auth, Docker, or runtime state looks
wrong.

```bash
hybridclaw doctor
hybridclaw doctor --fix
hybridclaw doctor --json
hybridclaw doctor docker
hybridclaw doctor browser-use
hybridclaw doctor providers
```

`doctor` checks runtime, gateway, config, credentials, database, providers,
local backends, browser automation, Docker, channels, skills, security, and
disk state in parallel.

Useful flags:

- `hybridclaw doctor --fix` applies safe remediations where a check exposes
  one, then reruns the fixable checks
- `hybridclaw doctor --json` prints a machine-readable report for CI or
  automation while still returning exit code `1` if errors remain
- `hybridclaw doctor <category>` narrows the report to one subsystem, for
  example `docker`, `browser-use`, or `providers`

When the config checks flag built-in tools that have gone unused for a while,
use `hybridclaw tool list`, `hybridclaw tool disable <name>`, and
`hybridclaw tool enable <name>` to keep the prompt surface tighter. The doctor
report treats the `browser_*` subtools as one browser toolset, so it only
suggests disabling them when that whole toolset is unused.

The `browser-use` category verifies the Playwright Chromium install used by
local browser automation. With `--fix`, HybridClaw offers the lazy Chromium
install remediation when the browser runtime is missing.

The `providers` category checks configured model providers, including
HybridAI discovery and bot-health calls. Auth failures, missing chatbot
configuration, and upstream service errors are reported separately so setup
problems do not look like generic provider outages.

## Model Latency Benchmark

Use the cross-stack benchmark when a model is healthy but responses are slower
than expected:

```bash
node scripts/benchmark-model-latency.mjs --help
node scripts/benchmark-model-latency.mjs \
  --model gpt-5.6-luna \
  --gateway-models hybridai/gpt-5.6-luna,openai-codex/gpt-5.6-luna \
  --stream both \
  --runs 3
```

The script sends equivalent requests through the local HybridClaw gateway, the
HybridAI API directly, and the upstream Anthropic or OpenAI API directly. Arms
without their required credentials are skipped:

- create a narrow gateway credential with
  `hybridclaw token create --label latency-bench --actions openai.api`, then
  provide the one-time token as `WEB_API_TOKEN`; `GATEWAY_API_TOKEN` is also
  accepted
- set `HYBRIDAI_API_KEY` for the direct HybridAI arm
- set `ANTHROPIC_API_KEY` for direct Claude models or `OPENAI_API_KEY` for
  direct GPT and o-series models

Use `--prompt-file <path>` with a prompt that requests a few hundred output
tokens when measuring generation throughput. `--max-tokens` applies only to
the direct HybridAI and vendor arms because the gateway's OpenAI-compatible
request parser does not accept that field; gateway output length follows the
prompt. `--json <path>` preserves raw per-run results.

The connection preflight separates DNS, TCP, and TLS setup time. Per-request
tables show time to headers, first event, first thinking delta, first visible
text, total time, input/output tokens, prompt-cache tokens, and streaming
tokens per second. A cache value of `-` means the backend did not report cache
data, while `0` is an explicit cache miss. Compare `gateway - HybridAI` for
HybridClaw overhead and `HybridAI - vendor` for backend proxy or queueing
overhead.

## Resource Hygiene

`doctor` includes a resource hygiene maintenance pass that detects stale
gateway artifacts such as orphaned sessions, leaked worker pool slots, and
abandoned workspace state. The check caches a DB snapshot and disk-state diff
so repeated runs are efficient. When `--fix` is passed, safe cleanups are
applied automatically (e.g. reclaiming leaked pool slots and removing
unstarted sessions that have no user messages).

## Request Logging

When environment-level checks pass but a specific turn still needs debugging,
start with the focused audit trace before enabling persistent request logging:

```text
/audit turn 3
/audit run run_abc123
```

Those views show the request, response, tool, approval, and audit events around
one turn. If the trace is not enough, start or restart the gateway with request
logging enabled:

```bash
hybridclaw gateway start --log-requests
hybridclaw gateway restart --log-requests
```

That persists best-effort redacted prompts, responses, and tool payloads to
SQLite `request_log` for turn-level debugging. Treat it as sensitive operator
data.

For lower-level provider debugging on a local machine, use:

```bash
hybridclaw gateway start --debug-model-responses
hybridclaw gateway restart --debug-model-responses
```

This writes provider response diagnostics and the last prompt under the
HybridClaw data directory. Treat those files as highly sensitive, because they
can include model payloads that normal operator logs intentionally avoid.
