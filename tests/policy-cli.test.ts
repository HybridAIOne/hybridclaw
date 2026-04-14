import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import { runPolicyCommand } from '../src/commands/policy-command.js';
import { handlePolicyCommand } from '../src/policy/policy-cli.js';
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
  expect(applied.text).toContain("Applied preset 'github'");

  let state = readPolicyState(workspacePath);
  expect(state.presets).toEqual(['github']);
  expect(state.rules.some((rule) => rule.host === 'api.github.com')).toBe(true);

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
