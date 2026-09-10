/**
 * Per-turn file relay: sandbox requests reach only the host-selected MLX model.
 * Unlike a network proxy, workers cannot choose a URL, credentials or headers.
 * Fixed files live directly in the existing IPC mount; symlinks are rejected.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertMlxEndpoint } from './mlx-endpoint.js';

export function startMlxRelay(options: {
  ipcPath: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  task: string;
}) {
  assertMlxEndpoint(options.baseUrl);
  const id = randomBytes(16).toString('hex');
  const prefix = `mlx-${id}`;
  const requestPath = path.join(options.ipcPath, `${prefix}.request`);
  const abort = new AbortController();
  const outputs = new Set<string>();
  const consumed = new Set<string>();
  let busy = false;
  let stopped = false;
  const poll = async () => {
    if (busy || stopped) return;
    busy = true;
    let output: number | undefined;
    let request: number | undefined;
    try {
      request = fs.openSync(
        requestPath,
        fs.constants.O_RDONLY |
          fs.constants.O_NOFOLLOW |
          fs.constants.O_NONBLOCK,
      );
      const stat = fs.fstatSync(request);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2 * 1024 ** 2)
        throw new Error('Invalid relay request');
      const payload = JSON.parse(fs.readFileSync(request, 'utf8')) as {
        id?: unknown;
        body?: { model?: unknown };
      };
      fs.closeSync(request);
      request = undefined;
      fs.unlinkSync(requestPath);
      if (
        typeof payload.id !== 'string' ||
        !/^[a-f0-9]{32}$/.test(payload.id) ||
        consumed.has(payload.id)
      )
        throw new Error('Invalid relay envelope');
      if (consumed.size >= 128) throw new Error('Relay turn budget exhausted');
      consumed.add(payload.id);
      const outputPath = path.join(
        options.ipcPath,
        `${prefix}-${payload.id}.response`,
      );
      output = fs.openSync(
        outputPath,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW,
        0o600,
      );
      outputs.add(outputPath);
      const write = (event: unknown) =>
        fs.writeSync(output as number, `${JSON.stringify(event)}\n`);
      if (!payload.body || payload.body.model !== options.model) {
        write({ status: 403, contentType: 'application/json' });
        write({
          data: Buffer.from(
            '{"error":"Model is not authorized for this relay"}',
          ).toString('base64'),
        });
        write({ end: true });
        return;
      }
      const cancelPath = path.join(
        options.ipcPath,
        `${prefix}-${payload.id}.cancel`,
      );
      outputs.add(cancelPath);
      const cancelled = new AbortController();
      const cancellationPoll = setInterval(() => {
        if (fs.existsSync(cancelPath)) cancelled.abort();
      }, 25);
      try {
        const response = await fetch(`${options.baseUrl}/chat/completions`, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.any([
            abort.signal,
            cancelled.signal,
            AbortSignal.timeout(180_000),
          ]),
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${options.apiKey}`,
            'X-HybridClaw-Task': options.task,
          },
          body: JSON.stringify(payload.body),
        });
        write({
          status: response.status,
          contentType:
            response.headers.get('content-type') || 'application/json',
        });
        let bytes = 0;
        if (response.body)
          for await (const chunk of response.body) {
            bytes += chunk.byteLength;
            if (bytes > 8 * 1024 ** 2)
              throw new Error('Relay output budget exceeded');
            write({ data: Buffer.from(chunk).toString('base64') });
          }
        write({ end: true });
      } catch {
        if (!stopped)
          write({ error: 'Local inference interrupted or unavailable' });
      } finally {
        clearInterval(cancellationPoll);
      }
    } catch {
      /* Untrusted IPC must not cause URL fetches or expose host details. */
    } finally {
      if (request !== undefined) fs.closeSync(request);
      if (output !== undefined) fs.closeSync(output);
      busy = false;
    }
  };
  const timer = setInterval(() => {
    void poll();
  }, 25);
  timer.unref();
  return {
    id,
    stop() {
      stopped = true;
      clearInterval(timer);
      abort.abort();
      for (const file of [requestPath, ...outputs]) {
        try {
          fs.unlinkSync(file);
        } catch {
          /* Already consumed. */
        }
      }
    },
  };
}
