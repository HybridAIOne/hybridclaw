---
name: alexa
description: "Expose HybridClaw as a custom Alexa skill and prepare guarded Alexa smart-home/device control payloads without exposing Amazon credentials."
user-invocable: true
requires:
  bins:
    - node
credentials:
  - id: alexa-ask-skill-id
    kind: header
    required: true
    secret_ref:
      source: store
      id: ALEXA_ASK_SKILL_ID
    scope: "Alexa Skills Kit applicationId verification for inbound custom skill requests"
    how_to_obtain: |
      Create a custom Alexa skill in the Alexa developer console and store the
      skill id with `hybridclaw secret set ALEXA_ASK_SKILL_ID "amzn1.ask.skill.<uuid>"`.
  - id: alexa-lwa-client-id
    kind: oauth
    required: true
    secret_ref:
      source: store
      id: ALEXA_LWA_CLIENT_ID
    scope: "Login with Amazon account linking client id"
    how_to_obtain: |
      Configure Login with Amazon account linking for the Alexa skill and store
      the OAuth client id with `hybridclaw secret set ALEXA_LWA_CLIENT_ID "amzn1.application-oa2-client.<id>"`.
  - id: alexa-lwa-client-secret
    kind: oauth
    required: true
    secret_ref:
      source: store
      id: ALEXA_LWA_CLIENT_SECRET
    scope: "Login with Amazon account linking client secret"
    how_to_obtain: |
      Store the LWA client secret with
      `hybridclaw secret set ALEXA_LWA_CLIENT_SECRET "<client secret>"`.
  - id: alexa-smarthome-refresh-token
    kind: oauth
    required: false
    secret_ref:
      source: store
      id: ALEXA_SMARTHOME_REFRESH_TOKEN
    scope: "Alexa Smart Home Skill API token refresh"
    how_to_obtain: |
      Complete the Smart Home Skill OAuth flow and store the refresh token with
      `hybridclaw secret set ALEXA_SMARTHOME_REFRESH_TOKEN "<refresh token>"`.
  - id: alexa-smarthome-access-token
    kind: bearer
    required: false
    secret_ref:
      source: store
      id: ALEXA_SMARTHOME_ACCESS_TOKEN
    scope: "Short-lived Alexa Smart Home Event Gateway bearer token"
    how_to_obtain: |
      Mint this from the stored Smart Home refresh token outside the prompt and
      route it through the SecretRef rail.
  - id: alexa-refresh-cookie
    kind: header
    required: false
    secret_ref:
      source: store
      id: ALEXA_REFRESH_COOKIE
    scope: "Opt-in community Alexa Remote / alexapy-compatible session cookie"
    how_to_obtain: |
      Only enable the community surface after operator approval. Invoke
      `/alexa set up Echo control for amazon.de and store the cookie` from a
      local HybridClaw session so the Alexa auth helper can run Amazon's device
      login flow, exchange the captured refresh token, and store the resulting
      full Cookie header.
metadata:
  hybridclaw:
    category: home-automation
    short_description: "ASK custom skill verification plus guarded Alexa smart-home and Alexa Remote planning."
    tags:
      - alexa
      - ask
      - smart-home
      - voice
      - r21
    related_roadmap:
      - R21
      - R48
    issue: 1117
    stakes_tiers:
      green:
        - ask-verify
        - ask-parse
        - ask-response
        - smarthome-discover
        - smarthome-state
        - devices
        - shopping-list
        - todo-list
        - last-commands
        - dnd-state
      amber:
        - announce
        - shopping-list-add
        - todo-list-add
        - music-play
        - routine-trigger
        - smarthome-turn-on
        - smarthome-turn-off
        - smarthome-brightness
        - smarthome-color
      red:
        - voice-command
        - smarthome-thermostat
        - safety-affecting-routine
    escalation:
      writes: confirm-each
      route: f14
    cost_measurement:
      system: UsageTotals
      sub_limit_key: alexa
---

# Alexa

Use this skill for Amazon Alexa workflows in two narrow modes:

1. Expose HybridClaw as a custom Alexa skill through the Alexa Skills Kit (ASK).
2. Prepare guarded Alexa-as-device reads and write plans for the official Smart
   Home Skill API and the opt-in community Alexa Remote / `alexapy` surface.

