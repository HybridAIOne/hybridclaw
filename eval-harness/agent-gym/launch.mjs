// Read only the configured model settings and provider key before creating a
// disposable runtime home. Production config imports happen only in the child.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withTemporaryDirectory } from './temporary.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root =
  process.env.HY_GYM_RUNTIME_ROOT ||
  fileURLToPath(new URL('../../', import.meta.url));
const { DEFAULT_RUNTIME_HOME_DIR } = await import(
  pathToFileURL(path.join(root, 'src/config/runtime-paths.ts')).href
);
const source = JSON.parse(
  fs.readFileSync(path.join(DEFAULT_RUNTIME_HOME_DIR, 'config.json'), 'utf8'),
);
const { readStoredRuntimeSecret } = await import(
  pathToFileURL(path.join(root, 'src/security/runtime-secrets.ts')).href
);
const apiKey =
  process.env.HYBRIDAI_API_KEY || readStoredRuntimeSecret('HYBRIDAI_API_KEY');
if (!apiKey) throw new Error('A configured HybridAI API key is required');
await withTemporaryDirectory('hy-conversation-gym-', async (home) => {
  let child;
  const forward = (signal) => child?.kill(signal);
  const onInterrupt = () => forward('SIGINT');
  const onTerminate = () => forward('SIGTERM');
  try {
    fs.chmodSync(home, 0o700);
    fs.writeFileSync(
      path.join(home, 'config.json'),
      JSON.stringify({
        version: source.version,
        security: { trustModelAccepted: true },
        hybridai: source.hybridai,
      }),
      { mode: 0o600 },
    );
    child = spawn(
      process.execPath,
      [
        '--import',
        path.join(root, 'node_modules/tsx/dist/loader.mjs'),
        path.join(directory, 'run.mjs'),
        ...process.argv.slice(2),
      ],
      {
        cwd: home,
        env: {
          ...process.env,
          HY_GYM_RUNTIME_ROOT: root,
          HYBRIDCLAW_DATA_DIR: home,
          HYBRIDCLAW_DISABLE_CONFIG_WATCHER: '1',
          HY_GYM_ISOLATED: '1',
          HYBRIDAI_API_KEY: apiKey,
        },
        stdio: 'inherit',
      },
    );
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onTerminate);
    process.exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
  }
});
