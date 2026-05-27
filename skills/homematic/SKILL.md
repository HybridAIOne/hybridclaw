---
name: homematic
description: "Read Homematic IP Home Control Unit state and prepare guarded smart-home control messages without exposing HCU credentials."
user-invocable: true
requires:
  bins:
    - node
credentials:
  - id: homematic-hcu-auth-token
    kind: bearer
    required: true
    secret_ref:
      source: store
      id: HOMEMATIC_HCU_AUTH_TOKEN
    scope: "Homematic IP HCU Connect API WebSocket authtoken header"
    how_to_obtain: |
      Enable HCU developer mode, generate an activation key, use
      `node skills/homematic/homematic.cjs http-request auth-token` and
      `confirm-token`, then store the confirmed Connect API auth token with
      `hybridclaw secret set HOMEMATIC_HCU_AUTH_TOKEN "<token>"`.
  - id: homematic-hcu-activation-key
    kind: header
    required: false
    secret_ref:
      source: store
      id: HOMEMATIC_HCU_ACTIVATION_KEY
    scope: "One-time HCU Connect API token enrollment"
    how_to_obtain: |
      Generate an activation key from HCUweb developer mode and store it only
      long enough to enroll the Connect API client:
      `hybridclaw secret set HOMEMATIC_HCU_ACTIVATION_KEY "<activation-key>"`.
metadata:
  hybridclaw:
    category: home-automation
    short_description: "Homematic IP HCU state reads and guarded device control planning."
    tags:
      - homematic
      - homematic-ip
      - hcu
      - smart-home
      - building-automation
      - r21
    related_roadmap:
      - R21
      - R48
    issue: 1100
    stakes_tiers:
      green:
        - plan
        - fixture-summary
        - hcu-get-state
        - hcu-get-system-state
        - plugin-ready
      amber:
        - auth-token
        - confirm-token
        - switch-control
        - thermostat-control
        - shutter-control
        - scene-trigger
      red:
        - safety-alarm-acknowledge
    escalation:
      writes: confirm-each
      route: f14
    cost_measurement:
      system: UsageTotals
      sub_limit_key: homematic
---

# Homematic

Use this skill for Homematic IP Home Control Unit (HCU) state inspection and
guarded smart-home control planning. The primary v1 integration target is the
official Homematic IP Connect API, which exposes HCU plugin communication over
WebSocket. Treat CCU/RaspberryMatic and Homematic IP Access Point cloud support
as separate compatibility paths until their protocols are implemented and
tested.

This v1 targets remote HCU Connect API clients. The HTTPS port `6969` auth
helpers implement the remote-client enrollment flow. Installed HCU plugin
containers instead receive their token from the HCU container environment and
mounted `/TOKEN` file; this helper does not implement container installation.

## Safety Rules

1. Start with `plan`, `summarize-fixture`, `plugin-ready`, `get-state`, or
   `get-system-state`.
2. For HCU setup, generate gateway `http-request` payloads with the helper.
   Never ask the operator to paste activation keys or auth tokens into chat.
3. For HCU WebSocket operations, use helper `websocket-message` output as the
   source of truth for connection headers, message type, path, stakes tier, and
   approval requirement.
4. For a local operator-owned read-only smoke test, `run-websocket` can open
   the HCU WebSocket directly using `HOMEMATIC_HCU_AUTH_TOKEN` from the helper
   environment. Do not pass that token as an argument. Use gateway-managed
   execution for any amber/red operation.
5. Reads are green but still privacy-sensitive because home occupancy, alarms,
   temperatures, shutters, and energy state can reveal living patterns.
6. Mutating device or group actions are amber unless they affect alarms,
   security zones, locks, or safety state; those are red.
7. Do not execute a write unless the operator granted the exact helper-reported
   `requiredGrant`. Include device/group ids, channel index, target value,
   rollback, and expected physical effect in the approval text.
8. Do not use shell `curl`, ad hoc WebSocket scripts, or cleartext headers when
   the gateway tool or helper output can express the request.

## Command Contract

Show helper usage:

```bash
node skills/homematic/homematic.cjs --help
```

Plan an explicit operation. The model should choose from the documented helper
operations instead of asking the helper to parse user prose:

```bash
node skills/homematic/homematic.cjs --format json plan get-state
node skills/homematic/homematic.cjs --format json plan set-set-point-temperature
```

Build HCU auth setup requests. The helper uses
`<secret:HOMEMATIC_HCU_ACTIVATION_KEY>` and
`<secret:HOMEMATIC_HCU_AUTH_TOKEN>` placeholders so the gateway resolves
stored secrets server-side.

```bash
node skills/homematic/homematic.cjs --format json http-request auth-token \
  --hcu-url https://hcu1-1234.local \
  --plugin-id com.example.hybridclaw.homematic

node skills/homematic/homematic.cjs --format json http-request confirm-token \
  --hcu-url https://hcu1-1234.local
```

Prepare read-only HCU Connect API messages:

```bash
node skills/homematic/homematic.cjs --format json websocket-message plugin-ready \
  --hcu-url https://hcu1-1234.local

node skills/homematic/homematic.cjs --format json websocket-message get-state \
  --hcu-url https://hcu1-1234.local

node skills/homematic/homematic.cjs --format json websocket-message get-system-state \
  --hcu-url https://hcu1-1234.local

node skills/homematic/homematic.cjs --format json --hmip-system-events websocket-message get-state \
  --hcu-url https://hcu1-1234.local
```

