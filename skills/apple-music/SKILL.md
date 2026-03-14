---
name: apple-music
description: Use this skill when the user wants Apple Music or macOS Music app playback control, now-playing details, playlist playback, or host-side music automation.
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
2. For playback control on macOS, prefer small `osascript` actions against the
   Music app.
3. For URLs, open the requested Apple Music page in the Music app or browser.
4. Do not modify playlists or library state unless the user asks.

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

## URL Workflow

Open an Apple Music URL or the app scheme directly:

```bash
open "https://music.apple.com/"
open "music://"
```

Use this when the user wants a specific artist, album, or playlist page rather
than direct terminal playback control.

## Working Rules

- Confirm before starting playback if the user may already be in a call or
  focused work session.
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
- Do not pretend host playback control will work on non-macOS environments.
