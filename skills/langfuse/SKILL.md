---
name: langfuse
description: "Use Langfuse for LLM observability and evaluation and look up Langfuse documentation. In HybridClaw, data access (traces, observations, sessions, scores, prompts, datasets, metrics) goes through the gateway-proxied langfuse.cjs helper with SecretRef auth — reads are green, writes are grant-gated. Documentation retrieval uses langfuse.com llms.txt, markdown pages, and search-docs. Covers instrumentation, prompt migration, error analysis, and LLM-as-a-judge calibration."
user-invocable: true
requires:
  bins:
    - node
credentials:
  - id: langfuse-basic-auth
    kind: header
    required: true
    secret_ref:
      source: store
      id: LANGFUSE_BASIC_AUTH
    scope: "Langfuse public API Authorization Basic header secret for <LANGFUSE_HOST>/api/public"
    how_to_obtain: |
      In Langfuse, open Project Settings → API Keys and create a key pair
      (public key `pk-lf-...` and secret key `sk-lf-...`). Locally base64-encode
      `public-key:secret-key` and store only that encoded credential in chat with
      `/secret set LANGFUSE_BASIC_AUTH "<base64-public-colon-secret>"`.
      The same key reads observability data and writes scores, comments,
      datasets, and prompt versions.
config_variables:
  - id: langfuse-host
    env: LANGFUSE_HOST
    required: true
    scope: "Langfuse API base URL used in <LANGFUSE_HOST>/api/public"
    how_to_obtain: |
      Use your Langfuse deployment base URL: `https://cloud.langfuse.com` (EU),
      `https://us.cloud.langfuse.com` (US), `https://jp.cloud.langfuse.com` (JP),
      or your self-hosted origin. Store it in chat with
      `/env set LANGFUSE_HOST https://cloud.langfuse.com`.
metadata:
  hybridclaw:
    category: observability
    short_description: "Langfuse LLM observability: traces, scores, prompts, datasets, metrics, docs lookup, and guarded evaluation writes."
    tags:
      - langfuse
      - observability
      - llm
      - evaluation
      - tracing
      - prompts
    stakes_tiers:
      green:
        - health
        - get-project
        - list-traces
        - get-trace
        - list-observations
        - get-observation
        - list-sessions
        - get-session
        - list-scores
        - get-score
        - list-score-configs
        - get-score-config
        - list-prompts
        - get-prompt
        - list-datasets
        - get-dataset
        - list-dataset-items
        - get-dataset-item
        - list-dataset-runs
        - get-dataset-run
        - list-models
        - get-model
        - list-comments
        - get-comment
        - metrics
      amber:
        - create-score
        - create-comment
        - create-dataset
        - create-dataset-item
        - create-prompt
    escalation:
      writes: confirm-each
      route: f14
    cost_measurement:
      system: UsageTotals
      sub_limit_key: langfuse
---

# Langfuse

This skill helps you use Langfuse effectively across all common workflows:
instrumenting applications, migrating prompts, debugging traces, accessing data,
and evaluating outputs.

