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
        - local-gen2-cover-open
        - local-gen2-cover-close
        - local-gen2-cover-stop
        - local-gen2-cover-goto-position
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

Use this skill for Shelly device inspection and guarded control through the
bundled helper. Keep the markdown instructions generic; API-specific request
construction belongs in `shelly.cjs`.

## Core Contract

- Build every Shelly HTTP request with `skills/shelly/shelly.cjs`. Do not
  handcraft Shelly URLs or JSON bodies when the helper supports the operation.
- Pass the helper-emitted `httpRequest` object unchanged to the built-in
  `http_request` tool.
- Read state before any relay, switch, light, or cover control operation.
- Treat control operations as amber and require explicit operator approval
  before passing `--operator-grant`.
- Do not perform factory reset, reboot, firmware update, Wi-Fi reset, auth
  changes, certificate upload, calibration, profile changes, or energy-counter
  reset through this skill.

## API Surfaces

- Local Gen2+ devices use RPC methods under `/rpc`, including `Shelly.*`,
  `Cover.*`, `Switch.*`, and `Shelly.GetComponents`.
- Local Gen1 devices use classic endpoints such as `/shelly`, `/status`, and
  `/relay/{id}`.
- Shelly Cloud Control API v2 uses a tenant server URI, an Authorization Cloud
  Key, and known device ids for state and control.
- Shelly Real Time Events HTTP calls use OAuth/Bearer authorization and can
  return account-level current or last-known device statuses.

Official references:
[Cloud Control API getting started](https://shelly-api-docs.shelly.cloud/cloud-control-api/),
[Cloud Control API v2](https://shelly-api-docs.shelly.cloud/cloud-control-api/communication-v2/),
[Cloud Real Time Events](https://shelly-api-docs.shelly.cloud/cloud-control-api/real-time-events/),
[Gen2+ Shelly service](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Shelly/),
[Gen2+ Cover service](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Cover/),
[Gen2+ Switch service](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Switch/),
[Gen2+ authentication](https://shelly-api-docs.shelly.cloud/gen2/General/Authentication/),
and [Gen1 device API](https://shelly-api-docs.shelly.cloud/gen1/).

## Helper Operations

Run `node skills/shelly/shelly.cjs --help` for the exact flags. The helper
emits a wrapper containing `command`, `operation`, `stakesTier`, and
`httpRequest`; pass only `httpRequest` to the network tool.

Supported operation groups:

- Local Gen2+ reads: device info, status, config, method list, components,
  cover config/status, and switch status.
- Local Gen2+ controls: cover open/close/stop/go-to-position and switch
  set/toggle.
- Local Gen1 reads/control: device info, status, relay status, relay set.
- Cloud reads/discovery: v2 state by known ids, OAuth token exchange, Real Time
  Events all-status.
- Cloud controls: switch, light, and cover set operations.

## Selection Workflow

1. Prefer local Gen2+ reads when a local device URL is available and reachable.
2. Fall back to Gen1 reads for older devices.
3. Use Real Time Events OAuth for account-level cloud discovery.
4. Use Cloud Control API v2 for known device ids, especially when local access
   is unavailable or the requested device is remote.
5. For control, use the matching local or cloud helper operation and include
   `--operator-grant` only after explicit approval.

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
  `cloud-oauth-token` to exchange it and capture `SHELLY_CLOUD_ACCESS_TOKEN`.
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
