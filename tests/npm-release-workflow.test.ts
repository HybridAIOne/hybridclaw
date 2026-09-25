import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { useTempDir } from './test-utils.js';

interface Step {
  name: string;
  id?: string;
  if?: string;
  run?: string;
}

const workflow = parse(
  fs.readFileSync('.github/workflows/publish-release.yml', 'utf8'),
);
const steps: Step[] = workflow.jobs['publish-npm'].steps;
const check = steps.find((step) => step.id === 'npm-version')!;
const publish = steps.find((step) => step.name.startsWith('Publish to npm'))!;
const makeTempDir = useTempDir('hybridclaw-npm-release-');

function runStep(step: Step, env: Record<string, string> = {}) {
  const dir = makeTempDir();
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: '@example/release', version: '1.2.0' }),
  );
  const shellEnv = path.join(dir, 'mock-npm.sh');
  fs.writeFileSync(
    shellEnv,
    `npm() {
      printf '%s\\n' "$*" >> "$CALLS"
      case "$1" in
        publish)
          echo "$PUBLISH_OUTPUT"
          return "$PUBLISH_STATUS"
          ;;
        view)
          count=0
          if [[ -f "$COUNTER" ]]; then read -r count < "$COUNTER"; fi
          count=$((count + 1))
          echo "$count" > "$COUNTER"
          if [[ "$VIEW_ERROR" != E404 || "$count" -le "$MISSING_VIEWS" ]]; then
            echo "npm error code $VIEW_ERROR" >&2
            return 1
          fi
          echo '"1.2.0"'
          ;;
        *) return 99 ;;
      esac
    }
    sleep() { echo "sleep $*" >> "$CALLS"; }
    `,
  );
  const callsFile = path.join(dir, 'calls');
  const outputFile = path.join(dir, 'output');
  fs.writeFileSync(outputFile, '');
  const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', `source "$MOCK_SHELL"\n${step.run}`], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      PATH: process.env.PATH,
      MOCK_SHELL: shellEnv,
      CALLS: callsFile,
      COUNTER: path.join(dir, 'counter'),
      GITHUB_OUTPUT: outputFile,
      PACKAGE: '@example/release',
      VERSION: '1.2.0',
      TARBALL: '/tmp/release artifact.tgz',
      PUBLISH_OUTPUT: '+ @example/release@1.2.0',
      PUBLISH_STATUS: '0',
      VIEW_ERROR: 'E404',
      MISSING_VIEWS: '0',
      ...env,
    },
  });
  if (!fs.existsSync(callsFile)) {
    throw new Error(result.error?.message || result.stderr || result.stdout);
  }
  return {
    ...result,
    calls: fs.readFileSync(callsFile, 'utf8').trim().split('\n'),
    outputs: fs.readFileSync(outputFile, 'utf8'),
  };
}

describe('npm release workflow', () => {
  it('checks availability before dependency installation and gates expensive steps', () => {
    const index = steps.indexOf(check);
    expect(index).toBeLessThan(
      steps.findIndex((step) => step.name === 'Install dependencies'),
    );
    for (const step of steps.slice(index + 1)) {
      expect(step.if).toBe("steps.npm-version.outputs.exists != 'true'");
    }
    expect(runStep(check).outputs).toContain('exists=true');
    expect(runStep(check, { MISSING_VIEWS: '1' }).outputs).toContain(
      'exists=false',
    );
    const unauthorized = runStep(check, { VIEW_ERROR: 'E401' });
    expect(unauthorized.status).toBe(1);
    expect(unauthorized.outputs).not.toContain('exists=false');
  });

  it.each(['1.2.0', '1.2.0-beta.1'])(
    'publishes one tarball with provenance and the correct tag for %s',
    (version) => {
      const result = runStep(publish, { VERSION: version, MISSING_VIEWS: '2' });
      expect(result.status).toBe(0);
      expect(result.calls.filter((call) => call.startsWith('publish '))).toEqual([
        `publish /tmp/release artifact.tgz --ignore-scripts --access public --tag ${version.includes('-') ? 'next' : 'latest'} --provenance`,
      ]);
      expect(result.calls.filter((call) => call.startsWith('view '))).toHaveLength(3);
      expect(result.calls.filter((call) => call === 'sleep 30')).toHaveLength(2);
    },
  );

  it('waits for an already staged version without uploading again', () => {
    const result = runStep(publish, {
      PUBLISH_STATUS: '1',
      PUBLISH_OUTPUT: 'npm error E409 Cannot publish over previously staged version "1.2.0".',
      MISSING_VIEWS: '1',
    });
    expect(result.status).toBe(0);
    expect(result.calls.filter((call) => call.startsWith('publish '))).toHaveLength(1);
    expect(result.calls.filter((call) => call.startsWith('view '))).toHaveLength(2);
  });

  it.each([
    'npm error E403 forbidden',
    'npm error E409 unrelated conflict',
    'npm error E409 Cannot publish over previously staged version "1.1.0".',
  ])('fails immediately on other publish errors: %s', (error) => {
    const result = runStep(publish, { PUBLISH_STATUS: '7', PUBLISH_OUTPUT: error });
    expect(result.status).toBe(7);
    expect(result.calls).toHaveLength(1);
  });

  it('fails on registry authentication errors instead of treating them as pending scans', () => {
    const result = runStep(publish, { VIEW_ERROR: 'E401' });
    expect(result.status).toBe(1);
    expect(result.calls).toHaveLength(2);
  });

  it('bounds the wait for a version that never becomes available', () => {
    const result = runStep(publish, { MISSING_VIEWS: '999' });
    expect(result.status).toBe(1);
    expect(result.calls.filter((call) => call.startsWith('view '))).toHaveLength(60);
    expect(result.calls.filter((call) => call === 'sleep 30')).toHaveLength(59);
    expect(result.stdout).toContain('::error::');
  });
});
