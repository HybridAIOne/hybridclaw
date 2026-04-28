import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';

const helperPath = path.join(
  process.cwd(),
  'skills',
  'salesforce',
  'scripts',
  'salesforce_query.py',
);
const scenariosPath = path.join(
  process.cwd(),
  'skills',
  'salesforce',
  'evals',
  'scenarios.json',
);

test('salesforce helper --help exits cleanly', () => {
  const result = spawnSync('python3', [helperPath, '--help'], {
    encoding: 'utf-8',
  });

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Salesforce CRM schema');
  expect(result.stdout).toContain('--gateway-url');
  expect(result.stdout).toContain('--gateway-token');
  expect(result.stdout).toContain('update-opportunity');
  expect(result.stdout).toContain('log-activity');
  expect(result.stdout).toContain('eval-scenarios');
});

test('salesforce helper plans compound natural-language workflows offline', () => {
  const result = spawnSync(
    'python3',
    [
      helperPath,
      '--format',
      'json',
      'plan',
      'Move the Acme deal to Closed Won and log a call from today',
    ],
    { encoding: 'utf-8' },
  );

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.command).toBe('plan');
  expect(payload.costMeasurement.system).toBe('UsageTotals');
  expect(payload.actions).toEqual([
    expect.objectContaining({
      action: 'update-opportunity',
      opportunity: 'Acme',
      stage: 'Closed Won',
      probability: 100,
    }),
    expect.objectContaining({
      action: 'log-activity',
      activityType: 'call',
      target: 'Acme',
      targetObject: 'Opportunity',
      date: 'today',
    }),
  ]);
});

test('salesforce helper preserves custom stage names and escapes SOQL LIKE wildcards', () => {
  const result = spawnSync(
    'python3',
    [
      '-c',
      [
        'import importlib.util, json, pathlib, sys',
        'helper_path = pathlib.Path(sys.argv[1])',
        'spec = importlib.util.spec_from_file_location("salesforce_query", helper_path)',
        'module = importlib.util.module_from_spec(spec)',
        'sys.modules[spec.name] = module',
        'spec.loader.exec_module(module)',
        'print(json.dumps({',
        '    "standardStage": module.normalize_stage_name("closed won"),',
        '    "customStage": module.normalize_stage_name("legal review - phase_2"),',
        '    "literal": module.escape_soql_literal("Acme_50%\'s"),',
        '    "likeLiteral": module.escape_soql_like_literal("Acme_50%\'s"),',
        '}))',
      ].join('\n'),
      helperPath,
    ],
    { encoding: 'utf-8' },
  );

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload).toEqual({
    standardStage: 'Closed Won',
    customStage: 'legal review - phase_2',
    literal: "Acme_50%\\'s",
    likeLiteral: "Acme\\_50\\%\\'s",
  });
});

