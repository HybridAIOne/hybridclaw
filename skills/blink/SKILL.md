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
    scope: "Blink account email for OAuth v2 login"
    how_to_obtain: "In the TUI, use `/secret set BLINK_EMAIL \"<account email>\"`. From a shell, use `hybridclaw secret set BLINK_EMAIL \"<account email>\"`."
  - id: blink-password
    kind: api_key
    required: true
    secret_ref:
      source: store
      id: BLINK_PASSWORD
    scope: "Blink account password for OAuth v2 login"
    how_to_obtain: "In the TUI, use `/secret set BLINK_PASSWORD \"<account password>\"`. From a shell, use `hybridclaw secret set BLINK_PASSWORD \"<account password>\"`."
  - id: blink-auth-token
    kind: bearer
    required: false
    secret_ref:
      source: store
      id: BLINK_AUTH_TOKEN
    scope: "Blink OAuth bearer token captured after login or refresh"
    how_to_obtain: "Captured by `node skills/blink/blink.cjs --format json run account-login`."
  - id: blink-refresh-token
    kind: bearer
    required: false
    secret_ref:
      source: store
      id: BLINK_REFRESH_TOKEN
    scope: "Blink OAuth refresh token captured after login"
    how_to_obtain: "Captured by `node skills/blink/blink.cjs --format json run account-login`."
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
        - account-refresh
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
        - thumbnail-download
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

- Build and run all Blink API calls with `skills/blink/blink.cjs`; do not handcraft Blink URLs, auth headers, or JSON bodies when the helper supports the operation.
- Use `run` for live Blink calls. The helper sends its own request objects through the gateway `/api/http/request` path, so the model does not reconstruct endpoint details.
- Use `http-request` only as dry-run JSON for inspection or fallback direct `http_request` execution when helper live execution is unavailable. Pass emitted `httpRequest` fields as structured JSON; do not stringify nested fields such as `captureResponseFields` or `secretHeaders`.
- For ordinary operator requests, do not read or grep `skills/blink/blink.cjs` to debug the helper. Trust the helper output. Source inspection is for maintainers changing this skill, not for listing devices.
- Helper operations use subject-verb names (`devices-list`, `account-login`, `camera-motion-set`). Legacy aliases are accepted, but prefer the canonical names shown below.
- Credentials and tokens must stay in the SecretRef-backed runtime secret store; never ask the operator to paste `BLINK_PASSWORD` or `BLINK_AUTH_TOKEN` into chat, and never include either value in prose.
- Do not run `hybridclaw secret get`, call `/api/secret`, inspect `env`, or use `curl`/ad hoc scripts to fetch Blink secrets. If the helper reports missing session secrets such as `BLINK_TIER`, run `run account-refresh` once, then `run account-login` if refresh cannot recover the session; email/password may already be stored.
- `account-login` is implemented as OAuth v2 Authorization Code + PKCE in the helper. Run `node skills/blink/blink.cjs --format json run account-login`; do not call old password login endpoints and do not web-search or endpoint-probe inside the user task.
- The Blink-specific implementation lives under `skills/blink/`; the gateway pieces this skill relies on are generic `http_request` primitives for nested response capture, explicit token bind-domain capture, secret-backed headers, manual redirect inspection, and response-body suppression.
- The helper only emits allowlisted hosts: `rest-prod.immedia-semi.com` and `rest-<BLINK_TIER>.immedia-semi.com`; arbitrary host/path passthrough is not supported.
- Clip downloads must go through the gateway artifact path; return artifact handles or metadata only, and rely on the helper-emitted `suppressResponseBody: true` so raw video bytes do not enter model context.
- Live-view requests are red and operator-UI-only; the helper emits `suppressResponseBody: true`, and RTSP/HLS/session handles must not be copied into chat even after approval.
- Stop after the first 401, invalid-credentials, or verification-required response; do not retry, poll, or fan out more Blink calls until credentials or the PIN handover are resolved.
- Stop after a 426 `app update is required` response or OAuth `unsupported_grant_type`. Do not probe alternate Blink endpoints, try new User-Agents, or attempt OAuth `grant_type=password`; use the helper's OAuth v2 Authorization Code + PKCE path with cookie and redirect handling outside model context.

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

`BLINK_DEVICE_ID` and `BLINK_CLIENT_NAME` are not secrets. The helper generates a stable OAuth hardware id automatically; `BLINK_DEVICE_ID` is only an optional advanced override. `BLINK_CLIENT_NAME` is retained as a non-secret compatibility label and is not sent to Blink OAuth v2.

```bash
node skills/blink/blink.cjs --format json run account-login
```

Successful OAuth v2 login captures:

`BLINK_AUTH_TOKEN`, `BLINK_REFRESH_TOKEN`, `BLINK_TIER`, `BLINK_ACCOUNT_ID`,
and `BLINK_CLIENT_ID`. Do not ask the operator to set these manually after
login; the gateway writes them to the secret store automatically.