> **HybridClaw integration.** This is the official Langfuse skill
> ([github.com/langfuse/skills](https://github.com/langfuse/skills), MIT)
> adapted for HybridClaw. Two things differ from the upstream skill:
>
> 1. **Credentials never leave the gateway.** Do not export
>    `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY`, run `npx langfuse-cli`, or
>    paste keys anywhere. Store them once in the runtime stores (below); the
>    gateway injects them server-side.
> 2. **Data access goes through `langfuse.cjs`**, not the Langfuse CLI. The
>    helper builds each REST request and sends it through the HybridClaw gateway,
>    which resolves `Authorization: Basic <secret:LANGFUSE_BASIC_AUTH>` and the
>    `<env:LANGFUSE_HOST>` base URL. Wherever a reference says to run
>    `langfuse-cli` or `curl -H "Authorization: Basic $AUTH"`, use the helper
>    instead. Documentation retrieval (section 2) is unchanged.

## HybridClaw setup

The helper never sees credentials. Store two values once:

1. `LANGFUSE_BASIC_AUTH` — base64 of `public-key:secret-key`:
   `/secret set LANGFUSE_BASIC_AUTH "<base64-public-colon-secret>"`
2. `LANGFUSE_HOST` — your Langfuse base URL:
   `/env set LANGFUSE_HOST https://cloud.langfuse.com` (use
   `https://us.cloud.langfuse.com` for US, `https://jp.cloud.langfuse.com` for
   JP, or your self-hosted origin).

Local-terminal alternative: `hybridclaw secret set LANGFUSE_BASIC_AUTH "<...>"`
and `hybridclaw env set LANGFUSE_HOST https://cloud.langfuse.com`.

See [references/operator-setup.md](references/operator-setup.md) for key scope,
host selection, autonomy defaults, and network-policy notes.

## Core Principles

Follow these principles for ALL Langfuse work:

1. **Documentation first**: never implement from memory. Langfuse updates
   frequently — fetch current docs (section 2) before writing instrumentation or
   SDK code.
2. **Helper for data access**: use `langfuse.cjs` (gateway + SecretRef) when
   querying or modifying Langfuse data. It owns endpoints, methods, bodies,
   stakes tiers, host, and the Basic auth placeholder.
3. **Best practices by use case**: check the relevant reference below before
   implementing.
4. **Use latest Langfuse versions**: unless the user says otherwise, target the
   latest Langfuse SDKs/APIs.

## Use-case references

- instrumenting an existing function/application:
  [references/instrumentation.md](references/instrumentation.md)
- migrating prompts from a codebase into Langfuse:
  [references/prompt-migration.md](references/prompt-migration.md)
- capturing user feedback (thumbs, ratings, implicit signals) as scores:
  [references/user-feedback.md](references/user-feedback.md)
- systematic error analysis — reading traces, building a failure taxonomy,
  deciding what to fix: [references/error-analysis.md](references/error-analysis.md)
- judge calibration (LLM-as-a-Judge reliability, accuracy checks, confusion
  matrices, metric ingestion):
  [references/judge-calibration.md](references/judge-calibration.md)
- upgrading or migrating Langfuse SDKs:
  [references/sdk-upgrade.md](references/sdk-upgrade.md)
- CI/CD experiment gates with `langfuse/experiment-action`:
  [references/ci-cd.md](references/ci-cd.md)
- raw Langfuse REST/CLI semantics (endpoints, pagination, v2 vs legacy):
  [references/cli.md](references/cli.md)
- HybridClaw credential, host, autonomy, and network-policy setup:
  [references/operator-setup.md](references/operator-setup.md)
- submitting feedback about this skill:
  [references/skill-feedback.md](references/skill-feedback.md)

## 1. Langfuse data access (HybridClaw gateway helper)

`langfuse.cjs` is the API wrapper. Do not handcraft Langfuse API URLs, JSON
bodies, tiers, host, or the Basic auth header from memory.

```bash
node skills/langfuse/langfuse.cjs --help
```

- **plan** classifies a natural-language request into an operation + tier:
  `node skills/langfuse/langfuse.cjs --format json plan "average eval score this week"`
- **run** executes a live request through the gateway (the gateway injects the
  Basic auth header):
  `node skills/langfuse/langfuse.cjs --format json run list-traces --user-id alice --limit 50`
- **http-request** emits the gateway-ready payload without calling Langfuse —
  use it for dry-run inspection or runtimes without helper gateway access.

Read examples (green):

```bash
node skills/langfuse/langfuse.cjs --format json run get-trace --trace-id abc123
node skills/langfuse/langfuse.cjs --format json run list-observations --type GENERATION --trace-id abc123
node skills/langfuse/langfuse.cjs --format json run list-scores --name quality
node skills/langfuse/langfuse.cjs --format json run get-prompt --prompt-name support-reply --label production
node skills/langfuse/langfuse.cjs --format json run metrics --query '{"view":"traces","metrics":[{"measure":"count","aggregation":"count"}]}'
```

Guarded write examples (amber — only after an explicit operator grant):

```bash
node skills/langfuse/langfuse.cjs --format json run create-score \
  --trace-id abc123 --name quality --value 0.8 --data-type NUMERIC --comment "reviewed" --operator-grant
node skills/langfuse/langfuse.cjs --format json run create-prompt \
  --name summarizer --type text --prompt "Summarize: {{input}}" --label production --operator-grant
```

Select region or self-hosted host explicitly (otherwise `<env:LANGFUSE_HOST>`):

```bash
node skills/langfuse/langfuse.cjs --format json run list-traces --host https://us.cloud.langfuse.com
```

### Working rules

- Reads are green. Writes (`create-score`, `create-comment`, `create-dataset`,
  `create-dataset-item`, `create-prompt`) require `--operator-grant`: produce a
  plan, wait for the operator's grant, then run the exact approved command.
- Deletions and project / API-key / organization / SCIM administration are out
  of scope. Use the Langfuse UI for those.
- Page size is capped at 100; use `--page` (legacy) or `--cursor` (modern
  endpoints) to paginate. The helper rejects `--limit` above 100.
- For broad trace queries that time out on Langfuse Cloud, prefer
  `list-observations` (with `--trace-id` when traversing from a known trace).
- In OpenTelemetry-instrumented apps, trace-level `input`/`output` can be null —
  the content lives in a `GENERATION` observation, so read observations to see
  prompts/outputs.
- Before creating a score config, list existing ones (`list-score-configs`);
  configs cannot be deleted.
- Never print, inspect, or ask for `LANGFUSE_BASIC_AUTH`; the gateway injects it
  as `Authorization: Basic <secret:LANGFUSE_BASIC_AUTH>`.
- Cost per assistant run is recorded by HybridClaw `UsageTotals`; helper output
  includes `costMeasurement.system = "UsageTotals"` for eval verification.

## 2. Langfuse documentation

Prefer your application's native web fetch/search tools (e.g. `web_fetch`,
`web_search`) over `curl`. The URLs work with any fetching method.

### 2a. Documentation index (llms.txt)

Fetch the full index of doc pages, then fetch the right one:

```bash
curl -s https://langfuse.com/llms.txt
```

### 2b. Fetch individual pages as markdown

Append `.md` to any doc path (or send `Accept: text/markdown`):

```bash
curl -s "https://langfuse.com/docs/observability/overview.md"
```

### 2c. Search documentation

When you don't know the page (also indexes GitHub issues/discussions):

```bash
curl -s "https://langfuse.com/api/search-docs?query=How+do+I+trace+LangGraph+agents"
```

Workflow: start with **llms.txt** to orient → **fetch the specific page** → fall
back to **search** when the topic is unclear.

## Eval suite

```bash
node skills/langfuse/langfuse.cjs --format json eval-scenarios
```

The fixture at `evals/scenarios.json` contains 10 scenarios covering trace,
observation, session, score, metric, prompt, and dataset reads plus guarded
score, dataset, and prompt writes.

## Skill feedback

If the skill gives wrong or outdated guidance, is missing something, or could be
improved, offer to submit feedback to the Langfuse skill maintainers following
[references/skill-feedback.md](references/skill-feedback.md). Do **not** trigger
this for issues with Langfuse the product — only this skill's instructions.

## Attribution

Adapted from the official Langfuse skill
([github.com/langfuse/skills](https://github.com/langfuse/skills)), MIT-licensed,
with HybridClaw gateway/SecretRef data access in place of the upstream
`langfuse-cli` + plaintext-key path. See [NOTICE.md](NOTICE.md).

## Validation

```bash
python3 skills/skill-creator/scripts/quick_validate.py skills/langfuse
node skills/langfuse/langfuse.cjs --help
node skills/langfuse/langfuse.cjs --format json eval-scenarios
```
