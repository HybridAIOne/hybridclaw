/**
 * MLX transport preserves native loopback isolation for Docker workers.
 * Relay IDs select turn-scoped IPC files, never a host URL or credential.
 * Direct host calls use the same compatible API with isolated task caches.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function fetchMlx(
  url: string,
  init: RequestInit,
  task?: string,
  ipcRoot = '/ipc',
): Promise<Response> {
  init.signal?.throwIfAborted();
  const target = new URL(url);
  const headers = new Headers(init.headers);
  if (target.hostname !== 'mlx.invalid') {
    if (
      target.protocol !== 'http:' ||
      target.hostname !== '127.0.0.1' ||
      target.username ||
      target.password ||
      target.pathname !== '/v1/chat/completions' ||
      target.search ||
      target.hash
    )
      throw new Error('MLX must remain on host loopback.');
    headers.set('X-HybridClaw-Task', task || randomBytes(16).toString('hex'));
    return fetch(url, {
      ...init,
      headers,
      redirect: 'error',
      signal: AbortSignal.any([
        AbortSignal.timeout(180_000),
        ...(init.signal ? [init.signal] : []),
      ]),
    });
  }
  const relay = headers.get('X-HybridClaw-Relay') || '';
  if (
    !/^[a-f0-9]{32}$/.test(relay) ||
    typeof init.body !== 'string' ||
    Buffer.byteLength(init.body) > 2 * 1024 ** 2
  )
    throw new Error('Invalid local relay request.');
  const id = randomBytes(16).toString('hex');
  const prefix = path.join(ipcRoot, `mlx-${relay}`);
  const requestPath = `${prefix}.request`;
  const responsePath = `${prefix}-${id}.response`;
  const cancelPath = `${prefix}-${id}.cancel`;
  const temporary = `${prefix}-${id}.tmp`;
  fs.writeFileSync(
    temporary,
    JSON.stringify({ id, body: JSON.parse(init.body) }),
    { mode: 0o600, flag: 'wx' },
  );
  fs.renameSync(temporary, requestPath);
  let offset = 0;
  let pending = '';
  let finished = false;
  let responseStatus = 0;
  let contentType = '';
  const chunks: Uint8Array[] = [];
  const deadline = Date.now() + 180_000;
  const cancelRelay = () => {
    finished = true;
    try {
      fs.writeFileSync(cancelPath, '', { mode: 0o600, flag: 'wx' });
    } catch {
      // A concurrent turn cleanup can remove the IPC directory already.
    }
    fs.rmSync(responsePath, { force: true });
  };
  const detachAbort = () =>
    init.signal?.removeEventListener('abort', cancelRelay);
  init.signal?.addEventListener('abort', cancelRelay, { once: true });
  async function readEvents() {
    init.signal?.throwIfAborted();
    if (Date.now() > deadline)
      throw new Error('Local inference relay timed out.');
    let file: number | undefined;
    try {
      file = fs.openSync(
        responsePath,
        fs.constants.O_RDONLY |
          fs.constants.O_NOFOLLOW |
          fs.constants.O_NONBLOCK,
      );
      const stat = fs.fstatSync(file);
      if (!stat.isFile() || stat.size > 16 * 1024 ** 2)
        throw new Error('Invalid relay response.');
      const data = Buffer.alloc(Math.max(0, stat.size - offset));
      offset += fs.readSync(file, data, 0, data.length, offset);
      pending += data.toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop() || '';
      for (const line of lines) {
        const event = JSON.parse(line) as {
          status?: number;
          contentType?: string;
          data?: string;
          end?: boolean;
          error?: string;
        };
        if (event.error) throw new Error('Local inference relay failed.');
        if (event.status) {
          responseStatus = event.status;
          contentType = event.contentType || 'application/json';
        }
        if (event.data) chunks.push(Buffer.from(event.data, 'base64'));
        if (event.end) finished = true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    } finally {
      if (file !== undefined) fs.closeSync(file);
    }
  }
  try {
    while (!responseStatus) {
      await readEvents();
      if (!responseStatus) await delay(25);
    }
  } catch (error) {
    cancelRelay();
    detachAbort();
    throw error;
  }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        init.signal?.throwIfAborted();
        while (!chunks.length && !finished) {
          await readEvents();
          if (!chunks.length && !finished) await delay(25);
        }
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else {
          controller.close();
          detachAbort();
          fs.rmSync(responsePath, { force: true });
        }
      } catch (error) {
        cancelRelay();
        detachAbort();
        controller.error(error);
      }
    },
    cancel() {
      cancelRelay();
      detachAbort();
    },
  });
  return new Response(body, {
    status: responseStatus,
    headers: { 'Content-Type': contentType },
  });
}
