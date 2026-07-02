---
name: firecrawl
description: "Scrape pages, crawl public sites, map URLs, and run JSON-schema extraction through managed or self-hosted Firecrawl."
user-invocable: true
requires:
  bins:
    - node
credentials:
  - id: firecrawl-api-key
    kind: api_key
    required: false
    secret_ref:
      source: store
      id: FIRECRAWL_API_KEY
    scope: "api.firecrawl.dev"
    how_to_obtain: "Create a managed Firecrawl API key in the Firecrawl dashboard. Set `FIRECRAWL_API_KEY` through browser admin at the active `/admin/secrets` route; if browser admin is unavailable, use `/secret set FIRECRAWL_API_KEY \"<fc-api-key>\"` in browser `/chat` or TUI; local console fallback: `hybridclaw secret set FIRECRAWL_API_KEY \"<fc-api-key>\"`."
  - id: firecrawl-self-host-api-key
    kind: api_key
    required: false
    secret_ref:
      source: store
      id: FIRECRAWL_SELF_HOST_API_KEY
    scope: "self-hosted Firecrawl"
    how_to_obtain: "Set this only when your self-hosted Firecrawl instance has API authentication enabled. Set `FIRECRAWL_SELF_HOST_API_KEY` through browser admin at the active `/admin/secrets` route; if browser admin is unavailable, use `/secret set FIRECRAWL_SELF_HOST_API_KEY \"<self-host-api-key>\"` in browser `/chat` or TUI; local console fallback: `hybridclaw secret set FIRECRAWL_SELF_HOST_API_KEY \"<self-host-api-key>\"`."
metadata:
  hybridclaw:
    category: research
    short_description: "Firecrawl managed/self-host scrape, crawl, map, and extraction."
    tags:
      - firecrawl
      - scrape
      - crawl
      - extraction
      - web
    related_roadmap:
      - R53
      - R53.1
      - R53.2
    issue: 829
    sub_issues:
      - 862
      - 863
    stakes_tiers:
      green:
        - scrape.url
        - map.site
        - extract.structured
      amber:
        - crawl.site
    cost_measurement:
      system: UsageTotals
      sub_limit_key: firecrawl
---

# Firecrawl

Use this skill for unauthenticated public web ingestion when HTTP fetch and
server-side parsing are enough. Firecrawl is the cheap path for public pages and
docs. Use the browser skill instead when the task needs login, interaction,
form filling, visual inspection, or client-side state. Do not use Firecrawl to
bypass access controls.

## Credential Rules

For managed mode, set or update the Firecrawl API key in this order:

1. Browser admin: open the active HybridClaw admin URL ending in `/admin/secrets` and set
   `FIRECRAWL_API_KEY`.
2. Browser `/chat` or TUI fallback:
   `/secret set FIRECRAWL_API_KEY "<fc-api-key>"`.
3. Local console fallback:

```bash
hybridclaw secret set FIRECRAWL_API_KEY "<fc-api-key>"
```

For a self-hosted Firecrawl instance, set the gateway-reachable base URL in the
runtime environment or pass it explicitly to the helper:

```bash
export FIRECRAWL_SELF_HOST_BASE_URL="http://firecrawl:3002"
```

The helper accepts base URLs with or without `/v2` and normalizes them to the
v2 API path. If your self-hosted Firecrawl deployment enables API
authentication, set that token separately in the same order:

1. Browser admin: open the active HybridClaw admin URL ending in `/admin/secrets` and set
   `FIRECRAWL_SELF_HOST_API_KEY`.
2. Browser `/chat` or TUI fallback:
   `/secret set FIRECRAWL_SELF_HOST_API_KEY "<self-host-api-key>"`.
3. Local console fallback:

```bash
hybridclaw secret set FIRECRAWL_SELF_HOST_API_KEY "<self-host-api-key>"
```

Use HTTPS for any self-host endpoint outside a trusted private network, especially when `--self-host-auth` is enabled; plain HTTP can expose bearer tokens on untrusted networks.

For live calls, run the colocated helper to build an `http_request` payload and
pass only the emitted `httpRequest` object to the built-in `http_request` tool.
The helper sets `bearerSecretName: "FIRECRAWL_API_KEY"` so the gateway injects
the managed token server-side. In self-host mode, pass `--self-host-auth` only
when the deployment requires a bearer token; the helper then uses
`FIRECRAWL_SELF_HOST_API_KEY`. Do not use bash/curl for live Firecrawl calls
when `http_request` is available, and never ask the user to paste API keys into
chat.

## Operations

