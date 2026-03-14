#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: search.sh [--resolve-only] [--country <cc>] [--delay-seconds <n>] <query>
EOF
}

require_bin() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required binary not found: $1" >&2
    exit 69
  fi
}

to_lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

to_upper() {
  printf '%s' "$1" | tr '[:lower:]' '[:upper:]'
}

resolve_station_url() {
  local query=$1
  local country=$2
  local encoded_query
  encoded_query=$(
    python3 - "$query" <<'PY'
import sys
import urllib.parse

print(urllib.parse.quote(sys.argv[1]))
PY
  )

  curl -fsSL \
    -A 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36' \
    "https://music.apple.com/${country}/search?term=${encoded_query}" |
    python3 -c '
import html
import re
import sys

country = sys.argv[1].lower()
page = sys.stdin.read()
pattern = re.compile(
    r"(https://music\.apple\.com/[a-z]{2}/station/[^\"'"'"'< >]+|/[a-z]{2}/station/[^\"'"'"'< >]+)"
)
seen = set()
for match in pattern.findall(page):
    value = html.unescape(match)
    if value.startswith("/"):
        value = f"https://music.apple.com{value}"
    value = value.split("?")[0]
    if value in seen:
        continue
    seen.add(value)
    if f"/{country}/station/" not in value and "/station/" not in value:
        continue
    print(value)
    break
' "$country"
}

