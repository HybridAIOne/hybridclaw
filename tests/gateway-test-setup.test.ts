import fs from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hybridclaw-gateway-setup-regression-');

it.each([false, true])(
  'cleans all homes after resource teardown (failure=%s)',
  async (fail) => {
    const originalHome = process.env.HOME;
    const originalFlag = process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;
    const originalExtra = process.env.HYBRIDCLAW_TEST_CLEANUP;
    const originalCwd = process.cwd();
    const sibling = makeTempDir();
    const hooks: Array<() => unknown> = [];
    vi.resetModules();
    vi.doMock('vitest', () => ({
      afterEach: (hook: () => unknown) => hooks.push(hook),
      vi,
    }));
    try {
      const { setupGatewayTest } = await import(
        './helpers/gateway-test-setup.js'
      );
      const homes: string[] = [];
      const { setupHome } = setupGatewayTest({
        tempHomePrefix: 'hybridclaw-gateway-cleanup-',
        envVars: ['HYBRIDCLAW_TEST_CLEANUP'],
        cleanup: async () => {
          for (const home of homes) expect(fs.existsSync(home)).toBe(true);
          process.chdir(originalCwd);
          if (fail) throw new Error('resource teardown failed');
        },
      });
      homes.push(setupHome({ HYBRIDCLAW_TEST_CLEANUP: 'one' }));
      homes.push(setupHome({ HYBRIDCLAW_TEST_CLEANUP: 'two' }));
      for (const home of homes) {
        makeTempDir.track(home);
        fs.writeFileSync(path.join(home, 'fixture'), 'test');
      }
      const audit = await vi.importActual<
        typeof import('../src/audit/audit-trail.js')
      >('../src/audit/audit-trail.js');
      const database = await vi.importActual<
        typeof import('../src/memory/database.js')
      >('../src/memory/database.js');
      const pendingWrite = path.join(homes[1], 'audit-completed');
      vi.spyOn(audit, 'flushAuditTrail').mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        fs.writeFileSync(pendingWrite, 'flushed');
      });
      let databaseClosed = false;
      vi.spyOn(database, 'closeDatabase').mockImplementation(() => {
        expect(fs.existsSync(pendingWrite)).toBe(true);
        databaseClosed = true;
      });
      process.chdir(homes[1]);
      expect(hooks).toHaveLength(2);
      // Vitest runs afterEach hooks in reverse registration order.
      if (fail)
        await expect(hooks[1]()).rejects.toThrow('resource teardown failed');
      else await hooks[1]();
      expect(databaseClosed).toBe(true);
      expect(process.env.HOME).toBe(originalHome);
      expect(process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER).toBe(originalFlag);
      expect(process.env.HYBRIDCLAW_TEST_CLEANUP).toBe(originalExtra);
      await hooks[0]();
      for (const home of homes) expect(fs.existsSync(home)).toBe(false);
      expect(fs.existsSync(sibling)).toBe(true);
    } finally {
      process.chdir(originalCwd);
      vi.doUnmock('vitest');
      vi.resetModules();
      for (const [key, value] of [
        ['HOME', originalHome],
        ['HYBRIDCLAW_DISABLE_CONFIG_WATCHER', originalFlag],
        ['HYBRIDCLAW_TEST_CLEANUP', originalExtra],
      ]) {
        if (value === undefined) delete process.env[key as string];
        else process.env[key as string] = value;
      }
    }
  },
);
