#!/usr/bin/env python3
# ruff: noqa: INP001
"""Salesforce CRM schema, query, and operation helper.

All HTTP traffic is routed through the HybridClaw gateway proxy at
``/api/http/request`` so that stored secrets (``<secret:NAME>`` placeholders)
are resolved gateway-side and never enter this process.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib import error, parse, request

DEFAULT_TIMEOUT = 30
DEFAULT_TIMEOUT_MS = DEFAULT_TIMEOUT * 1000
DEFAULT_MAX_RECORDS = 200
DEFAULT_FIELD_LIMIT = 80
DEFAULT_OBJECT_LIMIT = 200
DEFAULT_SEARCH_LIMIT = 10
DEFAULT_MEETING_MINUTES = 30

SF_ACCESS_TOKEN_SECRET = "SF_ACCESS_TOKEN"
SF_INSTANCE_URL_SECRET = "SF_INSTANCE_URL"

DEFAULT_GATEWAY_URL = "http://127.0.0.1:9090"
EVAL_SCENARIOS_PATH = (
    Path(__file__).resolve().parent.parent / "evals" / "scenarios.json"
)
SALESFORCE_ID_RE = re.compile(r"^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$")

ACTIVITY_OBJECT_ALIASES = {
    "account": "Account",
    "accounts": "Account",
    "contact": "Contact",
    "contacts": "Contact",
    "lead": "Lead",
    "leads": "Lead",
    "opportunity": "Opportunity",
    "opportunities": "Opportunity",
    "deal": "Opportunity",
    "deals": "Opportunity",
}

ACTIVITY_ID_PREFIXES = {
    "001": "Account",
    "003": "Contact",
    "006": "Opportunity",
    "00Q": "Lead",
}

SEARCH_CONFIG = {
    "leads": {
        "sobject": "Lead",
        "fields": ["Id", "Name", "Company", "Status", "Owner.Name"],
        "search_fields": ["Name", "Company", "Email"],
    },
    "contacts": {
        "sobject": "Contact",
        "fields": ["Id", "Name", "Email", "Account.Name", "Title"],
        "search_fields": ["Name", "Email", "Account.Name"],
    },
    "opportunities": {
        "sobject": "Opportunity",
        "fields": [
            "Id",
            "Name",
            "StageName",
            "Probability",
            "Amount",
            "CloseDate",
            "Account.Name",
            "IsClosed",
        ],
        "search_fields": ["Name", "Account.Name"],
    },
}

DEFAULT_STAGE_PROBABILITIES = {
    "closed won": 100,
    "closed lost": 0,
}


class ConfigError(RuntimeError):
    """Raised when configuration is invalid."""


class SalesforceError(RuntimeError):
    """Raised when a Salesforce API call fails."""


class GatewayError(RuntimeError):
    """Raised when the gateway proxy returns an error."""


@dataclass
class GatewayConfig:
    base_url: str
    api_token: str
    timeout_ms: int


@dataclass
class SalesforceSession:
    api_version: str
    gateway: GatewayConfig

    def data_path(self, suffix: str) -> str:
        return f"/services/data/v{self.api_version}{suffix}"

    def request_json(
        self,
        method: str,
        path_or_url: str,
        *,
        json_payload: dict[str, Any] | None = None,
    ) -> Any:
        url = (
            path_or_url
            if path_or_url.startswith("http://") or path_or_url.startswith("https://")
            else f"<secret:{SF_INSTANCE_URL_SECRET}>{path_or_url}"
        )
        return gateway_request(
            self.gateway,
            url=url,
            method=method,
            bearer_secret=SF_ACCESS_TOKEN_SECRET,
            json_payload=json_payload,
            replace_placeholders=True,
        )

    def get_json(self, path_or_url: str) -> Any:
        return self.request_json("GET", path_or_url)

    def patch_json(self, path_or_url: str, payload: dict[str, Any]) -> Any:
        return self.request_json("PATCH", path_or_url, json_payload=payload)

    def post_json(self, path_or_url: str, payload: dict[str, Any]) -> Any:
        return self.request_json("POST", path_or_url, json_payload=payload)


def is_mapping(value: Any) -> bool:
    return isinstance(value, dict)


def usage_totals_measurement() -> dict[str, Any]:
    return {
        "system": "UsageTotals",
        "source": "HybridClaw usage_events",
        "scope": "per assistant run/session",
        "fields": [
            "total_input_tokens",
            "total_output_tokens",
            "total_tokens",
            "total_cost_usd",
            "call_count",
            "total_tool_calls",
        ],
    }


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


# ---------------------------------------------------------------------------
# Gateway proxy
# ---------------------------------------------------------------------------


def gateway_request(
    gw: GatewayConfig,
    *,
    url: str,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    body: str | None = None,
    json_payload: dict[str, Any] | None = None,
    bearer_secret: str | None = None,
    replace_placeholders: bool = False,
    capture_response_fields: list[dict[str, str]] | None = None,
) -> Any:
    """Send an HTTP request through the gateway proxy.

    The gateway resolves ``<secret:NAME>`` placeholders and injects bearer
    tokens from the encrypted secret store so real credentials never enter
    this process.
    """
    proxy_url = f"{gw.base_url.rstrip('/')}/api/http/request"
    payload: dict[str, Any] = {
        "url": url,
        "method": method,
        "timeoutMs": gw.timeout_ms,
    }
    if headers:
        payload["headers"] = headers
    if body is not None:
        payload["body"] = body
    if json_payload is not None:
        payload["json"] = json_payload
    if bearer_secret:
        payload["bearerSecretName"] = bearer_secret
    if replace_placeholders:
        payload["replaceSecretPlaceholders"] = True
    if capture_response_fields is not None:
        payload["captureResponseFields"] = capture_response_fields

    proxy_headers: dict[str, str] = {"Content-Type": "application/json"}
    if gw.api_token:
        proxy_headers["Authorization"] = f"Bearer {gw.api_token}"

    encoded = json.dumps(payload, ensure_ascii=True).encode("utf-8")
    req = request.Request(
        proxy_url, data=encoded, method="POST", headers=proxy_headers,
    )
    try:
        with request.urlopen(req, timeout=gw.timeout_ms / 1000 + 5) as resp:
            raw = resp.read().decode("utf-8")
    except error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace").strip()
        raise GatewayError(
            f"Gateway proxy returned {exc.code} for {method} {url}: {detail}"
        ) from exc
    except error.URLError as exc:
        raise GatewayError(
            f"Cannot reach gateway at {proxy_url}: {exc.reason}"
        ) from exc
    except OSError as exc:
        raise GatewayError(
            f"Network error reaching gateway at {proxy_url}: {exc}"
        ) from exc

    if not raw:
        return {}

    try:
        envelope = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise GatewayError("Gateway returned non-JSON response") from exc

    if not is_mapping(envelope):
        raise GatewayError("Gateway response is not a JSON object")

    if not envelope.get("ok", False):
        status = envelope.get("status", "?")
        resp_body = envelope.get("body", "")
        raise SalesforceError(
            f"{status} response from Salesforce for {method} {url}: {resp_body}"
        )

    # When the gateway auto-captured OAuth tokens, it returns a minimal
    # envelope with {ok, status, captured} — return it as-is.
    if "captured" in envelope:
        return envelope

    body_text = envelope.get("body", "")
    if envelope.get("json") is not None:
        return envelope["json"]
    if not body_text:
        return {}
    try:
        return json.loads(body_text)
    except json.JSONDecodeError as exc:
        raise SalesforceError(
            f"Salesforce returned non-JSON data for {url}"
        ) from exc


# ---------------------------------------------------------------------------
# Authentication
# ---------------------------------------------------------------------------


def authenticate(gw: GatewayConfig, api_version: str) -> SalesforceSession:
    """Perform OAuth2 username-password flow via the gateway proxy.

    Credentials are sent as ``<secret:NAME>`` placeholders in the request body
    so the gateway resolves them server-side.  The gateway captures both
    ``access_token`` and ``instance_url`` from the OAuth token response into
    the encrypted secret store, and the token never enters this process.

    Subsequent API calls can reference ``instance_url`` via
    ``<secret:SF_INSTANCE_URL>``.
    """
    oauth_body = (
        "grant_type=password"
        "&client_id=<secret:SF_FULL_CLIENTID>"
        "&client_secret=<secret:SF_FULL_SECRET>"
        "&username=<secret:SF_FULL_USERNAME>"
        "&password=<secret:SF_FULL_PASSWORD>"
    )

    payload = gateway_request(
        gw,
        url="https://<secret:SF_DOMAIN>.salesforce.com/services/oauth2/token",
        method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        body=oauth_body,
        replace_placeholders=True,
        capture_response_fields=[
            {"jsonPath": "access_token", "secretName": SF_ACCESS_TOKEN_SECRET},
            {"jsonPath": "instance_url", "secretName": SF_INSTANCE_URL_SECRET},
        ],
    )

    if not is_mapping(payload):
        raise SalesforceError("Salesforce auth response was not a JSON object")

    captured = payload.get("captured", {})
    if not is_mapping(captured) or "access_token" not in captured:
        raise SalesforceError(
            "Gateway did not capture access_token from OAuth response"
        )
    if "instance_url" not in captured:
        raise SalesforceError(
            "Gateway did not capture instance_url from OAuth response"
        )

    resolved_version = (
        api_version
        if api_version != "latest"
        else resolve_latest_api_version(gw)
    )

    return SalesforceSession(
        api_version=resolved_version,
        gateway=gw,
    )


def normalize_api_version(raw_value: str) -> str:
    value = raw_value.strip()
    if not value or value.lower() == "latest":
        return "latest"
    return value[1:] if value.lower().startswith("v") else value


def resolve_latest_api_version(gw: GatewayConfig) -> str:
    versions = gateway_request(
        gw,
        url=f"<secret:{SF_INSTANCE_URL_SECRET}>/services/data/",
        method="GET",
        bearer_secret=SF_ACCESS_TOKEN_SECRET,
        replace_placeholders=True,
    )
    if not isinstance(versions, list) or not versions:
        raise SalesforceError("Salesforce did not return any API versions")

    def version_key(item: Any) -> tuple[int, ...]:
        raw_version = str(item.get("version", "")).strip()
        parts = []
        for chunk in raw_version.split("."):
            if not chunk.isdigit():
                return (0,)
            parts.append(int(chunk))
        return tuple(parts)

    latest = max(versions, key=version_key)
    version = str(latest.get("version", "")).strip()
    if not version:
        raise SalesforceError("Salesforce returned an invalid API version payload")
    return version


# ---------------------------------------------------------------------------
# Salesforce operation helpers
# ---------------------------------------------------------------------------


def command_payload(command: str, **fields: Any) -> dict[str, Any]:
    return {
        "status": "success",
        "command": command,
        "costMeasurement": usage_totals_measurement(),
        **fields,
    }


def ensure_positive_limit(value: int, default: int) -> int:
    return value if isinstance(value, int) and value >= 0 else default


def escape_soql_literal(value: str) -> str:
    return value.replace("\\", "\\\\").replace("'", "\\'")


def is_salesforce_id(value: str) -> bool:
    return bool(SALESFORCE_ID_RE.fullmatch(value.strip()))


def normalize_stage_name(value: str) -> str:
    normalized = re.sub(r"\s+", " ", value.strip())
    if not normalized:
        raise ConfigError("Opportunity stage is required.")
    known = {
        "prospecting": "Prospecting",
        "qualification": "Qualification",
        "needs analysis": "Needs Analysis",
        "value proposition": "Value Proposition",
        "id. decision makers": "Id. Decision Makers",
        "perception analysis": "Perception Analysis",
        "proposal/price quote": "Proposal/Price Quote",
        "negotiation/review": "Negotiation/Review",
        "closed won": "Closed Won",
        "closed lost": "Closed Lost",
    }
    return known.get(normalized.lower(), normalized.title())


def normalize_probability(value: int | None) -> int | None:
    if value is None:
        return None
    if value < 0 or value > 100:
        raise ConfigError("Opportunity probability must be between 0 and 100.")
    return value


def default_probability_for_stage(stage_name: str) -> int | None:
    return DEFAULT_STAGE_PROBABILITIES.get(stage_name.lower())


def normalize_activity_type(value: str) -> str:
    normalized = value.strip().lower()
    if normalized not in {"call", "email", "meeting"}:
        raise ConfigError("Activity type must be call, email, or meeting.")
    return normalized


def normalize_record_type(value: str) -> str:
    normalized = value.strip().lower().replace("-", "_")
    if normalized in {"opportunity", "deal", "deals"}:
        normalized = "opportunities"
    elif normalized == "contact":
        normalized = "contacts"
    elif normalized == "lead":
        normalized = "leads"
    if normalized not in SEARCH_CONFIG:
        raise ConfigError("Record type must be leads, contacts, or opportunities.")
    return normalized


def normalize_target_object(value: str) -> str:
    normalized = value.strip().lower()
    if not normalized:
        raise ConfigError("Target object is required.")
    resolved = ACTIVITY_OBJECT_ALIASES.get(normalized)
    if not resolved:
        raise ConfigError(
            "Target object must be account, contact, lead, or opportunity."
        )
    return resolved


def infer_object_from_salesforce_id(value: str) -> str | None:
    if not is_salesforce_id(value):
        return None
    return ACTIVITY_ID_PREFIXES.get(value[:3])


def clean_phrase(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip(" .,'\"")).strip()


def parse_activity_date(value: str | None) -> str:
    if value is None or not value.strip() or value.strip().lower() == "today":
        return date.today().isoformat()
    normalized = value.strip().lower()
    if normalized == "tomorrow":
        return (date.today() + timedelta(days=1)).isoformat()
    try:
        return date.fromisoformat(normalized).isoformat()
    except ValueError as exc:
        raise ConfigError(
            "Activity date must be today, tomorrow, or YYYY-MM-DD."
        ) from exc


def meeting_times(activity_date: str, duration_minutes: int) -> tuple[str, str]:
    duration = max(1, duration_minutes)
    start_date = date.fromisoformat(activity_date)
    start = datetime.combine(start_date, time(hour=9), tzinfo=timezone.utc)
    end = start + timedelta(minutes=duration)
    return (
        start.isoformat().replace("+00:00", "Z"),
        end.isoformat().replace("+00:00", "Z"),
    )


def record_identity(record: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": record.get("Id"),
        "name": record.get("Name"),
    }


def record_link_field(sobject: str) -> str:
    if sobject in {"Lead", "Contact"}:
        return "WhoId"
    return "WhatId"


def find_single_record(
    session: SalesforceSession,
    *,
    sobject: str,
    identifier: str,
    fields: list[str],
) -> dict[str, Any]:
    cleaned = identifier.strip()
    if not cleaned:
        raise ConfigError("A record id or name is required.")
    select_fields = [
        "Id",
        "Name",
        *[field for field in fields if field not in {"Id", "Name"}],
    ]
    if is_salesforce_id(cleaned):
        where = f"Id = '{escape_soql_literal(cleaned)}'"
        limit = 1
    else:
        exact = escape_soql_literal(cleaned)
        where = f"Name = '{exact}'"
        limit = 2

    soql = (
        f"SELECT {', '.join(select_fields)} FROM {sobject} "
        f"WHERE {where} LIMIT {limit}"
    )
    payload = run_query(
        session,
        soql=soql,
        tooling=False,
        max_records=limit,
        keep_attributes=False,
    )
    records = payload.get("records", [])
    if isinstance(records, list) and len(records) == 1 and is_mapping(records[0]):
        return records[0]
    if isinstance(records, list) and len(records) > 1:
        names = ", ".join(
            str(record.get("Name", record.get("Id")))
            for record in records
            if is_mapping(record)
        )
        raise SalesforceError(f"Ambiguous {sobject} target {cleaned!r}: {names}")

    if is_salesforce_id(cleaned):
        raise SalesforceError(f"No {sobject} found for id {cleaned!r}")

    like = escape_soql_literal(cleaned)
    soql = (
        f"SELECT {', '.join(select_fields)} FROM {sobject} "
        f"WHERE Name LIKE '%{like}%' ORDER BY LastModifiedDate DESC LIMIT 6"
    )
    payload = run_query(
        session,
        soql=soql,
        tooling=False,
        max_records=6,
        keep_attributes=False,
    )
    records = payload.get("records", [])
    if isinstance(records, list) and len(records) == 1 and is_mapping(records[0]):
        return records[0]
    if not records:
        raise SalesforceError(f"No {sobject} found matching {cleaned!r}")
    names = ", ".join(
        str(record.get("Name", record.get("Id")))
        for record in records
        if is_mapping(record)
    )
    raise SalesforceError(f"Ambiguous {sobject} target {cleaned!r}: {names}")


def strip_attributes(value: Any) -> Any:
    if isinstance(value, list):
        return [strip_attributes(item) for item in value]
    if is_mapping(value):
        return {
            key: strip_attributes(item)
            for key, item in value.items()
            if key != "attributes"
        }
    return value


def list_objects(
    session: SalesforceSession, *, search: str, custom_only: bool, limit: int
) -> dict[str, Any]:
    payload = session.get_json(session.data_path("/sobjects"))
    objects = payload.get("sobjects", []) if is_mapping(payload) else []
    if not isinstance(objects, list):
        raise SalesforceError("Unexpected sObject list response")

    filtered: list[dict[str, Any]] = []
    needle = search.lower().strip()
    for item in objects:
        if not is_mapping(item):
            continue
        name = str(item.get("name", "")).strip()
        label = str(item.get("label", "")).strip()
        if needle and needle not in name.lower() and needle not in label.lower():
            continue
        if custom_only and not bool(item.get("custom")):
            continue
        filtered.append(
            {
                "name": name,
                "label": label,
                "custom": bool(item.get("custom")),
                "queryable": bool(item.get("queryable")),
                "searchable": bool(item.get("searchable")),
                "createable": bool(item.get("createable")),
                "updateable": bool(item.get("updateable")),
                "deletable": bool(item.get("deletable")),
                "keyPrefix": item.get("keyPrefix"),
            }
        )

    filtered.sort(key=lambda item: (item["name"] or "", item["label"] or ""))
    total = len(filtered)
    shown = filtered[:limit] if limit > 0 else filtered
    return command_payload(
        "objects",
        apiVersion=session.api_version,
        count=len(shown),
        totalMatched=total,
        truncated=limit > 0 and total > len(shown),
        objects=shown,
    )


def describe_object(
    session: SalesforceSession, *, sobject: str, field_limit: int
) -> dict[str, Any]:
    path = session.data_path(f"/sobjects/{parse.quote(sobject)}/describe")
    payload = session.get_json(path)
    if not is_mapping(payload):
        raise SalesforceError("Unexpected describe response")

    fields_raw = payload.get("fields", [])
    child_raw = payload.get("childRelationships", [])
    if not isinstance(fields_raw, list) or not isinstance(child_raw, list):
        raise SalesforceError(
            "Describe response is missing fields or child relationships"
        )

    fields = sorted(
        [
            {
                "name": str(field.get("name", "")).strip(),
                "label": str(field.get("label", "")).strip(),
                "type": str(field.get("type", "")).strip(),
                "custom": bool(field.get("custom")),
                "required": not bool(field.get("nillable", True))
                and not bool(field.get("defaultedOnCreate"))
                and not bool(field.get("autoNumber")),
                "referenceTo": field.get("referenceTo", []),
                "relationshipName": field.get("relationshipName"),
                "length": field.get("length"),
                "precision": field.get("precision"),
                "scale": field.get("scale"),
                "externalId": bool(field.get("externalId")),
                "unique": bool(field.get("unique")),
            }
            for field in fields_raw
            if is_mapping(field)
        ],
        key=lambda item: item["name"],
    )

    child_relationships = sorted(
        [
            {
                "childSObject": str(rel.get("childSObject", "")).strip(),
                "field": str(rel.get("field", "")).strip(),
                "relationshipName": str(rel.get("relationshipName", "")).strip(),
                "cascadeDelete": bool(rel.get("cascadeDelete")),
            }
            for rel in child_raw
            if is_mapping(rel)
        ],
        key=lambda item: (item["childSObject"], item["field"]),
    )

    shown_fields = fields[:field_limit] if field_limit > 0 else fields
    return command_payload(
        "describe",
        apiVersion=session.api_version,
        object={
            "name": str(payload.get("name", "")).strip(),
            "label": str(payload.get("label", "")).strip(),
            "labelPlural": str(payload.get("labelPlural", "")).strip(),
            "keyPrefix": payload.get("keyPrefix"),
            "custom": bool(payload.get("custom")),
            "queryable": bool(payload.get("queryable")),
            "searchable": bool(payload.get("searchable")),
            "createable": bool(payload.get("createable")),
            "updateable": bool(payload.get("updateable")),
            "deletable": bool(payload.get("deletable")),
            "replicateable": bool(payload.get("replicateable")),
            "retrieveable": bool(payload.get("retrieveable")),
        },
        fieldCount=len(fields),
        fieldsShown=len(shown_fields),
        fieldsTruncated=field_limit > 0 and len(fields) > len(shown_fields),
        fields=shown_fields,
        childRelationshipCount=len(child_relationships),
        childRelationships=child_relationships,
    )


def relations_object(session: SalesforceSession, *, sobject: str) -> dict[str, Any]:
    described = describe_object(session, sobject=sobject, field_limit=0)
    fields = described.get("fields", [])
    child_relationships = described.get("childRelationships", [])

    parent_relations = [
        {
            "field": field.get("name"),
            "relationshipName": field.get("relationshipName"),
            "referenceTo": field.get("referenceTo", []),
            "required": field.get("required"),
        }
        for field in fields
        if isinstance(field, dict) and field.get("referenceTo")
    ]

    return command_payload(
        "relations",
        apiVersion=session.api_version,
        object=described.get("object"),
        parentRelations=parent_relations,
        childRelationships=child_relationships,
    )


def run_query(
    session: SalesforceSession,
    *,
    soql: str,
    tooling: bool,
    max_records: int,
    keep_attributes: bool,
) -> dict[str, Any]:
    query_path = "/tooling/query" if tooling else "/query"
    path = f"{session.data_path(query_path)}?{parse.urlencode({'q': soql})}"
    payload = session.get_json(path)
    if not is_mapping(payload):
        raise SalesforceError("Unexpected query response")

    records: list[Any] = []
    total_size = int(payload.get("totalSize", 0))
    current_payload = payload

    while True:
        page_records = current_payload.get("records", [])
        if not isinstance(page_records, list):
            raise SalesforceError("Query response records payload is invalid")
        for record in page_records:
            clean = record if keep_attributes else strip_attributes(record)
            records.append(clean)
            if max_records > 0 and len(records) >= max_records:
                return command_payload(
                    "tooling-query" if tooling else "query",
                    apiVersion=session.api_version,
                    soql=soql,
                    count=len(records),
                    totalSize=total_size,
                    done=False,
                    truncated=True,
                    records=records,
                )

        done = bool(current_payload.get("done", False))
        next_url = current_payload.get("nextRecordsUrl")
        if done or not isinstance(next_url, str) or not next_url:
            break
        current_payload = session.get_json(next_url)
        if not is_mapping(current_payload):
            raise SalesforceError("Unexpected paginated query response")

    return command_payload(
        "tooling-query" if tooling else "query",
        apiVersion=session.api_version,
        soql=soql,
        count=len(records),
        totalSize=total_size,
        done=done,
        truncated=False,
        records=records,
    )


def find_records(
    session: SalesforceSession,
    *,
    record_type: str,
    search: str,
    limit: int,
    open_only: bool,
) -> dict[str, Any]:
    normalized_type = normalize_record_type(record_type)
    config = SEARCH_CONFIG[normalized_type]
    sobject = str(config["sobject"])
    fields = list(config["fields"])
    search_fields = list(config["search_fields"])
    bounded_limit = ensure_positive_limit(limit, DEFAULT_SEARCH_LIMIT)
    where_parts: list[str] = []
    cleaned_search = search.strip()
    if cleaned_search:
        needle = escape_soql_literal(cleaned_search)
        where_parts.append(
            "("
            + " OR ".join(
                f"{field} LIKE '%{needle}%'" for field in search_fields
            )
            + ")"
        )
    if normalized_type == "opportunities" and open_only:
        where_parts.append("IsClosed = false")
    where_clause = f" WHERE {' AND '.join(where_parts)}" if where_parts else ""
    limit_clause = f" LIMIT {bounded_limit}" if bounded_limit > 0 else ""
    soql = (
        f"SELECT {', '.join(fields)} FROM {sobject}{where_clause} "
        f"ORDER BY LastModifiedDate DESC{limit_clause}"
    )
    query_payload = run_query(
        session,
        soql=soql,
        tooling=False,
        max_records=bounded_limit,
        keep_attributes=False,
    )
    return command_payload(
        "find",
        apiVersion=session.api_version,
        recordType=normalized_type,
        sobject=sobject,
        search=cleaned_search,
        openOnly=open_only,
        soql=soql,
        count=query_payload.get("count", 0),
        totalSize=query_payload.get("totalSize", 0),
        truncated=query_payload.get("truncated", False),
        records=query_payload.get("records", []),
    )


def update_opportunity(
    session: SalesforceSession,
    *,
    identifier: str,
    stage: str | None,
    probability: int | None,
    dry_run: bool,
) -> dict[str, Any]:
    updates: dict[str, Any] = {}
    stage_name = normalize_stage_name(stage) if stage else None
    if stage_name:
        updates["StageName"] = stage_name
        default_probability = default_probability_for_stage(stage_name)
        if probability is None and default_probability is not None:
            probability = default_probability
    normalized_probability = normalize_probability(probability)
    if normalized_probability is not None:
        updates["Probability"] = normalized_probability
    if not updates:
        raise ConfigError("Provide --stage, --probability, or both.")

    target = find_single_record(
        session,
        sobject="Opportunity",
        identifier=identifier,
        fields=["Id", "Name", "StageName", "Probability"],
    )
    target_id = str(target.get("Id") or "").strip()
    if not target_id:
        raise SalesforceError("Resolved Opportunity target did not include Id.")
    if not dry_run:
        session.patch_json(
            session.data_path(f"/sobjects/Opportunity/{parse.quote(target_id)}"),
            updates,
        )

    return command_payload(
        "update-opportunity",
        apiVersion=session.api_version,
        dryRun=dry_run,
        target=record_identity(target),
        previous={
            "StageName": target.get("StageName"),
            "Probability": target.get("Probability"),
        },
        update=updates,
    )


def resolve_activity_target(
    session: SalesforceSession,
    *,
    target: str,
    target_object: str | None,
) -> tuple[str, dict[str, Any]]:
    inferred_object = infer_object_from_salesforce_id(target)
    sobject = (
        normalize_target_object(target_object) if target_object else inferred_object
    )
    if not sobject:
        sobject = "Opportunity"
    fields = ["Id", "Name"]
    if sobject == "Opportunity":
        fields.extend(["StageName", "Probability"])
    if sobject == "Contact":
        fields.extend(["Email", "Account.Name"])
    if sobject == "Lead":
        fields.extend(["Company", "Status"])
    record = find_single_record(
        session,
        sobject=sobject,
        identifier=target,
        fields=fields,
    )
    return sobject, record


def build_activity_payload(
    *,
    activity_type: str,
    target_sobject: str,
    target_id: str,
    subject: str,
    activity_date: str,
    notes: str,
    duration_minutes: int,
) -> tuple[str, dict[str, Any]]:
    normalized_type = normalize_activity_type(activity_type)
    link_field = record_link_field(target_sobject)
    clean_subject = clean_phrase(subject)
    if not clean_subject:
        clean_subject = normalized_type.title()
    if normalized_type in {"call", "email"}:
        prefix = "Call" if normalized_type == "call" else "Email"
        task_subject = (
            clean_subject
            if clean_subject.lower().startswith(prefix.lower())
            else f"{prefix}: {clean_subject}"
        )
        payload: dict[str, Any] = {
            "Subject": task_subject,
            "Status": "Completed",
            "Priority": "Normal",
            "ActivityDate": activity_date,
            link_field: target_id,
        }
        if notes.strip():
            payload["Description"] = notes.strip()
        return "Task", payload

    start, end = meeting_times(activity_date, duration_minutes)
    event_subject = (
        clean_subject
        if clean_subject.lower().startswith("meeting")
        else f"Meeting: {clean_subject}"
    )
    payload = {
        "Subject": event_subject,
        "StartDateTime": start,
        "EndDateTime": end,
        link_field: target_id,
    }
    if notes.strip():
        payload["Description"] = notes.strip()
    return "Event", payload


def log_activity(
    session: SalesforceSession,
    *,
    activity_type: str,
    target: str,
    target_object: str | None,
    subject: str,
    activity_date: str | None,
    notes: str,
    duration_minutes: int,
    dry_run: bool,
) -> dict[str, Any]:
    resolved_date = parse_activity_date(activity_date)
    target_sobject, record = resolve_activity_target(
        session,
        target=target,
        target_object=target_object,
    )
    target_id = str(record.get("Id") or "").strip()
    if not target_id:
        raise SalesforceError("Resolved activity target did not include Id.")
    activity_sobject, fields = build_activity_payload(
        activity_type=activity_type,
        target_sobject=target_sobject,
        target_id=target_id,
        subject=subject,
        activity_date=resolved_date,
        notes=notes,
        duration_minutes=duration_minutes,
    )
    created: Any = {}
    if not dry_run:
        created = session.post_json(
            session.data_path(f"/sobjects/{activity_sobject}"),
            fields,
        )
    return command_payload(
        "log-activity",
        apiVersion=session.api_version,
        dryRun=dry_run,
        activityType=normalize_activity_type(activity_type),
        activityObject=activity_sobject,
        targetObject=target_sobject,
        target=record_identity(record),
        fields=fields,
        created=created if is_mapping(created) else {},
    )


def _extract_probability(text: str) -> int | None:
    match = re.search(r"\bprob(?:ability)?(?:\s+to)?\s+(\d{1,3})%?", text, re.I)
    if not match:
        return None
    return normalize_probability(int(match.group(1)))


def _strip_probability_phrase(value: str) -> str:
    return re.sub(
        r"\s+(?:with\s+)?prob(?:ability)?(?:\s+to)?\s+\d{1,3}%?",
        "",
        value,
        flags=re.I,
    ).strip()


def plan_natural_language(statement: str) -> dict[str, Any]:
    text = clean_phrase(statement)
    if not text:
        raise ConfigError("Natural-language command is required.")
    lower = text.lower()
    actions: list[dict[str, Any]] = []

    read_match = re.search(
        r"\b(?:find|show|list|read)\s+(open\s+)?"
        r"(leads?|contacts?|opportunit(?:y|ies)|deals?)"
        r"(?:\s+(?:matching|for|named|at|about)\s+(.+))?$",
        text,
        re.I,
    )
    if read_match:
        record_type = normalize_record_type(read_match.group(2))
        actions.append(
            {
                "action": "find-records",
                "recordType": record_type,
                "search": clean_phrase(read_match.group(3) or ""),
                "openOnly": bool(read_match.group(1)),
                "limit": DEFAULT_SEARCH_LIMIT,
            }
        )

    move_match = re.search(
        r"\bmove\s+(?:the\s+)?(.+?)\s+(?:deal|opportunity)\s+to\s+"
        r"(.+?)(?=(?:\s+and\s+log|\s+with\s+prob|\s*,|$))",
        text,
        re.I,
    )
    moved_opportunity = ""
    if move_match:
        moved_opportunity = clean_phrase(move_match.group(1))
        stage = normalize_stage_name(_strip_probability_phrase(move_match.group(2)))
        probability = _extract_probability(text)
        if probability is None:
            probability = default_probability_for_stage(stage)
        actions.append(
            {
                "action": "update-opportunity",
                "opportunity": moved_opportunity,
                "stage": stage,
                "probability": probability,
            }
        )

    activity_match = re.search(
        r"\blog\s+(?:an?\s+)?(call|email|meeting)"
        r"(?:\s+(?:from|for|on)\s+(today|tomorrow|\d{4}-\d{2}-\d{2}))?"
        r"(?:\s+(?:on|to|for)\s+(?:the\s+)?(.+?)\s+"
        r"(account|contact|lead|deal|opportunity))?(?:$|[,.])",
        text,
        re.I,
    )
    if activity_match:
        target = clean_phrase(activity_match.group(3) or moved_opportunity)
        target_object = activity_match.group(4) or (
            "opportunity" if moved_opportunity else None
        )
        if not target:
            raise ConfigError("Activity command needs a target record.")
        activity_type = normalize_activity_type(activity_match.group(1))
        actions.append(
            {
                "action": "log-activity",
                "activityType": activity_type,
                "target": target,
                "targetObject": normalize_target_object(target_object)
                if target_object
                else "Opportunity",
                "date": activity_match.group(2) or "today",
                "subject": f"{activity_type.title()} for {target}",
                "notes": text,
            }
        )

    if not actions:
        raise ConfigError(
            "Could not map the request to a supported Salesforce operation."
        )

    return command_payload(
        "plan",
        statement=text,
        actions=actions,
        actionCount=len(actions),
    )


def run_planned_actions(
    session: SalesforceSession,
    *,
    statement: str,
    dry_run: bool,
) -> dict[str, Any]:
    plan = plan_natural_language(statement)
    if dry_run:
        return command_payload(
            "run",
            dryRun=True,
            statement=plan["statement"],
            actions=plan["actions"],
            results=[],
        )
    results: list[dict[str, Any]] = []
    resolved_records: dict[str, dict[str, Any]] = {}
    for action in plan["actions"]:
        if action["action"] == "find-records":
            results.append(
                find_records(
                    session,
                    record_type=action["recordType"],
                    search=action["search"],
                    limit=action["limit"],
                    open_only=action["openOnly"],
                )
            )
        elif action["action"] == "update-opportunity":
            result = update_opportunity(
                session,
                identifier=action["opportunity"],
                stage=action["stage"],
                probability=action["probability"],
                dry_run=False,
            )
            results.append(result)
            target = result.get("target")
            if is_mapping(target):
                resolved_records[action["opportunity"]] = target
        elif action["action"] == "log-activity":
            target = action["target"]
            target_object = action["targetObject"]
            if target in resolved_records and target_object == "Opportunity":
                target = str(resolved_records[target].get("id") or target)
            results.append(
                log_activity(
                    session,
                    activity_type=action["activityType"],
                    target=target,
                    target_object=target_object,
                    subject=action["subject"],
                    activity_date=action["date"],
                    notes=action["notes"],
                    duration_minutes=DEFAULT_MEETING_MINUTES,
                    dry_run=False,
                )
            )
    return command_payload(
        "run",
        dryRun=False,
        statement=plan["statement"],
        actions=plan["actions"],
        results=results,
    )


def evaluate_scenarios() -> dict[str, Any]:
    raw = json.loads(EVAL_SCENARIOS_PATH.read_text("utf-8"))
    if not isinstance(raw, list):
        raise ConfigError("Salesforce eval scenarios must be a JSON array.")
    failures: list[dict[str, Any]] = []
    categories: dict[str, int] = {}
    for scenario in raw:
        if not is_mapping(scenario):
            failures.append({"id": None, "error": "Scenario is not an object"})
            continue
        scenario_id = str(scenario.get("id") or "")
        prompt = str(scenario.get("prompt") or "")
        expected = scenario.get("expected") if is_mapping(scenario.get("expected")) else {}
        category = str(scenario.get("category") or "uncategorized")
        categories[category] = categories.get(category, 0) + 1
        try:
            plan = plan_natural_language(prompt)
            actions = plan.get("actions", [])
            first_action = actions[0] if isinstance(actions, list) and actions else {}
            expected_action = expected.get("firstAction") if is_mapping(expected) else None
            if expected_action and first_action.get("action") != expected_action:
                failures.append(
                    {
                        "id": scenario_id,
                        "error": (
                            f"Expected {expected_action}, got "
                            f"{first_action.get('action')}"
                        ),
                    }
                )
        except Exception as exc:  # noqa: BLE001 - CLI eval reports all failures
            failures.append({"id": scenario_id, "error": str(exc)})
    return command_payload(
        "eval-scenarios",
        scenarioCount=len(raw),
        passed=len(raw) - len(failures),
        failed=len(failures),
        categories=categories,
        failures=failures,
    )


# ---------------------------------------------------------------------------
# Output formatting (unchanged)
# ---------------------------------------------------------------------------


def to_cell(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=True, separators=(",", ":"))
    return str(value)


def truncate(value: str, width: int = 40) -> str:
    return value if len(value) <= width else f"{value[: width - 3]}..."


def format_table(headers: list[str], rows: list[list[Any]]) -> str:
    rendered_rows = [[truncate(to_cell(cell)) for cell in row] for row in rows]
    widths = [len(header) for header in headers]
    for row in rendered_rows:
        for index, cell in enumerate(row):
            widths[index] = max(widths[index], len(cell))
    lines = [
        " | ".join(header.ljust(widths[index]) for index, header in enumerate(headers)),
        "-+-".join("-" * widths[index] for index in range(len(headers))),
    ]
    for row in rendered_rows:
        lines.append(
            " | ".join(cell.ljust(widths[index]) for index, cell in enumerate(row))
        )
    return "\n".join(lines)


def render_text(payload: dict[str, Any]) -> str:
    command = payload.get("command")
    if command == "objects":
        rows = [
            [
                item.get("name"),
                item.get("label"),
                "custom" if item.get("custom") else "standard",
                item.get("queryable"),
                item.get("searchable"),
            ]
            for item in payload.get("objects", [])
        ]
        table = format_table(
            ["Name", "Label", "Kind", "Queryable", "Searchable"], rows
        )
        lines = [
            f"API version: {payload.get('apiVersion')}",
            f"Matched objects: {payload.get('count')} of {payload.get('totalMatched')}",
        ]
        if payload.get("truncated"):
            lines.append("Results truncated by --limit.")
        lines.append("")
        lines.append(table if rows else "No matching objects.")
        return "\n".join(lines)

    if command == "describe":
        obj = payload.get("object", {})
        field_rows = [
            [
                field.get("name"),
                field.get("type"),
                field.get("required"),
                ",".join(field.get("referenceTo", [])),
                field.get("relationshipName"),
            ]
            for field in payload.get("fields", [])
        ]
        child_rows = [
            [
                rel.get("childSObject"),
                rel.get("field"),
                rel.get("relationshipName"),
                rel.get("cascadeDelete"),
            ]
            for rel in payload.get("childRelationships", [])
        ]
        lines = [
            f"Object: {obj.get('name')} ({obj.get('label')})",
            f"API version: {payload.get('apiVersion')}",
            f"Custom: {'yes' if obj.get('custom') else 'no'}",
            f"Field count: {payload.get('fieldsShown')} of {payload.get('fieldCount')}",
            f"Child relationships: {payload.get('childRelationshipCount')}",
            "",
            "Fields:",
            format_table(
                ["Field", "Type", "Required", "Reference To", "Relationship"],
                field_rows,
            )
            if field_rows
            else "No fields returned.",
            "",
            "Child relationships:",
            format_table(
                ["Child Object", "Field", "Relationship", "Cascade Delete"],
                child_rows,
            )
            if child_rows
            else "No child relationships returned.",
        ]
        if payload.get("fieldsTruncated"):
            lines.insert(5, "Field list truncated by --field-limit.")
        return "\n".join(lines)

    if command == "relations":
        obj = payload.get("object", {})
        parent_rows = [
            [
                rel.get("field"),
                rel.get("relationshipName"),
                ",".join(rel.get("referenceTo", [])),
                rel.get("required"),
            ]
            for rel in payload.get("parentRelations", [])
        ]
        child_rows = [
            [
                rel.get("childSObject"),
                rel.get("field"),
                rel.get("relationshipName"),
                rel.get("cascadeDelete"),
            ]
            for rel in payload.get("childRelationships", [])
        ]
        return "\n".join(
            [
                f"Object: {obj.get('name')} ({obj.get('label')})",
                f"API version: {payload.get('apiVersion')}",
                "",
                "Parent relations:",
                format_table(
                    ["Field", "Relationship", "References", "Required"], parent_rows
                )
                if parent_rows
                else "No parent relations returned.",
                "",
                "Child relationships:",
                format_table(
                    ["Child Object", "Field", "Relationship", "Cascade Delete"],
                    child_rows,
                )
                if child_rows
                else "No child relationships returned.",
            ]
        )

    if command in {"query", "tooling-query"}:
        records = payload.get("records", [])
        columns: list[str] = []
        if isinstance(records, list):
            seen: set[str] = set()
            for record in records:
                if not is_mapping(record):
                    continue
                for key in record.keys():
                    if key not in seen:
                        seen.add(key)
                        columns.append(key)
        rows = [
            [record.get(column) if is_mapping(record) else record for column in columns]
            for record in records
        ]
        lines = [
            f"API version: {payload.get('apiVersion')}",
            f"Rows returned: {payload.get('count')} of {payload.get('totalSize')}",
            f"Done: {'yes' if payload.get('done') else 'no'}",
        ]
        if payload.get("truncated"):
            lines.append("Results truncated by --max-records.")
        lines.extend(
            [
                "",
                f"SOQL: {payload.get('soql')}",
                "",
                format_table(columns, rows) if columns else "No rows returned.",
            ]
        )
        return "\n".join(lines)

    if command == "find":
        records = payload.get("records", [])
        columns: list[str] = []
        if isinstance(records, list):
            seen: set[str] = set()
            for record in records:
                if not is_mapping(record):
                    continue
                for key in record.keys():
                    if key not in seen:
                        seen.add(key)
                        columns.append(key)
        rows = [
            [record.get(column) if is_mapping(record) else record for column in columns]
            for record in records
        ]
        return "\n".join(
            [
                f"Record type: {payload.get('recordType')}",
                f"Rows returned: {payload.get('count')} of {payload.get('totalSize')}",
                f"SOQL: {payload.get('soql')}",
                "",
                format_table(columns, rows) if columns else "No rows returned.",
            ]
        )

    if command == "update-opportunity":
        target = payload.get("target", {})
        return "\n".join(
            [
                "Opportunity update prepared." if payload.get("dryRun") else "Opportunity updated.",
                f"Target: {target.get('name')} ({target.get('id')})"
                if is_mapping(target)
                else "Target: unknown",
                f"Update: {json.dumps(payload.get('update', {}), ensure_ascii=True)}",
                "Dry run: yes" if payload.get("dryRun") else "Dry run: no",
            ]
        )

    if command == "log-activity":
        target = payload.get("target", {})
        return "\n".join(
            [
                "Activity prepared." if payload.get("dryRun") else "Activity logged.",
                f"Activity object: {payload.get('activityObject')}",
                f"Target: {target.get('name')} ({target.get('id')})"
                if is_mapping(target)
                else "Target: unknown",
                "Dry run: yes" if payload.get("dryRun") else "Dry run: no",
            ]
        )

    if command in {"plan", "run", "eval-scenarios"}:
        return json.dumps(payload, ensure_ascii=True, indent=2)

    return json.dumps(payload, ensure_ascii=True, indent=2)


def emit(payload: dict[str, Any], output_format: str) -> None:
    if output_format == "json":
        print(json.dumps(payload, ensure_ascii=True, indent=2))
        return
    print(render_text(payload))


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _add_common_args(
    parser: argparse.ArgumentParser, *, with_defaults: bool = True,
) -> None:
    """Register shared flags on *parser*.

    When *with_defaults* is ``False`` the arguments use
    ``argparse.SUPPRESS`` so the subparser does not override a value
    already set by the main parser.  This lets flags like ``--format``
    work in any position on the command line.
    """
    _sup = argparse.SUPPRESS

    parser.add_argument(
        "--format",
        choices=("text", "json"),
        default="text" if with_defaults else _sup,
        help="Output format",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=DEFAULT_TIMEOUT if with_defaults else _sup,
        help=f"HTTP timeout in seconds (default: {DEFAULT_TIMEOUT})",
    )
    parser.add_argument(
        "--api-version",
        default="latest" if with_defaults else _sup,
        help="API version. Use 'latest' or a version like 61.0",
    )
    parser.add_argument(
        "--keep-attributes",
        action="store_true",
        default=False if with_defaults else _sup,
        help="Keep Salesforce attributes blocks in query output",
    )
    parser.add_argument(
        "--gateway-url",
        default=resolve_gateway_url() if with_defaults else _sup,
        help=f"Gateway proxy base URL (default: HYBRIDCLAW_GATEWAY_URL or {DEFAULT_GATEWAY_URL})",
    )
    parser.add_argument(
        "--gateway-token",
        default=resolve_gateway_token() if with_defaults else _sup,
        help="Gateway API token (default: HYBRIDCLAW_GATEWAY_TOKEN)",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Salesforce CRM schema, query, and operation helper"
    )
    _add_common_args(parser, with_defaults=True)

    subparsers = parser.add_subparsers(dest="command", required=True)

    plan_parser = subparsers.add_parser(
        "plan", help="Map a natural-language Salesforce request to API actions"
    )
    _add_common_args(plan_parser, with_defaults=False)
    plan_parser.add_argument("statement", help="Natural-language request to plan")

    run_parser = subparsers.add_parser(
        "run", help="Execute an opinionated natural-language Salesforce request"
    )
    _add_common_args(run_parser, with_defaults=False)
    run_parser.add_argument("statement", help="Natural-language request to execute")
    run_parser.add_argument(
        "--dry-run", action="store_true", help="Plan without calling Salesforce"
    )

    eval_parser = subparsers.add_parser(
        "eval-scenarios", help="Run the offline Salesforce NL planner eval suite"
    )
    _add_common_args(eval_parser, with_defaults=False)

    objects_parser = subparsers.add_parser("objects", help="List available sObjects")
    _add_common_args(objects_parser, with_defaults=False)
    objects_parser.add_argument(
        "--search", default="", help="Filter by object name or label"
    )
    objects_parser.add_argument(
        "--custom-only", action="store_true", help="Only show custom objects"
    )
    objects_parser.add_argument(
        "--limit",
        type=int,
        default=DEFAULT_OBJECT_LIMIT,
        help=f"Maximum number of objects to return (default: {DEFAULT_OBJECT_LIMIT}, 0 for all)",
    )

    describe_parser = subparsers.add_parser("describe", help="Describe one sObject")
    _add_common_args(describe_parser, with_defaults=False)
    describe_parser.add_argument("sobject", help="Salesforce object API name")
    describe_parser.add_argument(
        "--field-limit",
        type=int,
        default=DEFAULT_FIELD_LIMIT,
        help=f"Maximum number of fields to print (default: {DEFAULT_FIELD_LIMIT}, 0 for all)",
    )

    relations_parser = subparsers.add_parser(
        "relations", help="Show parent and child relationships for an sObject"
    )
    _add_common_args(relations_parser, with_defaults=False)
    relations_parser.add_argument("sobject", help="Salesforce object API name")

    find_parser = subparsers.add_parser(
        "find", help="Find leads, contacts, or opportunities by name or account"
    )
    _add_common_args(find_parser, with_defaults=False)
    find_parser.add_argument(
        "record_type",
        choices=("leads", "contacts", "opportunities"),
        help="CRM record collection to search",
    )
    find_parser.add_argument("--search", default="", help="Search text")
    find_parser.add_argument(
        "--open-only",
        action="store_true",
        help="Only return open opportunities",
    )
    find_parser.add_argument(
        "--limit",
        type=int,
        default=DEFAULT_SEARCH_LIMIT,
        help=f"Maximum records to return (default: {DEFAULT_SEARCH_LIMIT}, 0 for all)",
    )

    update_parser = subparsers.add_parser(
        "update-opportunity",
        help="Update an Opportunity stage and/or probability",
    )
    _add_common_args(update_parser, with_defaults=False)
    update_parser.add_argument("identifier", help="Opportunity id or exact name")
    update_parser.add_argument("--stage", default=None, help="New StageName")
    update_parser.add_argument(
        "--probability",
        type=int,
        default=None,
        help="New Probability percentage, 0-100",
    )
    update_parser.add_argument(
        "--dry-run", action="store_true", help="Resolve the target but skip PATCH"
    )

    activity_parser = subparsers.add_parser(
        "log-activity", help="Log a call, email, or meeting on a CRM record"
    )
    _add_common_args(activity_parser, with_defaults=False)
    activity_parser.add_argument(
        "activity_type", choices=("call", "email", "meeting")
    )
    activity_parser.add_argument("target", help="Target record id or name")
    activity_parser.add_argument(
        "--object",
        dest="target_object",
        default=None,
        choices=("account", "contact", "lead", "opportunity"),
        help="Target object type; defaults to Opportunity unless id prefix is known",
    )
    activity_parser.add_argument("--subject", default="", help="Activity subject")
    activity_parser.add_argument(
        "--date", default="today", help="Activity date: today, tomorrow, or YYYY-MM-DD"
    )
    activity_parser.add_argument("--notes", default="", help="Activity notes")
    activity_parser.add_argument(
        "--duration-minutes",
        type=int,
        default=DEFAULT_MEETING_MINUTES,
        help=f"Meeting duration in minutes (default: {DEFAULT_MEETING_MINUTES})",
    )
    activity_parser.add_argument(
        "--dry-run", action="store_true", help="Resolve the target but skip create"
    )

    query_parser = subparsers.add_parser("query", help="Run a SOQL row query")
    _add_common_args(query_parser, with_defaults=False)
    query_parser.add_argument("soql", help="SOQL statement to execute")
    query_parser.add_argument(
        "--max-records",
        type=int,
        default=DEFAULT_MAX_RECORDS,
        help=f"Maximum records to return across pages (default: {DEFAULT_MAX_RECORDS}, 0 for all)",
    )

    tooling_parser = subparsers.add_parser(
        "tooling-query", help="Run a Tooling API SOQL query"
    )
    _add_common_args(tooling_parser, with_defaults=False)
    tooling_parser.add_argument("soql", help="Tooling API SOQL statement to execute")
    tooling_parser.add_argument(
        "--max-records",
        type=int,
        default=DEFAULT_MAX_RECORDS,
        help=f"Maximum records to return across pages (default: {DEFAULT_MAX_RECORDS}, 0 for all)",
    )

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    try:
        if args.command == "plan":
            emit(plan_natural_language(args.statement), args.format)
            return 0
        if args.command == "eval-scenarios":
            payload = evaluate_scenarios()
            emit(payload, args.format)
            return 0 if payload.get("failed") == 0 else 1
        if args.command == "run" and args.dry_run:
            emit(
                run_planned_actions(
                    SalesforceSession(api_version="dry-run", gateway=GatewayConfig("", "", 0)),
                    statement=args.statement,
                    dry_run=True,
                ),
                args.format,
            )
            return 0

        gw = GatewayConfig(
            base_url=args.gateway_url,
            api_token=args.gateway_token,
            timeout_ms=args.timeout * 1000,
        )

        api_version = normalize_api_version(args.api_version)
        session = authenticate(gw, api_version)

        if args.command == "objects":
            payload = list_objects(
                session,
                search=args.search,
                custom_only=args.custom_only,
                limit=args.limit,
            )
        elif args.command == "describe":
            payload = describe_object(
                session,
                sobject=args.sobject,
                field_limit=args.field_limit,
            )
        elif args.command == "relations":
            payload = relations_object(session, sobject=args.sobject)
        elif args.command == "find":
            payload = find_records(
                session,
                record_type=args.record_type,
                search=args.search,
                limit=args.limit,
                open_only=args.open_only,
            )
        elif args.command == "update-opportunity":
            payload = update_opportunity(
                session,
                identifier=args.identifier,
                stage=args.stage,
                probability=args.probability,
                dry_run=args.dry_run,
            )
        elif args.command == "log-activity":
            payload = log_activity(
                session,
                activity_type=args.activity_type,
                target=args.target,
                target_object=args.target_object,
                subject=args.subject,
                activity_date=args.date,
                notes=args.notes,
                duration_minutes=args.duration_minutes,
                dry_run=args.dry_run,
            )
        elif args.command == "query":
            payload = run_query(
                session,
                soql=args.soql,
                tooling=False,
                max_records=args.max_records,
                keep_attributes=args.keep_attributes,
            )
        elif args.command == "run":
            payload = run_planned_actions(
                session,
                statement=args.statement,
                dry_run=False,
            )
        else:
            payload = run_query(
                session,
                soql=args.soql,
                tooling=True,
                max_records=args.max_records,
                keep_attributes=args.keep_attributes,
            )
    except (ConfigError, SalesforceError, GatewayError) as exc:
        payload = {"status": "error", "message": str(exc)}
        if args.format == "json":
            print(json.dumps(payload, ensure_ascii=True, indent=2))
        else:
            print(f"Error: {payload['message']}", file=sys.stderr)
        return 1

    emit(payload, args.format)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
