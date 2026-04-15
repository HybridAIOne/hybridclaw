import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { expect, test } from 'vitest';

import { useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir('hybridclaw-salesforce-skill-');

const helperPath = path.join(
  process.cwd(),
  'skills',
  'salesforce',
  'scripts',
  'salesforce_query.py',
);

function writeExecutable(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, 'utf-8');
  fs.chmodSync(filePath, 0o755);
}

function runLoadProfile(configPath: string, secretCommand: string): {
  ok: boolean;
  error?: string;
  type?: string;
  domain?: string;
} {
  const result = spawnSync(
    'python3',
    [
      '-c',
      [
        'import importlib.util, json, pathlib, sys',
        'helper_path = pathlib.Path(sys.argv[1])',
        'config_arg = sys.argv[2]',
        'secret_command = sys.argv[3]',
        'spec = importlib.util.spec_from_file_location("salesforce_query", helper_path)',
        'module = importlib.util.module_from_spec(spec)',
        'sys.modules[spec.name] = module',
        'spec.loader.exec_module(module)',
        'config_path = None if config_arg == "-" else pathlib.Path(config_arg)',
        'try:',
        '    profile = module.load_profile(config_path, secret_command)',
        '    print(json.dumps({"ok": True, "domain": profile.domain}))',
        'except Exception as exc:',
        '    print(json.dumps({"ok": False, "type": exc.__class__.__name__, "error": str(exc)}))',
      ].join('\n'),
      helperPath,
      configPath,
      secretCommand,
    ],
    {
      encoding: 'utf-8',
    },
  );

  expect(result.status).toBe(0);
  return JSON.parse(result.stdout.trim()) as {
    ok: boolean;
    error?: string;
    type?: string;
    domain?: string;
  };
}

test('salesforce helper accepts noisy secret command output when the last line is the secret', () => {
  const tempDir = makeTempDir();
  const secretCommandPath = path.join(tempDir, 'secret-noisy.sh');
  const configPath = path.join(tempDir, 'profile.json');

  writeExecutable(
    secretCommandPath,
    `#!/bin/sh
name="$3"
case "$name" in
  SF_FULL_USERNAME) printf '[runtime-config] watcher disabled: test\\nuser@example.com\\n' ;;
  SF_FULL_PASSWORD) printf '[runtime-config] watcher disabled: test\\npassword-token\\n' ;;
  SF_FULL_CLIENTID) printf '[runtime-config] watcher disabled: test\\nclient-id\\n' ;;
  SF_FULL_SECRET) printf '[runtime-config] watcher disabled: test\\nclient-secret\\n' ;;
  SF_DOMAIN) printf '[runtime-config] watcher disabled: test\\ntest\\n' ;;
  *) exit 1 ;;
esac
`,
  );
  fs.writeFileSync(configPath, '{}\n', 'utf-8');

  const payload = runLoadProfile(configPath, secretCommandPath);

  expect(payload.ok).toBe(true);
  expect(payload.domain).toBe('test');
});

test('salesforce helper rejects non-raw secret status output before URL parsing', () => {
  const tempDir = makeTempDir();
  const secretCommandPath = path.join(tempDir, 'secret-status.sh');
  const configPath = path.join(tempDir, 'profile.json');

  writeExecutable(
    secretCommandPath,
    `#!/bin/sh
name="$3"
printf 'Name: %s\\nStored: yes\\nPath: /tmp/credentials.json\\n' "$name"
`,
  );
  fs.writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        auth: {
          username: 'user@example.com',
          password: 'password-token',
          client_id: 'client-id',
          client_secret: 'client-secret',
          domain: { source: 'store', id: 'SF_DOMAIN' },
        },
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );

  const payload = runLoadProfile(configPath, secretCommandPath);

  expect(payload.ok).toBe(false);
  expect(payload.type).toBe('ConfigError');
  expect(payload.error).toContain('did not return a raw secret value');
});
