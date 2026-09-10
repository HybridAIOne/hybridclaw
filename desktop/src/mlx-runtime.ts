/**
 * Desktop ownership of optional native inference, separate from the gateway.
 * Sleep/quit unload owned workers; waking restores only a previously running
 * worker. The CLI owns installation validation and bounded crash recovery.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { BrowserWindow, dialog } from 'electron';
import type { GatewayRuntimeOptions } from './gateway-runtime.js';
import {
  resolveGatewayEntry,
  resolveGatewayNodeExecutable,
} from './runtime-paths.js';

export class DesktopMlxRuntime {
  private child: ChildProcess | null = null;
  private stopping: Promise<void> = Promise.resolve();
  private resumeAfterSleep = false;
  private installing = false;
  private installer: ChildProcess | null = null;
  private cancellingSetup = false;
  constructor(private options: GatewayRuntimeOptions) {}

  private spawn(args: string[]) {
    return spawn(
      resolveGatewayNodeExecutable({
        ...this.options,
        env: this.options.processEnv,
      }),
      [resolveGatewayEntry(this.options.runtimeRoot), 'local', ...args],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...this.options.processEnv, ELECTRON_RUN_AS_NODE: '1' },
      },
    );
  }
  async start() {
    await this.stopping;
    if (this.child || this.installing) return;
    const child = this.spawn(['serve', '--if-configured']);
    this.child = child;
    child.stdout?.resume();
    child.stderr?.resume();
    child.on('error', () => {
      if (this.child === child) {
        this.child = null;
        dialog.showErrorBox(
          'Local model unavailable',
          'The native inference process could not start. Run local setup or check its installation.',
        );
      }
    });
    child.on('exit', (code) => {
      if (this.child === child) {
        this.child = null;
        if (code && code !== 0)
          dialog.showErrorBox(
            'Local model stopped',
            'Local inference could not recover. Start it again or run local setup.',
          );
      }
    });
  }
  stop(): Promise<void> {
    const installer = this.installer;
    if (installer) {
      this.cancellingSetup = true;
    }
    const child = this.child;
    this.child = null;
    if (!child && !installer) return this.stopping;
    const previous = this.stopping;
    this.stopping = Promise.all([
      previous,
      ...[child, installer]
        .filter((process): process is ChildProcess => process !== null)
        .map(async (process) => {
          const exited = once(process, 'exit').catch(() => {});
          process.kill('SIGTERM');
          const timeout = setTimeout(() => process.kill('SIGKILL'), 6000);
          await exited;
          clearTimeout(timeout);
        }),
    ]).then(() => {});
    return this.stopping;
  }
  suspend() {
    this.resumeAfterSleep = this.child !== null;
    void this.stop();
  }
  resume() {
    if (this.resumeAfterSleep) {
      this.resumeAfterSleep = false;
      void this.start();
    }
  }

  async setup() {
    if (this.installing) return;
    this.installing = true;
    this.cancellingSetup = false;
    let progress: BrowserWindow | null = null;
    try {
      const inspect = this.spawn(['setup', '--list', '--json']);
      let output = '';
      inspect.stdout?.on('data', (data) => {
        output += String(data);
      });
      inspect.stderr?.resume();
      const [status] = await once(inspect, 'exit');
      if (status !== 0)
        throw new Error('Could not inspect the local hardware.');
      const data = JSON.parse(output.trim().split('\n').at(-1) || '{}') as {
        supported: boolean;
        recommended: string;
        hardware: {
          chip: string;
          memoryBytes: number;
          availableMemoryEstimateBytes?: number;
        };
        reservedBytes: number;
        candidates: Array<{
          id: string;
          label: string;
          weightBytes: number;
          fits: boolean;
          contextWindow: number;
        }>;
        unavailable: Array<{
          label: string;
          reason: string;
          listedMemoryGb: string;
        }>;
      };
      const candidates = data.candidates.filter((candidate) => candidate.fits);
      if (!data.supported || !candidates.length)
        throw new Error(
          'Managed inference needs Apple silicon, macOS 15+, and enough free memory for a catalog model.',
        );
      const choices = [...candidates].sort(
        (a, b) =>
          Number(b.id === data.recommended) - Number(a.id === data.recommended),
      );
      let model: (typeof choices)[number] | undefined;
      while (!model) {
        const selected = await dialog.showMessageBox({
          type: 'question',
          title: 'Set Up Local Model',
          message: `${data.hardware.chip} · ${Math.round(data.hardware.memoryBytes / 1024 ** 3)} GiB memory`,
          detail: `Reserving ${(data.reservedBytes / 1024 ** 3).toFixed(1)} GiB for macOS and your apps.${data.hardware.availableMemoryEstimateBytes === undefined ? '' : ` Currently about ${(data.hardware.availableMemoryEstimateBytes / 1024 ** 3).toFixed(1)} GiB is available, including inactive pages.`} The first model is recommended by estimated memory fit. Models must pass local checks before activation.\n\n${choices.map((model) => `${model.label}: ${(model.weightBytes / 1024 ** 3).toFixed(1)} GiB download, ${model.contextWindow} token context`).join('\n')}\n\nChoose a model to download and test. uv is required.`,
          buttons: [
            ...choices.map((model) => model.label),
            'View full shortlist…',
            'Cancel',
          ],
          cancelId: choices.length + 1,
          defaultId: 0,
        });
        if (selected.response === choices.length) {
          await dialog.showMessageBox({
            type: 'info',
            title: 'Current Local Model Shortlist',
            message: 'Mac support and memory fit',
            detail:
              'The post lists GPU VRAM. Mac estimates also reserve memory for macOS, apps and context.\n\n' +
              data.candidates
                .map(
                  (entry) =>
                    `${entry.label}: ${entry.fits ? 'available to download and test' : 'needs more available memory'}`,
                )
                .join('\n') +
              '\n\n' +
              data.unavailable
                .map(
                  (entry) =>
                    `${entry.label} (post: ${entry.listedMemoryGb} GB): ${entry.reason}`,
                )
                .join('\n\n'),
          });
          continue;
        }
        model = choices[selected.response];
        if (!model) return;
      }
      await this.stop();
      progress = new BrowserWindow({
        title: 'Local Model Setup',
        width: 600,
        height: 220,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      });
      await progress.loadURL(
        `data:text/html,${encodeURIComponent('<body style="font:16px system-ui;padding:28px"><h2>Setting up your local model</h2><p>Downloading the pinned model and testing streaming and tools. This can take several minutes. You can keep using HybridClaw.</p></body>')}`,
      );
      const installer = this.spawn(['setup', '--model', model.id, '--yes']);
      this.installer = installer;
      progress.on('close', () => {
        if (this.installer) void this.stop();
      });
      installer.stdout?.resume();
      installer.stderr?.resume();
      const [code] = await once(installer, 'exit');
      this.installer = null;
      if (this.cancellingSetup) return;
      if (code !== 0)
        throw new Error(
          'Local setup did not pass. Your previous default remains configured. Run “hybridclaw local setup” in a terminal for details.',
        );
      await dialog.showMessageBox({
        type: 'info',
        message: `${model.label} is ready`,
        detail:
          'Streaming and tool checks passed. The local model will start now.',
      });
      this.installing = false;
      await this.start();
    } catch (error) {
      if (!this.cancellingSetup)
        dialog.showErrorBox(
          'Local Model Setup',
          error instanceof Error ? error.message : 'Local setup failed.',
        );
    } finally {
      this.installing = false;
      this.installer = null;
      if (progress && !progress.isDestroyed()) progress.close();
    }
  }
}
