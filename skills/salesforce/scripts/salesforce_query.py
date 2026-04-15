#!/usr/bin/env python3
# ruff: noqa: INP001
"""Read-only Salesforce schema and query helper.

All HTTP traffic is routed through the HybridClaw gateway proxy at
``/api/http/request`` so that stored secrets (``<secret:NAME>`` placeholders)
are resolved gateway-side and never enter this process.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from typing import Any
from urllib import error, parse, request

DEFAULT_TIMEOUT = 30
DEFAULT_TIMEOUT_MS = DEFAULT_TIMEOUT * 1000
DEFAULT_MAX_RECORDS = 200
DEFAULT_FIELD_LIMIT = 80
DEFAULT_OBJECT_LIMIT = 200

SF_ACCESS_TOKEN_SECRET = "SF_ACCESS_TOKEN"
SF_INSTANCE_URL_SECRET = "SF_INSTANCE_URL"

DEFAULT_GATEWAY_URL = "http://127.0.0.1:9090"


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

    def get_json(self, path_or_url: str) -> Any:
        url = (
            path_or_url
            if path_or_url.startswith("http://") or path_or_url.startswith("https://")
            else f"<secret:{SF_INSTANCE_URL_SECRET}>{path_or_url}"
        )
        return gateway_request(
            self.gateway,
            url=url,
            method="GET",
            bearer_secret=SF_ACCESS_TOKEN_SECRET,
            replace_placeholders=True,
        )


def is_mapping(value: Any) -> bool:
    return isinstance(value, dict)


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
    so the gateway resolves them server-side.  The gateway auto-detects the
    OAuth token response, stores ``access_token`` in the encrypted secret
    store, and strips the entire response body — the token never enters this
    process.

    ``instance_url`` is stored separately via a second proxy call so that
    subsequent API calls can reference it via ``<secret:SF_INSTANCE_URL>``.
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
# Salesforce operations (unchanged logic, now using gateway proxy)
# ---------------------------------------------------------------------------


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
    return {
        "status": "success",
        "command": "objects",
        "apiVersion": session.api_version,
        "count": len(shown),
        "totalMatched": total,
        "truncated": limit > 0 and total > len(shown),
        "objects": shown,
    }


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
    return {
        "status": "success",
        "command": "describe",
        "apiVersion": session.api_version,
        "object": {
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
        "fieldCount": len(fields),
        "fieldsShown": len(shown_fields),
        "fieldsTruncated": field_limit > 0 and len(fields) > len(shown_fields),
        "fields": shown_fields,
        "childRelationshipCount": len(child_relationships),
        "childRelationships": child_relationships,
    }


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

    return {
        "status": "success",
        "command": "relations",
        "apiVersion": session.api_version,
        "object": described.get("object"),
        "parentRelations": parent_relations,
        "childRelationships": child_relationships,
    }


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
                return {
                    "status": "success",
                    "command": "tooling-query" if tooling else "query",
                    "apiVersion": session.api_version,
                    "soql": soql,
                    "count": len(records),
                    "totalSize": total_size,
                    "done": False,
                    "truncated": True,
                    "records": records,
                }

        done = bool(current_payload.get("done", False))
        next_url = current_payload.get("nextRecordsUrl")
        if done or not isinstance(next_url, str) or not next_url:
            break
        current_payload = session.get_json(next_url)
        if not is_mapping(current_payload):
            raise SalesforceError("Unexpected paginated query response")

    return {
        "status": "success",
        "command": "tooling-query" if tooling else "query",
        "apiVersion": session.api_version,
        "soql": soql,
        "count": len(records),
        "totalSize": total_size,
        "done": done,
        "truncated": False,
        "records": records,
    }


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
        description="Read-only Salesforce schema and query helper"
    )
    _add_common_args(parser, with_defaults=True)

    subparsers = parser.add_subparsers(dest="command", required=True)

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
        elif args.command == "query":
            payload = run_query(
                session,
                soql=args.soql,
                tooling=False,
                max_records=args.max_records,
                keep_attributes=args.keep_attributes,
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