test('salesforce helper validates Salesforce request URLs and reuses resolved opportunity ids', () => {
  const result = spawnSync(
    'python3',
    [
      '-c',
      [
        'import importlib.util, json, pathlib, sys',
        'helper_path = pathlib.Path(sys.argv[1])',
        'spec = importlib.util.spec_from_file_location("salesforce_query", helper_path)',
        'module = importlib.util.module_from_spec(spec)',
        'sys.modules[spec.name] = module',
        'spec.loader.exec_module(module)',
        'gateway_calls = []',
        'def fake_gateway_request(gateway, **kwargs):',
        '    gateway_calls.append(kwargs)',
        '    return {"ok": True}',
        'module.gateway_request = fake_gateway_request',
        'gateway = module.GatewayConfig(base_url="http://127.0.0.1:9090", api_token="test-token", timeout_ms=1000)',
        'session = module.SalesforceSession(api_version="61.0", gateway=gateway)',
        'session.request_json("GET", "/services/data/v61.0/query")',
        'session.request_json("GET", "https://example.my.salesforce.com/services/data/v61.0/query")',
        'errors = []',
        'for bad in ["http://stubs", "services/data/v61.0/query"]:',
        '    try:',
        '        session.request_json("GET", bad)',
        '    except module.ConfigError:',
        '        errors.append(bad)',
        'captured_targets = []',
        'class DummySession:',
        '    api_version = "61.0"',
        'module.plan_natural_language = lambda statement: {',
        '    "statement": statement,',
        '    "actions": [',
        '        {"action": "update-opportunity", "opportunity": "Acme", "stage": "Closed Won", "probability": 100},',
        '        {"action": "log-activity", "activityType": "call", "target": " acme ", "targetObject": "Opportunity", "subject": "Call for Acme", "date": "today", "notes": statement},',
        '    ],',
        '}',
        'module.update_opportunity = lambda *args, **kwargs: {"target": {"id": "006000000000001AAA", "name": "Acme"}}',
        'def fake_log_activity(*args, **kwargs):',
        '    captured_targets.append(kwargs["target"])',
        '    return {"target": kwargs["target"]}',
        'module.log_activity = fake_log_activity',
        'module.run_planned_actions(DummySession(), statement="move and log", dry_run=False)',
        'print(json.dumps({',
        '    "urls": [call["url"] for call in gateway_calls],',
        '    "errors": errors,',
        '    "capturedTargets": captured_targets,',
        '}))',
      ].join('\n'),
      helperPath,
    ],
    { encoding: 'utf-8' },
  );

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.urls).toEqual([
    '<secret:SF_INSTANCE_URL>/services/data/v61.0/query',
    'https://example.my.salesforce.com/services/data/v61.0/query',
  ]);
  expect(payload.errors).toEqual([
    'http://stubs',
    'services/data/v61.0/query',
  ]);
  expect(payload.capturedTargets).toEqual(['006000000000001AAA']);
});

test('salesforce helper eval suite covers 30 read and write scenarios', () => {
  const scenarios = JSON.parse(
    fs.readFileSync(scenariosPath, 'utf-8'),
  ) as Array<{
    category?: string;
    costMeasurement?: { system?: string };
  }>;
  const categories = new Set(scenarios.map((scenario) => scenario.category));

  expect(scenarios).toHaveLength(30);
  expect(categories).toEqual(
    new Set(['read', 'write-update', 'write-activity', 'compound']),
  );
  expect(
    scenarios.every(
      (scenario) => scenario.costMeasurement?.system === 'UsageTotals',
    ),
  ).toBe(true);

  const result = spawnSync(
    'python3',
    [helperPath, '--format', 'json', 'eval-scenarios'],
    { encoding: 'utf-8' },
  );

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.scenarioCount).toBe(30);
  expect(payload.failed).toBe(0);
  expect(payload.categories).toMatchObject({
    read: 10,
    'write-update': 10,
    'write-activity': 5,
    compound: 5,
  });
});

