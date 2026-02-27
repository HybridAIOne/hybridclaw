---
name: iss-position
description: Retrieve the current International Space Station (ISS) position from the WhereTheISS API and return standardized success/error payloads. Use when a user asks where the ISS is right now, requests current ISS latitude/longitude, or needs a reusable script to fetch live ISS coordinates.
---

# ISS Position

Fetch the ISS latitude and longitude with a deterministic Python script that matches this repository's existing `get_iss_position` tool behavior.

## Quick Start

1. Run:
```bash
python3 skills/iss-position/scripts/get_iss_position.py --format text
```
2. For machine-readable output, run:
```bash
python3 skills/iss-position/scripts/get_iss_position.py --format json
```

## Script Contract

Script path: `skills/iss-position/scripts/get_iss_position.py`

Behavior:
1. Call `https://api.wheretheiss.at/v1/satellites/25544`.
2. Use a default timeout of 15 seconds (override with `--timeout`).
3. Validate `latitude` and `longitude` as numeric values.
4. Return either:
```json
{"status":"success","latitude":12.34,"longitude":56.78,"message":"The ISS is currently at latitude 12.34 and longitude 56.78."}
```
or:
```json
{"status":"error","message":"Failed to retrieve ISS position."}
```
or:
```json
{"status":"error","message":"ISS API returned invalid latitude/longitude values"}
```

## Notes

- Network access is required to fetch live ISS coordinates.
- Use `--format text` for human-readable output and `--format json` for downstream tooling.
- Use `--timeout` to adjust request timeout when needed.
