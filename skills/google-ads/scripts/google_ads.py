#!/usr/bin/env python3
# ruff: noqa: INP001
"""Google Ads skill helper.

Live API calls are routed through HybridClaw's gateway HTTP proxy so Google
OAuth tokens and the Google Ads developer token stay in the encrypted runtime
secret rail and never enter this process.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib import error, request

DEFAULT_GATEWAY_URL = "http://127.0.0.1:9090"
DEFAULT_TIMEOUT_MS = 30_000
GATEWAY_TIMEOUT_BUFFER_S = 5
DEFAULT_API_VERSION = "v24"
GOOGLE_ADS_BASE_URL = "https://googleads.googleapis.com"
# The gateway mints Google OAuth tokens through the existing Workspace token
# secret name; Google Ads uses the same OAuth rail with the adwords scope.
GOOGLE_ADS_OAUTH_SECRET_NAME = "GOOGLE_WORKSPACE_CLI_TOKEN"
GOOGLE_ADS_DEVELOPER_TOKEN_SECRET = "GOOGLEADS_DEVELOPER_TOKEN"
SKILL_DIR = Path(__file__).resolve().parent.parent
EVAL_SCENARIOS_PATH = SKILL_DIR / "evals" / "scenarios.json"

DATE_WINDOWS = {
    "today": "TODAY",
    "yesterday": "YESTERDAY",
    "last 7 days": "LAST_7_DAYS",
    "past 7 days": "LAST_7_DAYS",
    "this week": "THIS_WEEK",
    "diese woche": "THIS_WEEK",
    "letzte 7 tage": "LAST_7_DAYS",
    "month": "THIS_MONTH",
    "monat": "THIS_MONTH",
}

AMBIGUOUS_QUARTER_RE = re.compile(r"\bq[1-4]\b")

MONEY_WORDS = {
    "budget",
    "budgets",
    "spend",
    "daily budget",
    "lifetime budget",
    "roas target",
    "target roas",
    "target cpa",
    "bidding strategy",
    "bid strategy",
    "gebot",
    "tagesbudget",
}

CAMPAIGN_STATE_WORDS = {
    "pause campaign",
    "paused campaign",
    "enable campaign",
    "start campaign",
    "remove campaign",
    "delete campaign",
    "campaign pause",
    "campaign enable",
    "kampagne pausieren",
    "kampagne aktivieren",
}

AD_COPY_WORDS = {
    "headline",
    "description",
    "rsa",
    "responsive search ad",
    "ad copy",
    "sitelink",
    "callout",
    "anzeigentext",
    "ueberschrift",
    "uberschrift",
}

CUSTOMER_MATCH_WORDS = {
    "customer match",
    "customer list",
    "hashed pii",
    "email hashes",
    "upload audience",
    "kundenliste",
}

AMBER_WORDS = {
    "keyword",
    "negative keyword",
    "ad group",
    "recommendation apply",
    "apply recommendation",
    "dismiss recommendation",
    "audience segment",
    "remarketing",
    "lookalike",
    "similar audience",
    "in-market",
    "user interest",
    "add keyword",
    "pause keyword",
    "remove keyword",
    "rename ad group",
    "remove ad group",
    "remove ad",
    "anzeigengruppe",
    "keyword hinzufuegen",
    "keyword hinzufugen",
}

READ_WORDS = {
    "show",
    "list",
    "report",
    "gaql",
    "performance",
    "impressions",
    "clicks",
    "ctr",
    "conversions",
    "roas",
    "recommendations",
    "zeige",
    "bericht",
    "klicks",
}


def normalize_intent_text(value: str) -> str:
    return (
        value.lower()
        .replace("\u00e4", "ae")
        .replace("\u00f6", "oe")
        .replace("\u00fc", "ue")
        .replace("\u00df", "ss")
    )

WRITE_GRANTS = {
    "budget-or-bid-strategy-mutation": "approve-google-ads-budget-or-bid-change",
    "campaign-state-mutation": "approve-google-ads-campaign-state-change",
    "conversion-action-edit": "approve-google-ads-conversion-action-edit",
    "ad-copy-submit": "approve-google-ads-ad-copy-submit",
    "ad-copy-draft": "approve-google-ads-ad-copy-draft",
    "campaign-structure-edit": "approve-google-ads-structure-edit",
    "audience-management": "approve-google-ads-audience-management",
    "customer-match-upload": "approve-google-ads-customer-match-upload",
    "recommendation-apply": "approve-google-ads-recommendation-apply",
    "recommendation-dismiss": "approve-google-ads-recommendation-dismiss",
}

GOOGLE_ADS_GAQL_SCHEMA = {
    "dialect": "GAQL",
    "readVerb": "SELECT",
    "mutationVerb": "not-supported",
    "requiredMetricScope": "segments.date DURING or segments.date BETWEEN",
    "defaultLimit": 25,
    "commonResources": [
        "campaign",
        "ad_group",
        "keyword_view",
        "search_term_view",
        "recommendation",
    ],
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


def normalize_customer_id(value: str | None) -> str:
    normalized = re.sub(r"[^0-9]", "", value or "")
    if normalized and not re.fullmatch(r"[0-9]{10}", normalized):
        raise ConfigError("Google Ads customer ids must contain exactly 10 digits.")
    return normalized


def normalize_api_version(value: str | None) -> str:
    normalized = (value or DEFAULT_API_VERSION).strip().lower()
    if not re.fullmatch(r"v[0-9]+(?:_[0-9]+)?", normalized):
        raise ConfigError(f"Invalid Google Ads API version: {value}")
    return normalized


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
    return value.startswith("http://127.") or value.startswith("http://localhost")


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
    return config


def gateway_request(
    gw: GatewayConfig,
    *,
    url: str,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    json_payload: dict[str, Any] | None = None,
    max_response_bytes: int | None = None,
) -> Any:
    proxy_url = f"{gw.base_url}/api/http/request"
    payload: dict[str, Any] = {
        "url": url,
        "method": method,
        "timeoutMs": gw.timeout_ms,
        "bearerSecretName": GOOGLE_ADS_OAUTH_SECRET_NAME,
        "secretHeaders": [
            {
                "name": "developer-token",
                "secretName": GOOGLE_ADS_DEVELOPER_TOKEN_SECRET,
                "prefix": "",
            }
        ],
        "skillName": "google-ads",
    }
    if headers:
        payload["headers"] = headers
    if json_payload is not None:
        payload["json"] = json_payload
    if max_response_bytes is not None:
        payload["maxResponseBytes"] = max_response_bytes

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
            f"Gateway proxy returned {exc.code} for {method} {url}: {detail}"
        ) from exc
    except error.URLError as exc:
        raise GatewayError(f"Cannot reach gateway at {proxy_url}: {exc.reason}") from exc
    except OSError as exc:
        raise GatewayError(f"Network error reaching gateway at {proxy_url}: {exc}") from exc

    if not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise GatewayError("Gateway proxy returned non-JSON output.") from exc


def coerce_positive_int(value: str | int, label: str) -> int:
    try:
        normalized = int(value)
    except (TypeError, ValueError) as exc:
        raise ConfigError(f"{label} must be an integer.") from exc
    if normalized <= 0:
        raise ConfigError(f"{label} must be greater than zero.")
    return normalized


def normalize_status(value: str, allowed: set[str], label: str = "status") -> str:
    normalized = (value or "").strip().upper()
    if normalized not in allowed:
        raise ConfigError(f"{label} must be one of: {', '.join(sorted(allowed))}.")
    return normalized


def ads_headers(login_customer_id: str = "") -> dict[str, str]:
    headers: dict[str, str] = {}
    if login_customer_id:
        headers["login-customer-id"] = login_customer_id
    return headers


def ads_url(api_version: str, path: str) -> str:
    return f"{GOOGLE_ADS_BASE_URL}/{api_version}{path}"


def ads_resource(customer_id: str, collection: str, resource_id: str | int) -> str:
    return f"customers/{customer_id}/{collection}/{resource_id}"


def composite_resource(
    customer_id: str,
    collection: str,
    left_id: str | int,
    right_id: str | int,
) -> str:
    return ads_resource(customer_id, collection, f"{left_id}~{right_id}")


def non_empty(value: str, label: str) -> str:
    text = (value or "").strip()
    if not text:
        raise ConfigError(f"{label} is required.")
    return text


def parse_bool(value: bool | str) -> bool:
    if isinstance(value, bool):
        return value
    return value.strip().lower() in {"1", "true", "yes", "y", "on"}


def normalize_float(value: str, label: str) -> float:
    try:
        normalized = float(value)
    except (TypeError, ValueError) as exc:
        raise ConfigError(f"{label} must be a number.") from exc
    if normalized <= 0:
        raise ConfigError(f"{label} must be greater than zero.")
    return normalized


def validate_sha256_hex(values: list[str], label: str) -> list[str]:
    hashes = [value.strip().lower() for value in values if value.strip()]
    invalid = [value for value in hashes if not re.fullmatch(r"[0-9a-f]{64}", value)]
    if invalid:
        raise ConfigError(f"{label} hashes must be lowercase SHA-256 hex strings.")
    return hashes


def validate_one_sha256_hex(value: Any, label: str) -> str:
    hashes = validate_sha256_hex([str(value)], label)
    if not hashes:
        raise ConfigError(f"{label} hash is required.")
    return hashes[0]


def parse_address_info(value: str) -> dict[str, Any]:
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as exc:
        raise ConfigError("--address-info-json must be a JSON object.") from exc
    if not isinstance(parsed, dict):
        raise ConfigError("--address-info-json must be a JSON object.")
    address: dict[str, Any] = {}
    for source, target in [
        ("hashedFirstName", "hashedFirstName"),
        ("hashedLastName", "hashedLastName"),
        ("hashedStreetAddress", "hashedStreetAddress"),
    ]:
        if source in parsed:
            address[target] = validate_one_sha256_hex(parsed[source], source)
    for key in ["countryCode", "postalCode"]:
        if key in parsed:
            address[key] = str(parsed[key]).strip()
    if "hashedFirstName" not in address or "hashedLastName" not in address:
        raise ConfigError(
            "--address-info-json requires hashedFirstName and hashedLastName."
        )
    if "countryCode" not in address:
        raise ConfigError("--address-info-json requires countryCode.")
    return address


def require_grant(args: argparse.Namespace, operation_key: str) -> str:
    expected = WRITE_GRANTS[operation_key]
    provided = (getattr(args, "grant", "") or "").strip()
    if provided != expected:
        raise ConfigError(
            f"Refusing {operation_key}; expected explicit grant `{expected}`."
        )
    return expected


def action_service(
    args: argparse.Namespace,
    *,
    command: str,
    path: str,
    operation_key: str,
    request_body: dict[str, Any],
) -> dict[str, Any]:
    grant = require_grant(args, operation_key)
    customer_id = normalize_customer_id(args.customer_id)
    if not customer_id:
        raise ConfigError("Missing Google Ads customer id.")
    gw = make_gateway_config(args)
    api_version = normalize_api_version(args.api_version)
    payload = gateway_request(
        gw,
        url=ads_url(api_version, path),
        method="POST",
        headers=ads_headers(normalize_customer_id(args.login_customer_id)),
        json_payload=request_body,
    )
    return with_cost({
        "command": command,
        "apiVersion": api_version,
        "customerId": customer_id,
        "loginCustomerId": normalize_customer_id(args.login_customer_id),
        "operationKey": operation_key,
        "grant": grant,
        "request": request_body,
        "payload": payload,
    })


def mutate_service(
    args: argparse.Namespace,
    *,
    service: str,
    operations: list[dict[str, Any]],
    operation_key: str,
    response_content_type: str = "RESOURCE_NAME_ONLY",
) -> dict[str, Any]:
    grant = require_grant(args, operation_key)
    customer_id = normalize_customer_id(args.customer_id)
    if not customer_id:
        raise ConfigError("Missing Google Ads customer id.")
    gw = make_gateway_config(args)
    api_version = normalize_api_version(args.api_version)
    request_body: dict[str, Any] = {
        "operations": operations,
        "validateOnly": bool(getattr(args, "validate_only", False)),
        "partialFailure": False,
        "responseContentType": response_content_type,
    }
    payload = gateway_request(
        gw,
        url=ads_url(api_version, f"/customers/{customer_id}/{service}:mutate"),
        method="POST",
        headers=ads_headers(normalize_customer_id(args.login_customer_id)),
        json_payload=request_body,
    )
    return with_cost({
        "command": getattr(args, "command", "mutate"),
        "apiVersion": api_version,
        "customerId": customer_id,
        "loginCustomerId": normalize_customer_id(args.login_customer_id),
        "service": service,
        "operationKey": operation_key,
        "grant": grant,
        "validateOnly": request_body["validateOnly"],
        "request": request_body,
        "payload": payload,
    })


def command_customers(args: argparse.Namespace) -> dict[str, Any]:
    gw = make_gateway_config(args)
    api_version = normalize_api_version(args.api_version)
    payload = gateway_request(
        gw,
        url=ads_url(api_version, "/customers:listAccessibleCustomers"),
        method="GET",
        headers=ads_headers(normalize_customer_id(args.login_customer_id)),
    )
    return with_cost({
        "command": "customers",
        "apiVersion": api_version,
        "payload": payload,
    })


def command_gaql(args: argparse.Namespace) -> dict[str, Any]:
    customer_id = normalize_customer_id(args.customer_id)
    if not customer_id:
        raise ConfigError("Missing Google Ads customer id.")
    query = args.query.strip()
    review = review_gaql(query)
    if not review["allowed"]:
        raise ConfigError("GAQL review failed: " + "; ".join(review["findings"]))

    gw = make_gateway_config(args)
    api_version = normalize_api_version(args.api_version)
    payload = gateway_request(
        gw,
        url=ads_url(api_version, f"/customers/{customer_id}/googleAds:searchStream"),
        method="POST",
        headers=ads_headers(normalize_customer_id(args.login_customer_id)),
        json_payload={"query": query},
        max_response_bytes=args.max_response_bytes,
    )
    return with_cost({
        "command": "gaql",
        "apiVersion": api_version,
        "customerId": customer_id,
        "loginCustomerId": normalize_customer_id(args.login_customer_id),
        "query": query,
        "review": review,
        "payload": payload,
    })


def choose_date_window(text: str) -> str:
    normalized = normalize_intent_text(text)
    for phrase, window in DATE_WINDOWS.items():
        if phrase in normalized:
            return window
    return "LAST_7_DAYS"


def detect_report_focus(text: str) -> str:
    normalized = normalize_intent_text(text)
    if "ad group" in normalized or "anzeigengruppe" in normalized:
        return "ad_group"
    if "keyword" in normalized or "negative keyword" in normalized:
        return "keyword_view"
    if "search term" in normalized or "suchbegriff" in normalized:
        return "search_term_view"
    if "recommendation" in normalized:
        return "recommendation"
    return "campaign"


def report_shape(focus: str, normalized: str) -> tuple[list[str], str, str]:
    if focus == "ad_group":
        order = (
            "metrics.ctr ASC"
            if "worst" in normalized or "below" in normalized
            else "metrics.clicks DESC"
        )
        return [
            "campaign.name",
            "ad_group.id",
            "ad_group.name",
            "metrics.impressions",
            "metrics.clicks",
            "metrics.ctr",
            "metrics.conversions",
            "metrics.cost_micros",
        ], "ad_group", order
    if focus == "keyword_view":
        return [
            "campaign.name",
            "ad_group.name",
            "ad_group_criterion.keyword.text",
            "metrics.impressions",
            "metrics.clicks",
            "metrics.ctr",
            "metrics.conversions",
            "metrics.cost_micros",
        ], "keyword_view", "metrics.clicks DESC"
    if focus == "search_term_view":
        return [
            "campaign.name",
            "ad_group.name",
            "search_term_view.search_term",
            "metrics.impressions",
            "metrics.clicks",
            "metrics.ctr",
            "metrics.conversions",
            "metrics.cost_micros",
        ], "search_term_view", "metrics.clicks DESC"
    if focus == "recommendation":
        return [
            "recommendation.resource_name",
            "recommendation.type",
            "recommendation.impact.base_metrics.clicks",
            "recommendation.impact.potential_metrics.clicks",
        ], "recommendation", ""
    order = (
        "metrics.cost_micros DESC"
        if "cost" in normalized or "spend" in normalized
        else "metrics.clicks DESC"
    )
    return [
        "campaign.id",
        "campaign.name",
        "campaign.status",
        "metrics.impressions",
        "metrics.clicks",
        "metrics.ctr",
        "metrics.conversions",
        "metrics.conversions_value",
        "metrics.cost_micros",
    ], "campaign", order


def report_where_parts(source: str, normalized: str, date_window: str) -> list[str]:
    where_parts = []
    if source != "recommendation":
        where_parts.append(f"segments.date DURING {date_window}")
    if "german" in normalized or "deutsch" in normalized:
        where_parts.append("campaign.name LIKE '%DE%'")
    if "below 1%" in normalized or "unter 1%" in normalized:
        where_parts.append("metrics.ctr < 0.01")
    return where_parts


def quarter_needs_clarification(normalized: str) -> bool:
    return bool(AMBIGUOUS_QUARTER_RE.search(normalized)) and not re.search(
        r"\b20[0-9]{2}\b|\b[0-9]{4}-[0-9]{2}-[0-9]{2}\b",
        normalized,
    )


def build_report_query(request_text: str) -> dict[str, Any]:
    focus = detect_report_focus(request_text)
    normalized = normalize_intent_text(request_text)
    if quarter_needs_clarification(normalized):
        return with_cost({
            "command": "report-plan",
            "request": request_text,
            "query": "",
            "resource": focus,
            "dateWindow": None,
            "review": {
                "allowed": False,
                "findings": [
                    "Quarter requests such as Q1 need an explicit year or date range before GAQL generation."
                ],
                "normalized": "",
            },
            "stakesTier": "green",
            "requiresEscalation": False,
            "requiresClarification": True,
        })
    date_window = choose_date_window(request_text)
    fields, source, order = report_shape(focus, normalized)
    where_parts = report_where_parts(source, normalized, date_window)
    query = f"SELECT {', '.join(fields)} FROM {source}"
    if where_parts:
        query += " WHERE " + " AND ".join(where_parts)
    if order:
        query += f" ORDER BY {order}"
    query += " LIMIT 25"

    return with_cost({
        "command": "report-plan",
        "request": request_text,
        "query": query,
        "resource": source,
        "dateWindow": date_window if source != "recommendation" else None,
        "review": review_gaql(query),
        "stakesTier": "green",
        "requiresEscalation": False,
    })


def review_gaql(query: str) -> dict[str, Any]:
    normalized = re.sub(r"\s+", " ", query.strip())
    lowered = normalized.lower()
    findings: list[str] = []

    if not lowered.startswith("select "):
        findings.append("GAQL must start with SELECT.")
    if re.search(r"\b(update|insert|delete|mutate|create|drop|alter)\b", lowered):
        findings.append("GAQL reports must be read-only.")
    if lowered.count(";") > 0:
        findings.append("GAQL must be a single statement without semicolons.")
    if " from " not in lowered:
        findings.append("GAQL must include a FROM resource.")
    uses_metrics = "metrics." in lowered
    has_date_window = "segments.date during" in lowered or "segments.date between" in lowered
    if uses_metrics and not has_date_window:
        findings.append("Metric reports should include a bounded segments.date window.")
    if " limit " not in lowered and any(token in lowered for token in ["campaign", "ad_group", "keyword_view", "search_term_view"]):
        findings.append("Exploratory reports should include LIMIT.")

    return {
        "allowed": len(findings) == 0,
        "findings": findings,
        "normalized": normalized,
    }


def contains_any(normalized_text: str, phrases: set[str]) -> bool:
    return any(phrase in normalized_text for phrase in phrases)


def classify_operation(request_text: str) -> dict[str, Any]:
    lowered = normalize_intent_text(request_text)
    reasons: list[str] = []
    operation = "read"
    tier = "green"
    required_grant = ""
    brand_voice = False

    if contains_any(lowered, CUSTOMER_MATCH_WORDS):
        operation = "customer-match-upload"
        tier = "red"
        required_grant = "approve-google-ads-customer-match-upload"
        reasons.append("customer-match upload can touch hashed PII")
    elif contains_any(lowered, MONEY_WORDS):
        operation = "budget-or-bid-strategy-mutation"
        tier = "red"
        required_grant = "approve-google-ads-budget-or-bid-change"
        reasons.append("budget or bidding changes can move real spend")
    elif "create campaign" in lowered or "new campaign" in lowered:
        operation = "budget-or-bid-strategy-mutation"
        tier = "red"
        required_grant = "approve-google-ads-budget-or-bid-change"
        reasons.append("campaign creation can attach budget and start spend")
    elif contains_any(lowered, CAMPAIGN_STATE_WORDS) or (
        "pause" in lowered and "campaign" in lowered
    ) or ("enable" in lowered and "campaign" in lowered):
        operation = "campaign-state-mutation"
        tier = "red"
        required_grant = "approve-google-ads-campaign-state-change"
        reasons.append("campaign state changes can start or stop spend")
    elif "conversion action" in lowered or "attribution model" in lowered:
        operation = "conversion-action-edit"
        tier = "red"
        required_grant = "approve-google-ads-conversion-action-edit"
        reasons.append("conversion changes alter optimization and reporting")
    elif contains_any(lowered, AD_COPY_WORDS) and any(
        word in lowered
        for word in [
            "submit",
            "create",
            "publish",
            "upload",
            "send",
            "draft",
            "entwirf",
            "erstelle",
        ]
    ):
        operation = "ad-copy"
        tier = "red" if any(word in lowered for word in ["submit", "publish", "upload"]) else "amber"
        required_grant = "approve-google-ads-ad-copy-submit" if tier == "red" else "approve-google-ads-ad-copy-draft"
        brand_voice = True
        reasons.append("ad copy must pass brand-voice review before submission")
    elif "recommendation" in lowered and "dismiss" in lowered:
        operation = "recommendation-dismiss"
        tier = "amber"
        required_grant = "approve-google-ads-recommendation-dismiss"
        reasons.append("recommendation dismissals require operator approval")
    elif "recommendation" in lowered and "apply" in lowered:
        operation = "recommendation-apply"
        tier = "amber"
        required_grant = "approve-google-ads-recommendation-apply"
        reasons.append("recommendation applies require operator approval")
    elif contains_any(lowered, AMBER_WORDS) and any(
        word in lowered
        for word in [
            "add",
            "edit",
            "pause",
            "apply",
            "target",
            "create",
            "hinzufuegen",
            "hinzufugen",
        ]
    ):
        operation = "campaign-structure-edit"
        tier = "amber"
        required_grant = "approve-google-ads-structure-edit"
        reasons.append("campaign structure changes require operator approval")
    elif contains_any(lowered, READ_WORDS):
        operation = "reporting-read"
        reasons.append("read-only reporting or inspection")
    else:
        operation = "unknown"
        tier = "amber"
        required_grant = "approve-google-ads-ambiguous-operation"
        reasons.append("ambiguous Google Ads operation requires review")

    return with_cost({
        "command": "plan",
        "request": request_text,
        "operation": operation,
        "stakesTier": tier,
        "requiresEscalation": tier in {"amber", "red"},
        "requiredGrant": required_grant,
        "brandVoiceGateRequired": brand_voice,
        "allowedWithoutGrant": tier == "green",
        "reasons": reasons,
    })


def command_plan(args: argparse.Namespace) -> dict[str, Any]:
    return classify_operation(args.request)


def command_report_plan(args: argparse.Namespace) -> dict[str, Any]:
    return build_report_query(args.request)


def command_review_gaql(args: argparse.Namespace) -> dict[str, Any]:
    return with_cost({
        "command": "review-gaql",
        "query": args.query,
        "review": review_gaql(args.query),
    })


def command_ad_copy_review(args: argparse.Namespace) -> dict[str, Any]:
    fields = {
        "headline": args.headline or "",
        "description": args.description or "",
        "sitelink": args.sitelink or "",
        "callout": args.callout or "",
    }
    non_empty = {key: value.strip() for key, value in fields.items() if value.strip()}
    findings: list[str] = []
    if not non_empty:
        findings.append("At least one ad-copy field is required.")
    for key, value in non_empty.items():
        if key == "headline" and len(value) > 30:
            findings.append("Responsive search ad headlines should be 30 characters or fewer.")
        if key == "description" and len(value) > 90:
            findings.append("Responsive search ad descriptions should be 90 characters or fewer.")
    return with_cost({
        "command": "ad-copy-review",
        "fields": non_empty,
        "brandVoiceGateRequired": True,
        "requiresEscalation": True,
        "stakesTier": "red",
        "requiredGrant": "approve-google-ads-ad-copy-submit",
        "preflight": {
            "allowed": len(findings) == 0,
            "findings": findings,
        },
    })


def command_prompt_template(args: argparse.Namespace) -> dict[str, Any]:
    question = non_empty(args.request, "request")
    deterministic_review = review_gaql(args.query) if args.query else {
        "allowed": False,
        "findings": ["No GAQL query has been drafted yet."],
        "normalized": "",
    }
    return with_cost({
        "command": "prompt-template",
        "templateFamily": "R21.6 NL-to-SQL model review",
        "dialect": "GAQL",
        "system": (
            "You review Google Ads GAQL for business meaning, schema fit, and safe scope. "
            "Return only JSON with status 'pass' or 'block', summary, and findings array. "
            "Block GAQL that does not answer the question, references absent schema, lacks a "
            "bounded date window for metrics, uses unsafe scope, or should be shown to the user "
            "before execution."
        ),
        "payload": {
            "question": question,
            "sql": args.query.strip(),
            "deterministicReview": {
                "status": "pass" if deterministic_review["allowed"] else "block",
                "readOnly": deterministic_review["allowed"],
                "statementCount": 1 if args.query.strip() else 0,
                "requiresWriteGrant": False,
                "findings": deterministic_review["findings"],
            },
            "schemaCache": json.dumps(GOOGLE_ADS_GAQL_SCHEMA, sort_keys=True),
        },
    })


def campaign_create_operation(args: argparse.Namespace, customer_id: str) -> dict[str, Any]:
    campaign: dict[str, Any] = {
        "name": non_empty(args.name, "campaign name"),
        "status": normalize_status(args.status, {"ENABLED", "PAUSED"}),
        "campaignBudget": ads_resource(
            customer_id,
            "campaignBudgets",
            coerce_positive_int(args.budget_id, "budget id"),
        ),
        "advertisingChannelType": normalize_status(
            args.channel_type,
            {"SEARCH", "DISPLAY", "VIDEO", "PERFORMANCE_MAX", "DEMAND_GEN"},
            "channel type",
        ),
    }
    if campaign["advertisingChannelType"] == "SEARCH":
        campaign["networkSettings"] = {
            "targetGoogleSearch": True,
            "targetSearchNetwork": parse_bool(args.target_search_network),
            "targetContentNetwork": parse_bool(args.target_content_network),
            "targetPartnerSearchNetwork": parse_bool(args.target_partner_search_network),
        }
    strategy = args.bidding_strategy
    if strategy == "manual-cpc":
        campaign["manualCpc"] = {}
    elif strategy == "maximize-conversions":
        campaign["maximizeConversions"] = {}
    elif strategy == "maximize-conversion-value":
        campaign["maximizeConversionValue"] = {}
    return {"create": campaign}


def command_campaign_create(args: argparse.Namespace) -> dict[str, Any]:
    customer_id = normalize_customer_id(args.customer_id)
    return mutate_service(
        args,
        service="campaigns",
        operation_key="budget-or-bid-strategy-mutation",
        operations=[campaign_create_operation(args, customer_id)],
    )


def command_campaign_status(args: argparse.Namespace) -> dict[str, Any]:
    customer_id = normalize_customer_id(args.customer_id)
    campaign_id = coerce_positive_int(args.campaign_id, "campaign id")
    status = normalize_status(args.status, {"ENABLED", "PAUSED"})
    return mutate_service(
        args,
        service="campaigns",
        operation_key="campaign-state-mutation",
        operations=[
            {
                "updateMask": "status",
                "update": {
                    "resourceName": ads_resource(customer_id, "campaigns", campaign_id),
                    "status": status,
                },
            }
        ],
    )


def command_campaign_rename(args: argparse.Namespace) -> dict[str, Any]:
    customer_id = normalize_customer_id(args.customer_id)
    campaign_id = coerce_positive_int(args.campaign_id, "campaign id")
    return mutate_service(
        args,
        service="campaigns",
        operation_key="campaign-structure-edit",
        operations=[
            {
                "updateMask": "name",
                "update": {
                    "resourceName": ads_resource(customer_id, "campaigns", campaign_id),
                    "name": non_empty(args.name, "campaign name"),
                },
            }
        ],
    )


def command_campaign_remove(args: argparse.Namespace) -> dict[str, Any]:
    customer_id = normalize_customer_id(args.customer_id)
    campaign_id = coerce_positive_int(args.campaign_id, "campaign id")
    return mutate_service(
        args,
        service="campaigns",
        operation_key="campaign-state-mutation",
        operations=[{"remove": ads_resource(customer_id, "campaigns", campaign_id)}],
    )


def command_campaign_bid_strategy(args: argparse.Namespace) -> dict[str, Any]:
    customer_id = normalize_customer_id(args.customer_id)
    campaign_id = coerce_positive_int(args.campaign_id, "campaign id")
    strategy = args.strategy
    update: dict[str, Any] = {
        "resourceName": ads_resource(customer_id, "campaigns", campaign_id),
    }
    update_mask = ""
    if strategy == "portfolio":
        update["biddingStrategy"] = non_empty(args.bidding_strategy_resource, "bidding strategy resource")
        update_mask = "biddingStrategy"
    elif strategy == "manual-cpc":
        update["manualCpc"] = {}
        update_mask = "manualCpc"
    elif strategy == "maximize-conversions":
        update["maximizeConversions"] = {}
        if args.target_cpa_micros:
            update["maximizeConversions"]["targetCpaMicros"] = str(
                coerce_positive_int(args.target_cpa_micros, "target cpa micros")
            )
            update_mask = "maximizeConversions.targetCpaMicros"
        else:
            update_mask = "maximizeConversions"
    elif strategy == "maximize-conversion-value":
        update["maximizeConversionValue"] = {}
        if args.target_roas:
            update["maximizeConversionValue"]["targetRoas"] = normalize_float(
                args.target_roas,
                "target roas",
            )
            update_mask = "maximizeConversionValue.targetRoas"
        else:
            update_mask = "maximizeConversionValue"
    elif strategy == "target-cpa":
        update["targetCpa"] = {
            "targetCpaMicros": str(
                coerce_positive_int(args.target_cpa_micros, "target cpa micros")
            )
        }
        update_mask = "targetCpa"
    elif strategy == "target-roas":
        update["targetRoas"] = {
            "targetRoas": normalize_float(args.target_roas, "target roas")
        }
        update_mask = "targetRoas"
    return mutate_service(
        args,
        service="campaigns",
        operation_key="budget-or-bid-strategy-mutation",
        operations=[{"updateMask": update_mask, "update": update}],
    )


def command_budget_amount(args: argparse.Namespace) -> dict[str, Any]:
    customer_id = normalize_customer_id(args.customer_id)
    budget_id = coerce_positive_int(args.budget_id, "budget id")
    amount_micros = coerce_positive_int(args.amount_micros, "amount micros")
    return mutate_service(
        args,
        service="campaignBudgets",
        operation_key="budget-or-bid-strategy-mutation",
        operations=[
            {
                "updateMask": "amountMicros",
                "update": {
                    "resourceName": ads_resource(
                        customer_id, "campaignBudgets", budget_id
                    ),
                    "amountMicros": str(amount_micros),
                },
            }
        ],
    )


def command_budget_lifetime_amount(args: argparse.Namespace) -> dict[str, Any]:
    customer_id = normalize_customer_id(args.customer_id)
    budget_id = coerce_positive_int(args.budget_id, "budget id")
    amount_micros = coerce_positive_int(args.total_amount_micros, "total amount micros")
    return mutate_service(
        args,
        service="campaignBudgets",
        operation_key="budget-or-bid-strategy-mutation",
        operations=[
            {
                "updateMask": "totalAmountMicros",
                "update": {
                    "resourceName": ads_resource(
                        customer_id, "campaignBudgets", budget_id
                    ),
                    "totalAmountMicros": str(amount_micros),
                },
            }
        ],
    )


def command_ad_group_create(args: argparse.Namespace) -> dict[str, Any]:
    customer_id = normalize_customer_id(args.customer_id)
    campaign_id = coerce_positive_int(args.campaign_id, "campaign id")
    status = normalize_status(args.status, {"ENABLED", "PAUSED"})
    ad_group: dict[str, Any] = {
        "campaign": ads_resource(customer_id, "campaigns", campaign_id),
        "name": args.name.strip(),
        "status": status,
    }
    if not ad_group["name"]:
        raise ConfigError("ad group name is required.")
    if args.cpc_bid_micros:
        ad_group["cpcBidMicros"] = str(
            coerce_positive_int(args.cpc_bid_micros, "cpc bid micros")
        )
    return mutate_service(
        args,
        service="adGroups",
        operation_key="campaign-structure-edit",
        operations=[{"create": ad_group}],
    )


def command_ad_group_status(args: argparse.Namespace) -> dict[str, Any]:
    customer_id = normalize_customer_id(args.customer_id)
    ad_group_id = coerce_positive_int(args.ad_group_id, "ad group id")
    status = normalize_status(args.status, {"ENABLED", "PAUSED", "REMOVED"})
    return mutate_service(
        args,
        service="adGroups",
        operation_key="campaign-structure-edit",
        operations=[
            {
                "updateMask": "status",
                "update": {
                    "resourceName": ads_resource(customer_id, "adGroups", ad_group_id),
                    "status": status,
                },
            }
        ],
    )


def command_ad_group_rename(args: argparse.Namespace) -> dict[str, Any]:
    customer_id = normalize_customer_id(args.customer_id)
    ad_group_id = coerce_positive_int(args.ad_group_id, "ad group id")
    return mutate_service(
        args,
        service="adGroups",
        operation_key="campaign-structure-edit",
        operations=[
            {
                "updateMask": "name",
                "update": {
                    "resourceName": ads_resource(customer_id, "adGroups", ad_group_id),
                    "name": non_empty(args.name, "ad group name"),
                },
            }
        ],
    )


def command_ad_group_remove(args: argparse.Namespace) -> dict[str, Any]:
    customer_id = normalize_customer_id(args.customer_id)
    ad_group_id = coerce_positive_int(args.ad_group_id, "ad group id")
    return mutate_service(
        args,
        service="adGroups",
        operation_key="campaign-structure-edit",
        operations=[{"remove": ads_resource(customer_id, "adGroups", ad_group_id)}],
    )


def command_keyword_create(args: argparse.Namespace) -> dict[str, Any]:
    customer_id = normalize_customer_id(args.customer_id)
    ad_group_id = coerce_positive_int(args.ad_group_id, "ad group id")
    status = normalize_status(args.status, {"ENABLED", "PAUSED"})
    match_type = normalize_status(args.match_type, {"BROAD", "EXACT", "PHRASE"}, "match type")
    text = args.text.strip()
    if not text:
        raise ConfigError("keyword text is required.")
    criterion: dict[str, Any] = {
        "adGroup": ads_resource(customer_id, "adGroups", ad_group_id),
        "status": status,
        "keyword": {"text": text, "matchType": match_type},
    }
    if args.cpc_bid_micros:
        criterion["cpcBidMicros"] = str(
            coerce_positive_int(args.cpc_bid_micros, "cpc bid micros")
        )
    return mutate_service(
        args,
        service="adGroupCriteria",
        operation_key="campaign-structure-edit",
        operations=[{"create": criterion}],
    )


def command_keyword_status(args: argparse.Namespace) -> dict[str, Any]:
    customer_id = normalize_customer_id(args.customer_id)
    ad_group_id = coerce_positive_int(args.ad_group_id, "ad group id")
    criterion_id = coerce_positive_int(args.criterion_id, "criterion id")
    status = normalize_status(args.status, {"ENABLED", "PAUSED"})
    return mutate_service(
        args,
        service="adGroupCriteria",
        operation_key="campaign-structure-edit",
        operations=[
            {
                "updateMask": "status",
                "update": {
                    "resourceName": ads_resource(
                        customer_id,
                        "adGroupCriteria",
                        f"{ad_group_id}~{criterion_id}",
                    ),
                    "status": status,
                },
            }
        ],
    )


def command_keyword_remove(args: argparse.Namespace) -> dict[str, Any]:
    customer_id = normalize_customer_id(args.customer_id)
    ad_group_id = coerce_positive_int(args.ad_group_id, "ad group id")
    criterion_id = coerce_positive_int(args.criterion_id, "criterion id")
    return mutate_service(
        args,
        service="adGroupCriteria",
        operation_key="campaign-structure-edit",
        operations=[
            {
                "remove": composite_resource(
                    customer_id,
                    "adGroupCriteria",
                    ad_group_id,
                    criterion_id,
                )
            }
        ],
    )


def command_rsa_create(args: argparse.Namespace) -> dict[str, Any]:
    if not args.brand_voice_approved:
        raise ConfigError(
            "Refusing ad-copy submission; pass --brand-voice-approved only after the brand-voice gate passes."
        )
    # This flag is a workflow assertion from the agent/operator review path,
    # not cryptographic proof. Keep the explicit grant check first.
    require_grant(args, "ad-copy-submit")
    customer_id = normalize_customer_id(args.customer_id)
    ad_group_id = coerce_positive_int(args.ad_group_id, "ad group id")
    headlines = [text.strip() for text in args.headline if text.strip()]
    descriptions = [text.strip() for text in args.description if text.strip()]
    final_urls = [url.strip() for url in args.final_url if url.strip()]
    if len(headlines) < 3:
        raise ConfigError("responsive search ads require at least three headlines.")
    if len(descriptions) < 2:
        raise ConfigError("responsive search ads require at least two descriptions.")
    if not final_urls:
        raise ConfigError("at least one final URL is required.")
    review_findings = []
    for headline in headlines:
        if len(headline) > 30:
            review_findings.append("Responsive search ad headlines should be 30 characters or fewer.")
    for description in descriptions:
        if len(description) > 90:
            review_findings.append("Responsive search ad descriptions should be 90 characters or fewer.")
    if review_findings:
        raise ConfigError("Ad-copy preflight failed: " + "; ".join(review_findings))
    return mutate_service(
        args,
        service="adGroupAds",
        operation_key="ad-copy-submit",
        operations=[
            {
                "create": {
                    "adGroup": ads_resource(customer_id, "adGroups", ad_group_id),
                    "status": normalize_status(args.status, {"ENABLED", "PAUSED"}),
                    "ad": {
                        "responsiveSearchAd": {
                            "headlines": [{"text": text} for text in headlines],
                            "descriptions": [
                                {"text": text} for text in descriptions
                            ],
                        },
                        "finalUrls": final_urls,
                    },
                }
            }
        ],
    )


def command_ad_status(args: argparse.Namespace) -> dict[str, Any]:
    customer_id = normalize_customer_id(args.customer_id)
    ad_group_id = coerce_positive_int(args.ad_group_id, "ad group id")
    ad_id = coerce_positive_int(args.ad_id, "ad id")
    status = normalize_status(args.status, {"ENABLED", "PAUSED", "REMOVED"})
    return mutate_service(
        args,
        service="adGroupAds",
        operation_key="campaign-structure-edit",
        operations=[
            {
                "updateMask": "status",
                "update": {
                    "resourceName": composite_resource(
                        customer_id,
                        "adGroupAds",
                        ad_group_id,
                        ad_id,
                    ),
                    "status": status,
                },
            }
        ],
    )


def command_ad_remove(args: argparse.Namespace) -> dict[str, Any]:
    customer_id = normalize_customer_id(args.customer_id)
    ad_group_id = coerce_positive_int(args.ad_group_id, "ad group id")
    ad_id = coerce_positive_int(args.ad_id, "ad id")
    return mutate_service(
        args,
        service="adGroupAds",
        operation_key="campaign-structure-edit",
        operations=[
            {
                "remove": composite_resource(
                    customer_id,
                    "adGroupAds",
                    ad_group_id,
                    ad_id,
                )
            }
        ],
    )


def command_conversion_action_status(args: argparse.Namespace) -> dict[str, Any]:
    customer_id = normalize_customer_id(args.customer_id)
    conversion_action_id = coerce_positive_int(
        args.conversion_action_id, "conversion action id"
    )
    status = normalize_status(args.status, {"ENABLED", "HIDDEN", "REMOVED"})
    return mutate_service(
        args,
        service="conversionActions",
        operation_key="conversion-action-edit",
        operations=[
            {
                "updateMask": "status",
                "update": {
                    "resourceName": ads_resource(
                        customer_id, "conversionActions", conversion_action_id
                    ),
                    "status": status,
                },
            }
        ],
    )


def command_conversion_action_create(args: argparse.Namespace) -> dict[str, Any]:
    customer_id = normalize_customer_id(args.customer_id)
    conversion: dict[str, Any] = {
        "name": non_empty(args.name, "conversion action name"),
        "type": normalize_status(args.type, {"WEBPAGE", "UPLOAD_CLICKS", "PHONE_CALL_LEAD"}, "type"),
        "category": normalize_status(args.category, {"DEFAULT", "PURCHASE", "LEAD", "SIGNUP", "PAGE_VIEW"}, "category"),
        "status": normalize_status(args.status, {"ENABLED", "HIDDEN"}),
        "countingType": normalize_status(args.counting_type, {"ONE_PER_CLICK", "MANY_PER_CLICK"}, "counting type"),
        "primaryForGoal": parse_bool(args.primary_for_goal),
    }
    if args.default_value:
        conversion["valueSettings"] = {
            "defaultValue": normalize_float(args.default_value, "default value"),
            "alwaysUseDefaultValue": parse_bool(args.always_use_default_value),
        }
    return mutate_service(
        args,
        service="conversionActions",
        operation_key="conversion-action-edit",
        operations=[{"create": conversion}],
    )


def command_conversion_action_attribution(args: argparse.Namespace) -> dict[str, Any]:
    customer_id = normalize_customer_id(args.customer_id)
    conversion_action_id = coerce_positive_int(
        args.conversion_action_id,
        "conversion action id",
    )
    model = normalize_status(
        args.attribution_model,
        {
            "DATA_DRIVEN",
            "LAST_CLICK",
            "FIRST_CLICK",
            "LINEAR",
            "TIME_DECAY",
            "POSITION_BASED",
        },
        "attribution model",
    )
    return mutate_service(
        args,
        service="conversionActions",
        operation_key="conversion-action-edit",
        operations=[
            {
                "updateMask": "attributionModelSettings.attributionModel",
                "update": {
                    "resourceName": ads_resource(
                        customer_id,
                        "conversionActions",
                        conversion_action_id,
                    ),
                    "attributionModelSettings": {"attributionModel": model},
                },
            }
        ],
    )


def command_user_list_customer_match_create(args: argparse.Namespace) -> dict[str, Any]:
    customer_id = normalize_customer_id(args.customer_id)
    user_list = {
        "name": non_empty(args.name, "user list name"),
        "description": args.description.strip(),
        "membershipStatus": "OPEN",
        "membershipLifeSpan": str(coerce_positive_int(args.membership_days, "membership days")),
        "crmBasedUserList": {"uploadKeyType": "CONTACT_INFO"},
    }
    return mutate_service(
        args,
        service="userLists",
        operation_key="customer-match-upload",
        operations=[{"create": user_list}],
    )


def command_user_list_remarketing_create(args: argparse.Namespace) -> dict[str, Any]:
    customer_id = normalize_customer_id(args.customer_id)
    actions = []
    for value in args.remarketing_action:
        actions.append({"remarketingAction": non_empty(value, "remarketing action resource")})
    for value in args.conversion_action:
        actions.append({"conversionAction": non_empty(value, "conversion action resource")})
    if not actions:
        raise ConfigError("At least one remarketing or conversion action resource is required.")
    user_list = {
        "name": non_empty(args.name, "user list name"),
        "description": args.description.strip(),
        "membershipStatus": "OPEN",
        "membershipLifeSpan": str(coerce_positive_int(args.membership_days, "membership days")),
        "basicUserList": {"actions": actions},
    }
    return mutate_service(
        args,
        service="userLists",
        operation_key="audience-management",
        operations=[{"create": user_list}],
    )


def command_user_list_lookalike_create(args: argparse.Namespace) -> dict[str, Any]:
    seed_ids = [
        str(coerce_positive_int(seed_id, "seed user list id"))
        for seed_id in args.seed_user_list_id
    ]
    if not seed_ids:
        raise ConfigError("At least one seed user list id is required.")
    user_list = {
        "name": non_empty(args.name, "user list name"),
        "description": args.description.strip(),
        "membershipStatus": "OPEN",
        "lookalikeUserList": {
            "seedUserListIds": seed_ids,
            "expansionLevel": normalize_status(
                args.expansion_level,
                {"NARROW", "BALANCED", "BROAD"},
                "expansion level",
            ),
            "countryCodes": [code.strip().upper() for code in args.country_code if code.strip()],
        },
    }
    return mutate_service(
        args,
        service="userLists",
        operation_key="audience-management",
        operations=[{"create": user_list}],
    )


def command_campaign_user_interest_target(args: argparse.Namespace) -> dict[str, Any]:
    customer_id = normalize_customer_id(args.customer_id)
    campaign_id = coerce_positive_int(args.campaign_id, "campaign id")
    interest_id = coerce_positive_int(args.user_interest_id, "user interest id")
    criterion = {
        "campaign": ads_resource(customer_id, "campaigns", campaign_id),
        "negative": bool(args.negative),
        "userInterest": {
            "userInterestCategory": ads_resource(
                customer_id,
                "userInterests",
                interest_id,
            )
        },
    }
    return mutate_service(
        args,
        service="campaignCriteria",
        operation_key="audience-management",
        operations=[{"create": criterion}],
    )


def command_customer_match_job_create(args: argparse.Namespace) -> dict[str, Any]:
    customer_id = normalize_customer_id(args.customer_id)
    user_list = non_empty(args.user_list_resource, "user list resource")
    if not user_list.startswith(f"customers/{customer_id}/userLists/"):
        raise ConfigError("user list resource must match customers/<customer-id>/userLists/<id>.")
    request_body = {
        "job": {
            "type": "CUSTOMER_MATCH_USER_LIST",
            "customerMatchUserListMetadata": {"userList": user_list},
        },
        "validateOnly": bool(args.validate_only),
        "enableMatchRateRangePreview": bool(args.enable_match_rate_range_preview),
    }
    return action_service(
        args,
        command="customer-match-job-create",
        path=f"/customers/{customer_id}/offlineUserDataJobs:create",
        operation_key="customer-match-upload",
        request_body=request_body,
    )


def command_customer_match_add_hashes(args: argparse.Namespace) -> dict[str, Any]:
    customer_id = normalize_customer_id(args.customer_id)
    resource_name = non_empty(args.job_resource_name, "offline user data job resource")
    if not resource_name.startswith(f"customers/{customer_id}/offlineUserDataJobs/"):
        raise ConfigError(
            "offline user data job resource must match customers/<customer-id>/offlineUserDataJobs/<id>."
        )
    email_hashes = validate_sha256_hex(args.sha256_email, "email")
    phone_hashes = validate_sha256_hex(args.sha256_phone, "phone")
    address_infos = [
        parse_address_info(value)
        for value in args.address_info_json
        if value.strip()
    ]
    if not email_hashes and not phone_hashes and not address_infos:
        raise ConfigError(
            "At least one hashed email, hashed phone, or address-info identifier is required."
        )
    operations = [
        {"create": {"userIdentifiers": [{"hashedEmail": email_hash}]}}
        for email_hash in email_hashes
    ]
    operations.extend(
        {"create": {"userIdentifiers": [{"hashedPhoneNumber": phone_hash}]}}
        for phone_hash in phone_hashes
    )
    operations.extend(
        {"create": {"userIdentifiers": [{"addressInfo": address_info}]}}
        for address_info in address_infos
    )
    request_body = {
        "operations": operations,
        "validateOnly": bool(args.validate_only),
        "enablePartialFailure": True,
        "enableWarnings": True,
    }
    return action_service(
        args,
        command="customer-match-add-hashes",
        path=f"/{resource_name}:addOperations",
        operation_key="customer-match-upload",
        request_body=request_body,
    )


def command_customer_match_job_run(args: argparse.Namespace) -> dict[str, Any]:
    customer_id = normalize_customer_id(args.customer_id)
    resource_name = non_empty(args.job_resource_name, "offline user data job resource")
    if not resource_name.startswith(f"customers/{customer_id}/offlineUserDataJobs/"):
        raise ConfigError(
            "offline user data job resource must match customers/<customer-id>/offlineUserDataJobs/<id>."
        )
    return action_service(
        args,
        command="customer-match-job-run",
        path=f"/{resource_name}:run",
        operation_key="customer-match-upload",
        request_body={},
    )


def command_apply_recommendation(args: argparse.Namespace) -> dict[str, Any]:
    customer_id = normalize_customer_id(args.customer_id)
    if not customer_id:
        raise ConfigError("Missing Google Ads customer id.")
    resource_name = args.resource_name.strip()
    if not resource_name.startswith(f"customers/{customer_id}/recommendations/"):
        raise ConfigError(
            "recommendation resource name must match customers/<customer-id>/recommendations/<id>."
        )
    request_body = {
        "operations": [{"resourceName": resource_name}],
        "partialFailure": bool(args.partial_failure),
    }
    return action_service(
        args,
        command="apply-recommendation",
        path=f"/customers/{customer_id}/recommendations:apply",
        operation_key="recommendation-apply",
        request_body=request_body,
    )


def command_dismiss_recommendation(args: argparse.Namespace) -> dict[str, Any]:
    customer_id = normalize_customer_id(args.customer_id)
    if not customer_id:
        raise ConfigError("Missing Google Ads customer id.")
    resource_name = args.resource_name.strip()
    if not resource_name.startswith(f"customers/{customer_id}/recommendations/"):
        raise ConfigError(
            "recommendation resource name must match customers/<customer-id>/recommendations/<id>."
        )
    request_body = {
        "operations": [{"resourceName": resource_name}],
        "partialFailure": bool(args.partial_failure),
    }
    return action_service(
        args,
        command="dismiss-recommendation",
        path=f"/customers/{customer_id}/recommendations:dismiss",
        operation_key="recommendation-dismiss",
        request_body=request_body,
    )


def load_scenarios() -> list[dict[str, Any]]:
    with EVAL_SCENARIOS_PATH.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, list):
        raise ConfigError("Google Ads eval scenarios must be a JSON array.")
    return payload


def run_eval_scenarios() -> dict[str, Any]:
    scenarios = load_scenarios()
    failures: list[dict[str, Any]] = []
    categories: dict[str, int] = {}
    tiers: dict[str, int] = {}
    key_paths = {
        "reviewAllowed": ("review", "allowed"),
        "preflightAllowed": ("preflight", "allowed"),
        "costSystem": ("costMeasurement", "system"),
    }

    for scenario in scenarios:
        category = str(scenario.get("category") or "uncategorized")
        categories[category] = categories.get(category, 0) + 1
        kind = str(scenario.get("kind") or "plan")
        expected = scenario.get("expected") if isinstance(scenario.get("expected"), dict) else {}

        if kind == "report-plan":
            actual = build_report_query(str(scenario.get("request") or ""))
        elif kind == "review-gaql":
            actual = with_cost({
                "review": review_gaql(str(scenario.get("query") or "")),
            })
        elif kind == "ad-copy-review":
            fake_args = argparse.Namespace(
                headline=scenario.get("headline") or "",
                description=scenario.get("description") or "",
                sitelink=scenario.get("sitelink") or "",
                callout=scenario.get("callout") or "",
            )
            actual = command_ad_copy_review(fake_args)
        else:
            actual = classify_operation(str(scenario.get("request") or ""))

        tier = str(actual.get("stakesTier") or expected.get("stakesTier") or "unknown")
        tiers[tier] = tiers.get(tier, 0) + 1

        checks = {
            "stakesTier": actual.get("stakesTier"),
            "requiresEscalation": actual.get("requiresEscalation"),
            "brandVoiceGateRequired": actual.get("brandVoiceGateRequired"),
            "operation": actual.get("operation"),
        }
        for key, expected_value in expected.items():
            if key in key_paths:
                first, second = key_paths[key]
                actual_value = actual.get(first, {}).get(second)
            elif key == "queryContains":
                query = str(actual.get("query") or "")
                missing = [entry for entry in expected_value if entry not in query]
                if missing:
                    failures.append(
                        {
                            "id": scenario.get("id"),
                            "field": key,
                            "expected": expected_value,
                            "actual": query,
                        }
                    )
                continue
            else:
                actual_value = checks.get(key)
            if actual_value != expected_value:
                failures.append(
                    {
                        "id": scenario.get("id"),
                        "field": key,
                        "expected": expected_value,
                        "actual": actual_value,
                    }
                )

    return with_cost({
        "command": "eval-scenarios",
        "scenarioCount": len(scenarios),
        "failed": len(failures),
        "failures": failures,
        "categories": categories,
        "stakesTiers": tiers,
    })


def command_eval_scenarios(_args: argparse.Namespace) -> dict[str, Any]:
    return run_eval_scenarios()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Google Ads GAQL reporting, planning, and guarded REST helper."
    )
    parser.add_argument("--format", choices=["text", "json"], default="text")
    parser.add_argument("--gateway-url", default=None)
    parser.add_argument("--gateway-token", default=None)
    parser.add_argument("--timeout-ms", type=int, default=DEFAULT_TIMEOUT_MS)
    parser.add_argument("--api-version", default=DEFAULT_API_VERSION)
    parser.add_argument("--login-customer-id", default="")
    subparsers = parser.add_subparsers(dest="command", required=True)

    customers = subparsers.add_parser(
        "customers", help="List accessible Google Ads customers through the gateway."
    )
    customers.set_defaults(func=command_customers)

    gaql = subparsers.add_parser("gaql", help="Run a reviewed GAQL report.")
    gaql.add_argument("customer_id")
    gaql.add_argument("query")
    gaql.add_argument("--max-response-bytes", type=int, default=2_000_000)
    gaql.set_defaults(func=command_gaql)

    review = subparsers.add_parser("review-gaql", help="Review GAQL without calling the API.")
    review.add_argument("query")
    review.set_defaults(func=command_review_gaql)

    report = subparsers.add_parser(
        "report-plan", help="Generate a conservative GAQL plan from natural language."
    )
    report.add_argument("request")
    report.set_defaults(func=command_report_plan)

    prompt_template = subparsers.add_parser(
        "prompt-template",
        help="Emit the R21.6-style model review prompt payload adapted for GAQL.",
    )
    prompt_template.add_argument("request")
    prompt_template.add_argument("--query", default="")
    prompt_template.set_defaults(func=command_prompt_template)

    plan = subparsers.add_parser("plan", help="Classify a Google Ads operation before execution.")
    plan.add_argument("request")
    plan.set_defaults(func=command_plan)

    copy = subparsers.add_parser(
        "ad-copy-review", help="Preflight ad-copy fields before brand-voice and approval."
    )
    copy.add_argument("--headline", default="")
    copy.add_argument("--description", default="")
    copy.add_argument("--sitelink", default="")
    copy.add_argument("--callout", default="")
    copy.set_defaults(func=command_ad_copy_review)

    campaign_create = subparsers.add_parser(
        "campaign-create", help="Create a campaign after explicit budget/spend approval."
    )
    campaign_create.add_argument("customer_id")
    campaign_create.add_argument("budget_id")
    campaign_create.add_argument("--name", required=True)
    campaign_create.add_argument("--status", default="PAUSED")
    campaign_create.add_argument("--channel-type", default="SEARCH")
    campaign_create.add_argument(
        "--bidding-strategy",
        choices=["manual-cpc", "maximize-conversions", "maximize-conversion-value"],
        default="manual-cpc",
    )
    campaign_create.add_argument("--target-search-network", default="true")
    campaign_create.add_argument("--target-content-network", default="false")
    campaign_create.add_argument("--target-partner-search-network", default="false")
    campaign_create.add_argument("--grant", default="")
    campaign_create.add_argument("--validate-only", action="store_true")
    campaign_create.set_defaults(func=command_campaign_create)

    campaign_status = subparsers.add_parser(
        "campaign-status", help="Pause or enable a campaign after explicit approval."
    )
    campaign_status.add_argument("customer_id")
    campaign_status.add_argument("campaign_id")
    campaign_status.add_argument("--status", required=True)
    campaign_status.add_argument("--grant", default="")
    campaign_status.add_argument("--validate-only", action="store_true")
    campaign_status.set_defaults(func=command_campaign_status)

    campaign_rename = subparsers.add_parser(
        "campaign-rename", help="Rename a campaign after explicit approval."
    )
    campaign_rename.add_argument("customer_id")
    campaign_rename.add_argument("campaign_id")
    campaign_rename.add_argument("--name", required=True)
    campaign_rename.add_argument("--grant", default="")
    campaign_rename.add_argument("--validate-only", action="store_true")
    campaign_rename.set_defaults(func=command_campaign_rename)

    campaign_remove = subparsers.add_parser(
        "campaign-remove", help="Remove a campaign after explicit approval."
    )
    campaign_remove.add_argument("customer_id")
    campaign_remove.add_argument("campaign_id")
    campaign_remove.add_argument("--grant", default="")
    campaign_remove.add_argument("--validate-only", action="store_true")
    campaign_remove.set_defaults(func=command_campaign_remove)

    campaign_bid_strategy = subparsers.add_parser(
        "campaign-bid-strategy",
        help="Switch a campaign bidding strategy after explicit approval.",
    )
    campaign_bid_strategy.add_argument("customer_id")
    campaign_bid_strategy.add_argument("campaign_id")
    campaign_bid_strategy.add_argument(
        "--strategy",
        choices=[
            "portfolio",
            "manual-cpc",
            "maximize-conversions",
            "maximize-conversion-value",
            "target-cpa",
            "target-roas",
        ],
        required=True,
    )
    campaign_bid_strategy.add_argument("--bidding-strategy-resource", default="")
    campaign_bid_strategy.add_argument("--target-cpa-micros", default="")
    campaign_bid_strategy.add_argument("--target-roas", default="")
    campaign_bid_strategy.add_argument("--grant", default="")
    campaign_bid_strategy.add_argument("--validate-only", action="store_true")
    campaign_bid_strategy.set_defaults(func=command_campaign_bid_strategy)

    budget_amount = subparsers.add_parser(
        "budget-amount", help="Update a campaign budget amount after explicit approval."
    )
    budget_amount.add_argument("customer_id")
    budget_amount.add_argument("budget_id")
    budget_amount.add_argument("--amount-micros", required=True)
    budget_amount.add_argument("--grant", default="")
    budget_amount.add_argument("--validate-only", action="store_true")
    budget_amount.set_defaults(func=command_budget_amount)

    budget_lifetime_amount = subparsers.add_parser(
        "budget-lifetime-amount",
        help="Update a lifetime campaign budget total after explicit approval.",
    )
    budget_lifetime_amount.add_argument("customer_id")
    budget_lifetime_amount.add_argument("budget_id")
    budget_lifetime_amount.add_argument("--total-amount-micros", required=True)
    budget_lifetime_amount.add_argument("--grant", default="")
    budget_lifetime_amount.add_argument("--validate-only", action="store_true")
    budget_lifetime_amount.set_defaults(func=command_budget_lifetime_amount)

    ad_group_create = subparsers.add_parser(
        "ad-group-create", help="Create an ad group after explicit approval."
    )
    ad_group_create.add_argument("customer_id")
    ad_group_create.add_argument("campaign_id")
    ad_group_create.add_argument("--name", required=True)
    ad_group_create.add_argument("--status", default="PAUSED")
    ad_group_create.add_argument("--cpc-bid-micros", default="")
    ad_group_create.add_argument("--grant", default="")
    ad_group_create.add_argument("--validate-only", action="store_true")
    ad_group_create.set_defaults(func=command_ad_group_create)

    ad_group_status = subparsers.add_parser(
        "ad-group-status", help="Pause, enable, or remove an ad group after approval."
    )
    ad_group_status.add_argument("customer_id")
    ad_group_status.add_argument("ad_group_id")
    ad_group_status.add_argument("--status", required=True)
    ad_group_status.add_argument("--grant", default="")
    ad_group_status.add_argument("--validate-only", action="store_true")
    ad_group_status.set_defaults(func=command_ad_group_status)

    ad_group_rename = subparsers.add_parser(
        "ad-group-rename", help="Rename an ad group after approval."
    )
    ad_group_rename.add_argument("customer_id")
    ad_group_rename.add_argument("ad_group_id")
    ad_group_rename.add_argument("--name", required=True)
    ad_group_rename.add_argument("--grant", default="")
    ad_group_rename.add_argument("--validate-only", action="store_true")
    ad_group_rename.set_defaults(func=command_ad_group_rename)

    ad_group_remove = subparsers.add_parser(
        "ad-group-remove", help="Remove an ad group after approval."
    )
    ad_group_remove.add_argument("customer_id")
    ad_group_remove.add_argument("ad_group_id")
    ad_group_remove.add_argument("--grant", default="")
    ad_group_remove.add_argument("--validate-only", action="store_true")
    ad_group_remove.set_defaults(func=command_ad_group_remove)

    keyword_create = subparsers.add_parser(
        "keyword-create", help="Create an ad group keyword after explicit approval."
    )
    keyword_create.add_argument("customer_id")
    keyword_create.add_argument("ad_group_id")
    keyword_create.add_argument("--text", required=True)
    keyword_create.add_argument("--match-type", default="EXACT")
    keyword_create.add_argument("--status", default="PAUSED")
    keyword_create.add_argument("--cpc-bid-micros", default="")
    keyword_create.add_argument("--grant", default="")
    keyword_create.add_argument("--validate-only", action="store_true")
    keyword_create.set_defaults(func=command_keyword_create)

    keyword_status = subparsers.add_parser(
        "keyword-status", help="Pause or enable an ad group keyword after approval."
    )
    keyword_status.add_argument("customer_id")
    keyword_status.add_argument("ad_group_id")
    keyword_status.add_argument("criterion_id")
    keyword_status.add_argument("--status", required=True)
    keyword_status.add_argument("--grant", default="")
    keyword_status.add_argument("--validate-only", action="store_true")
    keyword_status.set_defaults(func=command_keyword_status)

    keyword_remove = subparsers.add_parser(
        "keyword-remove", help="Remove an ad group keyword after approval."
    )
    keyword_remove.add_argument("customer_id")
    keyword_remove.add_argument("ad_group_id")
    keyword_remove.add_argument("criterion_id")
    keyword_remove.add_argument("--grant", default="")
    keyword_remove.add_argument("--validate-only", action="store_true")
    keyword_remove.set_defaults(func=command_keyword_remove)

    rsa_create = subparsers.add_parser(
        "rsa-create", help="Submit a responsive search ad after brand-voice and approval."
    )
    rsa_create.add_argument("customer_id")
    rsa_create.add_argument("ad_group_id")
    rsa_create.add_argument("--headline", action="append", default=[])
    rsa_create.add_argument("--description", action="append", default=[])
    rsa_create.add_argument("--final-url", action="append", default=[])
    rsa_create.add_argument("--status", default="PAUSED")
    rsa_create.add_argument("--brand-voice-approved", action="store_true")
    rsa_create.add_argument("--grant", default="")
    rsa_create.add_argument("--validate-only", action="store_true")
    rsa_create.set_defaults(func=command_rsa_create)

    ad_status = subparsers.add_parser(
        "ad-status", help="Pause, enable, or remove an ad after approval."
    )
    ad_status.add_argument("customer_id")
    ad_status.add_argument("ad_group_id")
    ad_status.add_argument("ad_id")
    ad_status.add_argument("--status", required=True)
    ad_status.add_argument("--grant", default="")
    ad_status.add_argument("--validate-only", action="store_true")
    ad_status.set_defaults(func=command_ad_status)

    ad_remove = subparsers.add_parser(
        "ad-remove", help="Remove an ad after approval."
    )
    ad_remove.add_argument("customer_id")
    ad_remove.add_argument("ad_group_id")
    ad_remove.add_argument("ad_id")
    ad_remove.add_argument("--grant", default="")
    ad_remove.add_argument("--validate-only", action="store_true")
    ad_remove.set_defaults(func=command_ad_remove)

    conversion_create = subparsers.add_parser(
        "conversion-action-create",
        help="Create a conversion action after explicit approval.",
    )
    conversion_create.add_argument("customer_id")
    conversion_create.add_argument("--name", required=True)
    conversion_create.add_argument("--type", default="WEBPAGE")
    conversion_create.add_argument("--category", default="DEFAULT")
    conversion_create.add_argument("--status", default="ENABLED")
    conversion_create.add_argument("--counting-type", default="ONE_PER_CLICK")
    conversion_create.add_argument("--primary-for-goal", default="true")
    conversion_create.add_argument("--default-value", default="")
    conversion_create.add_argument("--always-use-default-value", default="false")
    conversion_create.add_argument("--grant", default="")
    conversion_create.add_argument("--validate-only", action="store_true")
    conversion_create.set_defaults(func=command_conversion_action_create)

    conversion_status = subparsers.add_parser(
        "conversion-action-status",
        help="Update conversion action status after explicit approval.",
    )
    conversion_status.add_argument("customer_id")
    conversion_status.add_argument("conversion_action_id")
    conversion_status.add_argument("--status", required=True)
    conversion_status.add_argument("--grant", default="")
    conversion_status.add_argument("--validate-only", action="store_true")
    conversion_status.set_defaults(func=command_conversion_action_status)

    conversion_attribution = subparsers.add_parser(
        "conversion-action-attribution",
        help="Update a conversion action attribution model after explicit approval.",
    )
    conversion_attribution.add_argument("customer_id")
    conversion_attribution.add_argument("conversion_action_id")
    conversion_attribution.add_argument("--attribution-model", required=True)
    conversion_attribution.add_argument("--grant", default="")
    conversion_attribution.add_argument("--validate-only", action="store_true")
    conversion_attribution.set_defaults(func=command_conversion_action_attribution)

    customer_match_list = subparsers.add_parser(
        "customer-match-list-create",
        help="Create a CRM-based Customer Match user list after explicit approval.",
    )
    customer_match_list.add_argument("customer_id")
    customer_match_list.add_argument("--name", required=True)
    customer_match_list.add_argument("--description", default="")
    customer_match_list.add_argument("--membership-days", default="540")
    customer_match_list.add_argument("--grant", default="")
    customer_match_list.add_argument("--validate-only", action="store_true")
    customer_match_list.set_defaults(func=command_user_list_customer_match_create)

    remarketing_list = subparsers.add_parser(
        "remarketing-list-create",
        help="Create a basic remarketing user list from configured actions.",
    )
    remarketing_list.add_argument("customer_id")
    remarketing_list.add_argument("--name", required=True)
    remarketing_list.add_argument("--description", default="")
    remarketing_list.add_argument("--membership-days", default="540")
    remarketing_list.add_argument("--remarketing-action", action="append", default=[])
    remarketing_list.add_argument("--conversion-action", action="append", default=[])
    remarketing_list.add_argument("--grant", default="")
    remarketing_list.add_argument("--validate-only", action="store_true")
    remarketing_list.set_defaults(func=command_user_list_remarketing_create)

    lookalike_list = subparsers.add_parser(
        "lookalike-list-create",
        help="Create a lookalike audience from seed user-list ids after approval.",
    )
    lookalike_list.add_argument("customer_id")
    lookalike_list.add_argument("--name", required=True)
    lookalike_list.add_argument("--description", default="")
    lookalike_list.add_argument("--seed-user-list-id", action="append", default=[])
    lookalike_list.add_argument("--expansion-level", default="BALANCED")
    lookalike_list.add_argument("--country-code", action="append", default=[])
    lookalike_list.add_argument("--grant", default="")
    lookalike_list.add_argument("--validate-only", action="store_true")
    lookalike_list.set_defaults(func=command_user_list_lookalike_create)

    user_interest_target = subparsers.add_parser(
        "campaign-user-interest-target",
        help="Target or exclude an in-market/user-interest audience on a campaign.",
    )
    user_interest_target.add_argument("customer_id")
    user_interest_target.add_argument("campaign_id")
    user_interest_target.add_argument("user_interest_id")
    user_interest_target.add_argument("--negative", action="store_true")
    user_interest_target.add_argument("--grant", default="")
    user_interest_target.add_argument("--validate-only", action="store_true")
    user_interest_target.set_defaults(func=command_campaign_user_interest_target)

    customer_match_job = subparsers.add_parser(
        "customer-match-job-create",
        help="Create a Customer Match offline user data job after approval.",
    )
    customer_match_job.add_argument("customer_id")
    customer_match_job.add_argument("user_list_resource")
    customer_match_job.add_argument("--enable-match-rate-range-preview", action="store_true")
    customer_match_job.add_argument("--grant", default="")
    customer_match_job.add_argument("--validate-only", action="store_true")
    customer_match_job.set_defaults(func=command_customer_match_job_create)

    customer_match_hashes = subparsers.add_parser(
        "customer-match-add-hashes",
        help="Add pre-hashed SHA-256 Customer Match identifiers to an offline job.",
    )
    customer_match_hashes.add_argument("customer_id")
    customer_match_hashes.add_argument("job_resource_name")
    customer_match_hashes.add_argument("--sha256-email", action="append", default=[])
    customer_match_hashes.add_argument("--sha256-phone", action="append", default=[])
    customer_match_hashes.add_argument("--address-info-json", action="append", default=[])
    customer_match_hashes.add_argument("--grant", default="")
    customer_match_hashes.add_argument("--validate-only", action="store_true")
    customer_match_hashes.set_defaults(func=command_customer_match_add_hashes)

    customer_match_run = subparsers.add_parser(
        "customer-match-job-run",
        help="Run a prepared Customer Match offline user data job after approval.",
    )
    customer_match_run.add_argument("customer_id")
    customer_match_run.add_argument("job_resource_name")
    customer_match_run.add_argument("--grant", default="")
    customer_match_run.set_defaults(func=command_customer_match_job_run)

    recommendation = subparsers.add_parser(
        "apply-recommendation", help="Apply a Google Ads recommendation after approval."
    )
    recommendation.add_argument("customer_id")
    recommendation.add_argument("resource_name")
    recommendation.add_argument("--partial-failure", action="store_true")
    recommendation.add_argument("--grant", default="")
    recommendation.set_defaults(func=command_apply_recommendation)

    dismiss_recommendation = subparsers.add_parser(
        "dismiss-recommendation",
        help="Dismiss a Google Ads recommendation after approval.",
    )
    dismiss_recommendation.add_argument("customer_id")
    dismiss_recommendation.add_argument("resource_name")
    dismiss_recommendation.add_argument("--partial-failure", action="store_true")
    dismiss_recommendation.add_argument("--grant", default="")
    dismiss_recommendation.set_defaults(func=command_dismiss_recommendation)

    evals = subparsers.add_parser("eval-scenarios", help="Run bundled offline eval scenarios.")
    evals.set_defaults(func=command_eval_scenarios)

    return parser


def emit_text(payload: dict[str, Any]) -> None:
    command = payload.get("command")
    if command == "report-plan":
        print(payload["query"])
        if not payload["review"]["allowed"]:
            print("Findings:")
            for finding in payload["review"]["findings"]:
                print(f"- {finding}")
        return
    if command == "plan":
        print(f"operation: {payload['operation']}")
        print(f"stakesTier: {payload['stakesTier']}")
        print(f"requiresEscalation: {str(payload['requiresEscalation']).lower()}")
        if payload["requiredGrant"]:
            print(f"requiredGrant: {payload['requiredGrant']}")
        for reason in payload["reasons"]:
            print(f"- {reason}")
        return
    print(json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=True))


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        payload = args.func(args)
    except (ConfigError, GatewayError) as exc:
        print(f"google-ads: {exc}", file=sys.stderr)
        return 2

    if args.format == "json":
        print(json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=True))
    else:
        emit_text(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
