---
name: shelly
description: "Read and control Shelly smart relays, plugs, lights, covers, shutters, shades, sensors, and energy devices through local Gen1/Gen2 HTTP APIs, Shelly Gen2 RPC methods such as Cover.GetConfig and Cover.GetStatus, or the Shelly Cloud Control API with guarded output changes."
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
        - device.info
        - device.status
        - device.config
        - device.methods
        - device.components
        - gen1.get
        - rpc.get
        - cover.config
        - cover.status
        - switch.status
        - relay.status
        - cloud.state
        - cloud.oauth-token
        - cloud.all-status
        - cloud.websocket-url
      amber:
        - gen1.set
        - rpc.call
        - cloud.websocket-command
        - cover.open
        - cover.close
        - cover.stop
        - cover.goto
        - switch.set
        - switch.toggle
        - relay.set
        - light.set
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

Use this skill for Shelly device inspection and guarded control through the
bundled helper. Keep the markdown instructions generic; API-specific request
construction belongs in `shelly.cjs`.

## Core Contract

- Run Shelly HTTP operations through `skills/shelly/shelly.cjs`. Do not
  handcraft Shelly URLs or JSON bodies when the helper supports the operation.
- The helper executes HTTP operations through the HybridClaw gateway, so normal
  Shelly reads and writes should be a single helper command. Use `--request`
  only when an explicit request specification is needed for debugging or code
  review. For WebSocket planning outputs, use the emitted `webSocket` object as
  the complete connection or message specification.
- Read state before any relay, switch, light, or cover control operation.
- Treat control operations as amber. Before asking for approval, build an
  `approval-plan` for the selected operation and include its
  `approvedHelperCommandText` in the approval request. Stop after presenting
  the plan. Only after the operator confirms in a later message, run that
  helper command exactly and use its emitted request specification unchanged.
- Do not perform factory reset, reboot, firmware update, Wi-Fi reset, auth
  changes, or certificate upload through this skill.

## Helper Operations

Use this command surface directly; do not rediscover flags by trial and error.
Run `node skills/shelly/shelly.cjs --help` only when the surface below appears
stale. The helper owns the Shelly API method, path, body selection, gateway
dispatch, secret injection, and response wrapping. Normal HTTP commands execute
the request and return `command: "live"`, the operation, a redacted request
summary, and the gateway result. `--request` emits a request wrapper containing
`command`, `operation`, `stakesTier`, and `httpRequest` without executing it.
WebSocket helpers emit `webSocket` instead of `httpRequest`. `approval-plan`
emits no `httpRequest`; it validates an amber command and returns the exact
approved helper command to run after confirmation.

Command surface:

```text
node skills/shelly/shelly.cjs [--format json|pretty] [--request] <resource> <action> [flags]
node skills/shelly/shelly.cjs [--format json|pretty] approval-plan <resource> <action> [flags]

device info --device-url http://192.0.2.10 [--ident]
device status --device-url http://192.0.2.10
device config --device-url http://192.0.2.10
device methods --device-url http://192.0.2.10
device components --device-url http://192.0.2.10 [--include status] [--include config] [--key switch:0]
cover config --device-url http://192.0.2.10 --id 0
cover status --device-url http://192.0.2.10 --id 0
cover open --device-url http://192.0.2.10 --id 0 --operator-grant
cover close --device-url http://192.0.2.10 --id 0 --operator-grant
cover stop --device-url http://192.0.2.10 --id 0 --operator-grant
cover goto --device-url http://192.0.2.10 --id 0 --position 50 --operator-grant
cover status --cloud-host https://<HOST> --device-id abc123
cover goto --cloud-host https://<HOST> --device-id abc123 --position 50 --operator-grant
switch status --device-url http://192.0.2.10 --id 0
switch set --device-url http://192.0.2.10 --id 0 --on true --operator-grant
switch toggle --device-url http://192.0.2.10 --id 0 --operator-grant
switch set --cloud-host https://<HOST> --device-id abc123 --on true --operator-grant
relay status --device-url http://192.0.2.10 --id 0
relay set --device-url http://192.0.2.10 --id 0 --turn on|off|toggle --operator-grant
light set --cloud-host https://<HOST> --device-id abc123 --on true --brightness 50 --operator-grant
cloud state --cloud-host https://<HOST> --device-id abc123 --select status
cloud all-status --cloud-host https://<HOST>
cloud oauth-token --cloud-host https://<HOST>
cloud websocket-url --cloud-host https://<HOST>
cloud websocket-command --cloud-host https://<HOST> --device-id abc123 --cmd roller_to_pos --params-json '{"id":0,"pos":50}' --operator-grant
gen1 get --device-url http://192.0.2.10 --path /settings [--query key=value]
gen1 set --device-url http://192.0.2.10 --path /settings/relay/0 --query default_state=on --operator-grant
rpc get --device-url http://192.0.2.10 --method Cloud.GetStatus [--param id=0] [--params-json '{}']
rpc call --device-url http://192.0.2.10 --method Cover.Calibrate --params-json '{"id":0}' --operator-grant
```

Supported operation groups:

- Device reads: local info, status, config, method list, and components; cloud
  state when routed with cloud inputs.
