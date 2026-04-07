---
name: apple-music
description: Control Apple Music playback, inspect now playing, start playlists, and automate the macOS Music app.
category: apple
user-invocable: true
metadata:
  hybridclaw:
    tags:
      - apple
      - music
      - media
      - macos
---

# Apple Music

Use this skill for the macOS Music app and Apple Music playback workflows.

## Scope

- play, pause, skip, or resume playback
- inspect what is currently playing
- open the Music app or a music URL
- trigger simple host-side playback actions on the Mac

## Default Strategy

1. Confirm whether the user wants local Mac playback control or just information
   about Apple Music content.
2. Distinguish generic transport requests from content-specific requests.
3. For content-specific requests such as an artist radio, station, playlist,
   album, or song, resolve a directly playable target first and hand that
   target to the Music app itself.
4. For generic playback control on macOS, prefer small `osascript` actions
   against the Music app.
5. Do not modify playlists or library state unless the user asks.
6. If the user already asked you to play, pause, skip, or open something in
   Music, do not ask for a separate "yes" just to be safe. Attempt the
   host-side action and rely on the runtime approval flow if the command needs
   approval.
7. When you already have an exact Apple Music URL for playback, prefer the
   bundled `play-url.sh` helper instead of inventing a new `open` or
   UI-automation sequence.
8. If you need to resolve a content target from a plain-language query first,
   use the bundled `search.sh` helper. Do not invent additional helper names.

## Core Commands

Open the app:

```bash
open -a Music
```

Playback controls:

```bash
osascript -e 'tell application "Music" to playpause'
osascript -e 'tell application "Music" to pause'
osascript -e 'tell application "Music" to next track'
osascript -e 'tell application "Music" to previous track'
```

Now playing:

```bash
osascript -e 'tell application "Music" to get player state'
osascript -e 'tell application "Music" to if player state is playing then get {name of current track, artist of current track, album of current track}'
```

Use these only for generic transport actions like "play", "pause", "resume",
"next", or "what is playing". Do not use them to satisfy a request for
specific content such as "Play Phil Collins Radio".

## URL Workflow

Open Music directly only for app launch or page-view requests:

```bash
open -a Music
open "music://"
```

Use this when the user asked to open Music or show a page. Do not use plain
shell `open "https://music.apple.com/..."` for a playback request, because that
opens the default browser instead of issuing an in-app playback command.

## Targeted Content Workflow

For content-specific requests like "Play Phil Collins Radio on Apple Music":

1. Resolve the exact Apple Music target first.
2. For artist-only requests like "Play Phil Collins", prefer an artist radio or
   other directly playable station/song/album/playlist URL. Do not use the
   artist profile page itself as the playback target.
3. If the user already provided an Apple Music URL, hand that URL to Music with
   AppleScript `open location`.
4. Otherwise, find the best matching Apple Music station, album, playlist, or
   track URL.
5. For playback, hand the resolved URL to Music with AppleScript `open
   location`, then trigger playback in Music.
6. Verify playback state before claiming success.
7. Only fall back to generic `play` or `playpause` if the user asked for
   generic playback and there is no content target to resolve.

Shipped helpers in this skill:

- `skills/apple-music/scripts/play-url.sh`
- `skills/apple-music/scripts/search.sh`

No other helper filenames are shipped here. Do not guess names like
`lookup.sh`, `radio.sh`, or any other sibling script that you have not
actually read or listed.

Preferred playback helper:

```bash
bash skills/apple-music/scripts/play-url.sh "https://music.apple.com/us/station/bruce-springsteen/ra.1691955673"
```

The helper launches Music first when the app is not already running, opens the
resolved URL inside Music, nudges playback once, and prints verification
fields. For `music.apple.com` links it rewrites the handoff to a native
`music://...` deep link before asking Music to open it. Treat exit code `0` as
success. If it exits nonzero or prints `ok=false`, playback did not start
cleanly and you should not claim that music is playing. The helper rejects
Apple Music browse pages such as `/artist/...` or `/search...` because those
are not direct playback targets.

Preferred query-resolution helper when you do not already have a directly
playable URL:

```bash
bash skills/apple-music/scripts/search.sh "Phil Collins"
```

The search helper resolves a best-effort playable Apple Music target from the
query and, by default, immediately hands that URL to `play-url.sh` so playback
starts within the same approved action. Use `--resolve-only` only when you need
the resolved URL without playback:

```bash
bash skills/apple-music/scripts/search.sh --resolve-only "Phil Collins Radio"
```

Use read-only verification after a station or stream handoff when helpful:

```applescript
osascript <<'APPLESCRIPT'
tell application "Music"
  get {player state, current stream title, current stream URL}
end tell
APPLESCRIPT
```

## Working Rules

- Confirm before starting playback if the user may already be in a call or
  focused work session.
- Do not add a second confirmation step when the user already explicitly asked
  for playback control; let the runtime approval prompt handle host-side
  approval if needed.
- For `play ...` requests, success means Music started playback, not merely that
  a page, search results, or the app window opened.
- For exact URL playback, prefer `bash skills/apple-music/scripts/play-url.sh
  "<resolved-url>"` over handwritten inline AppleScript.
- For plain-language content requests without an exact URL, prefer `bash
  skills/apple-music/scripts/search.sh "<query>"` so target resolution and
  playback stay in one approved action.
- If Music is not already open, launch the Music app first before sending the
  playback URL or transport command.
- For artist-only playback requests, resolve an artist radio or another
  directly playable item. Do not treat an artist profile page as playable.
- The helper only counts playback as successful when Music exposes real
  playback evidence such as a loaded track/stream or an advancing player
  position, and when the target replaced the previous playback state. `missing
  value` is not success.
- Do not satisfy a content-specific request with `activate` + `play`,
  `playpause`, or other generic transport controls alone.
- Do not satisfy a content-specific request with `open "https://music.apple.com/..."`,
  `open "https://music.apple.com/search?term=..."`, or other browser-first URL
  opens.
- Do not pass `/artist/...` or `/search...` Apple Music URLs to
  `play-url.sh`; those are browse pages, not direct playback targets.
- Do not invent additional helper filenames under `skills/apple-music/scripts/`.
  If you have not read or listed the exact script path, do not call it.
- Do not degrade an exact station or playlist request into a generic search page
  or an artist query and then claim success.
- Prefer read-only now-playing queries before issuing playback changes.
- Keep actions small and reversible: play or pause first, deeper library edits
  only on request.
- If the user wants durable automations, suggest a Shortcuts or scheduled host
  workflow instead of a one-off manual command.

## Pitfalls

- Do not assume Apple Music streaming is available if the Music app is only used
  for local media on that Mac.
- Do not change library organization, ratings, or playlists without explicit
  confirmation.
- Do not use plain shell `open` on a `https://music.apple.com/...` URL as the
  playback step. That is a browser open, not a deterministic Music playback
  action.
- Do not use an Apple Music artist profile page as if it were a playable URL.
- Do not treat "play artist radio/station/playlist/album/song" as equivalent to
  "resume whatever is already loaded in Music."
- Do not pretend host playback control will work on non-macOS environments.
