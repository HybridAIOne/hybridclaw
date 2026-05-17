---
name: zabbix
description: "Read Zabbix monitoring state, inspect monitored hosts, summarize current or recent problems, and prepare guarded incident-response context without exposing Zabbix credentials."
user-invocable: true
requires:
  bins:
    - node
credentials:
  - id: ZABBIX_API_TOKEN
    kind: bearer
    required: true
    secret_ref:
      source: store
      id: ZABBIX_API_TOKEN
    scope: "https://<zabbix-frontend>/api_jsonrpc.php Authorization bearer"
    how_to_obtain: |
      Create a Zabbix API token in the Zabbix frontend and store it with
      `hybridclaw secret set ZABBIX_API_TOKEN "<token>"`.
metadata:
  hybridclaw:
    category: production-ops
    short_description: "Zabbix monitoring reads for incident triage."
    tags:
      - zabbix
      - monitoring
      - incident-response
      - production
      - r21
    related_roadmap:
      - R21
      - R32
      - R33
    issue: 1045
    stakes_tiers:
      green:
        - api-version
        - host-inventory
        - problem-read
        - trigger-problem-read
        - incident-summary
      amber:
        - event-acknowledge
        - event-suppress
      red:
        - event-close
    escalation:
      writes: confirm-each
      route: f14
    cost_measurement:
      system: UsageTotals
      sub_limit_key: zabbix
---

# Zabbix

Use this skill for Zabbix production monitoring reads: API health checks,
monitored host inventory, current or recent problems, problem-state triggers by
severity, and concise incident summaries that can feed R29 cards. Zabbix tells
us what is broken; local or SSH maintenance skills investigate and remediate on
the affected host.

This v1 skill is read-only. Do not acknowledge, suppress, close, update, or
delete Zabbix objects through this skill. If a later task adds write operations,
each write must be amber/red, require an exact operator grant through F8/F14,
and include the Zabbix event id and action in the approval text.

## Credential Rules

Store the API token in HybridClaw encrypted runtime secrets:

```bash
hybridclaw secret set ZABBIX_API_TOKEN "<zabbix-api-token>"
```

For live calls, run the helper to build a gateway `http_request` payload and
pass only the emitted `httpRequest` object to the built-in `http_request` tool.
The helper sets `bearerSecretName: "ZABBIX_API_TOKEN"` for authenticated
Zabbix methods so the gateway injects the bearer token server-side. It never
prints `Authorization` headers, token values, usernames, passwords, or Zabbix
session tokens.

When a terminal-side live smoke test is needed, pass `--live` to the same
`http-request` command. It posts the same `httpRequest` object to the HybridClaw gateway
`/api/http/request` route and stops after the first Zabbix 401/403 response.
Set `HYBRIDCLAW_GATEWAY_URL` and `HYBRIDCLAW_GATEWAY_TOKEN` only for gateway
access; do not store those as Zabbix credentials.

Do not call Zabbix with `curl` when the gateway `http_request` tool is
available. Do not ask the user to paste a Zabbix API token, username/password,
or session token into chat.

If the operator has a tenant-specific frontend path, pass it with `--base-url`
or set `ZABBIX_BASE_URL` in the runtime environment. The helper accepts both
`https://zabbix.example.com/zabbix` and
`https://zabbix.example.com/zabbix/api_jsonrpc.php` and normalizes both to the
JSON-RPC endpoint. HTTPS is required by default. Use `--allow-http` only for a
trusted local or private Zabbix frontend where plaintext HTTP is an intentional
operator choice.

## Command Contract

Show helper usage:

```bash
node skills/zabbix/zabbix.cjs --help
```

Build an unauthenticated API smoke-test request:

```bash
node skills/zabbix/zabbix.cjs --format json http-request api-version \
  --base-url https://zabbix.example.com/zabbix
```

List monitored hosts and interfaces:

```bash
node skills/zabbix/zabbix.cjs --format json http-request hosts \
  --base-url https://zabbix.example.com/zabbix \
  --monitored-only
```

Read current or recent problems:

```bash
node skills/zabbix/zabbix.cjs --format json http-request problems \
  --base-url https://zabbix.example.com/zabbix \
  --recent \
  --limit 50
```

Read triggers in problem state:

```bash
node skills/zabbix/zabbix.cjs --format json http-request triggers-problem \
  --base-url https://zabbix.example.com/zabbix \
  --limit 50
```

Run one live gateway-proxied request, with no retry loop:

```bash
node skills/zabbix/zabbix.cjs --live --format json http-request problems \
  --base-url https://zabbix.example.com/zabbix \
  --recent \
  --limit 50
```

The helper prints a wrapper such as
`{ "command": "http-request", "httpRequest": { ... } }`. Pass only the
`httpRequest` value to the built-in `http_request` tool.

Official API references:
[Zabbix API overview](https://www.zabbix.com/documentation/current/en/manual/api),
[`host.get`](https://www.zabbix.com/documentation/current/en/manual/api/reference/host/get),
[`problem.get`](https://www.zabbix.com/documentation/current/en/manual/api/reference/problem/get),
and
[`trigger.get`](https://www.zabbix.com/documentation/current/en/manual/api/reference/trigger/get).

## Filters

Use IDs when filtering by host or host group because Zabbix JSON-RPC read
methods filter most reliably on `hostids` and `groupids`:

```bash
node skills/zabbix/zabbix.cjs --format json http-request problems \
  --base-url https://zabbix.example.com/zabbix \
  --host-id 10084 \
  --group-id 2 \
  --severity high \
  --unacknowledged \
  --unsuppressed \
  --tag service=postgres \
  --time-from 1767225600 \
  --limit 25
```

Supported read filters:

- `--host-id <id>` / `--host <id>` and `--group-id <id>` /
  `--host-group <id>` can be repeated.
- `--tag <name>` or `--tag <name=value>` can be repeated.
- `--severity <0-5|name>` can be repeated or comma-separated.
- `--acknowledged` or `--unacknowledged` for problem reads.
- `--suppressed` or `--unsuppressed` for problem reads.
- `--time-from <unix-seconds>` and `--time-till <unix-seconds>` for problem reads.
- `--recent` includes recently resolved problems; omit it for unresolved current problems.

Severity names are `not-classified`, `information`, `warning`, `average`,
`high`, and `disaster`.

## Error Interpretation

- Gateway errors saying `ZABBIX_API_TOKEN` is not set, unavailable, missing, or
  unresolved mean the active HybridClaw runtime cannot resolve the stored
  secret. Ask the operator to set it in the same runtime/session and retry once
  after the runtime can see the secret.
- Gateway errors saying `ZABBIX_API_TOKEN` is blocked by secret resolution
  policy mean the stored secret exists but policy/runtime access blocked the
  injection path. Report the policy problem instead of asking for the same
  secret again.
- Zabbix 401 or 403 responses mean the gateway injected a token but Zabbix
  rejected it or the token lacks permission. Stop after that first failed live
  call and report a credential/setup problem; do not retry in a loop.
- Zabbix JSON-RPC `error` responses should be reported with the method, code,
  message, and data. Do not transform them into local remediation steps unless
  the user asks.
- Network, timeout, 429, or 5xx responses are upstream or connectivity
  failures. Report the response and retry only when the user asks.

## Incident Summary Guidance

When summarizing Zabbix state, preserve the event id, host, trigger/problem
name, severity, acknowledged/suppressed state, age, tags, and any maintenance
or acknowledgement context. Keep remediation separate from observation unless
another approved maintenance skill has verified the host state.