Do not use this skill for arbitrary Amazon API calls, shopping account access,
or browser automation. Keep all credentials behind SecretRef and use the helper
to build bounded payloads instead of hand-writing URLs, headers, cookies, or
request bodies.

## Safety Rules

1. Validate every inbound ASK request before parsing slots or running an agent
   bridge. Reject invalid `Signature`, invalid `SignatureCertChainUrl`, signing
   certificates that do not cover `echo-api.amazon.com`, or timestamp drift of
   150 seconds or more.
2. Never persist or echo Login with Amazon access tokens. The request token maps
   to a HybridClaw operator session outside the prompt through the F13 SecretRef
   rail.
3. Model output sent back to Alexa must be TTS-safe. Use `build-response` so
   markdown, code blocks, and very long URLs are stripped before SSML is built.
4. Path-B reads are green but privacy-sensitive because devices, list contents,
   routines, and last-command history can reveal household behavior.
5. Path-B writes are amber/red. Announcements, list mutations, device control,
   and routine triggers require exact F8/F14 approval that names the target room
   or device and the action.
6. Stop after the first `401`, `403`, or `INVALID_AUTHORIZATION_CREDENTIAL`
   response. Emit or surface `event: alexa.relink_required`; do not retry-loop.
7. The community cookie path is reverse-engineered and can break when Amazon
   changes web/API behavior. Treat it as opt-in and operationally brittle.
8. Do not accept Amazon passwords, refresh cookies, LWA tokens, or Smart Home
   tokens in chat or CLI flags. Store them with `hybridclaw secret set ...`.

## Command Contract

Show helper usage:

```bash
node skills/alexa/alexa.cjs --help
```

Validate an inbound ASK request body exactly as received by the HTTPS endpoint:

```bash
node skills/alexa/alexa.cjs --format json verify-request \
  --request-body /tmp/alexa-request.json \
  --signature-cert-url "$SIGNATURE_CERT_CHAIN_URL" \
  --signature "$SIGNATURE"
```

Exchange a linked Alexa account token for a HybridClaw operator-session handle
outside model-visible output:

```bash
node skills/alexa/alexa.cjs --format json account-link-session \
  --request-body /tmp/alexa-request.json
```

Parse a validated ASK request envelope into a bounded agent bridge:

```bash
node skills/alexa/alexa.cjs --format json parse-request \
  --request-body /tmp/alexa-request.json
```

Build a voice-safe ASK response:

```bash
node skills/alexa/alexa.cjs --format json build-response \
  --speech "On it. I'll text you when it's done." \
  --reprompt "Anything else?"
```

Prepare Smart Home Skill API payloads:

```bash
node skills/alexa/alexa.cjs --format json http-request smarthome-discover

node skills/alexa/alexa.cjs --format json http-request smarthome-state \
  --endpoint-id light-kitchen

node skills/alexa/alexa.cjs --format json plan smarthome-control \
  --endpoint-id light-kitchen \
  --action TurnOn

node skills/alexa/alexa.cjs --format json http-request smarthome-control \
  --endpoint-id light-kitchen \
  --action TurnOn \
  --operator-grant approve-alexa-write

node skills/alexa/alexa.cjs --format json plan smarthome-control \
  --endpoint-id thermostat-hallway \
  --action SetTargetTemperature \
  --temperature 20.5
```

Prepare community Alexa Remote / `alexapy` read payloads:

```bash
node skills/alexa/alexa.cjs --format json http-request devices \
  --amazon-domain amazon.de

node skills/alexa/alexa.cjs --format json http-request shopping-list
node skills/alexa/alexa.cjs --format json http-request todo-list
node skills/alexa/alexa.cjs --format json http-request last-commands
node skills/alexa/alexa.cjs --format json http-request dnd-state --device living-room
```

Prepare guarded community writes. First show the approval text to the operator.
After explicit approval, run the exact `approvedCommand` unchanged.
For Echo music playback, first call `http-request devices`, find the matching
`accountName` (for example `OK Computer`), then pass its `serialNumber`,
`deviceType`, and `deviceOwnerCustomerId` to `music-play`.

