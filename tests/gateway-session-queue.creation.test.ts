import { expect, test, vi } from 'vitest';
import { cleanupGatewayRuntime } from './helpers/gateway-test-setup.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const { stop } = vi.hoisted(() => ({
  stop: vi.fn(async (_session: string) => true),
}));
vi.mock('../src/agent/executor.js', () => ({ stopSessionExecution: stop }));
const temporary = useTempDir('gateway-queue-creation-');
useCleanMocks({
  cleanup: async () => {
    await cleanupGatewayRuntime();
    stop.mockClear();
  },
  resetModules: true,
  unstubAllEnvs: true,
});

test.each([
  { initial: 'canonical', target: 'original key' },
  { initial: 'canonical', target: 'stored ID' },
  { initial: 'canonical', target: 'release' },
  { initial: 'legacy', target: 'original key' },
  { initial: 'legacy', target: 'stored ID' },
  { initial: 'legacy', target: 'canonical key' },
  { initial: 'legacy', target: 'release' },
] as const)(
  'creation keeps $initial queue ownership for $target',
  async ({ initial, target }) => {
    vi.stubEnv('HOME', temporary());
    const db = await import('../src/memory/db.js');
    const { buildSessionKey } = await import('../src/session/session-key.js');
    db.initDatabase({ quiet: true });
    const key =
      initial === 'legacy'
        ? 'tui:new-peer'
        : buildSessionKey('main', 'web', 'dm', 'new-peer');
    const channel = initial === 'legacy' ? 'tui' : 'web';
    expect(db.getSessionById(key)).toBeUndefined();
    const independent = db.getOrCreateSession(
      'other-peer',
      null,
      'web',
      'main',
    );
    const { gatewaySessionQueue, releaseSessionWorker } = await import(
      '../src/gateway/session-worker-release.js'
    );
    let started!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let id = '';
    let canonical = '';
    const first = gatewaySessionQueue.run(key, async (bind) => {
      const session = db.getOrCreateSession(key, null, channel, 'main');
      id = session.id;
      canonical = session.session_key;
      await bind(id);
      started();
      await pending;
    });
    await entered;
    const secondTask = vi.fn(async () => {});
    const lookup =
      target === 'stored ID'
        ? id
        : target === 'canonical key'
          ? canonical
          : key;
    const second =
      target === 'release'
        ? releaseSessionWorker(id)
        : gatewaySessionQueue.run(lookup, secondTask);
    const independentTask = vi.fn(async () => {});
    try {
      await gatewaySessionQueue.run(independent.id, independentTask);
      expect(independentTask).toHaveBeenCalledOnce();
      expect(secondTask).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
    } finally {
      release();
      await Promise.all([first, second]);
    }
    if (target === 'release') expect(stop).toHaveBeenCalledExactlyOnceWith(id);
    else expect(secondTask).toHaveBeenCalledOnce();
  },
);

test.each(['canonical', 'legacy'] as const)(
  'a queued release keeps its known %s session after rotation',
  async (alias) => {
    vi.stubEnv('HOME', temporary());
    const db = await import('../src/memory/db.js');
    const { buildSessionKey } = await import('../src/session/session-key.js');
    db.initDatabase({ quiet: true });
    const key =
      alias === 'legacy'
        ? 'tui:rotating-peer'
        : buildSessionKey('main', 'web', 'dm', 'rotating-peer');
    const session = db.getOrCreateSession(
      key,
      null,
      alias === 'legacy' ? 'tui' : 'web',
      'main',
    );
    const { gatewaySessionQueue, releaseSessionWorker } = await import(
      '../src/gateway/session-worker-release.js'
    );
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = gatewaySessionQueue.run(session.id, () => pending);
    const releasing = releaseSessionWorker(key);
    const replacement = db.createFreshSessionInstance(session.id).session;
    try {
      const independent = vi.fn(async () => {});
      await gatewaySessionQueue.run(replacement.id, independent);
      expect(independent).toHaveBeenCalledOnce();
      expect(stop).not.toHaveBeenCalled();
    } finally {
      release();
      await Promise.all([first, releasing]);
    }
    expect(stop).toHaveBeenCalledExactlyOnceWith(session.id);
  },
);

test.each(['canonical', 'legacy'] as const)(
  'cold %s queue ownership survives rotation without blocking its replacement',
  async (alias) => {
    vi.stubEnv('HOME', temporary());
    const db = await import('../src/memory/db.js');
    const { buildSessionKey } = await import('../src/session/session-key.js');
    db.initDatabase({ quiet: true });
    const key =
      alias === 'legacy'
        ? 'tui:cold-rotation'
        : buildSessionKey('main', 'web', 'dm', 'cold-rotation');
    const { gatewaySessionQueue, releaseSessionWorker } = await import(
      '../src/gateway/session-worker-release.js'
    );
    let entered!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let id = '';
    const first = gatewaySessionQueue.run(key, async (bind) => {
      id = db.getOrCreateSession(
        key,
        null,
        alias === 'legacy' ? 'tui' : 'web',
        'main',
      ).id;
      await bind(id);
      entered();
      await pending;
    });
    await started;
    const replacement = db.createFreshSessionInstance(id).session;
    const releasing = releaseSessionWorker(id);
    try {
      const independent = vi.fn(async () => {});
      await gatewaySessionQueue.run(replacement.id, independent);
      expect(independent).toHaveBeenCalledOnce();
      expect(stop).not.toHaveBeenCalled();
    } finally {
      finish();
      await Promise.all([first, releasing]);
    }
    expect(stop).toHaveBeenCalledExactlyOnceWith(id);
  },
);

test('repeated concurrent binding is idempotent and every lease is released on failure', async () => {
  vi.stubEnv('HOME', temporary());
  const db = await import('../src/memory/db.js');
  db.initDatabase({ quiet: true });
  const session = db.getOrCreateSession('bound-session', null, 'web', 'main');
  const { gatewaySessionQueue } = await import(
    '../src/gateway/session-worker-release.js'
  );
  await expect(
    gatewaySessionQueue.run('unresolved-key', async (bind) => {
      await Promise.all([bind(session.id), bind(session.id)]);
      throw new Error('Fixture turn failed.');
    }),
  ).rejects.toThrow('Fixture turn failed.');
  await expect(
    gatewaySessionQueue.run(session.id, async () => 'stored queue released'),
  ).resolves.toBe('stored queue released');
  await expect(
    gatewaySessionQueue.run(
      'unresolved-key',
      async () => 'admission queue released',
    ),
  ).resolves.toBe('admission queue released');
});

test('separate unresolved admissions serialize when they resolve to the same stored session', async () => {
  vi.stubEnv('HOME', temporary());
  const db = await import('../src/memory/db.js');
  db.initDatabase({ quiet: true });
  const session = db.getOrCreateSession(
    'resolved-session',
    null,
    'web',
    'main',
  );
  const { gatewaySessionQueue } = await import(
    '../src/gateway/session-worker-release.js'
  );
  let entered!: () => void;
  let finish!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const secondTask = vi.fn(async () => {});
  const first = gatewaySessionQueue.run('first-admission', async (bind) => {
    await bind(session.id);
    entered();
    await pending;
  });
  const second = gatewaySessionQueue.run('second-admission', async (bind) => {
    await bind(session.id);
    await secondTask();
  });
  try {
    await started;
    await gatewaySessionQueue.run('unrelated-admission', async () => {});
    expect(secondTask).not.toHaveBeenCalled();
  } finally {
    finish();
    await Promise.all([first, second]);
  }
  expect(secondTask).toHaveBeenCalledOnce();
});