resolve_artist_track() {
  local query=$1
  local country=$2
  local country_upper
  country_upper=$(to_upper "$country")
  local encoded_query
  encoded_query=$(
    python3 - "$query" <<'PY'
import sys
import urllib.parse

print(urllib.parse.quote(sys.argv[1]))
PY
  )

  local artist_json
  artist_json=$(
    curl -fsSL \
      "https://itunes.apple.com/search?term=${encoded_query}&entity=musicArtist&limit=10&country=${country_upper}"
  )

  local artist_info
  artist_info=$(
    printf '%s' "$artist_json" | python3 -c '
import json
import re
import sys

query = sys.argv[1]
payload = json.load(sys.stdin)
results = payload.get("results") or []

def normalize(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()

needle = normalize(query.replace(" radio", "").replace(" station", ""))
best = None
best_score = -10**9
for entry in results:
    artist_name = str(entry.get("artistName") or "").strip()
    artist_id = entry.get("artistId")
    if not artist_name or not artist_id:
        continue
    candidate = normalize(artist_name)
    score = 0
    if candidate == needle:
        score += 1000
    if needle and needle in candidate:
        score += 100
    if candidate and candidate in needle:
        score += 50
    score -= abs(len(candidate) - len(needle))
    if score > best_score:
        best_score = score
        best = entry

if not best:
    sys.exit(1)

print(best["artistId"])
print(str(best.get("artistName") or "").strip())
' "$query"
  )

  local artist_id artist_name
  artist_id=$(sed -n '1p' <<<"$artist_info")
  artist_name=$(sed -n '2p' <<<"$artist_info")
  if [[ -z $artist_id || -z $artist_name ]]; then
    return 1
  fi

  local lookup_json
  lookup_json=$(
    curl -fsSL \
      "https://itunes.apple.com/lookup?id=${artist_id}&entity=song&limit=25&country=${country_upper}"
  )

  printf '%s' "$lookup_json" | python3 -c '
import json
import re
import sys

artist_name = sys.argv[1]
payload = json.load(sys.stdin)
results = payload.get("results") or []

def normalize(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()

needle = normalize(artist_name)
best = None
best_score = -10**9
for entry in results:
    if entry.get("wrapperType") != "track":
        continue
    url = str(entry.get("trackViewUrl") or "").strip()
    track_name = str(entry.get("trackName") or "").strip()
    track_artist = str(entry.get("artistName") or "").strip()
    if not url or not track_name or not track_artist:
        continue
    score = 0
    if normalize(track_artist) == needle:
        score += 1000
    if "trackNumber" in entry and isinstance(entry["trackNumber"], int):
        score -= max(entry["trackNumber"] - 1, 0)
    if score > best_score:
        best_score = score
        best = entry

if not best:
    sys.exit(1)

print(str(best.get("trackViewUrl") or "").split("?")[0])
print(str(best.get("trackName") or "").strip())
print(str(best.get("artistName") or "").strip())
print("artist-top-track")
' "$artist_name"
}

resolve_song_search() {
  local query=$1
  local country=$2
  local country_upper
  country_upper=$(to_upper "$country")
  local encoded_query
  encoded_query=$(
    python3 - "$query" <<'PY'
import sys
import urllib.parse

print(urllib.parse.quote(sys.argv[1]))
PY
  )

  curl -fsSL \
    "https://itunes.apple.com/search?term=${encoded_query}&entity=song&limit=10&country=${country_upper}" |
    python3 -c '
import json
import sys

payload = json.load(sys.stdin)
results = payload.get("results") or []
for entry in results:
    url = str(entry.get("trackViewUrl") or "").strip()
    track_name = str(entry.get("trackName") or "").strip()
    artist_name = str(entry.get("artistName") or "").strip()
    if not url or not track_name or not artist_name:
      continue
    print(url.split("?")[0])
    print(track_name)
    print(artist_name)
    print("song-search")
    break
else:
    sys.exit(1)
'
}

resolve_only=false
country=us
delay_seconds=6
declare -a positional=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --resolve-only)
      resolve_only=true
      shift
      ;;
    --country)
      if [[ $# -lt 2 ]]; then
        usage
        exit 64
      fi
      country=$(to_lower "$2")
      shift 2
      ;;
    --delay-seconds)
      if [[ $# -lt 2 ]]; then
        usage
        exit 64
      fi
      delay_seconds=$2
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      positional+=("$1")
      shift
      ;;
  esac
done

if [[ ${#positional[@]} -lt 1 ]]; then
  usage
  exit 64
fi

query="${positional[*]}"
script_dir=$(
  cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd
)
play_helper="$script_dir/play-url.sh"

require_bin curl
require_bin python3

if [[ ! -x $play_helper && ! -f $play_helper ]]; then
  echo "Required helper not found: $play_helper" >&2
  exit 66
fi

resolved_url=''
resolved_title=''
resolved_artist=''
resolved_kind=''
query_lower=$(to_lower "$query")

if [[ $query_lower == *" radio"* || $query_lower == *" station"* ]]; then
  if station_url=$(resolve_station_url "$query" "$country" 2>/dev/null) && [[ -n $station_url ]]; then
    resolved_url=$station_url
    resolved_title=$query
    resolved_artist=''
    resolved_kind='station-search'
  fi
fi

if [[ -z $resolved_url ]]; then
  if artist_result=$(resolve_artist_track "$query" "$country" 2>/dev/null); then
    resolved_url=$(sed -n '1p' <<<"$artist_result")
    resolved_title=$(sed -n '2p' <<<"$artist_result")
    resolved_artist=$(sed -n '3p' <<<"$artist_result")
    resolved_kind=$(sed -n '4p' <<<"$artist_result")
  fi
fi

if [[ -z $resolved_url ]]; then
  if song_result=$(resolve_song_search "$query" "$country" 2>/dev/null); then
    resolved_url=$(sed -n '1p' <<<"$song_result")
    resolved_title=$(sed -n '2p' <<<"$song_result")
    resolved_artist=$(sed -n '3p' <<<"$song_result")
    resolved_kind=$(sed -n '4p' <<<"$song_result")
  fi
fi

if [[ -z $resolved_url ]]; then
  echo "Could not resolve a playable Apple Music target for query: $query" >&2
  exit 1
fi

printf 'query=%s\n' "$query"
printf 'resolved_kind=%s\n' "$resolved_kind"
printf 'resolved_title=%s\n' "$resolved_title"
printf 'resolved_artist=%s\n' "$resolved_artist"
printf 'resolved_url=%s\n' "$resolved_url"

if [[ $resolve_only == true ]]; then
  exit 0
fi

printf '\n'
bash "$play_helper" "$resolved_url" "$delay_seconds"
