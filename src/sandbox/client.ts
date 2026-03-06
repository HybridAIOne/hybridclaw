import type { StreamChunk } from './types.js';

async function assertOk(res: Response, context: string): Promise<void> {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`sandbox-service ${context} → ${res.status}: ${body}`);
  }
}

export class SandboxClient {
  private baseUrl: string;
  private token: string;

  constructor(baseUrl?: string, token?: string) {
    this.baseUrl = (baseUrl || process.env.HYBRIDCLAW_SANDBOX_URL || '').replace(/\/+$/, '');
    if (!this.baseUrl) {
      throw new Error('HYBRIDCLAW_SANDBOX_URL is not configured');
    }
    this.token = token ?? process.env.HYBRIDCLAW_SANDBOX_TOKEN ?? '';
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return headers;
  }

  // -- Sandbox CRUD --

  async createSandbox(opts?: { volumeId?: string }): Promise<{ sandboxId: string }> {
    const body: Record<string, unknown> = {};
    if (opts?.volumeId) body.volume_id = opts.volumeId;
    const res = await fetch(`${this.baseUrl}/v1/sandboxes`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify(body),
    });
    await assertOk(res, 'POST /v1/sandboxes');
    const data = (await res.json()) as { sandbox_id: string };
    return { sandboxId: data.sandbox_id };
  }

  async deleteSandbox(sandboxId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/v1/sandboxes/${sandboxId}`, {
      method: 'DELETE',
      headers: this.authHeaders(),
    });
    await assertOk(res, `DELETE /v1/sandboxes/${sandboxId}`);
  }

  // -- Process execution --

  /**
   * Run a command synchronously. The `code` string is passed to `bash -c` by sandboxd.
   * For non-bash languages, set `language` (e.g. `"python"`).
   */
  async runProcess(
    sandboxId: string,
    opts: { code: string; language?: string; timeoutMs?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const timeoutSecs = opts.timeoutMs ? Math.ceil(opts.timeoutMs / 1000) : undefined;
    const res = await fetch(`${this.baseUrl}/v1/sandboxes/${sandboxId}/process`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify({
        code: opts.code,
        language: opts.language ?? 'bash',
        timeout_secs: timeoutSecs,
      }),
    });
    await assertOk(res, `POST /v1/sandboxes/${sandboxId}/process`);
    const data = (await res.json()) as { stdout: string; stderr: string; exit_code: number };
    return { stdout: data.stdout, stderr: data.stderr, exitCode: data.exit_code };
  }

  /**
   * Stream command execution via SSE. The `code` string is passed to `bash -c` by sandboxd.
   */
  async runProcessStream(
    sandboxId: string,
    code: string,
    onChunk: (c: StreamChunk) => void,
    signal?: AbortSignal,
  ): Promise<{ exitCode: number }> {
    const res = await fetch(`${this.baseUrl}/v1/sandboxes/${sandboxId}/process/stream`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify({ code, language: 'bash' }),
      signal,
    });
    await assertOk(res, `POST /v1/sandboxes/${sandboxId}/process/stream`);
    return this.consumeSSE(res, onChunk);
  }

  // -- Filesystem --

  async readFile(sandboxId: string, filePath: string): Promise<string> {
    const encoded = encodeURIComponent(filePath).replace(/%2F/g, '/');
    const res = await fetch(`${this.baseUrl}/v1/sandboxes/${sandboxId}/filesystem/${encoded}`, {
      method: 'GET',
      headers: this.authHeaders(),
    });
    await assertOk(res, `GET /v1/sandboxes/${sandboxId}/filesystem/${filePath}`);
    const data = (await res.json()) as { content: string };
    return data.content;
  }

  async writeFile(sandboxId: string, filePath: string, content: string): Promise<void> {
    const encoded = encodeURIComponent(filePath).replace(/%2F/g, '/');
    const res = await fetch(`${this.baseUrl}/v1/sandboxes/${sandboxId}/filesystem/${encoded}`, {
      method: 'PUT',
      headers: this.authHeaders(),
      body: JSON.stringify({ content }),
    });
    await assertOk(res, `PUT /v1/sandboxes/${sandboxId}/filesystem/${filePath}`);
  }

  async deleteFile(sandboxId: string, filePath: string): Promise<void> {
    const encoded = encodeURIComponent(filePath).replace(/%2F/g, '/');
    const res = await fetch(`${this.baseUrl}/v1/sandboxes/${sandboxId}/filesystem/${encoded}`, {
      method: 'DELETE',
      headers: this.authHeaders(),
    });
    await assertOk(res, `DELETE /v1/sandboxes/${sandboxId}/filesystem/${filePath}`);
  }

  async listDir(sandboxId: string, dirPath: string): Promise<string[]> {
    const params = new URLSearchParams({ path: dirPath });
    const res = await fetch(
      `${this.baseUrl}/v1/sandboxes/${sandboxId}/filesystem?${params.toString()}`,
      { method: 'GET', headers: this.authHeaders() },
    );
    await assertOk(res, `GET /v1/sandboxes/${sandboxId}/filesystem?path=${dirPath}`);
    const data = (await res.json()) as { entries: { name: string }[] };
    return data.entries.map((e) => e.name);
  }

  // -- Volumes --

  async createVolume(name: string): Promise<{ volumeId: string }> {
    const res = await fetch(`${this.baseUrl}/v1/volumes`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify({ volume_id: name }),
    });
    await assertOk(res, 'POST /v1/volumes');
    const data = (await res.json()) as { volume_id: string };
    return { volumeId: data.volume_id };
  }

  async getOrCreateVolume(name: string): Promise<{ volumeId: string }> {
    const getRes = await fetch(`${this.baseUrl}/v1/volumes/${name}`, {
      method: 'GET',
      headers: this.authHeaders(),
    });
    if (getRes.ok) {
      const data = (await getRes.json()) as { volume_id: string };
      return { volumeId: data.volume_id };
    }
    if (getRes.status === 404) {
      return this.createVolume(name);
    }
    const body = await getRes.text().catch(() => '');
    throw new Error(`sandbox-service GET /v1/volumes/${name} → ${getRes.status}: ${body}`);
  }

  // -- SSE parsing helper --

  private async consumeSSE(
    res: Response,
    onChunk: (c: StreamChunk) => void,
  ): Promise<{ exitCode: number }> {
    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body for SSE stream');

    const decoder = new TextDecoder();
    let buffer = '';
    let exitCode = -1;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;

          // SSE data: prefix
          const payload = trimmed.startsWith('data:')
            ? trimmed.slice(5).trim()
            : null;
          if (!payload) continue;

          let event: { type?: string; text?: string; exit_code?: number };
          try {
            event = JSON.parse(payload);
          } catch {
            continue;
          }

          if (event.type === 'stdout' || event.type === 'stderr') {
            onChunk({ type: event.type, text: event.text });
          } else if (event.type === 'exit') {
            exitCode = event.exit_code ?? -1;
            onChunk({ type: 'exit', exitCode });
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return { exitCode };
  }
}
