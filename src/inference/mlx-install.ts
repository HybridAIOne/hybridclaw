/**
 * Shared Mac installer activates only catalog artifacts that pass local checks.
 * CLI and console own consent and cancellation; this transaction owns rollback
 * and the cross-process setup lock, never a long-running inference service.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import {
  detectMacHardware,
  estimateMacModels,
  GIB,
} from './local-model-catalog.js';
import { benchmarkMlx } from './mlx-benchmark.js';
import { connectMlxModel } from './mlx-connection.js';
import {
  MLX_COMPONENT,
  type MlxInstallation,
  mlxHealth,
  mlxHome,
  startMlxChild,
  stopMlxChild,
} from './mlx-runtime.js';
import { claimMlxSetup } from './mlx-setup-lock.js';

async function run(
  command: string,
  args: string[],
  input?: string,
  env = process.env,
  signal?: AbortSignal,
  quiet = false,
) {
  const child = spawn(command, args, {
    env,
    signal,
    stdio: [
      input ? 'pipe' : 'ignore',
      quiet ? 'ignore' : 'inherit',
      quiet ? 'ignore' : 'inherit',
    ],
  });
  if (input) child.stdin?.end(input);
  let code: unknown;
  try {
    [code] = await once(child, 'exit');
  } catch (error) {
    // Aborting spawn emits an error before exit. Finish stopping the installer
    // before restoring its manifest or releasing the installation lock.
    if (child.pid) await stopMlxChild(child);
    throw error;
  }
  if (code !== 0)
    throw new Error(
      `${path.basename(command)} failed. The previous model remains configured.`,
    );
}
function privateWrite(file: string, content: string): void {
  fs.writeFileSync(`${file}.tmp`, content, { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

export class MlxSetupError extends Error {}

export type MlxSetupStage =
  | 'runtime'
  | 'download'
  | 'loading'
  | 'checking'
  | 'activating';

export async function installMlxModel(
  modelId: string,
  {
    signal,
    onProgress = () => {},
    quiet = false,
    route = 'cli.local.setup',
  }: {
    signal?: AbortSignal;
    onProgress?: (stage: MlxSetupStage) => void;
    quiet?: boolean;
    route?: 'cli.local.setup' | 'console.local.setup';
  } = {},
) {
  signal?.throwIfAborted();
  const estimate = estimateMacModels(detectMacHardware());
  if (!estimate.supported)
    throw new MlxSetupError(
      'Managed MLX requires Apple silicon and macOS 15 or later.',
    );
  const selected = estimate.candidates.find(
    (entry) => entry.id === modelId && entry.fits,
  );
  if (!selected)
    throw new MlxSetupError(
      'Choose a model that fits the current memory budget.',
    );
  const home = mlxHome();
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  let releaseSetup: () => void;
  try {
    releaseSetup = claimMlxSetup(home);
  } catch {
    throw new MlxSetupError(
      'Another local setup is running or its lock needs attention. Wait for it to finish before retrying.',
    );
  }
  try {
    if (
      fs.existsSync(path.join(home, 'installation.json')) &&
      (await mlxHealth(home))
    )
      throw new MlxSetupError(
        'Stop the local model before changing it: hybridclaw local stop',
      );
    const disk = fs.statfsSync(home);
    if (disk.bavail * disk.bsize < selected.weightBytes * 1.1 + 2 * GIB)
      throw new MlxSetupError(
        'Insufficient free disk space for the selected model and runtime.',
      );
    const previous = new Map<string, Buffer | null>();
    for (const name of [
      'installation.json',
      'manifest.json',
      'token',
      'benchmark.json',
    ])
      previous.set(
        name,
        fs.existsSync(path.join(home, name))
          ? fs.readFileSync(path.join(home, name))
          : null,
      );
    let child: ChildProcess | undefined;
    try {
      onProgress('runtime');
      await run(
        'uv',
        ['sync', '--project', MLX_COMPONENT, '--locked', '--python', '3.12'],
        undefined,
        { ...process.env, UV_PROJECT_ENVIRONMENT: path.join(home, 'venv') },
        signal,
        quiet,
      );
      onProgress('download');
      await run(
        path.join(home, 'venv', 'bin', 'python'),
        [path.join(MLX_COMPONENT, 'model_store.py'), home],
        JSON.stringify(selected),
        process.env,
        signal,
        quiet,
      );
      const installation: MlxInstallation = {
        version: 1,
        model: selected.id,
        repo: selected.repo,
        revision: selected.revision,
        license: selected.license,
        port: 8321,
        contextWindow: selected.contextWindow,
        memoryLimitBytes: estimate.memoryLimitBytes,
        cacheBytes: selected.cacheBytes,
      };
      privateWrite(
        path.join(home, 'installation.json'),
        JSON.stringify(installation, null, 2),
      );
      if (!previous.get('token'))
        privateWrite(path.join(home, 'token'), randomBytes(32).toString('hex'));
      signal?.throwIfAborted();
      onProgress('loading');
      child = await startMlxChild(home, signal);
      onProgress('checking');
      const report = await benchmarkMlx(home);
      signal?.throwIfAborted();
      onProgress('activating');
      privateWrite(
        path.join(home, 'benchmark.json'),
        JSON.stringify(report, null, 2),
      );
      connectMlxModel({ home, route, defaultModel: `mac-mlx/${selected.id}` });
      return report;
    } catch (error) {
      for (const [name, content] of previous) {
        if (content) privateWrite(path.join(home, name), content.toString());
        else fs.rmSync(path.join(home, name), { force: true });
      }
      throw error;
    } finally {
      if (child) await stopMlxChild(child);
    }
  } finally {
    releaseSetup();
  }
}
