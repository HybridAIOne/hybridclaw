#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: $0 <apple-music-url> [delay-seconds]" >&2
  exit 64
fi

target_url=$1
delay_seconds=${2:-6}
playback_url=$target_url
validation_url=$target_url

case "$validation_url" in
  music://*)
    validation_url="https://${validation_url#music://}"
    ;;
  musics://*)
    validation_url="https://${validation_url#musics://}"
    ;;
esac

if [[ $validation_url == https://*music.apple.com/* || $validation_url == http://*music.apple.com/* ]]; then
  validation_path=${validation_url#*music.apple.com}
  validation_path=${validation_path%%\?*}
  case "$validation_path" in
    */artist/*|/artist/*)
      echo "Artist page URLs are not direct playback targets. Resolve an artist radio, song, album, or playlist URL instead." >&2
      exit 64
      ;;
    */search|*/search/*|/search|/search/*)
      echo "Search page URLs are not direct playback targets. Resolve a station, song, album, or playlist URL instead." >&2
      exit 64
      ;;
  esac
fi

if [[ $target_url == https://*music.apple.com/* || $target_url == http://*music.apple.com/* ]]; then
  playback_url="music://${target_url#*://}"
fi

if ! pgrep -qx Music >/dev/null 2>&1; then
  open -a Music
  sleep 2
fi

result="$(
osascript - "$playback_url" "$delay_seconds" <<'APPLESCRIPT'
on run argv
  set targetUrl to item 1 of argv
  set delaySeconds to (item 2 of argv) as number
  set snapshot to {"", "", "", "", "", "", 0, false, -1}
  set initialSnapshot to {"", "", "", "", "", "", 0, false, -1}
  set playbackOk to false
  set targetApplied to false

  tell application "Music"
    launch
    activate
  end tell

  set initialSnapshot to my readSnapshot()

  tell application "Music"
    activate
    open location targetUrl
  end tell

  delay delaySeconds

  repeat with attempt from 1 to 6
    set snapshot to my readSnapshot()
    set {currentState, playlistName, trackName, artistName, streamTitle, streamUrl, playerPositionValue, mutedValue, soundVolumeValue} to snapshot
    set targetApplied to my targetLooksApplied(initialSnapshot, snapshot)

    if my hasPlaybackEvidence(snapshot) and targetApplied then
      set playbackOk to true
      exit repeat
    end if

    tell application "Music"
      activate
      try
        if current track is not missing value then
          play current track
        end if
      end try
      try
        play
      end try
      try
        resume
      end try
    end tell

    delay 2
  end repeat

  set snapshot to my readSnapshot()
  set {currentState, playlistName, trackName, artistName, streamTitle, streamUrl, playerPositionValue, mutedValue, soundVolumeValue} to snapshot
  set targetApplied to my targetLooksApplied(initialSnapshot, snapshot)
  set playbackOk to my hasPlaybackEvidence(snapshot) and targetApplied

  return "ok=" & playbackOk & linefeed & ¬
    "target_applied=" & targetApplied & linefeed & ¬
    "player_state=" & currentState & linefeed & ¬
    "playlist_name=" & playlistName & linefeed & ¬
    "track_name=" & trackName & linefeed & ¬
    "artist_name=" & artistName & linefeed & ¬
    "stream_title=" & streamTitle & linefeed & ¬
    "stream_url=" & streamUrl & linefeed & ¬
    "player_position=" & playerPositionValue & linefeed & ¬
    "muted=" & mutedValue & linefeed & ¬
    "sound_volume=" & soundVolumeValue
end run

on readSnapshot()
  set currentState to ""
  set playlistName to ""
  set trackName to ""
  set artistName to ""
  set streamTitle to ""
  set streamUrl to ""
  set playerPositionValue to 0
  set mutedValue to false
  set soundVolumeValue to -1

  tell application "Music"
    set currentState to (player state as text)

    try
      if current playlist is not missing value then
        set playlistName to my normalizeText(name of current playlist)
      end if
    end try

    try
      if current track is not missing value then
        set trackName to my normalizeText(name of current track)
        set artistName to my normalizeText(artist of current track)
      end if
    end try

    try
      if current stream title is not missing value then
        set streamTitle to my normalizeText(current stream title)
      end if
    end try

    try
      if current stream URL is not missing value then
        set streamUrl to my normalizeText(current stream URL)
      end if
    end try

    try
      set playerPositionValue to player position
    on error
      set playerPositionValue to 0
    end try

    try
      set mutedValue to mute
    on error
      set mutedValue to false
    end try

    try
      set soundVolumeValue to sound volume
    on error
      set soundVolumeValue to -1
    end try
  end tell

  return {currentState, playlistName, trackName, artistName, streamTitle, streamUrl, playerPositionValue, mutedValue, soundVolumeValue}
end readSnapshot

on normalizeText(rawValue)
  if rawValue is missing value then
    return ""
  end if

  return rawValue as text
end normalizeText

on hasPlaybackEvidence(snapshot)
  set {currentState, playlistName, trackName, artistName, streamTitle, streamUrl, playerPositionValue, mutedValue, soundVolumeValue} to snapshot

  if currentState is not "playing" then
    return false
  end if

  if trackName is not "" then
    return true
  end if

  if streamTitle is not "" then
    return true
  end if

  if streamUrl is not "" then
    return true
  end if

  if playerPositionValue > 1 then
    return true
  end if

  return false
end hasPlaybackEvidence

on targetLooksApplied(initialSnapshot, finalSnapshot)
  set {initialState, initialPlaylistName, initialTrackName, initialArtistName, initialStreamTitle, initialStreamUrl, initialPlayerPositionValue, initialMutedValue, initialSoundVolumeValue} to initialSnapshot
  set {currentState, playlistName, trackName, artistName, streamTitle, streamUrl, playerPositionValue, mutedValue, soundVolumeValue} to finalSnapshot

  if initialState is not "playing" then
    return true
  end if

  if playlistName is not initialPlaylistName then
    return true
  end if

  if trackName is not initialTrackName then
    return true
  end if

  if artistName is not initialArtistName then
    return true
  end if

  if streamTitle is not initialStreamTitle then
    return true
  end if

  if streamUrl is not initialStreamUrl then
    return true
  end if

  if playerPositionValue + 1 < initialPlayerPositionValue then
    return true
  end if

  return false
end targetLooksApplied
APPLESCRIPT
)"

printf '%s\n' "$result"

if ! grep -q '^ok=true$' <<<"$result"; then
  echo "Music did not enter active playback for the resolved target." >&2
  exit 1
fi
