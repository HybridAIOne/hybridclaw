import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { SandboxClient } from '../../src/sandbox/client.js';

/**
 * Spins up a local HTTP server that mocks sandbox-service endpoints.
 * Each test can register handlers for specific routes.
 */
function createMockServer() {
  type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;
  const handlers = new Map<string, Handler>();

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString('utf-8');
    const key = `${req.method} ${req.url}`;

    // Try exact match first, then prefix match
    const handler = handlers.get(key)
      || [...handlers.entries()].find(([k]) => key.startsWith(k))?.[1];

    if (handler) {
      handler(req, res, body);
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });

  return {
    server,
    handlers,
    onRoute(method: string, path: string, handler: Handler) {
      handlers.set(`${method} ${path}`, handler);
    },
    async start(): Promise<number> {
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          resolve(typeof addr === 'object' && addr ? addr.port : 0);
        });
      });
    },
    async stop(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

describe('SandboxClient', () => {
  let mock: ReturnType<typeof createMockServer>;
  let client: SandboxClient;
  let port: number;

  beforeEach(async () => {
    mock = createMockServer();
    port = await mock.start();
    client = new SandboxClient(`http://127.0.0.1:${port}`);
  });

  afterEach(async () => {
    await mock.stop();
  });

  describe('constructor', () => {
    it('throws when HYBRIDCLAW_SANDBOX_URL is not configured', () => {
      // Save and clear env
      const orig = process.env.HYBRIDCLAW_SANDBOX_URL;
      process.env.HYBRIDCLAW_SANDBOX_URL = '';
      try {
        assert.throws(() => new SandboxClient(''), /not configured/);
      } finally {
        process.env.HYBRIDCLAW_SANDBOX_URL = orig;
      }
    });

    it('accepts explicit baseUrl override', () => {
      const c = new SandboxClient('http://localhost:9999');
      assert.ok(c);
    });
  });

  describe('createSandbox', () => {
    it('sends POST /v1/sandboxes and returns sandboxId', async () => {
      mock.onRoute('POST', '/v1/sandboxes', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sandbox_id: 'sb-new' }));
      });
      const result = await client.createSandbox();
      assert.equal(result.sandboxId, 'sb-new');
    });

    it('passes volumeId when provided', async () => {
      let receivedBody = '';
      mock.onRoute('POST', '/v1/sandboxes', (_req, res, body) => {
        receivedBody = body;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sandbox_id: 'sb-vol' }));
      });
      await client.createSandbox({ volumeId: 'vol-123' });
      const parsed = JSON.parse(receivedBody);
      assert.equal(parsed.volume_id, 'vol-123');
    });

    it('throws on non-2xx response with context', async () => {
      mock.onRoute('POST', '/v1/sandboxes', (_req, res) => {
        res.writeHead(500);
        res.end('Internal server error');
      });
      await assert.rejects(
        () => client.createSandbox(),
        (err: Error) => err.message.includes('500'),
      );
    });
  });

  describe('deleteSandbox', () => {
    it('sends DELETE /v1/sandboxes/{id}', async () => {
      let deleteCalled = false;
      mock.onRoute('DELETE', '/v1/sandboxes/sb-1', (_req, res) => {
        deleteCalled = true;
        res.writeHead(200);
        res.end('{}');
      });
      await client.deleteSandbox('sb-1');
      assert.ok(deleteCalled);
    });

    it('throws on non-2xx response', async () => {
      mock.onRoute('DELETE', '/v1/sandboxes/sb-bad', (_req, res) => {
        res.writeHead(404);
        res.end('Not found');
      });
      await assert.rejects(() => client.deleteSandbox('sb-bad'));
    });
  });

  describe('runProcess', () => {
    it('sends code string with language=bash', async () => {
      let receivedBody = '';
      mock.onRoute('POST', '/v1/sandboxes/sb-1/process', (_req, res, body) => {
        receivedBody = body;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ stdout: 'out', stderr: '', exit_code: 0 }));
      });
      await client.runProcess('sb-1', { code: 'echo hello' });
      const parsed = JSON.parse(receivedBody);
      assert.equal(parsed.code, 'echo hello');
      assert.equal(parsed.language, 'bash');
    });

    it('maps exit_code to camelCase exitCode', async () => {
      mock.onRoute('POST', '/v1/sandboxes/sb-1/process', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ stdout: '', stderr: '', exit_code: 42 }));
      });
      const result = await client.runProcess('sb-1', { code: 'false' });
      assert.equal(result.exitCode, 42);
    });

    it('passes timeoutMs converted to timeout_secs', async () => {
      let receivedBody = '';
      mock.onRoute('POST', '/v1/sandboxes/sb-1/process', (_req, res, body) => {
        receivedBody = body;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ stdout: '', stderr: '', exit_code: 0 }));
      });
      await client.runProcess('sb-1', { code: 'sleep 1', timeoutMs: 5000 });
      const parsed = JSON.parse(receivedBody);
      assert.equal(parsed.timeout_secs, 5);
    });
  });

  describe('readFile', () => {
    it('returns content string from JSON response', async () => {
      mock.onRoute('GET', '/v1/sandboxes/sb-1/filesystem', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ content: 'file contents here' }));
      });
      const content = await client.readFile('sb-1', '/workspace/test.txt');
      assert.equal(content, 'file contents here');
    });
  });

  describe('writeFile', () => {
    it('sends PUT with JSON body containing content field', async () => {
      let receivedContentType = '';
      let receivedBody = '';
      mock.onRoute('PUT', '/v1/sandboxes/sb-1/filesystem', (req, res, body) => {
        receivedContentType = req.headers['content-type'] || '';
        receivedBody = body;
        res.writeHead(200);
        res.end('{}');
      });
      await client.writeFile('sb-1', '/workspace/test.txt', 'hello world');
      assert.ok(receivedContentType.includes('application/json'));
      const parsed = JSON.parse(receivedBody);
      assert.equal(parsed.content, 'hello world');
    });
  });

  describe('deleteFile', () => {
    it('sends DELETE to filesystem endpoint', async () => {
      let deleteCalled = false;
      mock.onRoute('DELETE', '/v1/sandboxes/sb-1/filesystem', (_req, res) => {
        deleteCalled = true;
        res.writeHead(200);
        res.end('{}');
      });
      await client.deleteFile('sb-1', '/workspace/test.txt');
      assert.ok(deleteCalled);
    });
  });

  describe('listDir', () => {
    it('returns array of entry names from response', async () => {
      mock.onRoute('GET', '/v1/sandboxes/sb-1/filesystem', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ entries: [{ name: 'a.txt' }, { name: 'b.md' }] }));
      });
      const entries = await client.listDir('sb-1', '/workspace');
      assert.deepEqual(entries, ['a.txt', 'b.md']);
    });
  });

  describe('runProcessStream', () => {
    it('parses SSE stdout/stderr/exit events and calls onChunk', async () => {
      const sseBody = [
        'data: {"type":"stdout","text":"hello"}\n\n',
        'data: {"type":"stderr","text":"warn"}\n\n',
        'data: {"type":"exit","exit_code":0}\n\n',
      ].join('');

      mock.onRoute('POST', '/v1/sandboxes/sb-1/process/stream', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(sseBody);
      });

      const chunks: Array<{ type: string; text?: string; exitCode?: number }> = [];
      const result = await client.runProcessStream('sb-1', 'echo hello', (c) => {
        chunks.push(c);
      });

      assert.equal(result.exitCode, 0);
      assert.equal(chunks.length, 3);
      assert.deepEqual(chunks[0], { type: 'stdout', text: 'hello' });
      assert.deepEqual(chunks[1], { type: 'stderr', text: 'warn' });
      assert.deepEqual(chunks[2], { type: 'exit', exitCode: 0 });
    });

    it('sends code and language=bash in request body', async () => {
      let receivedBody = '';
      mock.onRoute('POST', '/v1/sandboxes/sb-1/process/stream', (_req, res, body) => {
        receivedBody = body;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: {"type":"exit","exit_code":0}\n\n');
      });

      await client.runProcessStream('sb-1', 'ls -la', () => {});
      const parsed = JSON.parse(receivedBody);
      assert.equal(parsed.code, 'ls -la');
      assert.equal(parsed.language, 'bash');
    });

    it('returns exit code -1 when no exit event received', async () => {
      mock.onRoute('POST', '/v1/sandboxes/sb-1/process/stream', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: {"type":"stdout","text":"partial"}\n\n');
      });

      const result = await client.runProcessStream('sb-1', 'echo partial', () => {});
      assert.equal(result.exitCode, -1);
    });
  });

  describe('getOrCreateVolume', () => {
    it('returns existing volume on 200', async () => {
      mock.onRoute('GET', '/v1/volumes/test-vol', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ volume_id: 'test-vol' }));
      });
      const result = await client.getOrCreateVolume('test-vol');
      assert.equal(result.volumeId, 'test-vol');
    });

    it('creates new volume on 404', async () => {
      mock.onRoute('GET', '/v1/volumes/new-vol', (_req, res) => {
        res.writeHead(404);
        res.end('Not found');
      });
      mock.onRoute('POST', '/v1/volumes', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ volume_id: 'new-vol' }));
      });
      const result = await client.getOrCreateVolume('new-vol');
      assert.equal(result.volumeId, 'new-vol');
    });

    it('throws on other error status codes', async () => {
      mock.onRoute('GET', '/v1/volumes/err-vol', (_req, res) => {
        res.writeHead(500);
        res.end('Server error');
      });
      await assert.rejects(() => client.getOrCreateVolume('err-vol'));
    });
  });
});
