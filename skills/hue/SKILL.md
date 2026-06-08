---
name: hue
description: "Read and control Philips Hue Bridge lighting installations through local CLIP v2 or the Hue Remote API with SecretRef-backed credentials and guarded lighting changes."
user-invocable: true
requires:
  bins:
    - node
config_variables:
  - id: hue-bridge-host
    env: HUE_BRIDGE_HOST
    required: true
    scope: "Local Hue Bridge HTTPS base URL used in gateway http_request URLs"
    how_to_obtain: "Find the bridge IP through the Hue app, router DHCP table, mDNS, or discovery.meethue.com, then store it in chat with `/env set HUE_BRIDGE_HOST \"https://192.168.1.30\"`."
credentials:
  - id: hue-application-key
    kind: api_key
    required: true
    secret_ref:
      source: store
      id: HUE_APPLICATION_KEY
    scope: "Philips Hue CLIP v2 hue-application-key header"
    how_to_obtain: "Press the bridge link button, build the link request with `node skills/hue/hue.cjs --format json bridge link --app-name hybridclaw --instance-name lab`, send its `httpRequest` through the gateway, then store the returned username in chat with `/secret set HUE_APPLICATION_KEY \"<username>\"`."
  - id: hue-remote-refresh-token
    kind: bearer
    required: false
    secret_ref:
      source: store
      id: HUE_REMOTE_REFRESH_TOKEN
    scope: "Hue Remote API OAuth token used for off-LAN API calls"
    how_to_obtain: "Create a Hue developer app, complete the Hue Remote API OAuth flow, and store the refresh/access token in chat with `/secret set HUE_REMOTE_REFRESH_TOKEN \"<token>\"`."
  - id: hue-remote-access-token
    kind: bearer
    required: false
    secret_ref:
      source: store
      id: HUE_REMOTE_ACCESS_TOKEN
    scope: "Hue Remote API short-lived access token used as Authorization bearer"
    how_to_obtain: "Run `node skills/hue/hue.cjs --format json remote oauth-token` after configuring the Remote API client id, client secret, and refresh token; the emitted gateway request captures the access token into `HUE_REMOTE_ACCESS_TOKEN`."
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
4. For amber/red operations, use the helper to build the request shape, explain
   the target and expected effect, and stop for explicit operator approval
   before sending the emitted `httpRequest` through the gateway.
5. Include the target light, grouped light, room, scene, behavior, bridge id,
   action, and expected physical effect in approval text.
6. Never paste the Hue application key, OAuth client secret, or remote token
   into chat. The helper emits `secretHeaders` or `<secret:...>` placeholders
   for gateway-side resolution.
7. Hue Bridge certificates are self-signed by default. The helper marks local
   bridge HTTPS requests with a scoped `allowSelfSignedTls` flag for the
   gateway `http_request` proxy. Do not use a blanket insecure TLS bypass.
8. If a live call returns `401` or `unauthorized_user`, stop after that first
   failed call and re-link the bridge with the link-button flow.
9. In chat sessions, do not diagnose Hue runtime config by running
   `hybridclaw env list`, `hybridclaw secret list`, or other local CLI commands
   from `bash`; those commands can inspect the wrong runtime or fail because of
   the host Node version. Use gateway `http_request` errors and any `/env show`
   or `/secret list` output the operator provides.
10. If `HUE_BRIDGE_HOST` is configured and `HUE_APPLICATION_KEY` is missing,
   say only that the application key is missing. Do not ask the operator to
   find the bridge IP again. Ask them to press the physical link button, then
   build `node skills/hue/hue.cjs --format json bridge link --app-name
   hybridclaw --instance-name lab`, send the emitted `httpRequest`, and store
   the returned `success.username` with `/secret set HUE_APPLICATION_KEY
   "<username>"`.
11. If `HUE_BRIDGE_HOST` is missing, first reuse an exact Hue Bridge URL from
   current context or workspace memory when one is present. Ask the operator to
   find the bridge IP only when no exact URL is available.
12. If a gateway `http_request` error says `Stored secret HUE_APPLICATION_KEY
   is not set`, treat `HUE_BRIDGE_HOST` as already resolved for that request.
   Do not say the bridge host may be missing, do not tell the operator to run
   `hybridclaw env set`, and do not repeat the same read calls. Switch directly
   to the link-button setup path in rule 10.
13. If a private-host or gateway policy denial blocks a local bridge request,
   first inspect the current workspace network policy. Managed read-only LAN
   access already allows GET reads to RFC1918 hosts, and managed read-write LAN
   access allows the supported methods. If either managed LAN mode covers the
   attempted Hue request, report that mismatch as a gateway policy-evaluation
   bug instead of adding another rule. Do not edit policy by hand, do not add
   broad bridge rules, and do not tell the operator a gateway restart is
   required; workspace network policy is read per request.

## Command Contract

The helper is deliberately thin: it only turns clean subject/verb arguments
into gateway-ready `httpRequest` payloads. It does not write env values, edit
network policy, call the gateway, poll the bridge, or store secrets.

Show helper usage:

```bash
node skills/hue/hue.cjs --help
```

Build local CLIP v2 read requests, then pass the emitted `httpRequest` object
to the gateway `http_request` tool:

```bash
node skills/hue/hue.cjs --format json bridge list
node skills/hue/hue.cjs --format json device list
node skills/hue/hue.cjs --format json light list
node skills/hue/hue.cjs --format json grouped-light list
node skills/hue/hue.cjs --format json room list
node skills/hue/hue.cjs --format json zone list
node skills/hue/hue.cjs --format json scene list
node skills/hue/hue.cjs --format json motion list
node skills/hue/hue.cjs --format json behavior list
node skills/hue/hue.cjs --format json entertainment list
```

Read a bounded diagnostic eventstream window:

```bash
node skills/hue/hue.cjs --format json eventstream read --duration 30s
```

Prepare guarded write operations:

```bash
node skills/hue/hue.cjs --format json light on --id <id>
node skills/hue/hue.cjs --format json light off --id <id>
node skills/hue/hue.cjs --format json light brightness --id <id> --pct 60
node skills/hue/hue.cjs --format json light color --id <id> --xy 0.4317,0.4147
node skills/hue/hue.cjs --format json light color --id <id> --mirek 366
node skills/hue/hue.cjs --format json grouped-light on --id <grouped_light_id>
node skills/hue/hue.cjs --format json grouped-light brightness --id <grouped_light_id> --pct 60
node skills/hue/hue.cjs --format json scene recall --id <scene_id>
node skills/hue/hue.cjs --format json behavior disable --id <behavior_id>
node skills/hue/hue.cjs --format json bridge timezone --id <bridge_id> --timezone Europe/Berlin
```

The helper marks amber and red operations with `requiredGrant`. Send the
emitted `httpRequest` only after the operator approves the described effect.

Link a bridge after pressing the physical link button:

```bash
node skills/hue/hue.cjs --format json bridge link \
  --app-name hybridclaw \
  --instance-name lab
```

The link command emits a single `/api` request shape. Send that request through
the gateway after pressing the link button, then store the returned
`success.username` as `HUE_APPLICATION_KEY`. It uses `<env:HUE_BRIDGE_HOST>` by
default; pass `--host` only to override the env-store bridge URL.

Use Remote API reads only when off-LAN access is needed:

```bash
node skills/hue/hue.cjs --format json remote oauth-token
node skills/hue/hue.cjs --format json remote bridge list
node skills/hue/hue.cjs --format json remote light list --bridge <id>
node skills/hue/hue.cjs --format json remote room list --bridge <id>
```

## Setup

Store the local bridge URL in the env store, then press the bridge link button,
build the link request, send the emitted `httpRequest` through the gateway, and
store the returned username as the application key.

In chat:

```text
/env set HUE_BRIDGE_HOST "https://192.168.1.30"
node skills/hue/hue.cjs --format json bridge link --app-name hybridclaw --instance-name lab
/secret set HUE_APPLICATION_KEY "<username-from-link-response>"
```

From a local terminal:

```bash
hybridclaw env set HUE_BRIDGE_HOST "https://192.168.1.30"
node skills/hue/hue.cjs --format json bridge link --app-name hybridclaw --instance-name lab
hybridclaw secret set HUE_APPLICATION_KEY "<username-from-link-response>"
```

Managed LAN HTTP access covers local RFC1918 bridge reads according to the
workspace policy setting. The helper does not create or modify that setting.

For the Hue Remote API, create a developer app, complete the OAuth flow, then
store the resulting values:

```text
/secret set HUE_REMOTE_CLIENT_ID "<oauth-client-id>"
/secret set HUE_REMOTE_CLIENT_SECRET "<oauth-client-secret>"
/secret set HUE_REMOTE_REFRESH_TOKEN "<refresh-token>"
node skills/hue/hue.cjs --format json remote oauth-token
/secret set HUE_REMOTE_BRIDGE_ID "<bridge-id>"
```

Or from a local terminal:

```bash
hybridclaw secret set HUE_REMOTE_CLIENT_ID "<oauth-client-id>"
hybridclaw secret set HUE_REMOTE_CLIENT_SECRET "<oauth-client-secret>"
hybridclaw secret set HUE_REMOTE_REFRESH_TOKEN "<refresh-token>"
node skills/hue/hue.cjs --format json remote oauth-token
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
- On gateway policy denial for a local bridge, inspect the current workspace
  network policy first. If managed read-only LAN access covers the GET read, or
  managed read-write LAN access covers the attempted method, report a gateway
  policy-evaluation bug and do not add a duplicate bridge rule. If LAN access
  is off, tell the operator which LAN HTTP access setting is missing. Do not
  tell the operator to restart the gateway.
- If policy denial persists despite a matching managed LAN setting, report the
  helper-emitted host, method, and path. Do not substitute Remote API results
  unless the operator asks for off-LAN fallback.
- On missing Hue configuration, report exactly which configured names are
  present and which are missing. If the gateway says `Stored secret
  HUE_APPLICATION_KEY is not set`, do not say `HUE_BRIDGE_HOST` is unknown or
  missing; the `<env:HUE_BRIDGE_HOST>` placeholder already resolved far enough
  to reach secret-header injection. In chat, give only this slash-command
  recovery path:

```text
Press the Hue bridge link button, then let me run:
node skills/hue/hue.cjs --format json bridge link --app-name hybridclaw --instance-name lab

Store the returned username with:
/secret set HUE_APPLICATION_KEY "<username-from-link-response>"
```

  Do not include `hybridclaw env set` or ask the operator to set
  `HUE_BRIDGE_HOST` again unless the gateway explicitly reports that
  `HUE_BRIDGE_HOST` itself is missing.