- Generic Gen1 and Gen2 coverage: documented Gen1 HTTP paths and documented
  Gen2 RPC methods.
- Cover reads/control: config, status, open, close, stop, and go-to-position.
- Switch and relay reads/control: status, set, and toggle where supported.
- Light control: cloud set operations.
- Cloud account reads and event planning: v2 state by known ids, OAuth token
  exchange, Real Time Events all-status, WebSocket URL, and command-message
  construction.

## Selection Workflow

1. Prefer local Gen2+ reads when a local device URL is available and reachable.
2. Fall back to Gen1 reads for older devices.
3. Use Real Time Events OAuth for account-level cloud discovery.
4. Use Cloud Control API v2 for known device ids, especially when local access
   is unavailable or the requested device is remote.
5. For control, use the matching helper command and include `--operator-grant`
   only after explicit approval.

## Required Inputs

Collect only the inputs needed for the chosen surface.

| Input | Where it comes from | Used for |
| --- | --- | --- |
| Local device URL or IP | Router/DHCP data, Shelly app network details, local DNS, or a verified URL | Local Gen1/Gen2 reads and control |
| Cover or switch channel id | Local component keys such as `cover:0` or `switch:0` | Component-specific local/cloud operations |
| Shelly Cloud tenant server URI | Shelly Smart Control user settings; OAuth JWT `user_api_url` can also identify it | Cloud Control v2 and Real Time Events |
| `SHELLY_CLOUD_AUTH_KEY` | Shelly Smart Control user settings, Authorization Cloud Key | Cloud Control v2 for known device ids |
| Device id | Shelly Smart Control device details, Device Information, Device Id | Cloud Control v2 state/control |
| `SHELLY_CLOUD_ACCESS_TOKEN` | Captured OAuth access token | Real Time Events account discovery |
| `SHELLY_OAUTH_CODE` | Temporary OAuth authorization code from the callback URL | One-time token exchange |

## Access to Local Devices

Local device requests require the HybridClaw runtime to reach the device
network and the workspace network policy to allow the helper-emitted host,
port, method, and path. Operators can add policy rules through the CLI, the
local TUI/web `/policy` command, or the `/admin/approvals` network policy
editor. If local access is not available, use the cloud APIs or ask for a
reachable local device URL.

## Credentials

- Store the Cloud Control v2 key as `SHELLY_CLOUD_AUTH_KEY`.
- Store the Real Time Events OAuth token as `SHELLY_CLOUD_ACCESS_TOKEN`.
- Store an OAuth authorization code as `SHELLY_OAUTH_CODE` only long enough for
  `cloud oauth-token` to exchange it and capture `SHELLY_CLOUD_ACCESS_TOKEN`.
- Never paste raw keys, access tokens, authorization codes, or local device
  passwords into chat.
- Local Gen2+ devices with authentication enabled use Shelly digest
  authentication. Prefer unauthenticated info endpoints, configured local auth
  tooling, or cloud access rather than asking for local passwords in chat.

## Discovery and Names

- Cloud Control API v2 requires known device ids and can request status and
  settings for up to 10 ids at a time.
- Real Time Events all-status can discover account device statuses when
  `SHELLY_CLOUD_ACCESS_TOKEN` is configured.
- Shelly names can exist in multiple layers: app display name, room assignment,
  firmware device name, component name, and cloud metadata. Report the field
  and API surface that supplied or omitted a name; do not treat a missing field
  from one surface as proof that another naming layer is unset.

## Result Handling

- Base status and control answers on successful live Shelly API results from
  the current turn.
- Inspect returned JSON and require `isok: true` when that field is present.
- For cloud or local errors, report the operation, target, and upstream error
  without inventing state.
- Respect Shelly Cloud rate limits; do not fan out or retry in tight loops.

## API Surfaces

- Local Gen2+ devices use RPC methods under `/rpc`; use the dedicated
  noun-verb helpers for common operations and generic RPC helpers for other
  documented methods.
- Local Gen1 devices use classic HTTP endpoints; use dedicated helpers for
  common relay/status operations and generic Gen1 endpoint helpers for other
  documented paths.
- Shelly Cloud Control API v2 uses a tenant server URI, an Authorization Cloud
  Key, and known device ids for state and control.
- Shelly Real Time Events HTTP calls use OAuth/Bearer authorization and can
  return account-level current or last-known device statuses. Real Time Events
  WebSocket helpers emit connection and command-message specifications.

Official references:
[Cloud Control API getting started](https://shelly-api-docs.shelly.cloud/cloud-control-api/),
[Cloud Control API v2](https://shelly-api-docs.shelly.cloud/cloud-control-api/communication-v2/),
[Cloud Real Time Events](https://shelly-api-docs.shelly.cloud/cloud-control-api/real-time-events/),
[Gen2+ Shelly service](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Shelly/),
[Gen2+ Cover service](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Cover/),
[Gen2+ Switch service](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Switch/),
[Gen2+ authentication](https://shelly-api-docs.shelly.cloud/gen2/General/Authentication/),
and [Gen1 device API](https://shelly-api-docs.shelly.cloud/gen1/).
