/**
 * Console local-model jobs belong to the gateway, so navigation cannot cancel them.
 * Only fixed catalog IDs reach the shared installer; this is not a shell or a
 * provider editor. Observed lifecycle changes invalidate model discovery.
 * Start also reconnects healthy workers; status never repairs configuration
 * and exposes only readiness and gateway-retained numeric metrics, never credentials.
 */
import type { ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { GatewayRequestError } from '../errors/gateway-request-error.js';
import {
  detectMacHardware,
  estimateMacModels,
  supportsMacLocalModels,
} from '../inference/local-model-catalog.js';
import { LocalModelMetricsSampler } from '../inference/local-model-metrics.js';
import { LocalModelMetricsHistory } from '../inference/local-model-metrics-history.js';
import {
  connectMlxModel,
  isMlxConnected,
} from '../inference/mlx-connection.js';
import {
  installMlxModel,
  MlxSetupError,
  type MlxSetupStage,
} from '../inference/mlx-install.js';
import {
  mlxCredentials,
  mlxHealth,
  mlxHome,
  readMlxInstallation,
  startMlxChild,
  stopMlxChild,
} from '../inference/mlx-runtime.js';

import { invalidateLocalModelDiscovery } from '../providers/local-discovery.js';

type Stage = MlxSetupStage | 'starting' | 'connecting' | 'stopping';
type Job = {
  action: 'setup' | 'start' | 'stop';
  modelId: string | null;
  stage: Stage;
  status: 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed';
  error: string | null;
};

const STAGE_FAILURES: Record<Stage, string> = {
  runtime:
    'Runtime setup failed. Check that uv is installed and the Mac can reach the Python package servers, then retry.',
  download:
    'Download or file verification failed. Check your connection and free disk space, then retry; cached downloads are reused.',
  loading:
    'The model could not load. Close memory-heavy apps and retry, or choose a smaller model.',
  checking:
    'Local streaming or tool checks failed. The model was not activated. Retry setup or choose another model.',
  activating:
    'The model passed its checks, but configuration could not be saved. Check runtime-directory permissions and the mac-mlx provider name.',
  starting:
    'The model could not start. Close memory-heavy apps and try again. If this continues, run setup again.',
  connecting:
    'The local model could not connect to chat. Check runtime-directory permissions and the mac-mlx provider name, then retry.',
  stopping:
    'The model could not stop. Retry after the current request finishes.',
};

export class GatewayLocalModelService {
  private job: Job | null = null;
  private cancellation: AbortController | null = null;
  private pending: Promise<void> | null = null;
  private child: ChildProcess | null = null;
  private closing = false;
  private lastRunning: boolean | undefined;
  private lastConnected: boolean | undefined;
  private metrics: LocalModelMetricsHistory | null = null;

  startMetrics(): void {
    if (this.closing || this.metrics) return;
    const hardware = detectMacHardware();
    if (!supportsMacLocalModels(hardware)) return;
    const sampler = new LocalModelMetricsSampler();
    this.metrics = new LocalModelMetricsHistory(async () => {
      // Missing/invalid installations have no worker counters; host graphs
      // still run, and the status endpoint reports installation errors.
      const health = await mlxHealth().catch(() => null);
      return sampler.sample(hardware, health);
    });
    this.metrics.start();
  }

  async status() {
    const hardware = detectMacHardware();
    const estimate = estimateMacModels(hardware);
    let uvAvailable = false;
    if (estimate.supported) {
      try {
        execFileSync('uv', ['--version'], { timeout: 2000, stdio: 'ignore' });
        uvAvailable = true;
      } catch {
        /* The UI offers the prerequisite instructions. */
      }
    }
    let diskPath = mlxHome();
    while (!fs.existsSync(diskPath) && path.dirname(diskPath) !== diskPath)
      diskPath = path.dirname(diskPath);
    const disk = fs.statfsSync(diskPath);
    let installation: { modelId: string; contextWindow: number } | null = null;
    let installationError: string | null = null;
    let health: Record<string, unknown> | null = null;
    if (fs.existsSync(path.join(mlxHome(), 'installation.json'))) {
      try {
        const installed = readMlxInstallation();
        installation = {
          modelId: installed.model,
          contextWindow: installed.contextWindow,
        };
        health = await mlxHealth();
      } catch {
        installationError =
          'The saved installation could not be read. Run setup again to repair it.';
      }
    }
    const running = Boolean(health);
    const connected = Boolean(installation) && isMlxConnected();
    if (this.lastRunning !== running || this.lastConnected !== connected) {
      this.lastRunning = running;
      this.lastConnected = connected;
      invalidateLocalModelDiscovery();
    }
    return {
      hardware,
      ...estimate,
      uvAvailable,
      freeDiskBytes: disk.bavail * disk.bsize,
      installation,
      installationError,
      running,
      connected,
      metricsHistory: this.metrics?.snapshot() ?? [],
      job: this.job ? { ...this.job } : null,
    };
  }

  command(body: unknown): void {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new GatewayRequestError(400, 'Expected a local-model action.');
    const request = body as Record<string, unknown>;
    const { action, modelId } = request;
    if (
      Object.keys(request).some(
        (key) => key !== 'action' && key !== 'modelId',
      ) ||
      typeof action !== 'string' ||
      !['setup', 'start', 'stop', 'cancel'].includes(action) ||
      (action !== 'setup' && modelId !== undefined)
    )
      throw new GatewayRequestError(400, 'Invalid local-model action.');
    if (this.closing)
      throw new GatewayRequestError(409, 'The gateway is shutting down.');
    if (action === 'cancel') {
      if (this.job?.status === 'running' && this.cancellation) {
        this.job.status = 'cancelling';
        this.cancellation.abort();
      }
      return;
    }
    if (this.pending)
      throw new GatewayRequestError(
        409,
        'A local-model operation is already running.',
      );
    const estimate = estimateMacModels(detectMacHardware());
    if (!estimate.supported)
      throw new GatewayRequestError(
        400,
        'Managed setup requires Apple silicon and macOS 15 or later on the gateway host.',
      );
    if (
      action === 'setup' &&
      (typeof modelId !== 'string' ||
        !estimate.candidates.some(
          (model) => model.id === modelId && model.fits,
        ))
    )
      throw new GatewayRequestError(
        400,
        'Choose an installable shortlist model that fits the current memory budget.',
      );
    const job: Job = {
      action: action as Job['action'],
      modelId: typeof modelId === 'string' ? modelId : null,
      stage:
        action === 'setup'
          ? 'runtime'
          : action === 'start'
            ? 'starting'
            : 'stopping',
      status: 'running',
      error: null,
    };
    const controller = new AbortController();
    this.job = job;
    this.cancellation = controller;
    this.pending = this.run(job, controller.signal)
      .then(
        () => {
          job.status = 'completed';
        },
        (error: unknown) => {
          job.status = controller.signal.aborted ? 'cancelled' : 'failed';
          if (job.status === 'failed')
            job.error =
              error instanceof MlxSetupError
                ? error.message
                : STAGE_FAILURES[job.stage];
        },
      )
      .finally(() => {
        invalidateLocalModelDiscovery();
        this.cancellation = null;
        this.pending = null;
      });
  }

  private async run(job: Job, signal: AbortSignal): Promise<void> {
    if (job.action === 'setup') {
      await installMlxModel(job.modelId as string, {
        signal,
        quiet: true,
        route: 'console.local.setup',
        onProgress: (stage) => {
          job.stage = stage;
        },
      });
    } else if (job.action === 'start') {
      let started: ChildProcess | undefined;
      try {
        if (!(await mlxHealth())) {
          signal.throwIfAborted();
          started = await startMlxChild(mlxHome(), signal);
          this.child = started;
          started.once('exit', () => {
            if (this.child === started) this.child = null;
            invalidateLocalModelDiscovery();
          });
        }
        signal.throwIfAborted();
        job.stage = 'connecting';
        connectMlxModel({ route: 'console.local.start' });
      } catch (error) {
        if (started) {
          await stopMlxChild(started);
          if (this.child === started) this.child = null;
        }
        throw error;
      }
    } else {
      signal.throwIfAborted();
      const { token, baseUrl } = mlxCredentials();
      const response = await fetch(`${baseUrl.slice(0, -3)}/control/stop`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      });
      if (!response.ok) throw new Error('Local model stop failed.');
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    this.cancellation?.abort();
    await Promise.all([this.pending, this.metrics?.close()]);
    if (this.child) await stopMlxChild(this.child);
    this.child = null;
  }
}
