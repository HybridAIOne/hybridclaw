# ruff: noqa: INP001
"""Fetch the current ISS position and print a tool-compatible response."""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request
import urllib.error
from typing import Any, TypedDict

API_URL = "https://api.wheretheiss.at/v1/satellites/25544"
DEFAULT_REQUEST_TIMEOUT = 15
REQUEST_FAILURE_MESSAGE = "Failed to retrieve ISS position."
INVALID_COORDS_MESSAGE = "ISS API returned invalid latitude/longitude values"


class IssPosition(TypedDict):
    latitude: float
    longitude: float


class IssApiError(RuntimeError):
    """Raised when the ISS API request fails or returns invalid data."""


def fetch_current_position(timeout: int = DEFAULT_REQUEST_TIMEOUT) -> IssPosition:
    """Fetch current ISS coordinates from WhereTheISS."""

    try:
        with urllib.request.urlopen(API_URL, timeout=timeout) as response:
            payload: dict[str, Any] = json.loads(response.read())
    except (urllib.error.URLError, OSError) as exc:
        raise IssApiError(REQUEST_FAILURE_MESSAGE) from exc

    latitude = payload.get("latitude")
    longitude = payload.get("longitude")
    if not isinstance(latitude, (int, float)) or not isinstance(
        longitude, (int, float)
    ):
        raise IssApiError(INVALID_COORDS_MESSAGE)

    return IssPosition(latitude=float(latitude), longitude=float(longitude))


def _success_response(position: IssPosition) -> dict[str, Any]:
    latitude = position["latitude"]
    longitude = position["longitude"]
    return {
        "status": "success",
        "latitude": latitude,
        "longitude": longitude,
        "message": f"The ISS is currently at latitude {latitude} and longitude {longitude}.",
    }


def _error_response(message: str) -> dict[str, str]:
    return {"status": "error", "message": message}


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Fetch the current ISS position.")
    parser.add_argument(
        "--format",
        choices=("text", "json"),
        default="json",
        help="Output format. Use 'json' for tools and 'text' for humans.",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=DEFAULT_REQUEST_TIMEOUT,
        help=f"Request timeout in seconds (default: {DEFAULT_REQUEST_TIMEOUT}).",
    )
    return parser.parse_args()


def _emit(payload: dict[str, Any], output_format: str) -> None:
    if output_format == "json":
        print(json.dumps(payload, ensure_ascii=True))
        return

    status = payload.get("status")
    if status == "success":
        print(payload["message"])
        return

    print(f"Error: {payload.get('message', 'Unknown error')}", file=sys.stderr)


def main() -> int:
    args = _parse_args()

    try:
        payload = _success_response(fetch_current_position(timeout=args.timeout))
    except IssApiError as exc:
        payload = _error_response(str(exc))
        _emit(payload, args.format)
        return 1

    _emit(payload, args.format)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
