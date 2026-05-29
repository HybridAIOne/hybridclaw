---
name: blink
description: "Read Blink camera and video-doorbell state, list motion clips, and prepare guarded home-security control requests without exposing Blink credentials."
user-invocable: true
requires:
  bins:
    - node
credentials:
  - id: blink-email
    kind: api_key
    required: true
    secret_ref:
      source: store
      id: BLINK_EMAIL
    scope: "Blink account email for the login request body"
    how_to_obtain: "Store the Blink account email with `hybridclaw secret set BLINK_EMAIL \"<account email>\"`."
  - id: blink-password
    kind: api_key
    required: true
    secret_ref:
      source: store
      id: BLINK_PASSWORD
    scope: "Blink account password for first login only"
    how_to_obtain: "Store the Blink account password with `hybridclaw secret set BLINK_PASSWORD \"<account password>\"`."
  - id: blink-auth-token
    kind: bearer
    required: false
    secret_ref:
      source: store
      id: BLINK_AUTH_TOKEN
    scope: "Blink TOKEN_AUTH value captured after login"
    how_to_obtain: "Run the helper login flow through gateway `http_request`; the response capture writes this secret."
metadata:
  hybridclaw:
    category: home-automation
    short_description: "Blink camera, video doorbell, motion clip, and guarded privacy-control workflows."
    tags:
      - blink
      - camera
      - video-doorbell
      - home-security
      - smart-home
    stakes_tiers:
      green:
        - login
        - homescreen
        - networks
        - network-status
        - sync-modules
        - cameras
        - camera-config
        - camera-signals
        - doorbells
        - motion-events
        - clips
        - clip-download
      amber:
        - verify-pin
        - arm-network
        - disarm-network
        - camera-motion
        - thumbnail
        - mark-clip-watched
      red:
        - delete-clip
        - live-view
    escalation:
      writes: confirm-each
      route: f14
    cost_measurement:
      system: UsageTotals
      sub_limit_key: blink
---

# Blink

Use this skill for Blink camera, video doorbell, network arm-state, motion
event, and clip-metadata workflows. Blink does not publish an official public
API; this skill follows the bounded community API surface used by BlinkPy,
BlinkMonitorProtocol, and Home Assistant. Treat endpoint behavior as
best-effort and stop on the first authentication or verification failure.

## Core Contract

- Build all Blink API calls with `skills/blink/blink.cjs`; do not handcraft Blink URLs, auth headers, or JSON bodies when the helper supports the operation.
- Use the emitted `httpRequest` object with the gateway `http_request` tool; do not use shell `curl` for live Blink calls.
- Credentials and tokens must stay in the SecretRef-backed runtime secret store; never ask the operator to paste `BLINK_PASSWORD` or `BLINK_AUTH_TOKEN` into chat, and never include either value in prose.
- The Blink-specific implementation lives under `skills/blink/`; the gateway pieces this skill relies on are generic `http_request` primitives for nested response capture, secret-backed headers, and response-body suppression.
- The helper only emits allowlisted hosts: `rest-prod.immedia-semi.com`, `rest-<BLINK_TIER>.immedia-semi.com`, and `prod.immedia-semi.com` for selected media artifact paths; arbitrary host/path passthrough is not supported.
- Clip downloads must go through the gateway artifact path; return artifact handles or metadata only, and rely on the helper-emitted `suppressResponseBody: true` so raw video bytes do not enter model context.
- Live-view requests are red and operator-UI-only; the helper emits `suppressResponseBody: true`, and RTSP/HLS/session handles must not be copied into chat even after approval.
- Stop after the first 401, invalid-credentials, or verification-required response; do not retry, poll, or fan out more Blink calls until credentials or the PIN handover are resolved.

## Setup

Store the initial secrets:

```bash
hybridclaw secret set BLINK_EMAIL "<account email>"
hybridclaw secret set BLINK_PASSWORD "<account password>"
```

`BLINK_DEVICE_ID` and `BLINK_CLIENT_NAME` are not secrets. `BLINK_CLIENT_NAME` is only the display name shown in the Blink app and defaults to `hybridclaw`. `BLINK_DEVICE_ID` is the stable client identifier sent as Blink `unique_id`; the helper generates a deterministic `hybridclaw-<uuid>` value from the local HybridClaw environment when unset. Override either with environment variables or login flags when you need a specific client identity:

