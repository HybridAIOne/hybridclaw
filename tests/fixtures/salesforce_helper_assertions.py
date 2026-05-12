#!/usr/bin/env python3
"""Fixture assertions for tests/salesforce-skill.test.ts."""

from __future__ import annotations

import importlib.util
import json
import pathlib
import sys
from urllib import parse
from typing import Any


def load_helper(path: str) -> Any:
    helper_path = pathlib.Path(path)
    spec = importlib.util.spec_from_file_location("salesforce_query", helper_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load helper from {helper_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def print_json(payload: dict[str, Any]) -> None:
    print(json.dumps(payload))


def normalize_and_escape(module: Any) -> None:
    print_json(
        {
            "standardStage": module.normalize_stage_name("closed won"),
            "customStage": module.normalize_stage_name("legal review - phase_2"),
            "literal": module.escape_soql_literal("Acme_50%'s"),
            "likeLiteral": module.escape_soql_like_literal("Acme_50%'s"),
        }
    )


def request_and_reuse(module: Any) -> None:
    gateway_calls: list[dict[str, Any]] = []

    def fake_gateway_request(gateway: Any, **kwargs: Any) -> dict[str, bool]:
        gateway_calls.append(kwargs)
        return {"ok": True}

    module.gateway_request = fake_gateway_request
    gateway = module.GatewayConfig(
        base_url="http://127.0.0.1:9090",
        api_token="test-token",
        timeout_ms=1000,
    )
    session = module.SalesforceSession(api_version="61.0", gateway=gateway)
    session.request_json("GET", "/services/data/v61.0/query")
    session.request_json(
        "GET", "https://example.my.salesforce.com/services/data/v61.0/query"
    )

    errors: list[str] = []
    for bad in ["http://stubs", "services/data/v61.0/query"]:
        try:
            session.request_json("GET", bad)
        except module.ConfigError:
            errors.append(bad)

    captured_targets: list[str] = []

    class DummySession:
        api_version = "61.0"

    module.plan_natural_language = lambda statement: {
        "statement": statement,
        "actions": [
            {
                "action": "update-opportunity",
                "opportunity": "Acme",
                "stage": "Closed Won",
                "probability": 100,
            },
            {
                "action": "log-activity",
                "activityType": "call",
                "target": " acme ",
                "targetObject": "Opportunity",
                "subject": "Call for Acme",
                "date": "today",
                "notes": statement,
            },
        ],
    }
    module.update_opportunity = lambda *args, **kwargs: {
        "target": {"id": "006000000000001AAA", "name": "Acme"}
    }

    def fake_log_activity(*args: Any, **kwargs: Any) -> dict[str, str]:
        captured_targets.append(kwargs["target"])
        return {"target": kwargs["target"]}

    module.log_activity = fake_log_activity
    module.run_planned_actions(DummySession(), statement="move and log", dry_run=False)
    print_json(
        {
            "urls": [call["url"] for call in gateway_calls],
            "errors": errors,
            "capturedTargets": captured_targets,
        }
    )


def validate_plan_and_versions(module: Any) -> None:
    gateway_payloads: list[Any] = []

    def fake_gateway_request(gateway: Any, **kwargs: Any) -> Any:
        return gateway_payloads.pop(0)

    module.gateway_request = fake_gateway_request
    gateway = module.GatewayConfig(
        base_url="http://127.0.0.1:9090",
        api_token="test-token",
        timeout_ms=1000,
    )
    gateway_payloads.append(
        ["not-an-object", {"version": "60.0"}, 7, {"version": "61.0"}]
    )
    latest = module.resolve_latest_api_version(gateway)

    gateway_payloads.append(["bad", {"label": "missing version"}])
    invalid_version_error = ""
    try:
        module.resolve_latest_api_version(gateway)
    except module.SalesforceError as exc:
        invalid_version_error = str(exc)

    writes: list[dict[str, Any]] = []

    class DummySession:
        api_version = "61.0"

    module.plan_natural_language = lambda statement: {
        "statement": statement,
        "actions": [
            {
                "action": "update-opportunity",
                "opportunity": "Acme",
                "stage": "Closed Won",
                "probability": 100,
            },
            {
                "action": "find-records",
                "recordType": "leads",
                "search": "Acme",
                "limit": 10,
            },
        ],
    }

    def fake_update(*args: Any, **kwargs: Any) -> dict[str, Any]:
        writes.append(kwargs)
        return {"target": {"id": "006000000000001AAA", "name": "Acme"}}

    module.update_opportunity = fake_update
    plan_error = ""
    try:
        module.run_planned_actions(DummySession(), statement="bad plan", dry_run=False)
    except module.ConfigError as exc:
        plan_error = str(exc)

    print_json(
        {
            "latest": latest,
            "invalidVersionError": invalid_version_error,
            "planError": plan_error,
            "writeCount": len(writes),
        }
    )


class FakeSession:
    api_version = "61.0"

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.queries: list[str] = []

    def data_path(self, suffix: str) -> str:
        return "/services/data/v61.0" + suffix

    def get_json(self, path: str) -> dict[str, Any]:
        assert path.startswith("/services/data/v61.0/query?")
        self.queries.append(path)
        return {
            "totalSize": 1,
            "done": True,
            "records": [
                {
                    "Id": "006000000000001AAA",
                    "Name": "Acme Renewal",
                    "StageName": "Proposal/Price Quote",
                    "Probability": 60,
                }
            ],
        }

    def patch_json(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        self.calls.append({"method": "PATCH", "path": path, "payload": payload})
        return {}

    def post_json(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        self.calls.append({"method": "POST", "path": path, "payload": payload})
        return {"id": "00T000000000001AAA", "success": True}


def write_payloads(module: Any) -> None:
    session = FakeSession()
    update = module.update_opportunity(
        session,
        identifier="Acme Renewal",
        stage="Closed Won",
        probability=None,
        dry_run=False,
    )
    activity = module.log_activity(
        session,
        activity_type="call",
        target="006000000000001AAA",
        target_object="opportunity",
        subject="Discovery follow-up",
        activity_date="today",
        notes="Spoke with the champion.",
        duration_minutes=30,
        dry_run=False,
    )
    print_json(
        {
            "update": update,
            "activity": activity,
            "calls": session.calls,
            "queryCount": len(session.queries),
        }
    )


def single_query_fuzzy_resolution(module: Any) -> None:
    class QuerySession:
        api_version = "61.0"

        def __init__(self) -> None:
            self.queries: list[str] = []
            self.soql: list[str] = []

        def data_path(self, suffix: str) -> str:
            return "/services/data/v61.0" + suffix

        def get_json(self, path: str) -> dict[str, Any]:
            self.queries.append(path)
            self.soql.append(parse.parse_qs(parse.urlparse(path).query)["q"][0])
            return {
                "totalSize": 1,
                "done": True,
                "records": [
                    {
                        "Id": "006000000000001AAA",
                        "Name": "Acme Renewal",
                    }
                ],
            }

    session = QuerySession()
    record = module.find_single_record(
        session,
        sobject="Opportunity",
        identifier="Acme Ren",
        fields=["StageName", "Probability"],
    )
    print_json(
        {
            "record": record,
            "queryCount": len(session.queries),
            "query": session.soql[0],
        }
    )


def route_check(module: Any) -> None:
    assert callable(module.gateway_request)
    assert not hasattr(module, "request_json")
    assert not hasattr(module, "read_stored_secret")
    assert not hasattr(module, "resolve_secret_input")
    assert not hasattr(module, "normalize_stored_secret_output")
    assert not hasattr(module, "AuthConfig")
    assert not hasattr(module, "store_secret")
    print_json({"ok": True})


def secret_scan(path: str) -> None:
    content = pathlib.Path(path).read_text()
    assert "secret show" not in content, "Script must not read secrets via CLI"
    assert "secret set" not in content, (
        "Script must not write secrets via CLI - use captureResponseSecrets"
    )
    assert "subprocess" not in content, "Script must not shell out to manage secrets"
    assert "captureResponseSecrets" not in content, (
        "Script must not reference captureResponseSecrets directly"
    )
    print("ok")


CASES = {
    "normalize-and-escape": normalize_and_escape,
    "request-and-reuse": request_and_reuse,
    "validate-plan-and-versions": validate_plan_and_versions,
    "write-payloads": write_payloads,
    "single-query-fuzzy-resolution": single_query_fuzzy_resolution,
    "route-check": route_check,
}


def main() -> int:
    if len(sys.argv) != 3:
        print(
            "usage: salesforce_helper_assertions.py HELPER_PATH CASE",
            file=sys.stderr,
        )
        return 2

    helper_path, case = sys.argv[1], sys.argv[2]
    if case == "secret-scan":
        secret_scan(helper_path)
        return 0

    assertion = CASES.get(case)
    if assertion is None:
        print(f"unknown case: {case}", file=sys.stderr)
        return 2
    assertion(load_helper(helper_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
