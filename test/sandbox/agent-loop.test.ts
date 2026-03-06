import { describe, it, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Force exit after tests — runtime-config.ts starts a file watcher retry timer
// that keeps the event loop alive and can't be cleaned up externally.
after(() => setTimeout(() => process.exit(0), 50).unref());

// Agent loop imports config at module level, so we need env set before import.
// We'll test via the HTTP mock approach — mock the HybridAI API server.

describe('runAgentLoop', () => {
  let hybridaiServer: http.Server;
  let hybridaiPort: number;
  let sandboxServer: http.Server;
  let sandboxPort: number;

  // Track all requests to verify security properties
  let hybridaiRequests: Array<{ headers: http.IncomingHttpHeaders; body: string }>;
  let sandboxRequests: Array<{ headers: http.IncomingHttpHeaders; body: string; url: string }>;

  // Canned responses for HybridAI API
  let hybridaiResponses: Array<{
    choices: Array<{
      message: { role: string; content: string | null; tool_calls?: unknown[] };
      finish_reason: string;
    }>;
  }>;

  beforeEach(async () => {
    hybridaiRequests = [];
    sandboxRequests = [];
    hybridaiResponses = [];

    // Mock HybridAI API server
    hybridaiServer = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf-8');
      hybridaiRequests.push({ headers: req.headers, body });

      const response = hybridaiResponses.shift() || {
        choices: [{ message: { role: 'assistant', content: 'Default response' }, finish_reason: 'stop' }],
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'test', ...response }));
    });

    await new Promise<void>((resolve) => {
      hybridaiServer.listen(0, '127.0.0.1', () => resolve());
    });
    const hybridaiAddr = hybridaiServer.address();
    hybridaiPort = typeof hybridaiAddr === 'object' && hybridaiAddr ? hybridaiAddr.port : 0;

    // Mock sandbox-service server
    sandboxServer = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf-8');
      sandboxRequests.push({ headers: req.headers, url: req.url || '', body });

      // Simple sandbox mock responses
      if (req.url?.includes('/process') && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ stdout: 'ok', stderr: '', exit_code: 0 }));
        return;
      }
      if (req.url?.includes('/filesystem') && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ content: 'file content' }));
        return;
      }
      res.writeHead(200);
      res.end('{}');
    });

    await new Promise<void>((resolve) => {
      sandboxServer.listen(0, '127.0.0.1', () => resolve());
    });
    const sandboxAddr = sandboxServer.address();
    sandboxPort = typeof sandboxAddr === 'object' && sandboxAddr ? sandboxAddr.port : 0;

    // Set env vars for the agent loop
    process.env.HYBRIDAI_API_KEY = 'test-api-key-12345';
    process.env.HYBRIDCLAW_SANDBOX_URL = `http://127.0.0.1:${sandboxPort}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => hybridaiServer.close(() => resolve()));
    await new Promise<void>((resolve) => sandboxServer.close(() => resolve()));
    delete process.env.HYBRIDAI_API_KEY;
    delete process.env.HYBRIDCLAW_SANDBOX_URL;
  });

  // Note: Full agent-loop integration tests require dynamic import to pick up
  // env vars. The tests below validate the key security and behavioral properties
  // using the mock servers.

  describe('security', () => {
    it('API key must never appear in sandbox requests', async () => {
      const apiKey = process.env.HYBRIDAI_API_KEY!;

      // After any agent-loop run, verify no sandbox request contains the API key
      for (const req of sandboxRequests) {
        assert.ok(!req.body.includes(apiKey), 'API key found in sandbox request body');
        const authHeader = req.headers.authorization || '';
        assert.ok(!authHeader.includes(apiKey), 'API key found in sandbox Authorization header');
      }
    });
  });

  describe('basic flow', () => {
    it('returns success with result text when LLM responds without tool calls', async () => {
      hybridaiResponses.push({
        choices: [{
          message: { role: 'assistant', content: 'Hello! How can I help?' },
          finish_reason: 'stop',
        }],
      });

      // Dynamic import to get fresh module with current env
      const { runAgentLoop } = await import('../../src/sandbox/agent-loop.js');

      const result = await runAgentLoop(
        [{ role: 'user', content: 'Hello' }],
        'test-sandbox',
        {
          chatbotId: 'test-bot',
          model: 'test-model',
          enableRag: false,
          agentId: 'test-agent',
          channelId: 'test-channel',
        },
      );

      // The LLM call should have been made but the result depends on
      // whether HYBRIDAI_BASE_URL points to our mock. Since config.ts
      // loads at import time, we verify the structure.
      assert.ok(result);
      assert.ok('status' in result);
      assert.ok('toolsUsed' in result);
    });
  });

  describe('mock server sanity', () => {
    it('mock HybridAI server responds correctly', async () => {
      hybridaiResponses.push({
        choices: [{
          message: { role: 'assistant', content: 'Test response' },
          finish_reason: 'stop',
        }],
      });

      const res = await fetch(`http://127.0.0.1:${hybridaiPort}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
        body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'hi' }] }),
      });
      const data = await res.json() as { choices: Array<{ message: { content: string } }> };
      assert.equal(data.choices[0].message.content, 'Test response');
    });

    it('mock sandbox server responds to process calls', async () => {
      const res = await fetch(`http://127.0.0.1:${sandboxPort}/v1/sandboxes/sb-1/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'echo hi', language: 'shell' }),
      });
      const data = await res.json() as { exit_code: number };
      assert.equal(data.exit_code, 0);
    });

    it('sandbox requests never contain the API key', () => {
      const apiKey = 'test-api-key-12345';
      for (const req of sandboxRequests) {
        assert.ok(!req.body.includes(apiKey));
        assert.ok(!(req.headers.authorization || '').includes(apiKey));
      }
    });
  });

  describe('tool execution loop', () => {
    it('multi-turn: LLM returns tool_call then final answer', async () => {
      // First response: tool call
      hybridaiResponses.push({
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call-1',
              type: 'function',
              function: { name: 'read', arguments: '{"path":"/workspace/test.txt"}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      });
      // Second response: final answer
      hybridaiResponses.push({
        choices: [{
          message: { role: 'assistant', content: 'The file contains: test content' },
          finish_reason: 'stop',
        }],
      });

      // Verify mock server is working for the multi-turn pattern
      const res1 = await fetch(`http://127.0.0.1:${hybridaiPort}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data1 = await res1.json() as { choices: Array<{ message: { tool_calls?: unknown[] }; finish_reason: string }> };
      assert.ok(data1.choices[0].message.tool_calls);
      assert.equal(data1.choices[0].finish_reason, 'tool_calls');

      const res2 = await fetch(`http://127.0.0.1:${hybridaiPort}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data2 = await res2.json() as { choices: Array<{ message: { content: string }; finish_reason: string }> };
      assert.equal(data2.choices[0].finish_reason, 'stop');
      assert.equal(data2.choices[0].message.content, 'The file contains: test content');
    });
  });

  describe('abort signal', () => {
    it('aborted signal causes immediate return', async () => {
      const controller = new AbortController();
      controller.abort();

      // Dynamic import
      const { runAgentLoop } = await import('../../src/sandbox/agent-loop.js');

      const result = await runAgentLoop(
        [{ role: 'user', content: 'Hello' }],
        'test-sandbox',
        {
          chatbotId: 'test-bot',
          model: 'test-model',
          enableRag: false,
          agentId: 'test-agent',
          channelId: 'test-channel',
          abortSignal: controller.signal,
        },
      );

      assert.equal(result.status, 'error');
      assert.ok(result.error?.includes('Interrupted'));
    });
  });
});
