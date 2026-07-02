# Langfuse Operator Setup

## API Keys

In Langfuse, open **Project Settings → API Keys** and create a key pair for the
project HybridClaw should observe:

- public key, `pk-lf-...` (used as the Basic auth username)
- secret key, `sk-lf-...` (used as the Basic auth password)

Langfuse keys are project-scoped. The same key reads observability data and
writes scores, comments, datasets, and prompt versions; there is no separate
read-only tier, so treat the key as write-capable and rely on the skill's
amber/grant gating for changes.

## Store the Credential and Host

The Langfuse public API uses HTTP Basic auth. Base64-encode `public:secret`
locally and store only the encoded value, plus your deployment base URL. For
the secret value, use this order:

1. Browser admin: open the active HybridClaw admin URL ending in `/admin/secrets`.
2. Browser `/chat` or TUI fallback:

```text
/secret set LANGFUSE_BASIC_AUTH "<base64-of-public-key:secret-key>"
/env set LANGFUSE_HOST https://cloud.langfuse.com
```

3. Local console fallback:

```bash
hybridclaw secret set LANGFUSE_BASIC_AUTH "<base64-of-public-key:secret-key>"
hybridclaw env set LANGFUSE_HOST https://cloud.langfuse.com
```

To produce the encoded value locally:

```bash
printf '%s' 'pk-lf-xxxx:sk-lf-xxxx' | base64
```

The helper emits `Authorization: Basic <secret:LANGFUSE_BASIC_AUTH>` and a
`<env:LANGFUSE_HOST>` base URL, so HybridClaw injects both server-side. Do not
paste the keys into chat, logs, helper arguments, eval fixtures, or
documentation examples.

## Host Selection

| Deployment        | `LANGFUSE_HOST`                  |
| ----------------- | -------------------------------- |
| Langfuse Cloud EU | `https://cloud.langfuse.com`     |
| Langfuse Cloud US | `https://us.cloud.langfuse.com`  |
| Langfuse Cloud JP | `https://jp.cloud.langfuse.com`  |
| Self-hosted       | your origin, e.g. `https://langfuse.internal.example.com` |

`LANGFUSE_HOST` is a plaintext config variable. A request can also override it
for a single call with `--host https://...` (https only).

## Network Policy

The gateway HTTP proxy blocks private and loopback hosts. For self-hosted
Langfuse on a private network, allow the host in workspace network policy with
`/policy` (or `hybridclaw policy ...`) before live calls succeed. Langfuse Cloud
hosts are public and need no extra allowlisting beyond the default policy.

## Recommended Autonomy

- Trace, observation, session, score, prompt, dataset, model, comment, and
  metric reads: allow read-only autonomy for trusted operators.
- Score, comment, dataset, dataset-item, and prompt-version creation:
  `confirm-each`.
- Deletions and project / API-key / organization administration: out of scope —
  not exposed by this skill.

## Cost Reporting

Cost per assistant run is recorded by HybridClaw `UsageTotals`; helper output
includes `costMeasurement.system = "UsageTotals"`. Langfuse's own usage and cost
figures come from `metrics` and the trace/observation reads — the helper makes no
hidden billing calls.
