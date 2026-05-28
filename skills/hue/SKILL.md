---
name: hue
description: "Read and control Philips Hue Bridge lighting installations through local CLIP v2 or the Hue Remote API with SecretRef-backed credentials and guarded lighting changes."
user-invocable: true
requires:
  bins:
    - node
credentials:
  - id: hue-bridge-host
    kind: header
    required: true
    secret_ref:
      source: store
      id: HUE_BRIDGE_HOST
    scope: "Local Hue Bridge HTTPS base URL used by gateway http_request"
    how_to_obtain: "Find the bridge IP through the Hue app, router DHCP table, mDNS, or discovery.meethue.com, then store it with `hybridclaw secret set HUE_BRIDGE_HOST \"https://192.168.1.30\"`."
  - id: hue-application-key
    kind: api_key
    required: true
    secret_ref:
      source: store
      id: HUE_APPLICATION_KEY
    scope: "Philips Hue CLIP v2 hue-application-key header"
    how_to_obtain: "Press the bridge link button and run `node skills/hue/hue.cjs --format json link --host https://192.168.1.30 --tls-sha256-secret HUE_BRIDGE_TLS_SHA256 --app-name hybridclaw --instance-name lab`; the helper stores the returned key as `HUE_APPLICATION_KEY`."
  - id: hue-bridge-tls-sha256
    kind: header
    required: true
    secret_ref:
      source: store
      id: HUE_BRIDGE_TLS_SHA256
    scope: "Operator-pinned SHA-256 fingerprint for the local bridge TLS certificate"
    how_to_obtain: "Record the Hue Bridge certificate SHA-256 fingerprint out of band and store it with `hybridclaw secret set HUE_BRIDGE_TLS_SHA256 \"<sha256>\"`; do not disable TLS verification globally."
  - id: hue-remote-refresh-token
    kind: bearer
    required: false
    secret_ref:
      source: store
      id: HUE_REMOTE_REFRESH_TOKEN
    scope: "Hue Remote API OAuth token used for off-LAN API calls"
    how_to_obtain: "Create a Hue developer app, complete the Hue Remote API OAuth flow, and store the refresh/access token with `hybridclaw secret set HUE_REMOTE_REFRESH_TOKEN \"<token>\"`."
  - id: hue-remote-access-token
    kind: bearer
    required: false
    secret_ref:
      source: store
      id: HUE_REMOTE_ACCESS_TOKEN
    scope: "Hue Remote API short-lived access token used as Authorization bearer"
    how_to_obtain: "Run `node skills/hue/hue.cjs --format json http-request remote-oauth-token` after configuring the Remote API client id, client secret, and refresh token; the gateway captures the access token into `HUE_REMOTE_ACCESS_TOKEN`."
metadata:
  hybridclaw:
    category: home-automation
    short_description: "Philips Hue local CLIP v2 reads plus approval-gated light, group, scene, and automation control."
    tags:
      - hue
      - philips-hue
      - smart-home
      - lighting
      - r21
    related_roadmap:
      - R21.114
      - R48
    issue: 1118
    stakes_tiers:
      green:
        - local-bridge-list
        - local-device-list
        - local-light-list
        - local-grouped-light-list
        - local-room-list
        - local-zone-list
        - local-scene-list
        - local-motion-list
        - local-temperature-list
        - local-light-level-list
        - local-button-list
        - local-behavior-instance-list
        - local-entertainment-configuration-list
        - local-eventstream
      amber:
        - local-link-button
        - remote-oauth-token
        - remote-bridges
        - remote-light-list
        - local-light-on
        - local-light-off
        - local-light-brightness
        - local-light-color
        - local-group-on
        - local-group-off
        - local-group-brightness
        - local-group-color
        - local-room-on
        - local-room-off
        - local-group-recall-scene
        - local-scene-recall
        - local-behavior-enable
        - local-behavior-disable
        - local-scene-create
        - local-behavior-create
      red:
        - local-bridge-config-timezone
        - local-bridge-config-software-update
    escalation:
      writes: confirm-each
      route: f14
    cost_measurement:
      system: UsageTotals
      sub_limit_key: hue
---

# Philips Hue

Use this skill for Philips Hue Bridge lighting inspection and guarded control.
The primary path is local HTTPS to the Hue Bridge CLIP v2 API. Use the Hue
Remote API only when the operator explicitly needs off-LAN control or local
bridge access is unavailable.

## Safety Rules

1. Use `skills/hue/hue.cjs` for every supported Hue request shape. Do not
   handcraft CLIP v2 URLs or JSON bodies when the helper supports the action.
2. Read current light, room, zone, and scene state before changing lights.
3. Treat local reads as green, local light/group/scene/behavior changes as
   amber, off-LAN Remote API calls as amber, and bridge configuration writes as
   red.
4. For amber/red operations, run `plan` first and stop after the emitted
   `approval-plan`. Only after explicit operator approval in a later message,
   run the exact `approvedHelperCommandText`.
5. Include the target light, grouped light, room, scene, behavior, bridge id,
   action, and expected physical effect in approval text.
6. Never paste the Hue application key, OAuth client secret, or remote token
   into chat. The helper emits `secretHeaders` or `<secret:...>` placeholders
   for gateway-side resolution.
7. Hue Bridge certificates are self-signed by default. Use a pinned bridge
   certificate SHA-256 fingerprint or operator-supplied CA trust. Do not use a
   blanket insecure TLS bypass.
8. If a live call returns `401` or `unauthorized_user`, stop after that first
   failed call and re-link the bridge with the link-button flow.

