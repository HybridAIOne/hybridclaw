#!/usr/bin/env python3
# ruff: noqa: INP001
"""Read-only Salesforce schema and query helper."""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib import error, parse, request

DEFAULT_TIMEOUT = 30
DEFAULT_MAX_RECORDS = 200
DEFAULT_FIELD_LIMIT = 80
DEFAULT_OBJECT_LIMIT = 200
SECRET_REF_PATTERN = re.compile(r"^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$")
STORE_SECRET_NAME_PATTERN = re.compile(r"^[A-Z][A-Z0-9_]{0,127}$")
SECRET_COMMAND_STATUS_PREFIXES = (
    "Name:",
    "Stored:",
    "Path:",
    "Usage:",
    "hybridclaw error:",
    "Hint:",
)
SECRET_COMMAND_NOISE_PREFIXES = (
    "[runtime-",
    "Migrating .env to ",
)

DEFAULT_AUTH_PROFILE: dict[str, Any] = {
    "username": {"source": "store", "id": "SF_FULL_USERNAME"},
    "password": {"source": "store", "id": "SF_FULL_PASSWORD"},
    "client_id": {"source": "store", "id": "SF_FULL_CLIENTID"},
    "client_secret": {"source": "store", "id": "SF_FULL_SECRET"},
    "domain": {"source": "store", "id": "SF_DOMAIN"},
}


class ConfigError(RuntimeError):
    """Raised when the auth profile is invalid."""


class SalesforceError(RuntimeError):
    """Raised when a Salesforce API call fails."""


@dataclass
class AuthConfig:
    username: str
    password: str
    client_id: str
    client_secret: str
    domain: str
    api_version: str = "latest"


@dataclass
class SalesforceSession:
    instance_url: str
    access_token: str
    api_version: str
    timeout: int

    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.access_token}"}

    def data_path(self, suffix: str) -> str:
        return f"/services/data/v{self.api_version}{suffix}"

    def get_json(self, path_or_url: str) -> Any:
        url = (
            path_or_url
            if path_or_url.startswith("http://") or path_or_url.startswith("https://")
            else f"{self.instance_url}{path_or_url}"
        )
        return request_json(url, headers=self.headers(), timeout=self.timeout)


def is_mapping(value: Any) -> bool:
    return isinstance(value, dict)


def default_secret_command() -> str:
    return os.environ.get("HYBRIDCLAW_SECRET_COMMAND", "").strip() or "hybridclaw"


def load_profile(config_path: Path | None, secret_command: str) -> AuthConfig:
    raw_profile: dict[str, Any] = {}
    if config_path is not None:
        try:
            raw = json.loads(config_path.read_text(encoding="utf-8"))
        except FileNotFoundError as exc:
            raise ConfigError(f"Config file not found: {config_path}") from exc
        except json.JSONDecodeError as exc:
            raise ConfigError(
                f"Config file is not valid JSON: {config_path}: {exc}"
            ) from exc
        if not is_mapping(raw):
            raise ConfigError("Config file must contain a JSON object")
        raw_profile = raw

    auth_section = (
        raw_profile.get("auth") if is_mapping(raw_profile.get("auth")) else raw_profile
    )
    merged_auth = {
        **DEFAULT_AUTH_PROFILE,
        **(auth_section if is_mapping(auth_section) else {}),
    }
    api_version = str(raw_profile.get("api_version", "latest")).strip() or "latest"

    return AuthConfig(
        username=resolve_secret_input(
            merged_auth.get("username"),
            "auth.username",
            secret_command,
        ),
        password=resolve_secret_input(
            merged_auth.get("password"),
            "auth.password",
            secret_command,
        ),
        client_id=resolve_secret_input(
            merged_auth.get("client_id"),
            "auth.client_id",
            secret_command,
        ),
        client_secret=resolve_secret_input(
            merged_auth.get("client_secret"),
            "auth.client_secret",
            secret_command,
        ),
        domain=resolve_secret_input(
            merged_auth.get("domain"),
            "auth.domain",
            secret_command,
        ),
        api_version=normalize_api_version(api_version),
    )


