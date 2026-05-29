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
    scope: "Blink account email for future OAuth v2 login support"
    how_to_obtain: "In the TUI, use `/secret set BLINK_EMAIL \"<account email>\"`. From a shell, use `hybridclaw secret set BLINK_EMAIL \"<account email>\"`."
  - id: blink-password
    kind: api_key
    required: true
    secret_ref:
      source: store
      id: BLINK_PASSWORD
    scope: "Blink account password for future OAuth v2 login support"
    how_to_obtain: "In the TUI, use `/secret set BLINK_PASSWORD \"<account password>\"`. From a shell, use `hybridclaw secret set BLINK_PASSWORD \"<account password>\"`."
  - id: blink-auth-token
    kind: bearer
    required: false
    secret_ref:
      source: store
      id: BLINK_AUTH_TOKEN
    scope: "Blink TOKEN_AUTH value captured after login"
    how_to_obtain: "Captured by a future OAuth v2 login flow. Existing stored tokens may still work for read operations."
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
        - account-login
        - devices-list
        - networks-list
        - network-status-read
        - sync-modules-list
        - cameras-list
        - camera-config-read
        - camera-signals-read
        - doorbells-list
        - motion-events-list
        - clips-list
        - clip-download
      amber:
        - pin-verify
        - network-arm
        - network-disarm
        - camera-motion-set
        - camera-thumbnail-refresh
        - clip-watched-mark
      red:
        - clip-delete
        - camera-live-view-start
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
- Pass the emitted `httpRequest` fields as structured JSON. Do not stringify nested fields such as `captureResponseFields` or `secretHeaders`.
- Helper operations use subject-verb names (`devices-list`, `account-login`, `camera-motion-set`). Legacy aliases are accepted, but prefer the canonical names shown below.
- Credentials and tokens must stay in the SecretRef-backed runtime secret store; never ask the operator to paste `BLINK_PASSWORD` or `BLINK_AUTH_TOKEN` into chat, and never include either value in prose.
- `account-login` is currently a hard-stop auth contract, not an `httpRequest`, because Blink deprecated the old password login path. If it returns `blink-oauth-v2-required`, stop and report that OAuth v2 support is needed; do not web-search, endpoint-probe, or offer to implement it inside the user task.
- The Blink-specific implementation lives under `skills/blink/`; the gateway pieces this skill relies on are generic `http_request` primitives for nested response capture, secret-backed headers, and response-body suppression.
- The helper only emits allowlisted hosts: `rest-prod.immedia-semi.com`, `rest-<BLINK_TIER>.immedia-semi.com`, and `prod.immedia-semi.com` for selected media artifact paths; arbitrary host/path passthrough is not supported.
- Clip downloads must go through the gateway artifact path; return artifact handles or metadata only, and rely on the helper-emitted `suppressResponseBody: true` so raw video bytes do not enter model context.
- Live-view requests are red and operator-UI-only; the helper emits `suppressResponseBody: true`, and RTSP/HLS/session handles must not be copied into chat even after approval.
- Stop after the first 401, invalid-credentials, or verification-required response; do not retry, poll, or fan out more Blink calls until credentials or the PIN handover are resolved.
- Stop after a 426 `app update is required` response or OAuth `unsupported_grant_type`. Do not probe alternate Blink endpoints, try new User-Agents, or attempt OAuth `grant_type=password`; the required path is OAuth v2 Authorization Code + PKCE with cookie and redirect handling outside model context.

## Setup

Store the initial secrets in the TUI:

```text
/secret set BLINK_EMAIL "<account email>"
/secret set BLINK_PASSWORD "<account password>"
```

Equivalent shell commands:

```bash
hybridclaw secret set BLINK_EMAIL "<account email>"
hybridclaw secret set BLINK_PASSWORD "<account password>"
```

`BLINK_DEVICE_ID` and `BLINK_CLIENT_NAME` are not secrets. They are reserved for a future OAuth v2 login implementation and are not needed for reads when `BLINK_AUTH_TOKEN`, `BLINK_TIER`, and `BLINK_ACCOUNT_ID` are already set.