```bash
node skills/alexa/alexa.cjs --format json plan announce \
  --device living-room \
  --text "Package delivered."

node skills/alexa/alexa.cjs --format json http-request announce \
  --device living-room \
  --text "Package delivered." \
  --operator-grant approve-alexa-write

node skills/alexa/alexa.cjs --format json plan music-play \
  --device "<serialNumber from devices>" \
  --device-name "OK Computer" \
  --device-type "<deviceType from devices>" \
  --customer-id "<deviceOwnerCustomerId from devices>" \
  --query "Münchner Freiheit" \
  --provider AMAZON_MUSIC \
  --amazon-domain amazon.de

node skills/alexa/alexa.cjs --format json http-request music-play \
  --device "<serialNumber from devices>" \
  --device-name "OK Computer" \
  --device-type "<deviceType from devices>" \
  --customer-id "<deviceOwnerCustomerId from devices>" \
  --query "Münchner Freiheit" \
  --provider AMAZON_MUSIC \
  --amazon-domain amazon.de \
  --operator-grant approve-alexa-write
```

Use `voice-command` only as a last-resort equivalent of typing/speaking a
command into Alexa, because it can trigger arbitrary Alexa behavior. Prefer
specific helpers such as `music-play`, `announce`, list actions, routines, or
Smart Home directives when they cover the task.

```bash
node skills/alexa/alexa.cjs --format json plan voice-command \
  --device "<serialNumber from devices>" \
  --device-name "OK Computer" \
  --device-type "<deviceType from devices>" \
  --customer-id "<deviceOwnerCustomerId from devices>" \
  --voice-command "play Münchner Freiheit" \
  --amazon-domain amazon.de

node skills/alexa/alexa.cjs --format json http-request voice-command \
  --device "<serialNumber from devices>" \
  --device-name "OK Computer" \
  --device-type "<deviceType from devices>" \
  --customer-id "<deviceOwnerCustomerId from devices>" \
  --voice-command "play Münchner Freiheit" \
  --amazon-domain amazon.de \
  --operator-grant approve-alexa-red-write
```

```bash
node skills/alexa/alexa.cjs --format json http-request shopping-list-add \
  --item milk \
  --operator-grant approve-alexa-write

node skills/alexa/alexa.cjs --format json http-request shopping-list-complete \
  --item-id item-123 \
  --operator-grant approve-alexa-write

node skills/alexa/alexa.cjs --format json http-request todo-list-add \
  --item "call plumber" \
  --operator-grant approve-alexa-write

node skills/alexa/alexa.cjs --format json http-request todo-list-complete \
  --item-id item-456 \
  --operator-grant approve-alexa-write

node skills/alexa/alexa.cjs --format json http-request routine-trigger \
  --routine evening \
  --operator-grant approve-alexa-write
```

## Required Setup

Path A custom ASK skill:

```bash
hybridclaw secret set ALEXA_ASK_SKILL_ID "amzn1.ask.skill.<uuid>"
hybridclaw secret set ALEXA_LWA_CLIENT_ID "amzn1.application-oa2-client.<id>"
hybridclaw secret set ALEXA_LWA_CLIENT_SECRET "<lwa client secret>"
```

Path B Smart Home Skill API:

```bash
hybridclaw secret set ALEXA_SMARTHOME_CLIENT_ID "<smart-home oauth client id>"
hybridclaw secret set ALEXA_SMARTHOME_CLIENT_SECRET "<smart-home oauth client secret>"
hybridclaw secret set ALEXA_SMARTHOME_REFRESH_TOKEN "<refresh token>"
```

Path B community Alexa Remote / `alexapy` surface:

```bash
hybridclaw secret set ALEXA_AMAZON_DOMAIN "amazon.de"
```

Use HybridClaw or slash commands for operator setup. Do not ask the operator to
install or run external auth tools.

Start a local session and invoke the Alexa skill:

```bash
hybridclaw tui
```

Then use these prompts:

```text
/alexa set up Echo control for amazon.de and store the cookie
/alexa list my Alexa devices for amazon.de
/alexa play Münchner Freiheit on OK Computer
```

