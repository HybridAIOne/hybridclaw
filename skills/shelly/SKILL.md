---
name: shelly
description: "Read and control Shelly smart relays, plugs, lights, covers, sensors, and energy devices through local Gen1/Gen2 HTTP APIs or the Shelly Cloud Control API with guarded output changes."
user-invocable: true
requires:
  bins:
    - node
credentials:
  - id: shelly-cloud-auth-key
    kind: api_key
    required: false
    secret_ref:
      source: store
      id: SHELLY_CLOUD_AUTH_KEY
    scope: "Shelly Cloud Control API tenant host auth_key query parameter"
    how_to_obtain: "Generate an Authorization cloud key in Shelly Smart Control user settings and store it with `hybridclaw secret set SHELLY_CLOUD_AUTH_KEY \"<key>\"`."
  - id: shelly-cloud-access-token
    kind: bearer
    required: false
    secret_ref:
      source: store
      id: SHELLY_CLOUD_ACCESS_TOKEN
    scope: "Shelly Cloud Real Time Events HTTP API Authorization bearer"
    how_to_obtain: "Use Shelly's documented OAuth flow for the Real Time Events API and store the resulting access token with `hybridclaw secret set SHELLY_CLOUD_ACCESS_TOKEN \"<access-token>\"`."
metadata:
  hybridclaw:
    category: home-automation
    short_description: "Shelly local and cloud device reads plus guarded output control."
    tags:
      - shelly
      - smart-home
      - iot
      - energy
      - relay
    stakes_tiers:
      green:
        - local-gen1-shelly
        - local-gen1-status
        - local-gen1-relay-status
        - local-gen2-info
        - local-gen2-status
        - local-gen2-config
        - local-gen2-methods
        - local-gen2-components
        - local-gen2-switch-status
        - cloud-get-state
        - cloud-all-status
      amber:
        - local-gen1-relay-set
        - local-gen2-switch-set
        - local-gen2-switch-toggle
        - cloud-set-switch
        - cloud-set-light
        - cloud-set-cover
      red:
        - factory-reset
        - reboot
        - firmware-update
    escalation:
      writes: confirm-each
      route: f14
    cost_measurement:
      system: UsageTotals
      sub_limit_key: shelly
---

# Shelly

Use this skill for Shelly device inspection and guarded control. Prefer local
LAN calls when the gateway can reach the device. Use the Cloud Control API when
the device is remote, when local discovery is unavailable, or when the user
provides the Shelly cloud tenant host and device id.

## API Surface

Shelly has three relevant HTTP surfaces:

- Gen2+ local RPC uses `/rpc` methods such as `Shelly.GetStatus`,
  `Shelly.GetConfig`, `Shelly.GetDeviceInfo`, `Shelly.GetComponents`, and
  `Switch.Set`.
- Gen1 local devices use classic endpoints such as `/shelly`, `/status`, and
  `/relay/{id}`.
- Shelly Cloud Control API v2 uses the tenant server URI from the Shelly app,
  an `auth_key`, and `/v2/devices/api/...` endpoints. The v2 `auth_key`
  state endpoint requires known device ids.
- Shelly also documents an account-level Real Time Events HTTP endpoint,
  `/device/all_status?show_info=true&no_shared=true`, that can return current
  or last-known statuses for owned devices. That endpoint uses OAuth/Bearer
  access-token authentication through `SHELLY_CLOUD_ACCESS_TOKEN`, not the v2
  `auth_key`.

