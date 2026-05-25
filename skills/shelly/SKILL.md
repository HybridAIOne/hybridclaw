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
        - local-gen2-cover-config
        - local-gen2-cover-status
        - local-gen2-switch-status
        - cloud-get-state
        - cloud-oauth-token
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
- Do not infer or rewrite the HTTP verb, URL path, query string, or JSON body
  for Gen2+ RPC methods. Use the helper-emitted `httpRequest` exactly. Shelly
  local RPC has both direct method URLs and JSON-RPC transport forms; the
  workspace network policy matches the actual emitted method, host, port, and
  path.
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
- The Shelly OAuth flow is browser-consent based. Use `shelly-diy` as the
  default `client_id` for DIY use unless the operator has an integrator client
  id. The authorization code is exchanged at `https://<shelly_server>/oauth/auth`.

Official references:
[Cloud Control API getting started](https://shelly-api-docs.shelly.cloud/cloud-control-api/),
[Gen2+ Shelly service](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Shelly/),
[Gen2+ Cover service](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Cover/),
[Gen2+ Switch service](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Switch/),
[Gen2+ authentication](https://shelly-api-docs.shelly.cloud/gen2/General/Authentication/),
[Gen1 device API](https://shelly-api-docs.shelly.cloud/gen1/),
[Cloud Control API v2](https://shelly-api-docs.shelly.cloud/cloud-control-api/communication-v2/),
and
[Cloud Real Time Events](https://shelly-api-docs.shelly.cloud/cloud-control-api/real-time-events/).

## Default Workflow

1. Use a local-first resolution order:
   - If a device URL, LAN IP, `.local` host, or local bridge is available, try
     local Gen2+ reads first: `local-gen2-info`, then `local-gen2-status` or
     `local-gen2-components`. For cover names, call
     `local-gen2-cover-config --id <cover-channel>` because
     `Cover.GetConfig` exposes the cover component `name`.
   - If Gen2+ RPC is unavailable or the device is Gen1, try Gen1 reads:
     `local-gen1-shelly`, then `local-gen1-status`.
   - Use cloud only when local LAN access is unavailable, blocked by policy, or
     insufficient for the requested account/device discovery.
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
   payloads from memory when the helper supports the operation. Never change the
   helper-emitted HTTP method, URL shape, or body before passing `httpRequest`
   to the built-in `http_request` tool.

## OAuth Token Acquisition

Acquire `SHELLY_CLOUD_ACCESS_TOKEN` through a user-consented authorization-code
flow. Do not ask for Shelly account passwords, and do not paste access tokens
into chat.

1. Send the user to Shelly's authorization page with a callback URL. Do not use
   the bare `https://my.shelly.cloud/oauth_login.html?client_id=shelly-diy`
   URL; Shelly can reject it with "Wrong parameteres provided!". For DIY setup
   without a hosted app callback, create a temporary request-capture URL such
   as a Pipedream RequestBin endpoint and pass it as URL-encoded
   `redirect_uri`, plus a simple `state` value:
   `https://my.shelly.cloud/oauth_login.html?client_id=shelly-diy&redirect_uri=<url-encoded-request-bin-url>&state=hybridclaw`.
   Use a callback URL the operator controls and can inspect.
2. After consent, the browser redirects to the callback with a `code` query
   parameter. In a RequestBin flow, open the captured request and copy the
   `code` query parameter. Ask the user to store that one-time code as a
   temporary runtime secret:
   ```bash
   hybridclaw secret set SHELLY_OAUTH_CODE "<authorization-code>"
   ```
3. Exchange the code through the helper and gateway secret capture:
   ```bash
   node skills/shelly/shelly.cjs --format json http-request cloud-oauth-token \
     --cloud-host https://shelly-tenant.example \
     --code-secret SHELLY_OAUTH_CODE
   ```
   Pass the emitted `httpRequest` to `http_request`. The request sends
   `grant_type=code`, `client_id`, and the authorization code as a secret
   placeholder to `/oauth/auth`, with `replaceSecretPlaceholders: true`.
4. The gateway must capture `access_token` into `SHELLY_CLOUD_ACCESS_TOKEN`
   using `captureResponseFields`. The agent must report only whether capture
   succeeded, not the token value.
   Pass `captureResponseFields` as the JSON array emitted by the helper, not as
   a string. If capture fails, stop and report the failure; do not rerun the
   token exchange without capture and do not store a raw access token with
   `hybridclaw secret set` from tool output.
5. Use the `user_api_url` embedded in the JWT access token, or the tenant host
   supplied by the operator, for subsequent Real Time Events HTTP calls. If the
   token expires, rerun this OAuth flow unless Shelly documents and configures a
   refresh-token route.

## Evidence and Reporting Rules

Base Shelly state answers only on successful Shelly API tool results from the
current turn. Do not report capabilities, device lists, names, rooms, current
status, last-known status, or command readiness from intent, docs, partial
failures, or session memory.

- HTTP 200 means the transport succeeded. Still inspect the returned Shelly
  JSON and require `isok: true` when that field is present before treating the
  payload as authoritative.
- If a helper command fails, report the failed operation and stop or choose a
  documented fallback. Do not continue as if the command succeeded.
- If discovery returns ids without names, say exactly which fields were seen and
  which fields were missing.
- If credentials are missing for an API surface, name the missing secret and
  explain what remains possible with the credentials that are configured.
- For any request about current state, last-known state, controller activity,
  or recent device behavior, use live Shelly data: `cloud-all-status`,
  `cloud-get-state`, or local Gen1/Gen2 reads. If the live API response
  includes timestamps, report those timestamps. If it does not, say the
  endpoint returned current or last-known state without event history.
- Use `session_search` only to recover missing setup hints such as a previously
  used tenant host, device ids, or a room-to-device mapping. Treat those results
  as historical setup context only. Immediately verify any recovered host or id
  with a live Shelly API call before reporting device state.
- Do not call `session_search` after a successful `cloud-all-status`,
  `cloud-get-state`, or local Shelly read just to enrich status reporting.
  Report exactly what the live response returned and ask the user for missing
  room/name mappings if needed.
- Do not infer that a stored secret is missing from prior turns, memory, or
  prompt context. A secret is missing only if the current `http_request` using
  the helper-emitted placeholder fails with a stored-secret error. If the user
  says they configured a secret, retry the exact helper-backed request once.
- Do not promise account-wide cloud discovery unless
  `SHELLY_CLOUD_ACCESS_TOKEN` is configured. `SHELLY_CLOUD_AUTH_KEY` plus a
  tenant host can read or control known device ids only.

## Response Formatting

Use one user-facing table format per response. Do not start with a Markdown
pipe table and then repeat the same section as a box-drawing or terminal table.

For Shelly status summaries:

- Prefer Markdown pipe tables for compact device lists. Keep columns short and
  stable: number, id, IP suffix or host, type, state, position, temperature,
  and a concise note when needed.
- Put a blank line before and after every Markdown table. Do not place prose,
  repeated headings, or another table immediately adjacent to the final table
  row.
- Emit a complete table block once. Do not stream a partial table, restart the
  same section, or switch formats mid-answer.
- Use plain lists instead of wide tables when the number of columns would wrap
  badly in the target chat surface.
- Avoid box-drawing tables in final chat answers unless the user explicitly
  asks for terminal output. They are harder to copy, harder to render in
  proportional fonts, and can duplicate poorly when mixed with Markdown.

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
| Tenant host + `SHELLY_OAUTH_CODE` | Can exchange the code and capture `SHELLY_CLOUD_ACCESS_TOKEN`. |
| LAN IPs reachable from gateway | Can inspect local Gen1/Gen2 endpoints and derive ids/status from those responses. |

## Required Inputs and Where to Find Them

Collect only the inputs needed for the selected API surface. Do not ask for
cloud credentials when local LAN reads are sufficient, and do not ask for local
device passwords in chat.

| Input | Source | Use |
| --- | --- | --- |
| Shelly Cloud tenant server URI | Shelly Smart Control app, same user settings area as the Authorization Cloud Key. The OAuth JWT `user_api_url` can also reveal the account's current API server after consent. | `--cloud-host` or `SHELLY_CLOUD_HOST` for Cloud Control v2 and Real Time Events HTTP calls. |
| `SHELLY_CLOUD_AUTH_KEY` | Shelly Smart Control app user settings, Authorization Cloud Key. | Cloud Control API v2 state and control for known device ids. |
| Device id | Shelly Smart Control app device details, Device Information, Device Id. | Cloud Control API v2 `ids`; required for v2 state/control and limited to known devices. |
| `SHELLY_CLOUD_ACCESS_TOKEN` | OAuth authorization-code flow for Real Time Events; capture the returned `access_token` into HybridClaw secrets. | Account-level Real Time Events discovery with `cloud-all-status`. |
| `SHELLY_OAUTH_CODE` | Temporary authorization code returned to the configured OAuth callback after Shelly login consent. | One-time exchange for `SHELLY_CLOUD_ACCESS_TOKEN`; remove or ignore after successful capture. |
| LAN device URL or IP | Router/DHCP lease list, Shelly app device network details, local DNS, or a previously verified local URL. | Local Gen1/Gen2 reads and guarded local control when gateway policy and runtime network can reach the device. |
| Cover channel id | Local config/status component key such as `cover:0`, or the default channel for single-cover devices. | Local `Cover.*` calls and cloud cover channel targeting. |
| App-visible name or room | Shelly Smart Control app UI. | Human mapping only unless the same API response returns that field. Firmware/local RPC name fields can be null when name sync is disabled. |

The Cloud Control API getting-started documentation says the Authorization
Cloud Key and server URI are obtained from Shelly app user settings. The v2
communication documentation says per-device ids are found in each device's
Device Information screen. The Real Time Events documentation uses OAuth
Bearer access tokens and instructs clients to use the `user_api_url` embedded
in the token for subsequent account-level calls.

If the user asks to discover all Shelly devices from the cloud:

- Use `cloud-all-status` only when `SHELLY_CLOUD_ACCESS_TOKEN` is configured.
  This calls the documented Real Time Events HTTP endpoint
  `/device/all_status?show_info=true&no_shared=true` and emits
  `Authorization: Bearer <SHELLY_CLOUD_ACCESS_TOKEN>` through `secretHeaders`.
- The response returns `data.devices_status` keyed by device id; with
  `show_info=true`, each entry can include `_dev_info.id`, `_dev_info.gen`,
  `_dev_info.code`, and `_dev_info.online`. The official Real Time Events docs
  do not document Shelly Smart Control app display names or room assignments in
  this payload. Use the returned metadata to identify cover/roller devices,
  then use v2 `cloud-get-state` or guarded `cloud-set-cover` with exact ids.
- If `SHELLY_CLOUD_ACCESS_TOKEN` is not configured, ask for device ids from
  Shelly Smart Control `Device -> Settings -> Device Information -> Device Id`,
  or ask for LAN IPs reachable by the gateway.
- Do not try to call Real Time Events with `SHELLY_CLOUD_AUTH_KEY`; that key is
  for v2 `/v2/devices/api/...` control requests only.
- For known cover ids and configured `SHELLY_CLOUD_AUTH_KEY`, use
  `cloud-get-state --select settings` to inspect cloud v2 settings. Do not call
  tenant-host `/rpc/Cover.GetConfig`; that RPC path is a local device API, not a
  Shelly Cloud tenant endpoint.

## LAN Reachability and SSRF

Local Gen1/Gen2 APIs such as `Shelly.GetDeviceInfo`, `Cover.GetStatus`, and
`Cover.GetConfig` are device-local HTTP endpoints. Always prefer them over
cloud for local Shelly controllers when the requesting HybridClaw runtime is
allowed to reach the Shelly LAN address.

In this checkout, the generic `http_request` gateway blocks private and
loopback hosts such as `192.168.x.x`, `10.x.x.x`, `172.16-31.x.x`,
`localhost`, and `.local` with:

```text
HTTP request blocked by SSRF guard: private or loopback host (<host>).
```

Treat that as a product safety guard, not a Shelly failure. The skill cannot
change network policy from inside the user task.

Teach the operator which gate blocked the request:

- `HTTP request blocked by SSRF guard` is the gateway `http_request` private
  host guard. It is opened only by a matching explicit workspace network policy
  allow rule for the exact private host, port, method, path, and agent. The
  default network policy is not enough to bypass the private-host guard, and
  `tools.httpRequest.authRules[]` only injects secrets.
- For public Shelly Cloud HTTPS hosts, do not describe this as LAN SSRF
  blocking and do not suggest adding the cloud domain to a private-network
  allowlist. If the host is under `shelly.cloud`, verify whether DNS resolves.
  If it does not resolve, report an invalid or stale tenant host and ask for the
  current Shelly Cloud URI from Shelly Smart Control or from the OAuth JWT
  `user_api_url`.
- `network default policy denies unlisted hosts` is the container network
  approval policy. Open read-only Shelly LAN access for both gateway-proxied
  `http_request` calls and container network checks with a narrow allow rule.
  The operator can add the rule through any supported local policy surface:
  CLI, the local TUI/web `/policy` command, or the `/admin/approvals` network
  policy editor. All of these write the selected agent workspace policy.
  ```bash
  hybridclaw policy allow <shelly-lan-host-or-ip-pattern> \
    --methods GET \
    --paths /rpc/**,/shelly,/status \
    --port 80 \
    --comment "Shelly LAN read-only"
  ```
  In the local TUI/web chat, the equivalent slash command is `/policy allow ...`
  with the same host, methods, paths, port, and comment fields. In the browser
  admin console, open `/admin/approvals`, select the relevant agent, and add a
  network policy rule with the same values.
- Before telling the operator to add a policy rule, check whether an equivalent
  rule is already present. Compare the actual audited request host, port,
  method, and path with the saved policy. A rule for `GET /rpc/**` does not
  allow `POST /rpc`, and a rule for `POST /rpc/Cover.GetConfig` does not allow
  `POST /rpc`.
- If a private-host request is blocked, diagnose the mismatch from the current
  tool result and saved policy. Do not ask for a broader policy rule unless the
  helper-emitted request genuinely needs that broader method/path and the
  operator accepts that permission.
- If an equivalent rule is already present, do not ask the operator to run the
  same `hybridclaw policy allow` command again. Say that the policy is already
  saved and continue with the local request. If the local request still reports
  the SSRF guard, report it as a runtime/gateway mismatch or a rule mismatch
  that must be diagnosed, not as a missing allow rule.
- If the runtime still reports the SSRF guard after adding a policy rule, verify
  the currently running gateway has loaded a build that supports policy-backed
  private `http_request` targets, and verify the rule matches the current
  request's host, port, method, path, and agent. If it still cannot be opened,
  use cloud fallback or ask the operator to provide a dedicated Shelly LAN
  bridge or tool that is intentionally scoped to Shelly device IPs and read-only
  endpoints unless a separate operator grant is given for writes.
- Never collapse cloud DNS failure, LAN reachability failure, and container
  network policy denial into one cause. Report only the failure actually shown
  by the current tool result.

When a user wants local cover names or local device status:

1. First build the local request with the helper, for example:
   ```bash
   node skills/shelly/shelly.cjs --format json http-request local-gen2-cover-config \
     --device-url http://192.168.1.194 \
     --id 0
   ```
   Pass the emitted `httpRequest` to `http_request`.
   Do not manually replace the emitted method, URL path, query string, or body.
2. If the request returns the SSRF guard error above, explain that local LAN
   access is blocked from this runtime. Do not retry with handcrafted URLs,
   `curl`, DNS aliases, redirects, or URL encoding tricks.
3. Offer the supported alternatives:
   - Use Cloud Control API v2 with `SHELLY_CLOUD_AUTH_KEY` and known ids:
     `cloud-get-state --select settings`.
   - Use Real Time Events OAuth discovery with `SHELLY_CLOUD_ACCESS_TOKEN`:
     `cloud-all-status`.
   - Ask the operator to provide an explicit LAN-capable Shelly tool or local
     bridge that is intentionally scoped to Shelly device IPs and read-only
     endpoints unless a separate operator grant is given for writes.
4. If the operator provides such a LAN path, verify reachability from the
   gateway/runtime host, not only from the user's laptop. The useful read-only
   checks are:
   - Gen2+: `/rpc/Shelly.GetDeviceInfo`, `/rpc/Cover.GetStatus?id=0`,
     `/rpc/Cover.GetConfig?id=0`, `/rpc/Shelly.GetConfig`
   - Gen1: `/shelly`, `/status`

## Names and Rooms

Do not say Shelly App names or room names are unset just because a local RPC
response or a Cloud Control API v2 `settings` response omits a name field. Treat
that as "this endpoint did not return names" and say that clearly.

Shelly has multiple naming layers. Firmware configuration, cloud device
metadata, app display names, and room assignments can be exposed by different
API surfaces. When the user asks for names:

- A null, empty, or id-like value from `DeviceInfo.name`, `cover:<id>.name`,
  `sys.device.name`, `_dev_info`, Real Time Events, or v2 `settings` is
  negative evidence only for that specific API field. It is not evidence that
  the Shelly Smart Control app has no display name.
- If the user supplies app UI evidence or says the device has a name, accept
  that as the app-visible name unless a later live API response from the same
  app-level surface contradicts it. Do not argue from firmware fields.
- The Shelly Smart Control setting for synchronizing names can leave app-visible
  names and firmware/component names out of sync when it is disabled. In that
  state, firmware/local RPC reads can return null even though the app visibly
  has a name.
- Never answer "no", "not set", "default id only", or "no custom name in the
  Shelly app" from missing API name fields alone. Say which API fields were
  checked and that those fields did not expose the app-visible name.
- For cloud account discovery, use `cloud-all-status` with `show_info=true`.
  Inspect `_dev_info` and top-level fields, but expect only id, generation,
  product code, and online state unless the actual response includes more.
  Do not promise app names from Real Time Events.
- For firmware-level cover names, prefer local Gen2+
  `local-gen2-cover-config --id <cover-channel>` where the gateway can reach
  the device. `Cover.GetConfig` exposes the cover component `name`; this is the
  best API surface for shade/cover labels.
- For broader firmware-level device names, use `local-gen2-config` or
  `local-gen2-components --include config --key sys`. Look for
  `sys.device.name` and component `name` fields.
- If only Real Time Events or v2 `cloud-get-state` data is available, report
  the ids, IPs, model/code, and status. For v2 settings, inspect returned
  `cover:<id>`/cover settings for `name` before saying names were not returned
  by that endpoint.
- If no name-like or room-like field is returned, ask the user for a mapping or
  for LAN/local-config discovery. Do not claim that nobody named the devices in
  the Shelly app, and do not offer to rename the app-visible device unless the
  user explicitly asks for a rename operation and a documented API for that
  naming layer is available.

## Credentials

Use HybridClaw secrets for every credential. Do not paste raw keys, access
tokens, authorization codes, or local device passwords into chat.

For Cloud Control API v2 calls, get the Authorization Cloud Key from Shelly
Smart Control user settings and store it in HybridClaw encrypted runtime
secrets:

```bash
hybridclaw secret set SHELLY_CLOUD_AUTH_KEY "<cloud-auth-key>"
```

Pass the tenant server URI from the Shelly app with `--cloud-host` or set
`SHELLY_CLOUD_HOST` in the runtime environment. The helper emits the cloud key
as `<secret:SHELLY_CLOUD_AUTH_KEY>` in the request URL so the gateway resolves
it server-side. Never paste the raw cloud key into chat or command arguments.
Cloud Control v2 also needs known device ids; get them from each device's
Device Information screen in Shelly Smart Control.

For Real Time Events account-wide discovery, use Shelly's OAuth
authorization-code flow and store the captured access token separately:

```bash
hybridclaw secret set SHELLY_CLOUD_ACCESS_TOKEN "<oauth-access-token>"
```

`cloud-all-status` uses `secretHeaders` so the gateway injects
`Authorization: Bearer <SHELLY_CLOUD_ACCESS_TOKEN>` server-side. Treat this
token as distinct from `SHELLY_CLOUD_AUTH_KEY`; they are not interchangeable.

To acquire this token without exposing it to the agent, use the OAuth token
acquisition flow above. `cloud-oauth-token` mirrors the Salesforce skill's
gateway capture pattern: the authorization code is supplied through a temporary
secret placeholder, and the gateway captures the returned `access_token` into
encrypted runtime secrets.

The OAuth authorization code is temporary setup material, not a standing
credential. Store it only as `SHELLY_OAUTH_CODE` long enough for
`cloud-oauth-token` to exchange it and capture `SHELLY_CLOUD_ACCESS_TOKEN`.
After capture, use the token and the JWT `user_api_url`/tenant host for
Real Time Events calls.

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

node skills/shelly/shelly.cjs --format json http-request local-gen2-cover-config \
  --device-url http://192.0.2.10 \
  --id 0

node skills/shelly/shelly.cjs --format json http-request local-gen2-cover-status \
  --device-url http://192.0.2.10 \
  --id 0
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

node skills/shelly/shelly.cjs --format json http-request cloud-oauth-token \
  --cloud-host https://shelly-tenant.example \
  --code-secret SHELLY_OAUTH_CODE

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
