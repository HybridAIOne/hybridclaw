import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const cleanup: (() => void)[] = [];
const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hy-verified-job-',
  cleanup: () => {
    for (const end of cleanup.splice(0)) end();
  },
});

async function setup() {
  setupHome();
  const db = await import('../src/memory/db.js');
  const track = await import('../src/tracking/track-store.js');
  const follow = await import('../src/tracking/follow-through.js');
  const verification = await import('../src/tracking/tracked-verification.js');
  const { sessionWorkspaceDir } = await import('../src/scopes/scope-paths.js');
  const { beginTurnUser } = await import('../src/session/turn-user.js');
  const notifications = await import(
    '../src/gateway/web-notification-store.js'
  );
  db.initDatabase({ quiet: true });
  const session = (id: string, owner = 'user-a', agent = 'hy') => {
    const value = db.getOrCreateSession(id, null, 'web', agent);
    notifications.bindWebNotificationSession(
      value.id,
      notifications.notificationOperatorId(owner),
    );
    cleanup.push(beginTurnUser(value.id, owner));
    return value;
  };
  const first = session('first');
  const second = session('second');
  const item = track.addTracked(
    first,
    { title: 'Prepare a weekly brief' },
    'agent',
  );
  const root = sessionWorkspaceDir(first);
  fs.mkdirSync(root, { recursive: true });
  let requests = 0;
  const detail = (caller = first) =>
    follow.followThroughDetail(caller, follow.getTracked(caller, item.id));
  const change = (
    body: Record<string, unknown>,
    caller = first,
    actor: 'user' | 'agent' = 'agent',
  ) =>
    follow.mutateFollowThrough(
      caller,
      item.id,
      {
        revision: detail(caller).revision,
        request_id: `change-${++requests}`,
        ...body,
      },
      actor,
    );
  const checks = [
    {
      id: 'brief',
      title: 'Brief includes sources',
      kind: 'artifact',
      path: 'brief.md',
      format: 'text',
      required: ['Sources'],
    },
  ];
  return {
    db,
    track,
    follow,
    verification,
    first,
    second,
    item,
    root,
    detail,
    change,
    checks,
    session,
  };
}

test('checks, failed repair, actual file proof and linked work survive another device and reopen', async () => {
  const { db, track, root, item, first, second, detail, change, checks } =
    await setup();
  change({ action: 'contract', checks });
  change({ action: 'verify' });
  expect(detail(second).job).toMatchObject({
    ready: false,
    next_gate: 'repair',
    attempts_remaining: 2,
  });
  expect(() => change({ action: 'verify' })).toThrow('No evidence changed');
  expect(detail().job?.attempts).toHaveLength(1);
  expect(() =>
    change({
      action: 'contract',
      checks: [{ ...checks[0], required: ['Anything'] }],
    }),
  ).toThrow('Only the user');
  expect(() => track.markTracked(first, item.id, true, 'user')).toThrow(
    'not verified',
  );
  fs.writeFileSync(
    path.join(root, 'brief.md'),
    'Summary\nSources\nhttps://example.com',
  );
  change({ action: 'verify' }, second);
  db.closeDatabase();
  db.initDatabase({ quiet: true });
  expect(detail().job).toMatchObject({
    ready: true,
    next_gate: 'review',
    attempts_remaining: 1,
    verified_at: expect.any(String),
  });
  expect(detail().job?.attempts).toHaveLength(2);
  fs.writeFileSync(path.join(root, 'brief.md'), 'Replaced output');
  expect(detail().job).toMatchObject({
    ready: false,
    verified_at: null,
    next_gate: 'repair',
  });
  expect(() => track.markTracked(first, item.id, true, 'user')).toThrow(
    'not verified',
  );
});

test('repair is bounded and claimed pass data cannot override observed failures', async () => {
  const { root, detail, change, checks } = await setup();
  change({ action: 'contract', checks });
  for (let attempt = 0; attempt < 3; attempt++) {
    fs.writeFileSync(
      path.join(root, 'brief.md'),
      `Incomplete draft ${attempt}`,
    );
    change({
      action: 'verify',
      passed: true,
      ready: true,
      attempts_remaining: 99,
    });
  }
  expect(detail().job).toMatchObject({
    ready: false,
    next_gate: 'needs_attention',
    attempts_remaining: 0,
  });
  fs.writeFileSync(path.join(root, 'brief.md'), 'Sources');
  expect(() => change({ action: 'verify' })).toThrow('Verification limit');
});

test('dependencies, stale revisions and ownership enforce the same job boundary', async () => {
  const { track, follow, first, item, detail, change, checks, root, session } =
    await setup();
  const dependency = track.addTracked(
    first,
    { title: 'Confirm the source list' },
    'user',
  );
  change({ action: 'contract', checks, dependencies: [dependency.id] });
  expect(() =>
    follow.mutateFollowThrough(
      first,
      dependency.id,
      {
        action: 'contract',
        checks,
        dependencies: [item.id],
        revision: 1,
        request_id: 'cycle',
      },
      'agent',
    ),
  ).toThrow('cycle');
  expect(() => change({ action: 'verify', revision: 1 })).toThrow(
    'Item changed',
  );
  fs.writeFileSync(path.join(root, 'brief.md'), 'Sources');
  change({ action: 'verify' });
  expect(detail().job).toMatchObject({
    ready: false,
    next_gate: 'dependencies',
  });
  track.markTracked(first, dependency.id, true, 'user');
  expect(detail().job?.ready).toBe(true);
  const foreign = session('foreign', 'user-b');
  expect(() =>
    follow.followThroughDetail(foreign, follow.getTracked(foreign, item.id)),
  ).toThrow();
  track.markTracked(first, item.id, true, 'user');
  expect(detail().phase).toBe('completed');
});

