---
name: heygen
description: "Prepare guarded HeyGen Direct API requests for avatar video generation, video translation, asset discovery, and status polling."
user-invocable: true
requires:
  bins:
    - node
credentials:
  - id: heygen-api-key
    kind: api_key
    required: true
    secret_ref:
      source: store
      id: HEYGEN_API_KEY
    scope: HeyGen Direct API video generation and translation.
    how_to_obtain: "Create or regenerate the API token from HeyGen account settings. Set `HEYGEN_API_KEY` through browser admin at the active `/admin/secrets` route; if browser admin is unavailable, use `/secret set HEYGEN_API_KEY \"<api-key>\"` in browser `/chat` or TUI; local console fallback: `hybridclaw secret set HEYGEN_API_KEY \"<api-key>\"`."
metadata:
  hybridclaw:
    category: marketing
    short_description: "HeyGen avatar videos and translations through guarded API requests."
    tags:
      - heygen
      - avatar-video
      - video-translation
      - marketing
      - training
    related_roadmap:
      - R55
      - R55.1
    issue: 831
    sub_issue: 874
    stakes_tiers:
      green:
        - avatar-list
        - voice-list
        - language-list
        - video-status
        - translation-status
      amber:
        - video-generate
        - video-translate
      red:
        - public-auto-publish
    escalation:
      writes: confirm-each
      route: f8
    cost_measurement:
      system: UsageTotals
      sub_limit_contract: R5.4
      sub_limit_key: heygen
---

# HeyGen

Use this skill for HeyGen Direct API work: avatar and voice discovery, guarded
avatar video generation from approved scripts, video translation with lip-sync,
and polling asynchronous generation or translation status.

## Scope

- list available avatars, voices, and video-translation target languages
- create gateway-proxied requests for `POST /v2/videos`
- create gateway-proxied requests for `POST /v2/video_translate`
- poll `GET /v1/video_status.get` and `GET /v2/video_translate/{id}`
- classify and retry HeyGen 429, quota, and transient upstream responses with
  bounded `Retry-After` aware backoff
- block private or internal media URLs before asking HeyGen to fetch them
- require explicit operator grant before credit-consuming generate/translate calls

Custom avatar training, live streaming, real-time avatars, public publishing,
and distribution to external channels are outside this adapter slice.

## Credential Rules

HeyGen Direct API uses an API key sent as `X-API-KEY`. Store it in HybridClaw
encrypted runtime secrets; never paste it into the prompt.

Recommended setup order:

1. Browser admin: open the active HybridClaw admin URL ending in `/admin/secrets` and set
   `HEYGEN_API_KEY`.
2. Browser `/chat` or TUI fallback: `/secret set HEYGEN_API_KEY "<api-key>"`.
3. Local console fallback:

```bash
hybridclaw secret set HEYGEN_API_KEY "<api-key>"
```

For live API calls inside HybridClaw, prefer the helper's `request` command. It
sends the secret-backed payload through the local gateway, retries bounded
429/5xx responses, summarizes large asset lists by default, and fails clearly
if the gateway truncates a response.

Use `http-request` only when you need to inspect or hand off the generated
payload wrapper to the built-in `http_request` tool. The helper sets
`secretHeaders: [{ "name": "X-API-KEY", "secretName": "HEYGEN_API_KEY",
"prefix": "" }]` so the gateway injects the API key server-side.

Do not try to verify `HEYGEN_API_KEY` with bash, environment inspection, or by
asking the model whether the secret exists. The model cannot inspect the
gateway secret store. If the operator says the secret was set, attempt the
`http_request` call with the emitted `secretHeaders`. Only say the secret is
missing if `http_request` returns a gateway error that explicitly says
`HEYGEN_API_KEY` is not set, unavailable, missing, or unresolved.

## Default Workflow

1. Start with `request list-avatars` and `request list-voices` unless the
   avatar and voice ids are already known. These commands return concise
   summaries by default; use `--limit <count>` to show more candidates. Asset
   ids are opaque values; never use display names as `--avatar-id` or
   `--voice-id`.
2. Run the script through `/brand-voice` before generating avatar video from
   marketing, sales, training, or public-facing copy.
3. Use `plan` for natural-language generation or translation requests so the
   stakes tier and required grant are explicit.
4. Do not emit `generate-video` or `translate-video` requests unless the user
   has granted that exact credit-consuming operation in the current task or
   through an approved F8 escalation.
5. Poll status with `request video-status --watch` or
   `request translation-status --watch`. Use a bounded polling budget, respect
   `Retry-After`, avoid parallel polling loops, and stop if HeyGen reports
   quota, credit, or rate-limit failure.
