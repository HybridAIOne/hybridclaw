#!/usr/bin/env python3
# ruff: noqa: INP001
"""GA4 skill helper.

Live API calls are routed through HybridClaw's gateway HTTP proxy so delegated
OAuth tokens and service-account bearer tokens stay in the encrypted runtime
secret rail and never enter this process.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib import error, request

DEFAULT_API_VERSION = "v1beta"
DEFAULT_GATEWAY_URL = "http://127.0.0.1:9090"
DEFAULT_TIMEOUT_MS = 30_000
DEFAULT_LIMIT = 25
MAX_REVIEWED_LIMIT = 100_000
GATEWAY_TIMEOUT_BUFFER_S = 5
GA4_BASE_URL = "https://analyticsdata.googleapis.com"
DEFAULT_BEARER_SECRET_NAME = "GOOGLE_WORKSPACE_CLI_TOKEN"
SKILL_DIR = Path(__file__).resolve().parent.parent
EVAL_SCENARIOS_PATH = SKILL_DIR / "evals" / "scenarios.json"

AMBIGUOUS_QUARTER_RE = re.compile(r"\bq[1-4]\b", re.IGNORECASE)
EXPLICIT_YEAR_RE = re.compile(r"\b20[0-9]{2}\b")
ADMIN_MUTATION_RE = re.compile(
    r"\b(admin access|grant access|grant permission|add user|remove user|delete property|"
    r"create property|change tag|change key event|mark .*key event)\b",
    re.IGNORECASE,
)

KNOWN_DIMENSIONS = {
    "browser",
    "campaignName",
    "city",
    "country",
    "date",
    "defaultChannelGroup",
    "deviceCategory",
    "eventName",
    "firstUserSourceMedium",
    "hostName",
    "itemCategory",
    "itemName",
    "landingPagePlusQueryString",
    "pagePathPlusQueryString",
    "sessionCampaignName",
    "sessionDefaultChannelGroup",
    "sessionMedium",
    "sessionSource",
    "sessionSourceMedium",
}

KNOWN_METRICS = {
    "activeUsers",
    "averageSessionDuration",
    "bounceRate",
    "engagedSessions",
    "engagementRate",
    "eventCount",
    "grossPurchaseRevenue",
    "itemsPurchased",
    "keyEvents",
    "newUsers",
    "screenPageViews",
    "sessions",
    "totalRevenue",
    "transactions",
}


class ConfigError(RuntimeError):
    """Raised when helper configuration is invalid."""


class GatewayError(RuntimeError):
    """Raised when the gateway proxy returns an error."""


@dataclass
class GatewayConfig:
    base_url: str
    api_token: str
    timeout_ms: int


def usage_totals_measurement() -> dict[str, Any]:
    return {
        "system": "UsageTotals",
        "source": "HybridClaw usage_events",
        "scope": "per assistant run/session",
    }


def with_cost(payload: dict[str, Any]) -> dict[str, Any]:
    payload["costMeasurement"] = usage_totals_measurement()
    return payload


def normalize_intent_text(value: str) -> str:
    return value.lower()


def normalize_property_id(value: str | None) -> str:
    raw = (value or os.environ.get("GA4_PROPERTY_ID", "")).strip()
    if raw.startswith("properties/"):
        raw = raw.removeprefix("properties/")
    normalized = re.sub(r"[^0-9]", "", raw)
    if not normalized:
        raise ConfigError("Missing GA4 property id.")
    return normalized


def normalize_api_version(value: str | None) -> str:
    normalized = (value or DEFAULT_API_VERSION).strip().lower()
    if not re.fullmatch(r"v[0-9]+(?:beta|alpha)?", normalized):
        raise ConfigError(f"Invalid GA4 Data API version: {value}")
    return normalized


def resolve_bearer_secret_name(args: argparse.Namespace) -> str:
    value = (
        getattr(args, "bearer_secret_name", "")
        or os.environ.get("GA4_BEARER_SECRET_NAME", "")
    ).strip()
    return value or DEFAULT_BEARER_SECRET_NAME


def resolve_gateway_url() -> str:
    return (
        os.environ.get("HYBRIDCLAW_GATEWAY_URL", "").strip()
        or os.environ.get("GATEWAY_BASE_URL", "").strip()
        or DEFAULT_GATEWAY_URL
    )


def resolve_gateway_token() -> str:
    return (
        os.environ.get("HYBRIDCLAW_GATEWAY_TOKEN", "").strip()
        or os.environ.get("GATEWAY_API_TOKEN", "").strip()
        or ""
    )


def is_local_gateway_url(value: str) -> bool:
    return (
        value.startswith("http://127.")
        or value.startswith("http://localhost")
        or value.startswith("http://[::1]")
    )


def make_gateway_config(args: argparse.Namespace) -> GatewayConfig:
    config = GatewayConfig(
        base_url=(args.gateway_url or resolve_gateway_url()).rstrip("/"),
        api_token=(
            args.gateway_token
            if args.gateway_token is not None
            else resolve_gateway_token()
        ),
        timeout_ms=args.timeout_ms,
    )
    if not config.api_token and not is_local_gateway_url(config.base_url):
        raise ConfigError(
            "Refusing unauthenticated remote gateway URL. Set HYBRIDCLAW_GATEWAY_TOKEN or use a local 127.0.0.1/localhost gateway."
        )
    if not is_local_gateway_url(config.base_url) and config.base_url.startswith(
        "http://"
    ):
        raise ConfigError("Remote gateway URL must use HTTPS.")
    return config


def ga4_url(api_version: str, property_id: str, suffix: str) -> str:
    base_url = f"{GA4_BASE_URL}/{api_version}/properties/{property_id}"
    if not suffix:
        return base_url
    separator = "" if suffix.startswith("/") else ":"
    return f"{base_url}{separator}{suffix}"


def build_http_request(
    *,
    url: str,
    method: str,
    bearer_secret_name: str,
    timeout_ms: int,
    json_payload: dict[str, Any] | None = None,
    max_response_bytes: int | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "url": url,
        "method": method,
        "timeoutMs": timeout_ms,
        "bearerSecretName": bearer_secret_name,
        "skillName": "ga4",
    }
    if json_payload is not None:
        payload["json"] = json_payload
    if max_response_bytes is not None:
        payload["maxResponseBytes"] = max_response_bytes
    return payload


def gateway_request(gw: GatewayConfig, payload: dict[str, Any]) -> Any:
    proxy_url = f"{gw.base_url}/api/http/request"
    proxy_headers = {"Content-Type": "application/json"}
    if gw.api_token:
        proxy_headers["Authorization"] = f"Bearer {gw.api_token}"

    encoded = json.dumps(payload, ensure_ascii=True).encode("utf-8")
    req = request.Request(proxy_url, data=encoded, method="POST", headers=proxy_headers)
    try:
        with request.urlopen(
            req,
            timeout=gw.timeout_ms / 1000 + GATEWAY_TIMEOUT_BUFFER_S,
        ) as resp:
            raw = resp.read().decode("utf-8")
    except error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace").strip()
        raise GatewayError(
            f"Gateway proxy returned {exc.code} for {payload.get('method')} {payload.get('url')}: {detail}"
        ) from exc
    except error.URLError as exc:
        raise GatewayError(f"Cannot reach gateway at {proxy_url}: {exc.reason}") from exc
    except OSError as exc:
        raise GatewayError(f"Network error reaching gateway at {proxy_url}: {exc}") from exc

    if not raw:
        return {}
    try:
        response_payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise GatewayError("Gateway proxy returned non-JSON output.") from exc
    if isinstance(response_payload, dict) and response_payload.get("ok") is False:
        status = response_payload.get("status", "unknown")
        body = response_payload.get("body", "")
        raise GatewayError(
            f"Gateway proxy upstream request failed with status {status}: {body}"
        )
    return response_payload


def parse_json_object(value: str, label: str) -> dict[str, Any]:
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as exc:
        raise ConfigError(f"{label} must be valid JSON.") from exc
    if not isinstance(parsed, dict):
        raise ConfigError(f"{label} must be a JSON object.")
    return parsed


def metric(name: str) -> dict[str, str]:
    return {"name": name}


def dimension(name: str) -> dict[str, str]:
    return {"name": name}


def string_filter(field_name: str, value: str) -> dict[str, Any]:
    return {
        "filter": {
            "fieldName": field_name,
            "stringFilter": {"matchType": "EXACT", "value": value},
        }
    }


def date_ranges_for_intent(text: str) -> tuple[list[dict[str, str]], bool]:
    compare = any(
        phrase in text
        for phrase in (
            "vs prior",
            "versus prior",
            "compared with prior",
            "compare",
            "previous period",
            "prior period",
            "prior week",
            "previous week",
        )
    )
    if compare:
        return (
            [
                {
                    "name": "current_period",
                    "startDate": "7daysAgo",
                    "endDate": "yesterday",
                },
                {
                    "name": "prior_period",
                    "startDate": "14daysAgo",
                    "endDate": "8daysAgo",
                },
            ],
            False,
        )
    if "yesterday" in text:
        return ([{"startDate": "yesterday", "endDate": "yesterday"}], False)
    if "today" in text or "current" in text or "realtime" in text:
        return ([{"startDate": "today", "endDate": "today"}], False)
    if "90 days" in text or "past 90" in text:
        return ([{"startDate": "90daysAgo", "endDate": "yesterday"}], False)
    if "last month" in text or "previous month" in text:
        return ([{"startDate": "30daysAgo", "endDate": "yesterday"}], False)
    if "this month" in text:
        return ([{"startDate": "firstDayOfMonth", "endDate": "yesterday"}], False)
    if "this week" in text:
        return ([{"startDate": "7daysAgo", "endDate": "yesterday"}], False)
    if "last 7" in text or "past 7" in text or "last week" in text:
        return ([{"startDate": "7daysAgo", "endDate": "yesterday"}], False)
    return ([{"startDate": "30daysAgo", "endDate": "yesterday"}], True)


def metrics_for_intent(text: str) -> list[str]:
    metrics: list[str] = []
    if any(word in text for word in ("conversion", "conversions", "key event", "key events")):
        metrics.append("keyEvents")
    if "purchase revenue" in text:
        metrics.append("grossPurchaseRevenue")
    elif "revenue" in text or "sales" in text:
        metrics.append("totalRevenue")
    if "transaction" in text:
        metrics.append("transactions")
    if "items purchased" in text:
        metrics.append("itemsPurchased")
    if ("event count" in text or "events" in text) and "key event" not in text:
        metrics.append("eventCount")
    if "bounce" in text:
        metrics.append("bounceRate")
    if "engaged sessions" in text:
        metrics.append("engagedSessions")
    elif "session" in text or "traffic" in text:
        metrics.append("sessions")
    if "active users" in text or "users" in text:
        metrics.append("activeUsers")
    if not metrics:
        metrics.append("sessions")
    return list(dict.fromkeys(metrics))


def dimensions_for_intent(text: str) -> list[str]:
    dims: list[str] = []
    if any(phrase in text for phrase in ("daily", "by day", "trend", "time series")):
        dims.append("date")
    if "landing page" in text or "landing pages" in text:
        dims.append("landingPagePlusQueryString")
    if "source medium" in text or "source / medium" in text:
        dims.append("sessionSourceMedium")
    elif any(
        phrase in text
        for phrase in ("channel", "organic", "paid search", "email", "direct", "traffic source")
    ):
        dims.append("sessionDefaultChannelGroup")
    if "campaign" in text and "channel" not in text and "email campaign" not in text:
        dims.append("sessionCampaignName")
    if "country" in text:
        dims.append("country")
    if "device" in text:
        dims.append("deviceCategory")
    if "event count" in text or "events had" in text:
        dims.append("eventName")
    if "item category" in text:
        dims.append("itemCategory")
    if "item name" in text or "items purchased" in text:
        dims.append("itemName")
    if not dims and (
        "compare" in text or "trend" in text or re.search(r"\bvs\b", text)
    ):
        dims.append("date")
    return list(dict.fromkeys(dims))


def filter_for_intent(text: str) -> dict[str, Any] | None:
    if "organic" in text:
        return string_filter("sessionDefaultChannelGroup", "Organic Search")
    if "paid search" in text:
        return string_filter("sessionDefaultChannelGroup", "Paid Search")
    if re.search(r"\bemail\b", text):
        return string_filter("sessionDefaultChannelGroup", "Email")
    if re.search(r"\bdirect\b", text):
        return string_filter("sessionDefaultChannelGroup", "Direct")
    return None


def order_bys_for_metrics(metrics: list[str], dims: list[str]) -> list[dict[str, Any]]:
    if "date" in dims:
        return [{"dimension": {"dimensionName": "date"}}]
    return [{"metric": {"metricName": metrics[0]}, "desc": True}]


def build_report_plan(intent: str, limit: int = DEFAULT_LIMIT) -> dict[str, Any]:
    text = normalize_intent_text(intent)
    if AMBIGUOUS_QUARTER_RE.search(text) and not EXPLICIT_YEAR_RE.search(text):
        return with_cost(
            {
                "command": "report-plan",
                "intent": intent,
                "requiresClarification": True,
                "clarification": "Quarter requests must include an explicit year or exact date range.",
                "request": {},
                "review": {
                    "allowed": False,
                    "findings": ["Quarter request is missing an explicit year."],
                },
            }
        )
    if ADMIN_MUTATION_RE.search(text):
        return with_cost(
            {
                "command": "report-plan",
                "intent": intent,
                "requiresClarification": True,
                "clarification": "GA4 Admin/API mutations are outside this read-only reporting skill.",
                "request": {},
                "review": {
                    "allowed": False,
                    "findings": ["Admin or access mutation requested."],
                },
            }
        )

    metrics = metrics_for_intent(text)
    dims = dimensions_for_intent(text)
    date_ranges, date_range_inferred = date_ranges_for_intent(text)
    report: dict[str, Any] = {
        "dateRanges": date_ranges,
        "metrics": [metric(name) for name in metrics],
        "limit": limit,
        "keepEmptyRows": False,
    }
    if dims:
        report["dimensions"] = [dimension(name) for name in dims]
        report["orderBys"] = order_bys_for_metrics(metrics, dims)
    else:
        report["orderBys"] = order_bys_for_metrics(metrics, [])

    dimension_filter = filter_for_intent(text)
    if dimension_filter:
        report["dimensionFilter"] = dimension_filter

    review = review_report_request(report)
    return with_cost(
        {
            "command": "report-plan",
            "intent": intent,
            "dateRangeInferred": date_range_inferred,
            "requiresClarification": False,
            "request": report,
            "review": review,
            "http": {
                "method": "POST",
                "path": "properties/{propertyId}:runReport",
            },
        }
    )


def get_names(items: Any, label: str) -> list[str]:
    if items is None:
        return []
    if not isinstance(items, list):
        raise ConfigError(f"{label} must be an array.")
    names: list[str] = []
    for index, item in enumerate(items):
        if not isinstance(item, dict) or not isinstance(item.get("name"), str):
            raise ConfigError(f"{label}[{index}].name is required.")
        names.append(item["name"])
    return names


def review_report_request(report: dict[str, Any]) -> dict[str, Any]:
    findings: list[str] = []
    warnings: list[str] = []
    try:
        dimensions = get_names(report.get("dimensions", []), "dimensions")
        metrics = get_names(report.get("metrics"), "metrics")
    except ConfigError as exc:
        return {"allowed": False, "findings": [str(exc)], "warnings": warnings}

    if not metrics:
        findings.append("At least one GA4 metric is required.")
    for name in dimensions:
        if name not in KNOWN_DIMENSIONS:
            findings.append(f"Unknown or unsupported GA4 dimension: {name}")
    for name in metrics:
        if name not in KNOWN_METRICS:
            findings.append(f"Unknown or unsupported GA4 metric: {name}")

    date_ranges = report.get("dateRanges")
    if not isinstance(date_ranges, list) or not date_ranges:
        findings.append("At least one date range is required.")
    else:
        for index, item in enumerate(date_ranges):
            if not isinstance(item, dict):
                findings.append(f"dateRanges[{index}] must be an object.")
                continue
            if not item.get("startDate") or not item.get("endDate"):
                findings.append(f"dateRanges[{index}] requires startDate and endDate.")

    limit = report.get("limit", DEFAULT_LIMIT)
    if not isinstance(limit, int):
        findings.append("limit must be an integer.")
    elif limit <= 0:
        findings.append("limit must be greater than zero.")
    elif limit > MAX_REVIEWED_LIMIT:
        findings.append(f"limit must be <= {MAX_REVIEWED_LIMIT}.")
    elif limit > 10_000:
        warnings.append("Large GA4 exports may consume quota; keep the report scoped.")

    if "dimensionFilter" in report and not isinstance(report["dimensionFilter"], dict):
        findings.append("dimensionFilter must be an object.")
    if "metricFilter" in report and not isinstance(report["metricFilter"], dict):
        findings.append("metricFilter must be an object.")

    return {
        "allowed": not findings,
        "readOnly": True,
        "requiresWriteGrant": False,
        "findings": findings,
        "warnings": warnings,
        "dimensions": dimensions,
        "metrics": metrics,
    }


def prompt_template(intent: str, report: dict[str, Any] | None = None) -> dict[str, Any]:
    planned = build_report_plan(intent) if report is None else None
    request_payload = report or planned["request"]
    review = (
        planned["review"]
        if planned is not None
        else review_report_request(request_payload)
    )
    return with_cost(
        {
            "templateFamily": "R21.5 GA4 analyst query review",
            "dialect": "GA4 Data API runReport JSON",
            "payload": {
                "question": intent,
                "deterministicReview": review,
                "request": request_payload,
            },
        }
    )


def load_eval_scenarios() -> list[dict[str, Any]]:
    try:
        parsed = json.loads(EVAL_SCENARIOS_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ConfigError(f"Missing eval scenarios: {EVAL_SCENARIOS_PATH}") from exc
    except json.JSONDecodeError as exc:
        raise ConfigError("GA4 eval scenarios must be valid JSON.") from exc
    if not isinstance(parsed, list):
        raise ConfigError("GA4 eval scenarios must be a JSON array.")
    return parsed


def eval_scenarios() -> dict[str, Any]:
    scenarios = load_eval_scenarios()
    failures: list[dict[str, Any]] = []
    categories: Counter[str] = Counter()
    for scenario in scenarios:
        category = str(scenario.get("category", "uncategorized"))
        categories[category] += 1
        expected = scenario.get("expected", {})
        plan = build_report_plan(str(scenario.get("request", "")))
        if expected.get("costSystem") != plan["costMeasurement"]["system"]:
            failures.append({"request": scenario.get("request"), "reason": "cost mismatch"})
            continue
        if expected.get("requiresClarification") is True:
            if not plan.get("requiresClarification"):
                failures.append({"request": scenario.get("request"), "reason": "expected clarification"})
            continue
        request_payload = plan.get("request", {})
        planned_dims = {item["name"] for item in request_payload.get("dimensions", [])}
        planned_metrics = {item["name"] for item in request_payload.get("metrics", [])}
        missing_dims = set(expected.get("dimensions", [])) - planned_dims
        missing_metrics = set(expected.get("metrics", [])) - planned_metrics
        if missing_dims or missing_metrics:
            failures.append(
                {
                    "request": scenario.get("request"),
                    "missingDimensions": sorted(missing_dims),
                    "missingMetrics": sorted(missing_metrics),
                }
            )

    return with_cost(
        {
            "command": "eval-scenarios",
            "scenarioCount": len(scenarios),
            "failed": len(failures),
            "failures": failures,
            "categories": dict(sorted(categories.items())),
        }
    )


def emit(payload: Any, output_format: str) -> None:
    if output_format == "json":
        print(json.dumps(payload, indent=2))
        return
    if isinstance(payload, str):
        print(payload)
    else:
        print(json.dumps(payload, indent=2))


def command_report_plan(args: argparse.Namespace) -> dict[str, Any]:
    return build_report_plan(args.intent, args.limit)


def command_review_request(args: argparse.Namespace) -> dict[str, Any]:
    report = parse_json_object(args.request_json, "request-json")
    return with_cost(
        {
            "command": "review-request",
            "review": review_report_request(report),
            "request": report,
        }
    )


def command_prompt_template(args: argparse.Namespace) -> dict[str, Any]:
    report = parse_json_object(args.request_json, "request-json") if args.request_json else None
    return prompt_template(args.intent, report)


def command_http_request(args: argparse.Namespace) -> dict[str, Any]:
    property_id = normalize_property_id(args.property_id)
    api_version = normalize_api_version(args.api_version)
    report = parse_json_object(args.request_json, "request-json")
    review = review_report_request(report)
    if not review["allowed"]:
        raise ConfigError("GA4 request failed review: " + "; ".join(review["findings"]))
    http_request = build_http_request(
        url=ga4_url(api_version, property_id, "runReport"),
        method="POST",
        bearer_secret_name=resolve_bearer_secret_name(args),
        timeout_ms=args.timeout_ms,
        json_payload=report,
        max_response_bytes=args.max_response_bytes,
    )
    return with_cost(
        {
            "command": "http-request",
            "propertyId": property_id,
            "auth": {"bearerSecretName": http_request["bearerSecretName"]},
            "review": review,
            "httpRequest": http_request,
        }
    )


def command_metadata_request(args: argparse.Namespace) -> dict[str, Any]:
    property_id = normalize_property_id(args.property_id)
    api_version = normalize_api_version(args.api_version)
    http_request = build_http_request(
        url=ga4_url(api_version, property_id, "/metadata"),
        method="GET",
        bearer_secret_name=resolve_bearer_secret_name(args),
        timeout_ms=args.timeout_ms,
        max_response_bytes=args.max_response_bytes,
    )
    return with_cost(
        {
            "command": "metadata-request",
            "propertyId": property_id,
            "auth": {"bearerSecretName": http_request["bearerSecretName"]},
            "httpRequest": http_request,
        }
    )


def command_run_report(args: argparse.Namespace) -> dict[str, Any]:
    wrapper = command_http_request(args)
    gw = make_gateway_config(args)
    response_payload = gateway_request(gw, wrapper["httpRequest"])
    wrapper["payload"] = response_payload
    wrapper["command"] = "run-report"
    return wrapper


def command_eval_scenarios(_args: argparse.Namespace) -> dict[str, Any]:
    return eval_scenarios()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="GA4 Data API reporting, planning, review, and gateway helper."
    )
    parser.add_argument("--format", choices=["text", "json"], default="text")
    parser.add_argument("--gateway-url", default="")
    parser.add_argument("--gateway-token", default=None)
    parser.add_argument("--timeout-ms", type=int, default=DEFAULT_TIMEOUT_MS)
    parser.add_argument("--bearer-secret-name", default="")
    subparsers = parser.add_subparsers(dest="command", required=True)

    report_plan = subparsers.add_parser(
        "report-plan", help="Plan a GA4 runReport request from natural language."
    )
    report_plan.add_argument("intent")
    report_plan.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    report_plan.set_defaults(func=command_report_plan)

    review_request = subparsers.add_parser(
        "review-request", help="Review GA4 runReport request JSON before execution."
    )
    review_request.add_argument("request_json")
    review_request.set_defaults(func=command_review_request)

    prompt = subparsers.add_parser(
        "prompt-template", help="Emit the GA4 analyst-query prompt template payload."
    )
    prompt.add_argument("intent")
    prompt.add_argument("--request-json", default="")
    prompt.set_defaults(func=command_prompt_template)

    http_request = subparsers.add_parser(
        "http-request", help="Build an http_request payload for GA4 runReport."
    )
    http_request.add_argument("property_id")
    http_request.add_argument("--api-version", default=DEFAULT_API_VERSION)
    http_request.add_argument("--request-json", required=True)
    http_request.add_argument("--max-response-bytes", type=int, default=None)
    http_request.set_defaults(func=command_http_request)

    metadata = subparsers.add_parser(
        "metadata-request", help="Build an http_request payload for GA4 metadata."
    )
    metadata.add_argument("property_id")
    metadata.add_argument("--api-version", default=DEFAULT_API_VERSION)
    metadata.add_argument("--max-response-bytes", type=int, default=None)
    metadata.set_defaults(func=command_metadata_request)

    run_report = subparsers.add_parser(
        "run-report", help="Run a GA4 report through the HybridClaw gateway proxy."
    )
    run_report.add_argument("property_id")
    run_report.add_argument("--api-version", default=DEFAULT_API_VERSION)
    run_report.add_argument("--request-json", required=True)
    run_report.add_argument("--max-response-bytes", type=int, default=None)
    run_report.set_defaults(func=command_run_report)

    eval_parser = subparsers.add_parser(
        "eval-scenarios", help="Run the bundled GA4 analyst-query eval suite."
    )
    eval_parser.set_defaults(func=command_eval_scenarios)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        payload = args.func(args)
    except (ConfigError, GatewayError) as exc:
        print(f"ga4: {exc}", file=sys.stderr)
        return 2
    emit(payload, args.format)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