If Blink marks the client as unverified, it sends an email/SMS PIN. Use F14
durable handover to receive that PIN from the operator, then run the
login helper with the PIN:

```bash
node skills/blink/blink.cjs --format json run account-login --pin "<code>"
```

The PIN can appear in helper arguments because it is a short-lived operator
handover code; the password and auth token must never appear there.

## Helper Commands

Use this command surface directly:

```text
node skills/blink/blink.cjs [--format json|pretty] http-request <operation> [flags]
node skills/blink/blink.cjs [--format json|pretty] run <operation> [flags]
node skills/blink/blink.cjs [--format json|pretty] plan <operation> [flags]

run account-login [--pin <code>]
run account-refresh
run devices-list

http-request account-login
http-request account-refresh
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
http-request clips-list [--network <network-id>] --since 2026-05-26T00:00:00Z --page 0 --max 50
http-request clip-download --path /api/v2/accounts/<account-id>/media/clip/<file.mp4> [--filename clip.mp4]
http-request thumbnail-download --path /api/v3/media/accounts/<account-id>/networks/<network-id>/<camera-type>/<camera-id>/thumbnail/thumbnail.jpg?ts=<ts>&ext= [--filename camera.jpg]

plan network-arm --network <network-id>
plan network-disarm --network <network-id>
plan camera-motion-set --network <network-id> --camera <camera-id> --enable true
plan camera-thumbnail-refresh --network <network-id> --camera <camera-id> [--camera-type default|mini|doorbell]
plan clip-watched-mark --clip <clip-id>
plan clip-delete --clip <clip-id>
plan camera-live-view-start --network <network-id> --camera <camera-id> [--camera-type default|mini|doorbell]
```

Blink clip listing uses the account-scoped `media/changed` API. `clips-list --network <id>` is accepted for the issue-contract command shape, but the helper still calls the account-scoped endpoint and marks the requested network in metadata; filter returned clip metadata by that network before summarizing or choosing a clip path for `clip-download`.
For a current still image, run the approved `camera-thumbnail-refresh`, run `devices-list`, then pass the returned camera `thumbnail` path to `thumbnail-download`. Do not rewrite thumbnail paths onto `prod.immedia-semi.com`; the helper routes them through the authenticated `rest-<BLINK_TIER>.immedia-semi.com` host and stores the image as an artifact instead of exposing bytes in model context. Treat `updated_at`, `status: done`, and local file mtime as evidence that Blink accepted the refresh command, not as proof that the visual frame changed. Compare the returned artifact `sha256` with the prior camera thumbnail when one is available; if it is unchanged, say Blink refreshed the thumbnail command but returned the same image bytes instead of calling it a fresh screenshot.

`plan` emits no live side effect. It returns `approvalText`,
`approvedHelperCommandText`, the exact target host/path/method, and the
bounded `httpRequest` shape. Stop after producing the plan. Only after the
operator confirms that exact network/camera/clip/action through F8/F14, run
the approved helper command exactly.

## Read Workflow

1. Use `devices-list` first for a compact account overview; it includes networks, sync modules, cameras, and doorbell-like devices on current Blink accounts.
2. If `devices-list` returns `blink-login-required` or fails because `BLINK_AUTH_TOKEN`, `BLINK_REFRESH_TOKEN`, `BLINK_TIER`, or `BLINK_ACCOUNT_ID` is missing or stale, run `node skills/blink/blink.cjs --format json run account-refresh` once before `account-login`. Do not tell the operator all Blink credentials are missing just because token/tier/account session secrets are not set yet.
3. If refresh cannot recover the session, run `node skills/blink/blink.cjs --format json run account-login` once.
4. If login returns `handover-required`, ask for the Blink PIN via F14. When the operator provides the PIN, run exactly `node skills/blink/blink.cjs --format json run account-login --pin <code>`, then immediately run `node skills/blink/blink.cjs --format json run devices-list` if login succeeds. Do not read source, inspect secrets, call `http_request`, or try direct gateway/curl calls between those two helper commands.
5. If login or the PIN resume fails, report the helper error and stop. Do not guess alternate endpoints, read tokens, or retry a fresh login unless the helper explicitly returns another `handover-required`.
6. If login reports invalid credentials, app update, unsupported grant, or verification failure, stop immediately; do not try guessed `/api/v3`, `/api/v4`, `/api/v6`, OAuth password-grant, or User-Agent variants.
7. Use the narrower list commands when the operator asks for a specific network or device class; use `camera-config-read` for motion/video/illuminator settings and `camera-signals-read` for camera battery, Wi-Fi/sync signal, and temperature telemetry when the homescreen response is not enough.
8. For incident-card summaries, report concrete device ids/names, network ids, offline duration, low battery, poor signal, temperature, and motion bursts only from successful live Blink responses.

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
