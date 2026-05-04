import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  AgentIdentityValidationError,
  formatAgentIdentity,
  formatLocalInstanceIdFromUuid,
  isCanonicalAgentIdentity,
  parseAgentIdentity,
  resolveLocalInstanceId,
  slugifyAgentIdentityComponent,
} from '../src/identity/agent-id.js';

const ORIGINAL_INSTANCE_ID = process.env.HYBRIDCLAW_INSTANCE_ID;
const ORIGINAL_DATA_DIR = process.env.HYBRIDCLAW_DATA_DIR;

let tmpDir: string;

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-agent-id-'));
  delete process.env.HYBRIDCLAW_INSTANCE_ID;
});

afterEach(() => {
  restoreEnvVar('HYBRIDCLAW_INSTANCE_ID', ORIGINAL_INSTANCE_ID);
  restoreEnvVar('HYBRIDCLAW_DATA_DIR', ORIGINAL_DATA_DIR);
  vi.restoreAllMocks();
  vi.resetModules();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('canonical agent identities', () => {
  test('parses and normalizes agent-slug@user@instance-id identities', () => {
    expect(parseAgentIdentity(' Support-Lena@Acme@Inst-7F3A ')).toEqual({
      id: 'support-lena@acme@inst-7f3a',
      agentSlug: 'support-lena',
      userSlug: 'acme',
      instanceId: 'inst-7f3a',
    });
    expect(isCanonicalAgentIdentity('support-lena@acme@inst-7f3a')).toBe(true);
  });

  test('round-trips valid identities through parse and format', () => {
    const values = [
      'support-lena@acme@inst-7f3a',
      'main@local@inst-550e8400-e29b-41d4-a716-446655440000',
      'research.agent@team_1@local-dev',
    ];

    for (const value of values) {
      const parsed = parseAgentIdentity(value);
      expect(
        formatAgentIdentity(
          parsed.agentSlug,
          parsed.userSlug,
          parsed.instanceId,
        ),
      ).toBe(value);
    }
  });

  test('rejects malformed identities', () => {
    const invalidValues = [
      '',
      'support-lena',
      'support-lena@acme',
      'support-lena@acme@inst@extra',
      '@acme@inst-1',
      'support lena@acme@inst-1',
      'support-lena@acme ltd@inst-1',
      'support-lena@acme@',
      '.support@acme@inst-1',
      'support@-acme@inst-1',
      'support@acme@_inst-1',
    ];

    for (const value of invalidValues) {
      expect(() => parseAgentIdentity(value), value).toThrow(
        AgentIdentityValidationError,
      );
    }
  });

  test('slugifies local agent identity components with a fallback', () => {
    expect(slugifyAgentIdentityComponent(' Support Lena! ', 'main')).toBe(
      'support-lena',
    );
    expect(slugifyAgentIdentityComponent(' user@example.com ', 'local')).toBe(
      'user',
    );
    expect(slugifyAgentIdentityComponent(' !!! ', 'local')).toBe('local');
  });
});

describe('local instance id allocation', () => {
  test('formats UUID-based instance ids', () => {
    expect(
      formatLocalInstanceIdFromUuid('550E8400-E29B-41D4-A716-446655440000'),
    ).toBe('inst-550e8400-e29b-41d4-a716-446655440000');
    expect(() => formatLocalInstanceIdFromUuid('not-a-uuid')).toThrow(
      AgentIdentityValidationError,
    );
  });

  test('allocates once and persists the UUID-backed instance id', () => {
    const statePath = path.join(tmpDir, 'identity', 'instance-id.json');
    const randomUuid = () => '550e8400-e29b-41d4-a716-446655440000';
    const now = () => new Date('2026-05-03T10:00:00.000Z');

    const first = resolveLocalInstanceId({ statePath, randomUuid, now });
    const second = resolveLocalInstanceId({
      statePath,
      randomUuid: () => '660e8400-e29b-41d4-a716-446655440000',
      now,
    });

    expect(first).toBe('inst-550e8400-e29b-41d4-a716-446655440000');
    expect(second).toBe(first);
    expect(JSON.parse(fs.readFileSync(statePath, 'utf-8'))).toEqual({
      currentInstanceId: first,
      allocatedAt: '2026-05-03T10:00:00.000Z',
    });
  });

  test('caches the default resolved instance id after first allocation', async () => {
    process.env.HYBRIDCLAW_DATA_DIR = tmpDir;
    vi.resetModules();
    const identity = await import('../src/identity/agent-id.js');

    const first = identity.resolveLocalInstanceId();
    fs.rmSync(identity.localInstanceIdStatePath(), { force: true });
    const second = identity.resolveLocalInstanceId();

    expect(second).toBe(first);
    expect(fs.existsSync(identity.localInstanceIdStatePath())).toBe(false);
  });

  test('keeps explicit state-path resolution uncached for tests', () => {
    const statePath = path.join(tmpDir, 'identity', 'instance-id.json');
    const randomUuid = () => '550e8400-e29b-41d4-a716-446655440000';
    const now = () => new Date('2026-05-03T10:00:00.000Z');

    resolveLocalInstanceId({ statePath, randomUuid, now });
    const replacement = 'inst-660e8400-e29b-41d4-a716-446655440000';
    fs.writeFileSync(
      statePath,
      `${JSON.stringify(
        {
          currentInstanceId: replacement,
          allocatedAt: '2026-05-03T10:01:00.000Z',
        },
        null,
        2,
      )}\n`,
      'utf-8',
    );

    expect(resolveLocalInstanceId({ statePath })).toBe(replacement);
  });

  test('honors explicit instance id overrides without mutating persisted state', () => {
    const statePath = path.join(tmpDir, 'identity', 'instance-id.json');
    process.env.HYBRIDCLAW_INSTANCE_ID = 'Local Dev!';

    expect(resolveLocalInstanceId({ statePath })).toBe('local-dev');
    expect(fs.existsSync(statePath)).toBe(false);
  });

  test('preserves an existing state file instead of reallocating', () => {
    const statePath = path.join(tmpDir, 'identity', 'instance-id.json');
    const first = resolveLocalInstanceId({
      statePath,
      randomUuid: () => '550e8400-e29b-41d4-a716-446655440000',
      now: () => new Date('2026-05-03T10:00:00.000Z'),
    });
    const second = resolveLocalInstanceId({
      statePath,
      randomUuid: () => '660e8400-e29b-41d4-a716-446655440000',
      now: () => new Date('2026-05-03T10:01:00.000Z'),
    });

    expect(second).toBe(first);
  });

  test('uses the winning state file when concurrent allocation hits EEXIST', () => {
    const statePath = path.join(tmpDir, 'identity', 'instance-id.json');
    const winnerId = 'inst-660e8400-e29b-41d4-a716-446655440000';
    const winnerState = {
      currentInstanceId: winnerId,
      allocatedAt: '2026-05-03T10:01:00.000Z',
    };
    const linkSpy = vi
      .spyOn(fs, 'linkSync')
      .mockImplementation(
        (_existingPath: fs.PathLike, newPath: fs.PathLike) => {
          fs.writeFileSync(
            newPath,
            `${JSON.stringify(winnerState, null, 2)}\n`,
            'utf-8',
          );
          const error = new Error('file exists') as NodeJS.ErrnoException;
          error.code = 'EEXIST';
          throw error;
        },
      );

    const resolved = resolveLocalInstanceId({
      statePath,
      randomUuid: () => '550e8400-e29b-41d4-a716-446655440000',
      now: () => new Date('2026-05-03T10:00:00.000Z'),
    });

    expect(resolved).toBe(winnerId);
    expect(linkSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(statePath, 'utf-8'))).toEqual(
      winnerState,
    );
  });
});