test('file checks reject escaping paths, symlinks, empty and oversized files and malformed JSON', async () => {
  const { verification: v, first, root } = await setup();
  const check = {
    id: 'data',
    title: 'Data has a summary',
    kind: 'artifact',
    path: 'data.json',
    format: 'json',
    required: ['summary'],
  };
  expect(() => v.jobContract([{ ...check, path: '../outside' }], [])).toThrow(
    'workspace',
  );
  const contract = v.jobContract([check], []);
  const read = () => ({});
  for (const value of ['', 'not JSON', '{}', '{"summary":null}']) {
    fs.writeFileSync(path.join(root, 'data.json'), value);
    expect(v.observeChecks(first, contract, read)[0].passed).toBe(false);
  }
  fs.writeFileSync(path.join(root, 'data.json'), '{"summary":"Ready"}');
  expect(v.observeChecks(first, contract, read)[0].passed).toBe(true);
  fs.writeFileSync(path.join(root, 'large'), Buffer.alloc(1024 * 1024 + 1));
  fs.symlinkSync(path.join(root, 'data.json'), path.join(root, 'linked'));
  fs.writeFileSync(path.join(root, '.env'), 'TEST_VALUE=example');
  fs.writeFileSync(path.join(root, 'credentials.json'), '{"value":"example"}');
  for (const file of ['large', 'linked', '.env', 'credentials.json']) {
    expect(
      v.observeChecks(
        first,
        v.jobContract([{ ...check, path: file }], []),
        read,
      )[0].passed,
    ).toBe(false);
  }
});

test('only accessible confirmed receipts pass; a model-written assertion is insufficient', async () => {
  const { verification: v, first, change, detail } = await setup();
  const checks = [
    {
      id: 'sent',
      title: 'Service confirms the update',
      kind: 'receipt',
      reference: {
        kind: 'receipt',
        session_id: first.id,
        receipt_id: 'action-1',
      },
    },
  ];
  change({ action: 'contract', checks });
  change({ action: 'verify' });
  expect(detail().job?.ready).toBe(false);
  const contract = v.jobContract(checks, []);
  const receipt = {
    ok: true,
    proof: { status: 'confirmed' },
  } as import('../src/gateway/receipts-command.js').Receipt;
  expect(v.observeChecks(first, contract, () => ({ receipt }))[0].passed).toBe(
    true,
  );
  expect(
    v.observeChecks(first, contract, () => ({
      receipt: { ...receipt, ok: false },
    }))[0].passed,
  ).toBe(false);
  expect(
    v.observeChecks(first, contract, () => {
      throw new Error('Not accessible');
    })[0].passed,
  ).toBe(false);
});

test('only a fresh user decision renews repair checks and preserves failures', async () => {
  const { root, detail, change, checks, first, track, item } = await setup();
  change({ action: 'contract', checks });
  for (let attempt = 0; attempt < 3; attempt++) {
    fs.writeFileSync(path.join(root, 'brief.md'), `Incomplete ${attempt}`);
    change({ action: 'verify' });
  }
  expect(() => change({ action: 'retry_checks' })).toThrow('Only the user');
  change({ action: 'retry_checks' }, first, 'user');
  expect(detail().job).toMatchObject({ attempts_remaining: 2 });
  expect(detail().job?.attempts).toHaveLength(3);
  fs.writeFileSync(path.join(root, 'brief.md'), 'Sources');
  change({ action: 'verify' });
  expect(detail().job?.ready).toBe(true);
  track.editTracked(first, item.id, {
    outcome: 'Include a separate conclusion.',
  });
  expect(detail().job?.ready).toBe(false);
  expect(() => change({ action: 'verify' })).toThrow('outcome changed');
  change(
    {
      action: 'contract',
      checks: [{ ...checks[0], required: ['Sources', 'Conclusion'] }],
    },
    first,
    'user',
  );
  expect(detail().job?.ready).toBe(false);
  expect(detail().job?.attempts).toHaveLength(4);
});

test('the tool exposes the same job and a lost verify acknowledgement cannot consume another attempt', async () => {
  const { first, item, checks, follow, detail } = await setup();
  const { runTrackToolAction } = await import(
    '../src/tracking/track-command.js'
  );
  const created = runTrackToolAction({
    sessionId: first.id,
    id: item.id,
    action: 'contract',
    checks,
    revision: detail().revision,
    request_id: 'tool-contract',
  });
  expect(JSON.parse(created.result).item.job.criteria).toHaveLength(1);
  const body = {
    action: 'verify',
    revision: detail().revision,
    request_id: 'verify-once',
  };
  expect(
    follow.mutateFollowThrough(first, item.id, body, 'agent').applied,
  ).toBe(true);
  expect(
    follow.mutateFollowThrough(first, item.id, body, 'agent').applied,
  ).toBe(false);
  expect(detail().job?.attempts).toHaveLength(1);
  expect(() =>
    runTrackToolAction({
      sessionId: first.id,
      id: item.id,
      action: 'retry_checks',
      actor: 'user',
    }),
  ).toThrow('Invalid');
});