6. Treat auto-publish to public channels as red tier and escalate before any
   upload, share link, social post, or public channel message.

## Command Contract

Run the colocated helper with Node:

```bash
node skills/heygen/heygen.cjs --help
```

Plan a request without contacting HeyGen:

```bash
node skills/heygen/heygen.cjs plan "Create an approved onboarding video from this script"
```

List avatars, voices, or translation languages. Asset lists use compact summary
output by default:

```bash
node skills/heygen/heygen.cjs request list-avatars --limit 10
node skills/heygen/heygen.cjs request list-voices --limit 10
node skills/heygen/heygen.cjs request list-translation-languages
```

Generate an avatar video only after explicit operator grant:

```bash
node skills/heygen/heygen.cjs http-request generate-video \
  --avatar-id avatar_123 \
  --voice-id voice_123 \
  --script "Approved script text" \
  --title "Quarterly enablement update" \
  --resolution 1080p \
  --aspect-ratio 16:9 \
  --operator-grant
```

Translate a video only after explicit operator grant:

```bash
node skills/heygen/heygen.cjs http-request translate-video \
  --video-url https://example.com/source.mp4 \
  --output-language de \
  --mode fast \
  --operator-grant
```

Poll status:

```bash
node skills/heygen/heygen.cjs request video-status --video-id <video-id>
node skills/heygen/heygen.cjs request video-status --video-id <video-id> --watch --max-polls 10 --interval-seconds 30
node skills/heygen/heygen.cjs request translation-status --video-translate-id <translation-id>
```

If you truly need a raw gateway payload for the built-in `http_request` tool:

```bash
node skills/heygen/heygen.cjs http-request list-avatars
```

Classify retry behavior after an API response:

```bash
node skills/heygen/heygen.cjs classify-rate-limit \
  --status 429 \
  --retry-after 5 \
  --body-json '{"message":"Too Many Requests"}'
```

## Stakes

Green tier:

- `list-avatars`
- `list-voices`
- `list-translation-languages`
- `video-status`
- `translation-status`

Amber tier:

- `generate-video`
- `translate-video`

Red tier:

- public auto-publish, social posting, public share-link distribution, or
  uploading generated media to a public channel

## Working Rules

- Never print or ask for the HeyGen API key.
- Prefer `request` for live API calls. Use `http-request` plus the built-in
  `http_request` tool only when a raw payload is necessary.
- Do not hand-author HeyGen `http_request` payloads. Use the helper output
  unchanged so `skillName`, secret injection, response limits, and cost
  metadata stay intact.
- Do not pipe asset-list responses through `head` or ask for the full JSON by
  default. Use `request list-avatars --limit <count>` or
  `request list-voices --limit <count>`. These commands cache concise asset
  summaries locally so `generate-video` can catch display names and stale ids
  before contacting HeyGen.
- Pass `--skip-cache-validation` only for a known private/custom asset id
  supplied by the operator and not present in the cached asset list.
- Do not claim `HEYGEN_API_KEY` is missing unless `http_request` returns an
  explicit missing/forbidden/unresolved secret error.
- Keep scripts at or below 5000 characters for the direct video endpoint.
- Do not pass localhost, loopback, RFC1918, link-local, or other internal media
  URLs to HeyGen.
- Honor `Retry-After` on HTTP 429 and back off on quota/rate-limit messages.
- Poll with `--watch` only when the user expects you to wait. Keep polling
  bounded with `--max-polls` and `--interval-seconds`; otherwise perform one
  status check and report the id so the session can resume later.
- Use `request` or `skills/heygen/client.cjs` when direct execution is needed;
  it sends the generated `httpRequest` through `/api/http/request`, never adds
  cleartext HeyGen credentials to process output, retries bounded 429/5xx
  responses, and refuses truncated gateway bodies instead of parsing partial
  JSON.
- Avoid concurrent generate/translate bursts; HeyGen quotas are account and
  plan dependent.
- Cost per assistant run is recorded by HybridClaw `UsageTotals`; helper output
  includes `costMeasurement.system = "UsageTotals"` so evals can verify the
  accounting contract.

## References

- HeyGen Quick Start:
  https://docs.heygen.com/
- Generate video endpoint:
  https://docs.heygen.com/reference/create-video-1
- Translate video endpoint:
  https://docs.heygen.com/reference/video-translate
- API limits and costs:
  https://docs.heygen.com/reference/limits

## Validation

Run:

```bash
python3 skills/skill-creator/scripts/quick_validate.py skills/heygen
node skills/heygen/heygen.cjs --help
node skills/heygen/heygen.cjs eval-scenarios
```