def read_stored_secret(secret_name: str, secret_command: str) -> str:
    if not STORE_SECRET_NAME_PATTERN.fullmatch(secret_name):
        raise ConfigError(
            f"{secret_name} is not a valid HybridClaw stored secret name"
        )

    command_text = secret_command.strip() or "hybridclaw"
    command_parts = shlex.split(command_text)
    if not command_parts:
        raise ConfigError("HYBRIDCLAW_SECRET_COMMAND resolved to an empty command")
    executable = command_parts[0]
    if (
        "/" not in executable
        and "\\" not in executable
        and shutil.which(executable) is None
    ):
        raise ConfigError(
            f"Cannot resolve `{executable}` in PATH. Set HYBRIDCLAW_SECRET_COMMAND or pass --secret-command."
        )

    try:
        completed = subprocess.run(
            [*command_parts, "secret", "show", secret_name, "--raw"],
            check=False,
            capture_output=True,
            text=True,
            timeout=20,
        )
    except OSError as exc:
        raise ConfigError(
            f"Failed to run `{command_text} secret show {secret_name} --raw`: {exc}"
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise ConfigError(
            f"`{command_text} secret show {secret_name} --raw` timed out"
        ) from exc

    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip()
        if not detail:
            detail = "unknown error"
        raise ConfigError(
            f"stored secret {secret_name} could not be read via `{command_text} secret show {secret_name} --raw`: {detail}"
        )

    resolved = normalize_stored_secret_output(
        completed.stdout,
        secret_name=secret_name,
        command_text=command_text,
    )
    if not resolved:
        raise ConfigError(f"stored secret {secret_name} is empty")
    return resolved


def normalize_stored_secret_output(
    stdout: str, *, secret_name: str, command_text: str
) -> str:
    lines = [line.strip() for line in stdout.splitlines() if line.strip()]
    if not lines:
        return ""

    if len(lines) == 1:
        return lines[0]

    if any(
        line.startswith(SECRET_COMMAND_STATUS_PREFIXES) for line in lines
    ):
        raise ConfigError(
            f"`{command_text} secret show {secret_name} --raw` did not return a raw secret value. "
            "Use a HybridClaw build that supports `secret show --raw`, or point "
            "`--secret-command` / `HYBRIDCLAW_SECRET_COMMAND` at the correct CLI."
        )

    non_secret_lines = lines[:-1]
    if non_secret_lines and all(
        line.startswith(SECRET_COMMAND_NOISE_PREFIXES) for line in non_secret_lines
    ):
        return lines[-1] or ""

    raise ConfigError(
        f"`{command_text} secret show {secret_name} --raw` returned unexpected multi-line output. "
        "Set `--secret-command` / `HYBRIDCLAW_SECRET_COMMAND` to the exact HybridClaw CLI you want to use."
    )


def resolve_secret_input(value: Any, field_name: str, secret_command: str) -> str:
    if isinstance(value, str):
        candidate = value.strip()
        if not candidate:
            raise ConfigError(f"{field_name} is required")
        match = SECRET_REF_PATTERN.fullmatch(candidate)
        if not match:
            return candidate
        env_name = match.group(1)
        resolved = os.environ.get(env_name, "").strip()
        if not resolved:
            raise ConfigError(
                f"{field_name} references environment variable {env_name}, but it is not set"
            )
        return resolved

    if not is_mapping(value):
        raise ConfigError(
            f'{field_name} must be a string, ${{ENV_VAR}}, or {{"source": "env"|"store", "id": "NAME"}}'
        )

    source = value.get("source")
    ref_id = value.get("id")
    if source == "env":
        if not isinstance(ref_id, str) or not re.fullmatch(
            r"[A-Za-z_][A-Za-z0-9_]*", ref_id
        ):
            raise ConfigError(
                f'{field_name} must use {{"source": "env", "id": "ENV_VAR"}}'
            )
        resolved = os.environ.get(ref_id, "").strip()
        if not resolved:
            raise ConfigError(
                f"{field_name} references environment variable {ref_id}, but it is not set"
            )
        return resolved

    if source == "store":
        if not isinstance(ref_id, str) or not STORE_SECRET_NAME_PATTERN.fullmatch(
            ref_id
        ):
            raise ConfigError(
                f'{field_name} must use {{"source": "store", "id": "SECRET_NAME"}}'
            )
        return read_stored_secret(ref_id, secret_command)

    if not isinstance(ref_id, str):
        raise ConfigError(
            f'{field_name} must use {{"source": "env"|"store", "id": "NAME"}}'
        )
    raise ConfigError(
        f'{field_name} uses unsupported secret source "{source}"; expected "env" or "store"'
    )


def normalize_domain(raw_domain: str) -> str:
    domain = raw_domain.strip().rstrip("/")
    if not domain:
        raise ConfigError("auth.domain is required")
    if domain in {"login", "production"}:
        return "https://login.salesforce.com"
    if domain in {"test", "sandbox"}:
        return "https://test.salesforce.com"
    if domain.startswith("http://") or domain.startswith("https://"):
        return domain
    return f"https://{domain}"


def normalize_api_version(raw_value: str) -> str:
    value = raw_value.strip()
    if not value or value.lower() == "latest":
        return "latest"
    return value[1:] if value.lower().startswith("v") else value


def request_json(
    url: str,
    *,
    headers: dict[str, str] | None = None,
    body: bytes | None = None,
    method: str | None = None,
    timeout: int = DEFAULT_TIMEOUT,
) -> Any:
    req = request.Request(url, data=body, method=method, headers=headers or {})
    try:
        with request.urlopen(req, timeout=timeout) as response:
            payload = response.read().decode("utf-8")
    except error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace").strip()
        message = detail or exc.reason or "request failed"
        raise SalesforceError(
            f"{exc.code} response from Salesforce for {url}: {message}"
        ) from exc
    except error.URLError as exc:
        raise SalesforceError(
            f"Failed to reach Salesforce at {url}: {exc.reason}"
        ) from exc
    except OSError as exc:
        raise SalesforceError(f"Network error while requesting {url}: {exc}") from exc

    if not payload:
        return {}

    try:
        return json.loads(payload)
    except json.JSONDecodeError as exc:
        raise SalesforceError(f"Salesforce returned non-JSON data for {url}") from exc


def authenticate(auth: AuthConfig, timeout: int) -> SalesforceSession:
    token_url = f"{normalize_domain(auth.domain)}/services/oauth2/token"
    body = parse.urlencode(
        {
            "grant_type": "password",
            "client_id": auth.client_id,
            "client_secret": auth.client_secret,
            "username": auth.username,
            "password": auth.password,
        }
    ).encode("utf-8")
    payload = request_json(
        token_url,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        body=body,
        method="POST",
        timeout=timeout,
    )
    if not is_mapping(payload):
        raise SalesforceError("Salesforce auth response was not a JSON object")
    access_token = str(payload.get("access_token", "")).strip()
    instance_url = str(payload.get("instance_url", "")).strip().rstrip("/")
    if not access_token or not instance_url:
        raise SalesforceError(
            "Salesforce auth response did not include access_token and instance_url"
        )

    api_version = (
        auth.api_version
        if auth.api_version != "latest"
        else resolve_latest_api_version(instance_url, access_token, timeout)
    )

    return SalesforceSession(
        instance_url=instance_url,
        access_token=access_token,
        api_version=api_version,
        timeout=timeout,
    )


def resolve_latest_api_version(
    instance_url: str, access_token: str, timeout: int
) -> str:
    versions = request_json(
        f"{instance_url}/services/data/",
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=timeout,
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
    url = (
        f"{session.instance_url}{session.data_path(query_path)}?"
        f"{parse.urlencode({'q': soql})}"
    )
    payload = session.get_json(url)
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


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Read-only Salesforce schema and query helper"
    )
    parser.add_argument(
        "--config",
        type=Path,
        help="Optional JSON profile containing auth secret refs and api_version",
    )
    parser.add_argument(
        "--format",
        choices=("text", "json"),
        default="text",
        help="Output format",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=DEFAULT_TIMEOUT,
        help=f"HTTP timeout in seconds (default: {DEFAULT_TIMEOUT})",
    )
    parser.add_argument(
        "--api-version",
        help="Override config api_version. Use 'latest' or a version like 61.0",
    )
    parser.add_argument(
        "--keep-attributes",
        action="store_true",
        help="Keep Salesforce attributes blocks in query output",
    )
    parser.add_argument(
        "--secret-command",
        default=default_secret_command(),
        help="Command used to resolve HybridClaw store-backed secrets (default: HYBRIDCLAW_SECRET_COMMAND or 'hybridclaw')",
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    objects_parser = subparsers.add_parser("objects", help="List available sObjects")
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
    relations_parser.add_argument("sobject", help="Salesforce object API name")

    query_parser = subparsers.add_parser("query", help="Run a SOQL row query")
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
        profile = load_profile(args.config, args.secret_command)
        if args.api_version:
            profile.api_version = normalize_api_version(args.api_version)
        session = authenticate(profile, timeout=args.timeout)

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
    except (ConfigError, SalesforceError) as exc:
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
