import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import { runPolicyCommand } from '../src/commands/policy-command.js';
import { handlePolicyCommand } from '../src/policy/policy-cli.js';
import { loadPolicyPreset } from '../src/policy/policy-presets.js';
import { listPolicyPresetSummaries } from '../src/policy/policy-presets.js';
import {
  readPolicyState,
  resolveWorkspacePolicyPath,
} from '../src/policy/policy-store.js';

const originalCwd = process.cwd();

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-policy-cli-'));
}

afterEach(() => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
});

test('policy command supports status, allow, list, default, and delete flows', () => {
  const workspacePath = makeWorkspace();

  const status = runPolicyCommand([], { workspacePath });
  expect(status.kind).toBe('info');
  expect(status.title).toBe('Policy Status');
  expect(status.text).toContain('Default: deny');

  const allow = runPolicyCommand(
    [
      'allow',
      'api.github.com',
      '--methods',
      'GET,POST',
      '--agent',
      'main',
      '--comment',
      'GitHub API',
    ],
    { workspacePath },
  );
  expect(allow.kind).toBe('plain');
  expect(allow.text).toContain('Rule added: [2] ALLOW api.github.com:*');

  const list = runPolicyCommand(['list'], { workspacePath });
  expect(list.kind).toBe('info');
  expect(list.text).toContain('Default: deny');
  expect(list.text).toContain('api.github.com');
  expect(list.text).toContain('GitHub API');

  const listJson = runPolicyCommand(['list', '--agent', 'main', '--json'], {
    workspacePath,
  });
  expect(listJson.kind).toBe('info');
  expect(JSON.parse(listJson.text)).toMatchObject({
    default: 'deny',
    rules: expect.arrayContaining([
      expect.objectContaining({ host: 'hybridclaw.io', agent: '*' }),
      expect.objectContaining({ host: 'api.github.com', agent: 'main' }),
    ]),
  });

  const setDefault = runPolicyCommand(['default', 'allow'], { workspacePath });
  expect(setDefault.kind).toBe('plain');
  expect(setDefault.text).toBe('Default policy: allow');

  const deleted = runPolicyCommand(['delete', 'api.github.com'], {
    workspacePath,
  });
  expect(deleted.kind).toBe('plain');
  expect(deleted.text).toContain('Deleted rule #2: api.github.com');
});

test('policy allow warns when a host rule also matches subdomains', () => {
  const workspacePath = makeWorkspace();

  const allow = runPolicyCommand(['allow', 'github.com'], { workspacePath });

  expect(allow.kind).toBe('plain');
  expect(allow.text).toContain('Rule added: [2] ALLOW github.com:*');
  expect(allow.text).toContain(
    'Note: github.com also matches subdomains like *.github.com under current host-scope rules.',
  );
});

test('policy allow rejects malformed or out-of-range port values', () => {
  const workspacePath = makeWorkspace();

  const malformed = runPolicyCommand(
    ['allow', 'example.com', '--port', '443abc'],
    { workspacePath },
  );
  expect(malformed.kind).toBe('error');
  expect(malformed.text).toBe(
    '`--port` must be `*` or a base-10 integer in the range 1-65535.',
  );

  const outOfRange = runPolicyCommand(
    ['allow', 'example.com', '--port', '99999'],
    { workspacePath },
  );
  expect(outOfRange.kind).toBe('error');
  expect(outOfRange.text).toBe(
    '`--port` must be `*` or a base-10 integer in the range 1-65535.',
  );
});

test('policy preset commands support list, dry-run, apply, and remove', () => {
  const workspacePath = makeWorkspace();

  const presetList = runPolicyCommand(['preset', 'list'], { workspacePath });
  expect(presetList.kind).toBe('info');
  expect(presetList.text).toContain('github');
  expect(presetList.text).toContain('npm');

  const dryRun = runPolicyCommand(['preset', 'add', 'github', '--dry-run'], {
    workspacePath,
  });
  expect(dryRun.kind).toBe('info');
  expect(dryRun.title).toBe('Policy Preset Dry Run');
  expect(dryRun.text).toContain("Preset 'github' would add:");
  expect(dryRun.text).toContain('api.github.com:443');

  const applied = runPolicyCommand(['preset', 'add', 'github'], {
    workspacePath,
  });
  expect(applied.kind).toBe('plain');
  expect(applied.text).toContain(
    "Applied preset 'github' (3 rules added, 4 total rules)",
  );

  let state = readPolicyState(workspacePath);
  expect(state.presets).toEqual(['github']);
  expect(state.rules.some((rule) => rule.host === 'api.github.com')).toBe(true);
  const listJson = runPolicyCommand(['list', '--json'], { workspacePath });
  expect(listJson.kind).toBe('info');
  expect(JSON.parse(listJson.text)).toMatchObject({
    presets: ['github'],
    rules: expect.arrayContaining([
      expect.objectContaining({
        host: 'github.com',
        managedByPreset: 'github',
      }),
      expect.objectContaining({
        host: 'api.github.com',
        managedByPreset: 'github',
      }),
    ]),
  });

  const removed = runPolicyCommand(['preset', 'remove', 'github'], {
    workspacePath,
  });
  expect(removed.kind).toBe('plain');
  expect(removed.text).toContain("Removed preset 'github'");

  state = readPolicyState(workspacePath);
  expect(state.presets).toEqual([]);
  expect(state.rules).toEqual([
    expect.objectContaining({ host: 'hybridclaw.io' }),
  ]);
});

