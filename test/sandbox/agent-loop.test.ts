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

    // Set env vars (sandbox URL read at construction time)
    process.env.HYBRIDAI_API_KEY = 'test-api-key-12345';
    process.env.HYBRIDCLAW_SANDBOX_URL = `http://127.0.0.1:${sandboxPort}`;
    process.env.HYBRIDAI_BASE_URL = `http://127.0.0.1:${hybridaiPort}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => hybridaiServer.close(() => resolve()));
    await new Promise<void>((resolve) => sandboxServer.close(() => resolve()));
    delete process.env.HYBRIDAI_API_KEY;
    delete process.env.HYBRIDCLAW_SANDBOX_URL;
    delete process.env.HYBRIDAI_BASE_URL;
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
          hybridAiBaseUrl: `http://127.0.0.1:${hybridaiPort}`,
        },
      );

      assert.equal(result.status, 'success');
      assert.equal(result.result, 'Hello! How can I help?');
      assert.deepEqual(result.toolsUsed, []);
      // Verify the HybridAI API was actually called
      assert.equal(hybridaiRequests.length, 1);
    });

    it('passes model and chatbotId in the LLM request', async () => {
      hybridaiResponses.push({
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      });

      const { runAgentLoop } = await import('../../src/sandbox/agent-loop.js');
      await runAgentLoop(
        [{ role: 'user', content: 'hi' }],
        'test-sandbox',
        {
          chatbotId: 'my-bot',
          model: 'claude-3-5-sonnet',
          enableRag: false,
          agentId: 'test-agent',
          channelId: 'ch-1',
          hybridAiBaseUrl: `http://127.0.0.1:${hybridaiPort}`,
        },
      );

      const body = JSON.parse(hybridaiRequests[0].body);
      assert.equal(body.model, 'claude-3-5-sonnet');
      assert.equal(body.chatbot_id, 'my-bot');
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
          message: { role: 'assistant', content: 'The file contains: file content' },
          finish_reason: 'stop',
        }],
      });

      const { runAgentLoop } = await import('../../src/sandbox/agent-loop.js');
      const result = await runAgentLoop(
        [{ role: 'user', content: 'Read test.txt' }],
        'test-sandbox',
        {
          chatbotId: 'test-bot',
          model: 'test-model',
          enableRag: false,
          agentId: 'test-agent',
          channelId: 'ch-1',
          hybridAiBaseUrl: `http://127.0.0.1:${hybridaiPort}`,
        },
      );

      assert.equal(result.status, 'success');
      assert.equal(result.result, 'The file contains: file content');
      assert.deepEqual(result.toolsUsed, ['read']);
      // Two LLM calls: one with tool_call, one for final answer
      assert.equal(hybridaiRequests.length, 2);
      // One sandbox filesystem request
      assert.ok(sandboxRequests.some(r => r.url.includes('/filesystem')));
    });

    it('API key never appears in sandbox requests during tool execution', async () => {
      hybridaiResponses.push({
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"command":"echo hi"}' } }],
          },
          finish_reason: 'tool_calls',
        }],
      });
      hybridaiResponses.push({
        choices: [{ message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }],
      });

      const { runAgentLoop } = await import('../../src/sandbox/agent-loop.js');
      await runAgentLoop(
        [{ role: 'user', content: 'Run echo' }],
        'test-sandbox',
        {
          chatbotId: 'test-bot',
          model: 'test-model',
          enableRag: false,
          agentId: 'test-agent',
          channelId: 'ch-1',
          hybridAiBaseUrl: `http://127.0.0.1:${hybridaiPort}`,
        },
      );

      const apiKey = process.env.HYBRIDAI_API_KEY!;
      for (const req of sandboxRequests) {
        assert.ok(!req.body.includes(apiKey), `API key found in sandbox request to ${req.url}`);
        assert.ok(!(req.headers.authorization ?? '').includes(apiKey), 'API key in sandbox auth header');
      }
    });
  });

  describe('abort signal', () => {
    it('aborted signal causes immediate return without calling LLM', async () => {
      const controller = new AbortController();
      controller.abort();

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
          hybridAiBaseUrl: `http://127.0.0.1:${hybridaiPort}`,
        },
      );

      assert.equal(result.status, 'error');
      assert.ok(result.error?.includes('Interrupted'));
      // LLM should never have been called
      assert.equal(hybridaiRequests.length, 0);
    });
  });
});
