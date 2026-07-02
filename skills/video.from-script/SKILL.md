---
name: video.from-script
description: "Render approved avatar + voice + script briefs into HeyGen MP4 videos with async job polling."
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
    scope: HeyGen Direct API avatar video generation.
    how_to_obtain: "Create or regenerate the API token from HeyGen account settings. Set `HEYGEN_API_KEY` through browser admin at the active `/admin/secrets` route; if browser admin is unavailable, use `/secret set HEYGEN_API_KEY \"<api-key>\"` in browser `/chat` or TUI; local console fallback: `hybridclaw secret set HEYGEN_API_KEY \"<api-key>\"`."
metadata:
  hybridclaw:
    category: media
    short_description: "Async HeyGen avatar videos from script text."
    tags:
      - video
      - avatar-video
      - heygen
      - from-script
      - mp4
    related_roadmap:
      - R55
      - R55.2
    issue: 875
    depends_on:
      - R55.1
      - heygen
    stakes_tiers:
      green:
        - plan
        - status
      amber:
        - start
        - render
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

# Video From Script

Use this skill when the user wants an avatar video from three concrete inputs:
an avatar or image source, a voice id, and approved script text. The backing
provider is HeyGen Direct API via the bundled `heygen` adapter.

## Scope

- plan avatar video generation from script text
- start a HeyGen video generation job and return the job id immediately
- poll job status until it is `completed`, `failed`, or still rendering
- download the completed MP4 into `.generated-videos`
- keep HeyGen API keys behind gateway secret injection

Template videos, free-form prompt-to-video, public publishing, social posting,
and custom avatar training are outside this skill. Use `video-generation` for
native Sora/Veo prompt videos and `heygen` for lower-level HeyGen API work.
Polling is the completion transport implemented for R55.2; webhook callbacks
belong in a provider/gateway adapter if that transport is added later.

## Default Workflow

1. Confirm the user has provided an avatar source, voice id, and final script.
2. Run public-facing marketing, sales, training, or onboarding copy through
   `/brand-voice` before starting a credit-consuming render.
3. Use `plan` if the request is vague or needs an explicit risk summary.
4. Use `start` after the operator grants the exact credit-consuming render.
   Return the `jobId` to the user because HeyGen renders asynchronously.
5. Use `status --job-id <id>` to poll conservatively. Add `--download` only
   after the status is complete or when the user asks you to fetch the MP4.
6. Use `render --wait` only when the user explicitly wants the agent to wait
   for the final MP4 in the same run.

Do not run parallel render bursts. HeyGen quotas are tight and account/plan
dependent.

## Command Contract

Run the helper with Node:

```bash
node skills/video.from-script/video-from-script.cjs --help
```

In packaged agent workspaces this skill can be mounted with a hyphenated
directory name. If the command above fails with `Cannot find module`, run:

```bash
node skills/video-from-script/video-from-script.cjs --help
```

Plan without contacting HeyGen:

```bash
node skills/video.from-script/video-from-script.cjs plan "Create a product update avatar video"
```

Start an async render after explicit operator grant:

```bash
node skills/video.from-script/video-from-script.cjs start \
  --avatar-id avatar_123 \
  --voice-id voice_123 \
  --script "Approved script text" \
  --title "Product update" \
  --resolution 1080p \
  --aspect-ratio 16:9 \
  --operator-grant
```

Poll and download the completed MP4:

```bash
node skills/video.from-script/video-from-script.cjs status \
  --job-id video_123 \
  --download
```

Wait for completion in one command only when that behavior is requested:

```bash
node skills/video.from-script/video-from-script.cjs render --wait \
  --avatar-id avatar_123 \
  --voice-id voice_123 \
  --script "Approved script text" \
  --operator-grant
```

## Working Rules

- Never print, request, or accept a raw HeyGen API key.
- Keep script text at or below 5000 characters.
- Use exact HeyGen asset ids for `--avatar-id` and `--voice-id`. Display names
  such as a presenter name or voice name are not ids.
- Refresh candidates with `node skills/heygen/heygen.cjs request list-avatars
  --limit <count>` and `node skills/heygen/heygen.cjs request list-voices
  --limit <count>` before choosing ids. Those summaries are cached so this
  helper can reject display names and stale ids before contacting HeyGen.
- Use `--skip-cache-validation` only when the operator supplied a known private
  HeyGen asset id that is not present in the cached list.
- Provide exactly one avatar source: `--avatar-id`, `--image-url`, or
  `--image-asset-id`.
- Require `--operator-grant` for `start` and `render`.
- Prefer `start` + `status` over a long blocking render.
- Treat `pending`, `waiting`, and `processing` as normal async states.
- Treat `failed` as terminal and include the provider error when available.
- Download only completed provider URLs, and save MP4 artifacts under
  `.generated-videos`.
- In web chat, the completed MP4 must be returned through the helper's
  `artifacts[]` output so the gateway can render the browser preview/download
  route. When asked to post or show an already completed video, run
  `status --job-id <id> --download` again instead of writing a remembered local
  path or hand-built `/api/artifact` link.
- Do not say web chat cannot embed, display, or deliver the MP4, and do not
  suggest Finder, drag-and-drop, Discord, or email unless the user explicitly
  asks for that external channel.
- Public auto-publish or share-link distribution is red tier and requires a
  separate escalation.

## Validation

Run:

```bash
python3 skills/skill-creator/scripts/quick_validate.py skills/video.from-script
node skills/video.from-script/video-from-script.cjs --help
node skills/video.from-script/video-from-script.cjs eval-scenarios
```