- `scrape.url`: scrape one public URL. Default output is markdown.
- `crawl.site`: start a public site crawl with conservative default limit `25`.
- `crawl.status`: fetch crawl progress and paginated crawl results by job id.
- `crawl.cancel`: cancel a crawl job by id.
- `crawl.active`: list active crawls for the authenticated Firecrawl team.
- `map.site`: return a URL map with conservative default limit `500`.
- `extract.structured`: start a structured extraction job through `POST /v2/extract`.
- `extract.status`: fetch extraction status and results by job id.

Both adapters target Firecrawl API v2. The managed adapter sends requests to
`https://api.firecrawl.dev/v2`; the self-host adapter sends the same operations
to the configured self-host base URL. Firecrawl self-host deployments may not
enable every upstream managed feature; `/agent` and `/browser` are intentionally
outside this skill surface.

For single-page JSON extraction during scraping, `scrape.url` can include
`--schema-json`; for the R53.1/R53.2 `extract` endpoint, use
`extract.structured` and then poll `extract.status`.

## Command Contract

Run the helper with Node:

```bash
node skills/firecrawl/firecrawl.cjs --help
```

Build a managed single-page scrape request:

```bash
node skills/firecrawl/firecrawl.cjs --format json http-request scrape.url \
  --url https://example.com/docs \
  --format-name markdown
```

Build the same request for self-hosted Firecrawl:

```bash
node skills/firecrawl/firecrawl.cjs --format json --adapter self-host \
  --base-url http://firecrawl:3002 \
  http-request scrape.url \
  --url https://example.com/docs \
  --format-name markdown
```

Add `--self-host-auth` only if the self-hosted deployment requires
`FIRECRAWL_SELF_HOST_API_KEY`.

Build a site crawl request:

```bash
node skills/firecrawl/firecrawl.cjs --format json http-request crawl.site \
  --url https://example.com/docs \
  --limit 25 \
  --include-path 'docs/.*'
```

Check or cancel a crawl:

```bash
node skills/firecrawl/firecrawl.cjs --format json http-request crawl.status \
  --id 00000000-0000-0000-0000-000000000000

node skills/firecrawl/firecrawl.cjs --format json http-request crawl.cancel \
  --id 00000000-0000-0000-0000-000000000000
```

Build a URL map request:

```bash
node skills/firecrawl/firecrawl.cjs --format json http-request map.site \
  --url https://example.com \
  --limit 500 \
  --sitemap include
```

Build a structured extraction request:

```bash
node skills/firecrawl/firecrawl.cjs --format json http-request extract.structured \
  --url 'https://example.com/pricing/*' \
  --schema-json '{"type":"object","properties":{"plans":{"type":"array"}}}' \
  --prompt "Extract plan names and prices."
```

Check an extraction job:

```bash
node skills/firecrawl/firecrawl.cjs --format json http-request extract.status \
  --id 00000000-0000-0000-0000-000000000000
```

The helper prints a wrapper such as
`{ "command": "http-request", "httpRequest": { ... } }`. Pass only the
`httpRequest` value to the built-in `http_request` tool.

## Policy Defaults

- Target URLs must be `http` or `https` and must not embed credentials.
- Managed mode rejects custom API base URLs.
- Self-host mode requires `--base-url` or `FIRECRAWL_SELF_HOST_BASE_URL`; API base URLs must be `http` or `https` and must not embed credentials.
- `crawl.site` always emits `ignoreRobotsTxt: false`.
- The helper rejects `--ignore-robots-txt`.
- Crawl and map limits are explicit and bounded to reduce surprise cost.
- Use `--zero-data-retention` only when the Firecrawl team has enabled it for the configured account or self-hosted deployment.

## Error Interpretation

- Gateway errors saying `FIRECRAWL_API_KEY` is not set, unavailable, missing,
  or unresolved mean the active HybridClaw runtime cannot resolve the stored
  secret. Ask the operator to set it in the same runtime/session.
- Gateway errors saying `FIRECRAWL_API_KEY` is blocked by policy mean the
  secret exists but policy/runtime access blocked injection. Do not ask the
  operator to set the same secret again.
- Firecrawl 401 or 403 responses mean the gateway injected a token but
  Firecrawl rejected it or the account cannot use the requested feature.
- Firecrawl 402, 408, 429, or 5xx responses are upstream billing, timeout, rate
  limit, or service failures. Report the upstream response and retry only when
  the user asks.
- Self-host errors saying `FIRECRAWL_SELF_HOST_BASE_URL` is missing mean the
  operator needs to configure the gateway-reachable Firecrawl API origin.