```bash
node skills/blink/blink.cjs --format json http-request account-login
```

This currently returns `command: "auth-required"` and `reason:
"blink-oauth-v2-required"` instead of an `httpRequest`. A future successful
OAuth v2 login flow should capture:

`BLINK_AUTH_TOKEN`, `BLINK_TIER`, `BLINK_ACCOUNT_ID`, and `BLINK_CLIENT_ID`.
Do not ask the operator to set these manually after login; the gateway should
write them to the secret store automatically.

If Blink marks the client as unverified, it sends an email/SMS PIN. Use F14
durable handover to receive that PIN from the operator, then run the
`pin-verify` helper request with the PIN. The PIN can appear in the helper
arguments because it is a short-lived operator handover code; the password and
auth token must never appear there.

If Blink login is required, stop after the helper's `auth-required` result.
Do not fetch community issues, try app-version User-Agent strings, call the old
OAuth password grant, or ask the operator whether to implement OAuth in the
same task.

## Helper Commands

Use this command surface directly:

```text
node skills/blink/blink.cjs [--format json|pretty] http-request <operation> [flags]
node skills/blink/blink.cjs [--format json|pretty] plan <operation> [flags]

http-request account-login
http-request pin-verify --pin <code>
http-request devices-list
http-request networks-list
http-request network-status-read --network <network-id>
http-request sync-modules-list --network <network-id>
http-request cameras-list --network <network-id>
http-request camera-config-read --network <network-id> --camera <camera-id>
http-request camera-signals-read --network <network-id> --camera <camera-id>
http-request doorbells-list --network <network-id>
http-request motion-events-list --network <network-id> --since 2026-05-26T00:00:00Z
http-request clips-list --since 2026-05-26T00:00:00Z --page 0 --max 50
http-request clip-download --path /api/v2/accounts/<account-id>/media/clip/<file.mp4>

plan network-arm --network <network-id>
plan network-disarm --network <network-id>
plan camera-motion-set --network <network-id> --camera <camera-id> --enable true
plan camera-thumbnail-refresh --network <network-id> --camera <camera-id> [--camera-type default|mini|doorbell]
plan clip-watched-mark --clip <clip-id>
plan clip-delete --clip <clip-id>
plan camera-live-view-start --network <network-id> --camera <camera-id> [--camera-type default|mini|doorbell]
```

Blink clip listing uses the account-scoped `media/changed` API, so `clips-list` intentionally does not accept `--network`; use the returned clip metadata to choose a clip path for `clip-download`.

`plan` emits no live side effect. It returns `approvalText`,
`approvedHelperCommandText`, the exact target host/path/method, and the
bounded `httpRequest` shape. Stop after producing the plan. Only after the
operator confirms that exact network/camera/clip/action through F8/F14, run
the approved helper command exactly.

## Read Workflow

1. Use `devices-list` first for a compact account overview; it includes networks, sync modules, cameras, and doorbell-like devices on current Blink accounts.
2. If `devices-list` fails because `BLINK_AUTH_TOKEN`, `BLINK_TIER`, or `BLINK_ACCOUNT_ID` is missing or stale, run `http-request account-login` once.
3. If `account-login` returns `blink-oauth-v2-required`, stop and report that this skill needs OAuth v2 Authorization Code + PKCE support before it can log in. Do not try guessed `/api/v3`, `/api/v4`, `/api/v6`, OAuth password-grant, or User-Agent variants.
4. If a future login flow reports `verification_required`, `client_verification_required`, or similar invalid-credential text, stop immediately; for verification challenges, ask for F14 PIN handover and run `http-request pin-verify --pin <code>`.
5. Use the narrower list commands when the operator asks for a specific network or device class; use `camera-config-read` for motion/video/illuminator settings and `camera-signals-read` for camera battery, Wi-Fi/sync signal, and temperature telemetry when the homescreen response is not enough.
6. For incident-card summaries, report concrete device ids/names, network ids, offline duration, low battery, poor signal, temperature, and motion bursts only from successful live Blink responses.

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
