import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-agent-share-command-',
});

async function setupCommand() {
  setupHome();
  const db = await import('../src/memory/db.js');
  db.initDatabase({ quiet: true });
  db.upsertAgent({ id: 'lexware', name: 'Lexware' });
  const { handleAgentPackageCommand } = await import(
    '../src/cli/agent-command.js'
  );
  return { db, handleAgentPackageCommand };
}

test('agent share, shares, and unshare manage canonical grants', async () => {
  const { db, handleAgentPackageCommand } = await setupCommand();
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  await handleAgentPackageCommand([
    'share',
    'lexware',
    'User_A@HybridAI.One',
    '--expires-at',
    '2099-01-01T00:00:00Z',
  ]);
  expect(logSpy).toHaveBeenLastCalledWith(
    'Shared agent lexware with user_a@hybridai.',
  );
  expect(db.getAgentById('lexware')?.shared).toBe(true);

  logSpy.mockClear();
  await handleAgentPackageCommand(['shares', 'lexware']);
  expect(logSpy).toHaveBeenCalledWith(
    expect.stringMatching(
      /^user_a@hybridai\tuser\tlocal\tlocal-operator\t.+\t\t2099-01-01T00:00:00\.000Z$/,
    ),
  );

  logSpy.mockClear();
  await handleAgentPackageCommand([
    'unshare',
    'lexware',
    'USER_A@HYBRIDAI.ONE',
  ]);
  expect(logSpy).toHaveBeenLastCalledWith(
    'Unshared agent lexware from user_a@hybridai.',
  );
  expect(db.getAgentById('lexware')?.shared).toBeUndefined();

  logSpy.mockClear();
  await handleAgentPackageCommand(['shares', 'lexware']);
  expect(logSpy).toHaveBeenLastCalledWith('No shares for agent lexware.');
});

test('agent sharing commands reject invalid or missing targets', async () => {
  const { handleAgentPackageCommand } = await setupCommand();
  vi.spyOn(console, 'log').mockImplementation(() => {});

  await expect(
    handleAgentPackageCommand(['share', 'missing', 'user_a@hybridai']),
  ).rejects.toThrow('Agent "missing" was not found.');
  await expect(
    handleAgentPackageCommand([
      'share',
      'lexware',
      'user_a@hybridai',
      '--expires-at',
      'invalid',
    ]),
  ).rejects.toThrow('Agent grant `expiresAt` must be a valid date.');
  await expect(
    handleAgentPackageCommand(['unshare', 'lexware', 'user_a@hybridai']),
  ).rejects.toThrow('Agent lexware is not shared with user_a@hybridai.');
  await expect(handleAgentPackageCommand(['shares', 'missing'])).rejects.toThrow(
    'Unknown agent: missing',
  );
});
