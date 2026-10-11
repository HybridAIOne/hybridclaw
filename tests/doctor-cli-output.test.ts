import { expect, it, vi } from 'vitest';
import { useCleanMocks } from './test-utils.js';

// A stale channel plugin logs `Plugin failed to load` while doctor
// initialises plugins; the finding below is the only report doctor prints.
vi.mock('../src/doctor/checks/index.js', async () => {
  const { logger } = await import('../src/logger.js');
  return {
    doctorChecks: () => [
      {
        category: 'channels',
        label: 'Channels',
        run: async () => {
          logger.warn({ pluginId: 'line' }, 'Plugin failed to load');
          return [
            {
              category: 'channels',
              label: 'Channels',
              severity: 'error',
              message: 'Run `hybridclaw plugin reinstall line --yes`',
            },
          ];
        },
      },
    ],
  };
});

useCleanMocks({ unstubAllEnvs: true });

it.each([[[]], [['--json']]])(
  'doctor %j prints findings without log lines',
  async (argv) => {
    vi.stubEnv('HYBRIDCLAW_FORCE_LOG_LEVEL', '');
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    const printed: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => {
      printed.push(String(line));
    });
    const { runDoctorCli } = await import('../src/doctor.js');

    expect(await runDoctorCli(argv)).toBe(1);

    expect(written.join('')).not.toContain('Plugin failed to load');
    const output = printed.join('\n');
    expect(output).toContain('plugin reinstall line');
    if (argv.includes('--json')) expect(() => JSON.parse(output)).not.toThrow();
  },
);
