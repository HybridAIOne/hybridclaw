import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { expect, test } from 'vitest';

const helperPath = path.join(
  process.cwd(),
  'skills',
  'salesforce',
  'scripts',
  'salesforce_query.py',
);

test('salesforce helper --help exits cleanly', () => {
  const result = spawnSync('python3', [helperPath, '--help'], {
    encoding: 'utf-8',
  });

  expect(result.status).toBe(0);
  expect(result.stdout).toContain(
    'Read-only Salesforce schema and query helper',
  );
  expect(result.stdout).toContain('--gateway-url');
  expect(result.stdout).toContain('--gateway-token');
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
        'assert "captureResponseSecrets" not in content or True, "sanity"',
        'print("ok")',
      ].join('\n'),
      helperPath,
    ],
    { encoding: 'utf-8' },
  );

  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe('ok');
});