Run a local HCU WebSocket read. This is for operator-owned smoke tests where
the helper environment can see the stored token value; normal agent flows
should prefer generated payloads and gateway-managed secrets.
Use `--insecure-local-tls` only for operator-owned local/private HCU hosts with
self-signed certificates.

```bash
HOMEMATIC_HCU_AUTH_TOKEN="<token>" \
  node skills/homematic/homematic.cjs --format json run-websocket get-state \
  --hcu-url https://hcu1-1234.local
```

Generate policy material for local HCU network access and SecretRef routing:

```bash
node skills/homematic/homematic.cjs --format json policy-rules \
  --hcu-url https://hcu1-1234.local \
  --agent main
```

Prepare guarded write messages:

First produce an approval plan. After explicit operator confirmation, run the
exact `approvedCommand` unchanged.

```bash
node skills/homematic/homematic.cjs --format json approval-plan set-switch-state \
  --hcu-url https://hcu1-1234.local \
  --device-id 3014F711A000000000001234 \
  --channel-index 1 \
  --on true
```

```bash
node skills/homematic/homematic.cjs --format json websocket-message set-switch-state \
  --hcu-url https://hcu1-1234.local \
  --device-id 3014F711A000000000001234 \
  --channel-index 1 \
  --on true \
  --operator-grant approve-homematic-write

node skills/homematic/homematic.cjs --format json websocket-message set-set-point-temperature \
  --hcu-url https://hcu1-1234.local \
  --group-id 00000000-1111-2222-3333-444444444444 \
  --temperature 20.5 \
  --operator-grant approve-homematic-write

node skills/homematic/homematic.cjs --format json websocket-message set-shutter-level \
  --hcu-url https://hcu1-1234.local \
  --device-id 3014F711A000000000001234 \
  --channel-index 1 \
  --level 0.25 \
  --operator-grant approve-homematic-write

node skills/homematic/homematic.cjs --format json websocket-message acknowledge-safety-alarm \
  --hcu-url https://hcu1-1234.local \
  --operator-grant approve-homematic-security-write
```

Summarize a saved HCU state fixture without contacting hardware:

```bash
node skills/homematic/homematic.cjs --format json summarize-fixture \
  --fixture skills/homematic/fixtures/hcu-state.json
```

The helper returns `auditEvents` payloads for planned and live read/control
operations. These are structured for the F2 audit rail and intentionally carry
SecretRef ids, never secret values.

## Required Inputs

- HCU URL: use the local HCUweb hostname, usually
  `https://hcu1-XXXX.local`, where `XXXX` are the last four SGTIN digits shown
  on the underside of the Home Control Unit.
- Developer mode: enable HCU developer mode in HCUweb before creating remote
  Connect API credentials.
- WebSocket exposure: enable Connect API WebSocket exposure in HCUweb for
  remote-client reads and guarded message planning.
- Plugin id: use a stable reverse-DNS style id and keep it identical for auth
  enrollment and WebSocket messages.
- Credentials: store activation keys and auth tokens in HybridClaw secrets;
  never paste values into chat or CLI arguments.

## Access To Local Devices

HCU v1 requires local network reachability to `hcu1-XXXX.local` on HTTPS port
`6969` for remote-client auth enrollment and WSS port `9001` for Connect API
messages. On macOS, the terminal or agent host may need Local Network access
before `.local` mDNS names resolve or WebSocket connections succeed. If mDNS is
unavailable, use the HCU's local IP address and keep the host allowlist scoped
to that address.

CCU/RaspberryMatic and Homematic IP Access Point cloud setups are not HCU
Connect API endpoints. CCU/RaspberryMatic needs its local CCU API path, and the
Access Point cloud path uses a separate cloud REST API. Treat both as follow-up
compatibility work, not as prerequisites for this HCU skill.

## V1 Coverage

This helper emits `PLUGIN_STATE_RESPONSE` and `HMIP_SYSTEM_REQUEST` messages for
read/state and guarded native Homematic IP control paths. Connect API plugin
device inclusion (`DISCOVER_*`, `INCLUSION_EVENT`, `EXCLUSION_EVENT`),
plugin-device control/status (`CONTROL_*`, `STATUS_*`), HCUweb configuration
templates (`CONFIG_TEMPLATE_*`, `CONFIG_UPDATE_*`), system info, and user
message flows are intentionally deferred follow-up surfaces.

## References

- Official Homematic IP Connect API:
  https://github.com/homematicip/connect-api
- Connect API Java reference:
  https://github.com/homematicip/connect-api-java
- Documentation model:
  https://github.com/homematicip/connect-api-documentation-model
- OpenCCU-LTS context for cloud-free CCU deployments:
  https://github.com/homematicip/OpenCCU-LTS

Relevant HCU Connect API notes:

- Remote HCU plugins connect to `wss://hcu1-XXXX.local:9001`.
- WebSocket connection headers include `plugin-id` and `authtoken`.
- HCU auth enrollment uses HTTPS port `6969`, header `VERSION: 12`, and the
  `requestConnectApiAuthToken` / `confirmConnectApiAuthToken` endpoints.
- Add `hmip-system-events: true` to the WebSocket handshake when subscribing
  to HCU `HMIP_SYSTEM_EVENT` push messages.
- HCU system requests use `type: "HMIP_SYSTEM_REQUEST"` and a `body.path`
  such as `/hmip/home/getState`,
  `/hmip/device/control/setSwitchState`,
  `/hmip/group/heating/setSetPointTemperature`, or
  `/hmip/home/security/acknowledgeSafetyAlarm`.
- `/hmip/home/getState` is the HCU Connect API path. `/hmip/home/getCurrentState`
  belongs to the separate Homematic IP REST / Access Point API surface.