## Command Contract

Show helper usage:

```bash
node skills/hue/hue.cjs --help
```

Build local CLIP v2 read requests. Pass the emitted `httpRequest` object to
the gateway `http_request` tool when not using helper live mode:

```bash
node skills/hue/hue.cjs --format json --request http-request bridge
node skills/hue/hue.cjs --format json --request http-request devices
node skills/hue/hue.cjs --format json --request http-request lights
node skills/hue/hue.cjs --format json --request http-request grouped-lights
node skills/hue/hue.cjs --format json --request http-request rooms
node skills/hue/hue.cjs --format json --request http-request zones
node skills/hue/hue.cjs --format json --request http-request scenes
node skills/hue/hue.cjs --format json --request http-request motion-sensors
node skills/hue/hue.cjs --format json --request http-request behavior-instances
node skills/hue/hue.cjs --format json --request http-request entertainment-configurations
```

Read a bounded diagnostic eventstream window:

```bash
node skills/hue/hue.cjs --format json --request http-request eventstream --duration 30s
```

Prepare guarded write operations. First produce an approval plan:

```bash
node skills/hue/hue.cjs --format json plan light-on --light <id>
node skills/hue/hue.cjs --format json plan light-off --light <id>
node skills/hue/hue.cjs --format json plan light-brightness --light <id> --pct 60
node skills/hue/hue.cjs --format json plan light-color --light <id> --xy 0.4317,0.4147
node skills/hue/hue.cjs --format json plan light-color --light <id> --mirek 366
node skills/hue/hue.cjs --format json plan group-on --group <grouped_light_id>
node skills/hue/hue.cjs --format json plan group-brightness --group <grouped_light_id> --pct 60
node skills/hue/hue.cjs --format json plan group-recall-scene --scene <id>
node skills/hue/hue.cjs --format json plan behavior-disable --behavior <id>
node skills/hue/hue.cjs --format json plan scene-create --name Evening --group <room_id> --group-type room --actions-json '[{"target":{"rid":"<light_id>","rtype":"light"},"action":{"on":{"on":true}}}]'
node skills/hue/hue.cjs --format json plan behavior-create --name Vacation --configuration-json '{"script_id":"example"}'
node skills/hue/hue.cjs --format json plan light-on --remote --remote-bridge <bridge-id> --light <id>
```

After explicit approval, run the helper command from
`approvedHelperCommandText` exactly. It includes `--operator-grant
approve-hue-write` for amber writes or `--operator-grant
approve-hue-bridge-config` for red bridge configuration writes.

Link a bridge after pressing the physical link button:

```bash
node skills/hue/hue.cjs --format json link \
  --host https://192.168.1.30 \
  --tls-sha256-secret HUE_BRIDGE_TLS_SHA256 \
  --app-name hybridclaw \
  --instance-name lab
```

The link helper polls `/api` for about 30 seconds via the gateway
`http_request` proxy and stores the returned application key as
`HUE_APPLICATION_KEY`. The helper output only reports the secret name captured;
it never prints the key.

Use Remote API reads only when off-LAN access is needed:

```bash
node skills/hue/hue.cjs --format json http-request remote-oauth-token
node skills/hue/hue.cjs --format json --request http-request remote-bridges
node skills/hue/hue.cjs --format json --request http-request remote-lights --bridge <id>
node skills/hue/hue.cjs --format json --request http-request remote-rooms --bridge <id>
```

## Setup

Store the local bridge URL and application key in the runtime secret store:

```bash
hybridclaw secret set HUE_BRIDGE_HOST "https://192.168.1.30"
hybridclaw secret set HUE_BRIDGE_TLS_SHA256 "<sha256-fingerprint>"
node skills/hue/hue.cjs --format json link --host https://192.168.1.30 --tls-sha256-secret HUE_BRIDGE_TLS_SHA256 --app-name hybridclaw --instance-name lab
```

Local bridge requests default to the `HUE_BRIDGE_TLS_SHA256` runtime secret.
Use `--tls-sha256` only for one-off diagnostics from an operator-owned
terminal.

For the Hue Remote API, create a developer app, complete the OAuth flow, then
store the resulting values:

```bash
hybridclaw secret set HUE_REMOTE_CLIENT_ID "<oauth-client-id>"
hybridclaw secret set HUE_REMOTE_CLIENT_SECRET "<oauth-client-secret>"
hybridclaw secret set HUE_REMOTE_REFRESH_TOKEN "<refresh-token>"
node skills/hue/hue.cjs --format json http-request remote-oauth-token
hybridclaw secret set HUE_REMOTE_BRIDGE_ID "<bridge-id>"
```

## Resource Coverage

The helper allowlists the initial CLIP v2 resource set from the OpenHue
OpenAPI contract and Philips Hue CLIP v2 docs: `bridge`, `device`, `light`,
`grouped_light`, `room`, `zone`, `scene`, `motion`, `temperature`,
`light_level`, `button`, `behavior_instance`, and
`entertainment_configuration`. Arbitrary `/clip/v2/resource/<type>` passthrough
is rejected.

## Result Handling

- Base answers on successful live Hue API results from the current turn.
- For scene recall, expect `recall: { action: "active" }`.
- For light/group color, use either XY coordinates or mirek color
  temperature, not both.
- Eventstream output can reveal occupancy. Keep diagnostic reads short and do
  not create a long-lived subscription from this skill.
- On gateway policy denial, report the policy failure and the helper-emitted
  host, method, and path. Do not substitute Remote API results unless the
  operator asks for off-LAN fallback.
