/**
 * Owns one resident MLX process independently of the chat model and workers.
 * Serving is offline; only explicit setup installs the pinned Python environment
 * and model. Lost or timed-out pipes fail the decision instead of retrying elsewhere.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

export class LayaRuntime {
  constructor({ home, component }) {
    this.home = home;
    this.component = component;
    this.child = null;
    this.pending = null;
    this.state = 'stopped';
    this.error = undefined;
    this.operation = null;
    this.stopping = false;
  }
  status() {
    return {
      supported: process.platform === 'darwin' && process.arch === 'arm64',
      installed:
        fs.existsSync(path.join(this.home, 'ready')) &&
        fs.existsSync(this.python()),
      status: this.state,
      ...(this.error ? { error: this.error } : {}),
    };
  }
  python() {
    return path.join(this.home, 'venv', 'bin', 'python');
  }
  command(action) {
    if (!['setup', 'start', 'stop'].includes(action))
      throw new Error('Unknown operation.');
    if (action === 'stop') {
      void this.stop();
      return;
    }
    if (!this.status().supported || this.operation || this.child)
      throw new Error('Local runtime unavailable or busy.');
    if (action === 'start' && !this.status().installed)
      throw new Error('Setup required.');
    this.state = action === 'setup' ? 'setup' : 'starting';
    this.error = undefined;
    this.stopping = false;
    this.operation = (action === 'setup' ? this.setup() : this.start())
      .catch(() => {
        if (this.stopping) return;
        this.state = 'error';
        this.error =
          'Laya could not start. Check uv, available memory and model setup, then retry.';
      })
      .finally(() => {
        this.operation = null;
      });
  }
  env(offline = false) {
    return {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      LANG: process.env.LANG,
      PYTHONNOUSERSITE: '1',
      HF_HUB_DISABLE_TELEMETRY: '1',
      UV_PROJECT_ENVIRONMENT: path.join(this.home, 'venv'),
      ...(offline ? { HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' } : {}),
    };
  }
  async run(command, args) {
    const child = spawn(command, args, { env: this.env(), stdio: 'ignore' });
    this.child = child;
    try {
      const [code] = await once(child, 'exit');
      if (this.stopping || code !== 0) throw new Error('Setup failed.');
    } finally {
      if (this.child === child) this.child = null;
    }
  }
  async setup() {
    fs.mkdirSync(this.home, { recursive: true, mode: 0o700 });
    fs.rmSync(path.join(this.home, 'ready'), { force: true });
    await this.run('uv', [
      'sync',
      '--frozen',
      '--no-dev',
      '--project',
      this.component,
      '--python',
      '3.12',
    ]);
    await this.run(this.python(), [
      path.join(this.component, 'worker.py'),
      'setup',
      this.home,
    ]);
    this.state = 'starting';
    await this.start();
    fs.writeFileSync(path.join(this.home, 'ready'), '', { mode: 0o600 });
  }
  async start() {
    this.state = 'starting';
    const child = spawn(
      this.python(),
      [path.join(this.component, 'worker.py'), 'serve', this.home],
      {
        env: this.env(true),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    this.child = child;
    child.stderr.resume();
    let buffer = '';
    let ready = false;
    let ended = false;
    await new Promise((resolve, reject) => {
      // Engineering choice, 2026-09-29: bound cold loading; decisions use the routing timeout.
      const timer = setTimeout(() => {
        failed();
        child.kill('SIGKILL');
      }, 120_000);
      const failed = () => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        if (this.child === child) {
          this.child = null;
          if (this.state !== 'stopped') {
            this.state = 'error';
            this.error = 'Laya stopped unexpectedly. Start it again in Labs.';
          }
        }
        this.pending?.reject(new Error('Local process unavailable.'));
        this.pending = null;
        if (!ready) reject(new Error('Startup failed.'));
      };
      child.on('error', failed);
      child.on('exit', failed);
      child.stdin.on('error', failed);
      child.stdout.on('data', (chunk) => {
        if (ended || this.stopping) return;
        buffer += chunk.toString();
        if (buffer.length > 100000) {
          failed();
          child.kill('SIGKILL');
          return;
        }
        while (buffer.includes('\n')) {
          const end = buffer.indexOf('\n');
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          try {
            const message = JSON.parse(line);
            if (!ready && message.ready === true) {
              ready = true;
              clearTimeout(timer);
              this.state = 'running';
              resolve();
            } else if (ready && this.pending) {
              const pending = this.pending;
              this.pending = null;
              if (message.error || !message.result)
                pending.reject(new Error('Local decision failed.'));
              else pending.resolve(message.result);
            } else {
              throw new Error('Unexpected response.');
            }
          } catch {
            failed();
            child.kill('SIGKILL');
          }
        }
      });
    });
  }
  async predict({ text, questions, signal }) {
    signal.throwIfAborted();
    if (this.state !== 'running' || !this.child || this.pending)
      throw new Error('Local classifier unavailable or busy.');
    const child = this.child;
    const payload = `${JSON.stringify({ text, questions })}\n`;
    if (Buffer.byteLength(payload) > 65536)
      throw new Error('Request too large.');
    return new Promise((resolve, reject) => {
      const cleanup = () => signal.removeEventListener('abort', abort);
      const abort = () => {
        cleanup();
        this.pending = null;
        reject(new Error('Cancelled.'));
        void this.stop();
      };
      this.pending = {
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
      signal.addEventListener('abort', abort, { once: true });
      child.stdin.write(payload);
    });
  }
  async stop() {
    this.stopping = true;
    this.state = 'stopped';
    const child = this.child;
    this.pending?.reject(new Error('Local classifier stopped.'));
    this.pending = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit').catch(() => {});
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
      if (this.child === child) this.child = null;
    }
  }
}