Official references:
[Gen2+ Shelly service](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Shelly/),
[Gen2+ Switch service](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Switch/),
[Gen2+ authentication](https://shelly-api-docs.shelly.cloud/gen2/General/Authentication/),
[Gen1 device API](https://shelly-api-docs.shelly.cloud/gen1/),
[Cloud Control API v2](https://shelly-api-docs.shelly.cloud/cloud-control-api/communication-v2/),
and
[Cloud Real Time Events](https://shelly-api-docs.shelly.cloud/cloud-control-api/real-time-events/).

## Default Workflow

1. Identify the device generation and reachable API first:
   - Gen2+: `local-gen2-info`, then `local-gen2-status` or
     `local-gen2-components`.
   - Gen1: `local-gen1-shelly`, then `local-gen1-status`.
   - Cloud Real Time Events OAuth/Bearer: `cloud-all-status` to discover
     account device ids and current or last-known statuses.
   - Cloud Control API v2 `auth_key`: `cloud-get-state` with `--select status`
     and only known device ids needed for the task.
2. Read state before any output control.
3. Treat relay, switch, light, and cover changes as amber. Get explicit
   operator approval before passing `--operator-grant`.
4. Do not perform reboot, factory reset, firmware update, Wi-Fi reset, auth
   changes, certificate upload, or profile changes through this v1 skill.
5. Use the helper as the API wrapper. Do not handcraft Shelly URLs or JSON
   payloads from memory when the helper supports the operation.

## Evidence and Reporting Rules

Base the answer only on successful tool results from the current turn or on
explicitly cited session memory. Do not report capabilities, device lists,
names, rooms, or command readiness from intent, docs, or partial failures.

- HTTP 200 means the transport succeeded. Still inspect the returned Shelly
  JSON and require `isok: true` when that field is present before treating the
  payload as authoritative.
- If a helper command fails, report the failed operation and stop or choose a
  documented fallback. Do not continue as if the command succeeded.
- If discovery returns ids without names, say exactly which fields were seen and
  which fields were missing.
- If credentials are missing for an API surface, name the missing secret and
  explain what remains possible with the credentials that are configured.
- Do not promise account-wide cloud discovery unless
  `SHELLY_CLOUD_ACCESS_TOKEN` is configured. `SHELLY_CLOUD_AUTH_KEY` plus a
  tenant host can read or control known device ids only.

## Device Discovery and IDs

For Cloud Control API v2 calls in this skill, assume the operator must provide
the Shelly tenant host and one or more device ids. `cloud-get-state` sends
`POST /v2/devices/api/get?auth_key=<AUTH_KEY>` and the documented body requires
`ids`, with 1 to 10 device ids per request. Do not claim that the v2
`auth_key` API can list every device.

Use this credential decision matrix:

| Configured inputs | Allowed discovery/control claim |
| --- | --- |
| Tenant host only | No cloud reads. Ask for `SHELLY_CLOUD_AUTH_KEY` or `SHELLY_CLOUD_ACCESS_TOKEN`. |
| Tenant host + `SHELLY_CLOUD_AUTH_KEY` + no ids | Can operate only after ids are known. Cannot list all devices through v2. |
| Tenant host + `SHELLY_CLOUD_AUTH_KEY` + ids | Can read and guard-control those exact ids through v2. |
| Tenant host + `SHELLY_CLOUD_ACCESS_TOKEN` | Can use `cloud-all-status` for account status discovery. |
| LAN IPs reachable from gateway | Can inspect local Gen1/Gen2 endpoints and derive ids/status from those responses. |

If the user asks to discover all Shelly devices from the cloud:

- Use `cloud-all-status` only when `SHELLY_CLOUD_ACCESS_TOKEN` is configured.
  This calls the documented Real Time Events HTTP endpoint
  `/device/all_status?show_info=true&no_shared=true` and emits
  `Authorization: Bearer <SHELLY_CLOUD_ACCESS_TOKEN>` through `secretHeaders`.
- The response returns `data.devices_status` keyed by device id; with
  `show_info=true`, each entry can include `_dev_info.id`, app name, model, and
  online state. Use that to identify cover/roller devices, then use v2
  `cloud-get-state` or guarded `cloud-set-cover` with exact ids.
- If `SHELLY_CLOUD_ACCESS_TOKEN` is not configured, ask for device ids from
  Shelly Smart Control `Device -> Settings -> Device Information -> Device Id`,
  or ask for LAN IPs reachable by the gateway.
- Do not try to call Real Time Events with `SHELLY_CLOUD_AUTH_KEY`; that key is
  for v2 `/v2/devices/api/...` control requests only.

## Names and Rooms

Do not say Shelly App names or room names are unset just because a local RPC
response or a Cloud Control API v2 `settings` response omits a name field. Treat
that as "this endpoint did not return names" and say that clearly.

Shelly has multiple naming layers. Firmware configuration, cloud device
metadata, app display names, and room assignments can be exposed by different
API surfaces. When the user asks for names:

- Prefer `cloud-all-status` with `show_info=true` when
  `SHELLY_CLOUD_ACCESS_TOKEN` is configured. Inspect `_dev_info.app_name`,
  `_dev_info.name`, `_dev_info.id`, `name`, and any returned room-like fields.
- If only local Gen2+ data or v2 `cloud-get-state` data is available, report
  the ids, IPs, model, and status, then say names were not returned by that
  endpoint.
- If no name-like or room-like field is returned, ask the user for a mapping or
  for OAuth-backed discovery. Do not claim that nobody named the devices in the
  Shelly app.

## Credentials

For Cloud Control API calls, store the Shelly authorization key in HybridClaw
encrypted runtime secrets:

```bash
hybridclaw secret set SHELLY_CLOUD_AUTH_KEY "<cloud-auth-key>"
```

Pass the tenant server URI from the Shelly app with `--cloud-host` or set
`SHELLY_CLOUD_HOST` in the runtime environment. The helper emits the cloud key
as `<secret:SHELLY_CLOUD_AUTH_KEY>` in the request URL so the gateway resolves
it server-side. Never paste the raw cloud key into chat or command arguments.

For Real Time Events account-wide discovery, store the Shelly OAuth access token
separately:

```bash
hybridclaw secret set SHELLY_CLOUD_ACCESS_TOKEN "<oauth-access-token>"
```

`cloud-all-status` uses `secretHeaders` so the gateway injects
`Authorization: Bearer <SHELLY_CLOUD_ACCESS_TOKEN>` server-side. Treat this
token as distinct from `SHELLY_CLOUD_AUTH_KEY`; they are not interchangeable.

For local Gen2+ devices with authentication enabled, note that Shelly uses
SHA-256 digest authentication. The gateway `http_request` tool may return 401
for protected local endpoints. `Shelly.GetDeviceInfo` and Gen1 `/shelly` remain
available without authentication. Do not ask the user to paste local device
passwords into chat; use cloud control or an operator-configured local auth
route/tooling outside this helper.

## Command Contract

Show helper usage:

```bash
node skills/shelly/shelly.cjs --help
```

Build local Gen2+ read requests:

```bash
node skills/shelly/shelly.cjs --format json http-request local-gen2-info \
  --device-url http://192.0.2.10

node skills/shelly/shelly.cjs --format json http-request local-gen2-status \
  --device-url http://192.0.2.10

node skills/shelly/shelly.cjs --format json http-request local-gen2-components \
  --device-url http://192.0.2.10 \
  --include status \
  --include config \
  --key switch:0
```

Build guarded local Gen2+ switch control:

```bash
node skills/shelly/shelly.cjs --format json http-request local-gen2-switch-set \
  --device-url http://192.0.2.10 \
  --id 0 \
  --on true \
  --operator-grant
```

Build local Gen1 read and relay control requests:

```bash
node skills/shelly/shelly.cjs --format json http-request local-gen1-shelly \
  --device-url http://192.0.2.10

node skills/shelly/shelly.cjs --format json http-request local-gen1-relay-set \
  --device-url http://192.0.2.10 \
  --id 0 \
  --turn off \
  --operator-grant
```

Build Cloud Control API requests:

```bash
node skills/shelly/shelly.cjs --format json http-request cloud-get-state \
  --cloud-host https://shelly-tenant.example \
  --device-id b48a0a1cd978 \
  --select status \
  --pick-status sys

node skills/shelly/shelly.cjs --format json http-request cloud-all-status \
  --cloud-host https://shelly-tenant.example

node skills/shelly/shelly.cjs --format json http-request cloud-set-switch \
  --cloud-host https://shelly-tenant.example \
  --device-id b48a0a1cd978 \
  --channel 0 \
  --on true \
  --operator-grant
```

The helper prints a wrapper such as
`{ "command": "http-request", "httpRequest": { ... } }`. Pass only the
`httpRequest` value to the built-in `http_request` tool.

## Error Interpretation

- Shelly Cloud 401/403 responses mean the cloud key is missing, blocked, or
  rejected, or the OAuth access token is missing, blocked, expired, or rejected
  for `cloud-all-status`. Stop after the first failure and ask the operator to
  verify the relevant secret and tenant host.
- Shelly Cloud 400 `DEVICE_OFFLINE`, `DEVICE_INVALID_CHANNEL`, or
  `BAD_REQUEST` responses are upstream device or parameter failures. Report
  the device id, operation, and upstream error string.
- Shelly Cloud requests are limited to 1 request per second. Do not fan out or
  retry in a loop.
- Local 401 responses usually mean device digest auth is enabled. Fall back to
  unauthenticated info endpoints or cloud control unless the operator has
  configured an approved local credential path.
- Local network errors mean the gateway cannot reach the device URL from its
  runtime network. Ask for the device URL that is reachable from the gateway,
  not just from the user's laptop.