For a CLI-only operator, the same requests can be sent through any HybridClaw
channel that supports slash skill invocation:

```text
/skill alexa set up Echo control for amazon.de and store the cookie
/skill alexa list my Alexa devices for amazon.de
/skill alexa play Münchner Freiheit on OK Computer
```

When handling the setup prompt, run the bundled auth helper from the agent
workspace. For slash handling, use detached mode so the local browser proxy
survives while the operator completes Amazon login, OTP, and CVF pages across
turns:

```bash
node skills/alexa/alexa-auth.cjs setup --domain amazon.de --write-secret --detach --timeout-ms 600000
```

Return the `proxyUrl` from the helper output to the operator. When the operator
comes back after login, check the same setup with:

```bash
node skills/alexa/alexa-auth.cjs status --domain amazon.de
```

Do not keep the setup proxy alive with ad hoc shell process management.
Detached mode is the supported lifecycle: it writes a status file, keeps the
proxy process alive after the slash turn ends, and stores the secret itself
after Amazon returns the token.

If invoking non-detached foreground setup through a shell tool, set that tool
timeout to at least `600000` ms too. Browser login, OTP, CAPTCHA, and Safari
handoff regularly take longer than 60 seconds; killing the shell command also
kills the local proxy and produces Safari errors such as "server unexpectedly
closed the connection" on `127.0.0.1:<port>/www.amazon.com/ap/signin`.

The bundled helper owns the browser proxy and token callback. It uses Amazon's
expected domain rules: for western marketplaces such as `amazon.de`, the proxy
base is `amazon.com` and the marketplace stays `amazon.de`. If the browser shows
Amazon's "Suchst du etwas?" 404 page at the local proxy URL, or login completes
but no `Atnr|...` token is returned to the terminal, stop that run and restart
through `alexa-auth.cjs`.

The helper starts Amazon's Alexa device-login flow on a local callback port,
captures the resulting `Atnr|...` refresh token, exchanges it for Alexa Remote
cookies through Amazon's token exchange endpoint, verifies the account against
the regional Alexa Remote API (`layla.amazon.com` for `amazon.de`), stores
`ALEXA_REFRESH_COOKIE` when requested, and returns device metadata. Re-run the
same slash setup prompt when Amazon expires the stored cookie. Port `8080` is
preferred for compatibility with the cookie helper, but HybridClaw automatically
uses another free local port when `8080` is already occupied.

If using HybridClaw's direct `http_request` helper path instead of invoking
the browser setup flow, `ALEXA_REFRESH_COOKIE` must be the complete `Cookie`
header for an authenticated Alexa Remote API request such as
`https://alexa.amazon.de/api/devices-v2/device`. A single cookie value such as
`session-id` or `ubid-main` is not enough. Do not paste Amazon passwords,
one-time codes, or raw tokens into chat; store only the resulting cookie header
through the HybridClaw secret store. The `alexa-auth.cjs import-cookie` helper
can store a cookie with `--write-secret` only when a local JSON file exposes a
recognizable full cookie header.

Use the community credentials only for operator-approved, opt-in workflows.
Amazon OTP or CAPTCHA prompts require F14 2FA handover. The helper output uses
`<secret:...>` placeholders and SecretRef names, never cleartext values.

## References

- Alexa Skills Kit overview:
  <https://developer.amazon.com/en-US/docs/alexa/ask-overviews/build-skills-with-the-alexa-skills-kit.html>
- ASK request and response JSON:
  <https://developer.amazon.com/en-US/docs/alexa/custom-skills/request-and-response-json-reference.html>
- ASK web service signature and timestamp validation:
  <https://developer.amazon.com/en-US/docs/alexa/custom-skills/host-a-custom-skill-as-a-web-service.html>
- Account linking with Login with Amazon:
  <https://developer.amazon.com/en-US/docs/alexa/account-linking/understand-account-linking.html>
- Smart Home Skill API:
  <https://developer.amazon.com/en-US/docs/alexa/smarthome/understand-the-smart-home-skill-api.html>
- ASK SDK for Node.js:
  <https://github.com/alexa/alexa-skills-kit-sdk-for-nodejs>
- `alexapy`:
  <https://gitlab.com/keatontaylor/alexapy>