test('github preset allows common GitHub write methods', () => {
  const preset = loadPolicyPreset('github');
  const githubApiRule = preset.rules.find((rule) => rule.host === 'api.github.com');
  const githubSiteRule = preset.rules.find((rule) => rule.host === 'github.com');

  expect(githubApiRule?.methods).toEqual([
    'GET',
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
  ]);
  expect(githubSiteRule?.methods).toEqual([
    'GET',
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
  ]);
});

test('policy preset list only parses preset summaries', () => {
  const originalReadFileSync = fs.readFileSync.bind(fs);
  vi.spyOn(fs, 'readFileSync').mockImplementation((filePath, options) => {
    if (
      typeof filePath === 'string' &&
      /presets[/\\]github\.yaml$/u.test(filePath)
    ) {
      return `name: github
description: GitHub API, repo pages, and raw content
rules:
  - action: allow
    host: [broken
`;
    }
    return originalReadFileSync(filePath, options);
  });

  expect(listPolicyPresetSummaries()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'github',
        description: 'GitHub API, repo pages, and raw content',
      }),
    ]),
  );
});

test('removing a preset preserves identical manual rules', () => {
  const workspacePath = makeWorkspace();

  const manual = runPolicyCommand(
    [
      'allow',
      'api.github.com',
      '--methods',
      'GET,POST',
      '--comment',
      'Manual duplicate',
    ],
    { workspacePath },
  );
  expect(manual.kind).toBe('plain');

  const applied = runPolicyCommand(['preset', 'add', 'github'], {
    workspacePath,
  });
  expect(applied.kind).toBe('plain');

  let state = readPolicyState(workspacePath);
  expect(
    state.rules.filter((rule) => rule.host === 'api.github.com'),
  ).toHaveLength(2);

  const removed = runPolicyCommand(['preset', 'remove', 'github'], {
    workspacePath,
  });
  expect(removed.kind).toBe('plain');

  state = readPolicyState(workspacePath);
  expect(state.presets).toEqual([]);
  expect(state.rules).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        host: 'api.github.com',
        comment: 'Manual duplicate',
      }),
    ]),
  );
  expect(
    state.rules.filter((rule) => rule.host === 'api.github.com'),
  ).toHaveLength(1);
  expect(state.rules.some((rule) => rule.host === 'github.com')).toBe(false);
  expect(
    state.rules.some((rule) => rule.host === 'raw.githubusercontent.com'),
  ).toBe(false);
});

test('policy preset add rejects path traversal names', () => {
  const workspacePath = makeWorkspace();

  const result = runPolicyCommand(['preset', 'add', '../../../etc/passwd'], {
    workspacePath,
  });

  expect(result.kind).toBe('error');
  expect(result.title).toBe('Policy Command Failed');
  expect(result.text).toBe(
    'Invalid preset name: "../../../etc/passwd"',
  );
});

test('policy presets load .yml files when no .yaml file exists', () => {
  const originalExistsSync = fs.existsSync.bind(fs);
  const originalReadFileSync = fs.readFileSync.bind(fs);

  vi.spyOn(fs, 'existsSync').mockImplementation((filePath) => {
    if (
      typeof filePath === 'string' &&
      /presets[/\\]alt-github\.yaml$/u.test(filePath)
    ) {
      return false;
    }
    if (
      typeof filePath === 'string' &&
      /presets[/\\]alt-github\.yml$/u.test(filePath)
    ) {
      return true;
    }
    return originalExistsSync(filePath);
  });

  vi.spyOn(fs, 'readFileSync').mockImplementation((filePath, options) => {
    if (
      typeof filePath === 'string' &&
      /presets[/\\]alt-github\.yml$/u.test(filePath)
    ) {
      return `name: alt-github
description: Alternate GitHub preset
rules:
  - action: allow
    host: api.github.com
    port: 443
    methods: ["GET"]
    paths: ["/**"]
`;
    }
    return originalReadFileSync(filePath, options);
  });

  expect(loadPolicyPreset('alt-github')).toMatchObject({
    name: 'alt-github',
    description: 'Alternate GitHub preset',
    rules: [expect.objectContaining({ host: 'api.github.com' })],
  });
});

test('policy CLI handler writes to the workspace under the current working directory', async () => {
  const workspacePath = makeWorkspace();
  process.chdir(workspacePath);
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  await handlePolicyCommand(['allow', 'example.com']);

  expect(logSpy).toHaveBeenCalledWith(
    expect.stringContaining('Rule added: [2] ALLOW example.com:*'),
  );
  expect(fs.existsSync(resolveWorkspacePolicyPath(workspacePath))).toBe(true);
});

test('policy CLI handler throws usage errors from the shared command runner', async () => {
  const workspacePath = makeWorkspace();
  process.chdir(workspacePath);

  await expect(handlePolicyCommand(['default', 'maybe'])).rejects.toThrow(
    'Usage: `policy default <allow|deny>`',
  );
});