test('salesforce helper builds gateway-backed opportunity update and activity writes', () => {
  const result = spawnSync(
    'python3',
    [
      '-c',
      [
        'import importlib.util, json, pathlib, sys',
        'helper_path = pathlib.Path(sys.argv[1])',
        'spec = importlib.util.spec_from_file_location("salesforce_query", helper_path)',
        'module = importlib.util.module_from_spec(spec)',
        'sys.modules[spec.name] = module',
        'spec.loader.exec_module(module)',
        'class FakeSession:',
        '    api_version = "61.0"',
        '    def __init__(self):',
        '        self.calls = []',
        '    def data_path(self, suffix):',
        '        return "/services/data/v61.0" + suffix',
        '    def get_json(self, path):',
        '        assert path.startswith("/services/data/v61.0/query?")',
        '        return {',
        '            "totalSize": 1,',
        '            "done": True,',
        '            "records": [{',
        '                "Id": "006000000000001AAA",',
        '                "Name": "Acme Renewal",',
        '                "StageName": "Proposal/Price Quote",',
        '                "Probability": 60,',
        '            }],',
        '        }',
        '    def patch_json(self, path, payload):',
        '        self.calls.append({"method": "PATCH", "path": path, "payload": payload})',
        '        return {}',
        '    def post_json(self, path, payload):',
        '        self.calls.append({"method": "POST", "path": path, "payload": payload})',
        '        return {"id": "00T000000000001AAA", "success": True}',
        'session = FakeSession()',
        'update = module.update_opportunity(',
        '    session,',
        '    identifier="Acme Renewal",',
        '    stage="Closed Won",',
        '    probability=None,',
        '    dry_run=False,',
        ')',
        'activity = module.log_activity(',
        '    session,',
        '    activity_type="call",',
        '    target="006000000000001AAA",',
        '    target_object="opportunity",',
        '    subject="Discovery follow-up",',
        '    activity_date="today",',
        '    notes="Spoke with the champion.",',
        '    duration_minutes=30,',
        '    dry_run=False,',
        ')',
        'print(json.dumps({"update": update, "activity": activity, "calls": session.calls}))',
      ].join('\n'),
      helperPath,
    ],
    { encoding: 'utf-8' },
  );

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.update.update).toEqual({
    StageName: 'Closed Won',
    Probability: 100,
  });
  expect(payload.activity.activityObject).toBe('Task');
  expect(payload.activity.fields).toEqual(
    expect.objectContaining({
      Subject: 'Call: Discovery follow-up',
      Status: 'Completed',
      Priority: 'Normal',
      WhatId: '006000000000001AAA',
    }),
  );
  expect(payload.calls).toEqual([
    expect.objectContaining({
      method: 'PATCH',
      path: '/services/data/v61.0/sobjects/Opportunity/006000000000001AAA',
    }),
    expect.objectContaining({
      method: 'POST',
      path: '/services/data/v61.0/sobjects/Task',
    }),
  ]);
});

test('salesforce helper routes all requests through gateway proxy', () => {
  const result = spawnSync(
    'python3',
    [
      '-c',
      [
        'import importlib.util, json, pathlib, sys',
        'helper_path = pathlib.Path(sys.argv[1])',
        'spec = importlib.util.spec_from_file_location("salesforce_query", helper_path)',
        'module = importlib.util.module_from_spec(spec)',
        'sys.modules[spec.name] = module',
        'spec.loader.exec_module(module)',
        '# Verify gateway_request exists and is the HTTP layer',
        'assert callable(module.gateway_request)',
        '# Verify no direct urllib request_json function exists',
        'assert not hasattr(module, "request_json")',
        '# Verify no secret resolution functions exist',
        'assert not hasattr(module, "read_stored_secret")',
        'assert not hasattr(module, "resolve_secret_input")',
        'assert not hasattr(module, "normalize_stored_secret_output")',
        '# Verify no AuthConfig (secrets are never loaded into the script)',
        'assert not hasattr(module, "AuthConfig")',
        '# Verify no store_secret function (token captured gateway-side)',
        'assert not hasattr(module, "store_secret")',
        'print(json.dumps({"ok": True}))',
      ].join('\n'),
      helperPath,
    ],
    { encoding: 'utf-8' },
  );

  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout.trim());
  expect(payload.ok).toBe(true);
});

test('salesforce helper never touches secrets directly', () => {
  const result = spawnSync(
    'python3',
    [
      '-c',
      [
        'import pathlib, sys',
        'content = pathlib.Path(sys.argv[1]).read_text()',
        'assert "secret show" not in content, (',
        '    "Script must not read secrets via CLI"',
        ')',
        'assert "secret set" not in content, (',
        '    "Script must not write secrets via CLI — use captureResponseSecrets"',
        ')',
        'assert "subprocess" not in content, (',
        '    "Script must not shell out to manage secrets"',
        ')',
        'assert "captureResponseSecrets" not in content, (',
        '    "Script must not reference captureResponseSecrets directly"',
        ')',
        'print("ok")',
      ].join('\n'),
      helperPath,
    ],
    { encoding: 'utf-8' },
  );

  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe('ok');
});