```bash
BLINK_DEVICE_ID="hybridclaw-<stable uuid>" BLINK_CLIENT_NAME="hybridclaw" \
  node skills/blink/blink.cjs --format json http-request login

node skills/blink/blink.cjs --format json http-request login \
  --device-id "hybridclaw-<stable uuid>" --client-name "hybridclaw"
```

The first successful login captures:

```bash
hybridclaw secret set BLINK_AUTH_TOKEN "<token>"
hybridclaw secret set BLINK_TIER "<rest tier, e.g. e003>"
hybridclaw secret set BLINK_ACCOUNT_ID "<numeric account id>"
hybridclaw secret set BLINK_CLIENT_ID "<numeric client id>"
```

If Blink marks the client as unverified, it sends an email/SMS PIN. Use F14
durable handover to receive that PIN from the operator, then run the
`verify-pin` helper request with the PIN. The PIN can appear in the helper
arguments because it is a short-lived operator handover code; the password and
auth token must never appear there.

## Helper Commands

Use this command surface directly:

```text
node skills/blink/blink.cjs [--format json|pretty] http-request <operation> [flags]
node skills/blink/blink.cjs [--format json|pretty] plan <operation> [flags]

http-request login [--device-id <stable-id>] [--client-name <name>]
http-request verify-pin --pin <code>
http-request homescreen
http-request networks
http-request network-status --network <network-id>
http-request sync-modules --network <network-id>
http-request cameras --network <network-id>
http-request camera-config --network <network-id> --camera <camera-id>
http-request camera-signals --network <network-id> --camera <camera-id>
http-request doorbells --network <network-id>
http-request motion-events --network <network-id> --since 2026-05-26T00:00:00Z
http-request clips --since 2026-05-26T00:00:00Z --page 0 --max 50
http-request clip-download --path /api/v2/accounts/<account-id>/media/clip/<file.mp4>

plan arm-network --network <network-id>
plan disarm-network --network <network-id>
plan camera-motion --network <network-id> --camera <camera-id> --enable true
plan thumbnail --network <network-id> --camera <camera-id> [--camera-type default|mini|doorbell]
plan mark-clip-watched --clip <clip-id>
plan delete-clip --clip <clip-id>
plan live-view --network <network-id> --camera <camera-id> [--camera-type default|mini|doorbell]
```

Blink clip listing uses the account-scoped `media/changed` API, so `clips` intentionally does not accept `--network`; use the returned clip metadata to choose a clip path for `clip-download`.

`plan` emits no live side effect. It returns `approvalText`,
`approvedHelperCommandText`, the exact target host/path/method, and the
bounded `httpRequest` shape. Stop after producing the plan. Only after the
operator confirms that exact network/camera/clip/action through F8/F14, run
the approved helper command exactly.

## Read Workflow

1. Run `http-request login` if `BLINK_AUTH_TOKEN`, `BLINK_TIER`, `BLINK_ACCOUNT_ID`, or `BLINK_CLIENT_ID` is missing or stale.
2. If the login response or gateway result reports status 401/412, `verification_required`, `client_verification_required`, or similar invalid-credential text, stop immediately; for verification challenges, ask for F14 PIN handover and run `http-request verify-pin --pin <code>`.
3. Use `homescreen` first for a compact account overview; it includes networks, sync modules, cameras, and doorbell-like devices on current Blink accounts.
4. Use the narrower list commands when the operator asks for a specific network or device class; use `camera-config` for motion/video/illuminator settings and `camera-signals` for camera battery, Wi-Fi/sync signal, and temperature telemetry when the homescreen response is not enough.
5. For incident-card summaries, report concrete device ids/names, network ids, offline duration, low battery, poor signal, temperature, and motion bursts only from successful live Blink responses.

## Guarded Writes

Network arm/disarm, per-camera motion detection, thumbnail snapshots,
clip-state changes, deletion, and live view all affect privacy or retention.
They are amber/red and require exact F8/F14 approval with the target network,
camera, clip, and action in the approval text.

Do not perform destructive maintenance, account changes, password changes,
notification setting changes, or firmware actions through this skill.

## References

- BlinkPy: https://github.com/fronzbot/blinkpy
- BlinkMonitorProtocol: https://github.com/MattTW/BlinkMonitorProtocol
- Home Assistant Blink integration: https://www.home-assistant.io/integrations/blink/
