import http from 'node:http';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type {
  HybridClawPluginApi,
  PluginInboundWebhookDefinition,
} from '../src/plugins/plugin-sdk.js';
import { useTempDir } from './test-utils.js';

vi.mock('@hybridaione/hybridclaw/plugin-sdk', () =>
  import('../src/plugins/plugin-sdk.ts'),
);

const TOKEN = 'test-token-0123456789';
const VERSION = '2026-07-28';
const makeTempDir = useTempDir('hybridclaw-published-tools-');

const SALES_TOOL = {
  name: 'ask_sales_pipeline',
  title: 'Sales pipeline',
  description: 'Use for questions about Salesforce pipeline and forecast.',
  instructions: 'internal-instructions-marker: use the salesforce skill.',
  agentId: 'sales',
  allowedTools: ['bash', 'read'],
};
const OPEN_TOOL = {
  name: 'ask_anything',
  description: 'General HybridClaw agent.',
  instructions: '',
  allowedTools: ['*'],
};

let server: http.Server | null = null;

afterEach(async () => {
  const listening = server;
  server = null;
  if (listening) await new Promise((resolve) => listening.close(resolve));
});

async function startPlugin(
  options: {
    pluginConfig?: Record<string, unknown>;
    dispatch?: (request: Record<string, unknown>) => Promise<unknown>;
    homeDir?: string;
  } = {},
) {
  const homeDir = options.homeDir ?? makeTempDir();
  const webhooks: PluginInboundWebhookDefinition[] = [];
  const dispatch = vi.fn(
    options.dispatch ??
      (async () => ({ status: 'success', result: 'Pipeline is 4.2M.' })),
  );
  const api = {
    config: {
      agents: { defaultAgentId: 'main', list: [{ id: 'main' }, { id: 'sales' }] },
    },
    pluginConfig: {
      instructions: '',
      syncWaitSeconds: 5,
      allowedOrigins: [],
      tools: [SALES_TOOL, OPEN_TOOL],
      ...options.pluginConfig,
    },
    runtime: { homeDir },
    getCredential: (key: string) =>
      key === 'PUBLISHED_TOOLS_TOKEN' ? TOKEN : undefined,
    registerInboundWebhook: (webhook: PluginInboundWebhookDefinition) =>
      webhooks.push(webhook),
    dispatchInboundMessage: dispatch,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as HybridClawPluginApi;
  const plugin = (await import('../plugins/published-tools/src/index.js'))
    .default;
  plugin.register(api);
  const webhook = webhooks[0];
  server = http.createServer((req, res) => {
    void webhook.handler({
      req,
      res,
      url: new URL(req.url || '/', 'http://localhost'),
      pluginId: 'published-tools',
      webhookName: 'mcp',
      method: 'POST',
      path: '/api/plugin-webhooks/published-tools/mcp',
      logger: api.logger,
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return {
    webhook,
    dispatch,
    homeDir,
    url: `http://127.0.0.1:${address.port}/mcp`,
  };
}

function rpcBody(method: string, params: Record<string, unknown> = {}) {
  return {
    jsonrpc: '2.0',
    id: 1,
    method,
    params: {
      ...params,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': VERSION,
        'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  };
}

async function post(
  url: string,
  body: unknown,
  headers: Record<string, string | undefined> = {},
) {
  const message = body as { method?: string; params?: { name?: string } };
  const defaults: Record<string, string | undefined> = {
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': VERSION,
    'mcp-method': message.method,
    'mcp-name': message.params?.name,
  };
  const merged = Object.fromEntries(
    Object.entries({ ...defaults, ...headers }).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const response = await fetch(url, {
    method: 'POST',
    headers: merged,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    json: text ? JSON.parse(text) : null,
  };
}

async function callTool(url: string, name: string, args: unknown) {
  return post(url, rpcBody('tools/call', { name, arguments: args }));
}

test.each([
  ['a reused name', { tools: [SALES_TOOL, SALES_TOOL] }, /reserved or reused/],
  [
    'the reserved get_result name',
    { tools: [{ ...OPEN_TOOL, name: 'hybridclaw_get_result' }] },
    /reserved or reused/,
  ],
  [
    'an unknown agent',
    { tools: [{ ...SALES_TOOL, agentId: 'ghost' }] },
    /unknown agent "ghost"/,
  ],
  [
    '"*" mixed with tool names',
    { tools: [{ ...SALES_TOOL, allowedTools: ['*', 'bash'] }] },
    /cannot be combined/,
  ],
])('config with %s fails plugin load', async (_label, pluginConfig, error) => {
  await expect(startPlugin({ pluginConfig })).rejects.toThrow(error);
});

test.each([
  ['a missing token', { authorization: undefined }, 401],
  ['a wrong token', { authorization: 'Bearer nope' }, 401],
  [
    'a wrong X-Api-Key',
    { authorization: undefined, 'x-api-key': 'nope' },
    401,
  ],
  ['a foreign browser origin', { origin: 'https://evil.example.com' }, 403],
])('%s is rejected before the body is read', async (_label, headers, status) => {
  const { url, dispatch } = await startPlugin();
  const response = await post(
    url,
    rpcBody('tools/call', { name: 'ask_anything', arguments: { question: 'x' } }),
    headers,
  );
  expect(response.status).toBe(status);
  expect(dispatch).not.toHaveBeenCalled();
  if (status === 401) {
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
  }
});

test('the token is also accepted as X-Api-Key for hosts that reserve Authorization', async () => {
  const { url, dispatch } = await startPlugin();
  const response = await post(
    url,
    rpcBody('tools/call', { name: 'ask_anything', arguments: { question: 'x' } }),
    { authorization: undefined, 'x-api-key': TOKEN },
  );
  expect(response.status).toBe(200);
  expect(response.json.result.structuredContent.status).toBe('completed');
  expect(dispatch).toHaveBeenCalledTimes(1);
});

test.each([
  [
    'no MCP-Protocol-Version header',
    rpcBody('tools/list'),
    { 'mcp-protocol-version': undefined },
    400,
    -32020,
  ],
  [
    'an Mcp-Method that differs from the body',
    rpcBody('tools/list'),
    { 'mcp-method': 'server/discover' },
    400,
    -32020,
  ],
  [
    'an Mcp-Name that differs from the body',
    rpcBody('tools/call', { name: 'ask_anything', arguments: {} }),
    { 'mcp-name': 'ask_sales_pipeline' },
    400,
    -32020,
  ],
  [
    'a header version that differs from _meta',
    rpcBody('tools/list'),
    { 'mcp-protocol-version': '2025-11-25' },
    400,
    -32020,
  ],
  [
    'missing client capabilities',
    { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': VERSION } } },
    {},
    400,
    -32602,
  ],
  ['an unknown method', rpcBody('prompts/list'), {}, 404, -32601],
  ['malformed JSON', '{"jsonrpc":', { 'mcp-method': 'tools/list' }, 400, -32700],
])(
  'a request with %s gets the spec error',
  async (_label, body, headers, status, code) => {
    const { url } = await startPlugin();
    const response = await post(url, body, headers);
    expect(response.status).toBe(status);
    expect(response.json.error.code).toBe(code);
  },
);

test('an unsupported version names the supported ones', async () => {
  const { url } = await startPlugin();
  const body = rpcBody('tools/list');
  body.params._meta['io.modelcontextprotocol/protocolVersion'] = '1900-01-01';
  const response = await post(url, body, {
    'mcp-protocol-version': '1900-01-01',
  });
  expect(response.status).toBe(400);
  expect(response.json.error).toMatchObject({
    code: -32022,
    data: { requested: '1900-01-01' },
  });
  expect(response.json.error.data.supported).toEqual(
    expect.arrayContaining([VERSION, '2025-11-25']),
  );
});

// Legacy clients (initialize handshake, no 2026-07-28 headers or _meta).
const LEGACY_HEADERS = {
  'mcp-protocol-version': undefined,
  'mcp-method': undefined,
  'mcp-name': undefined,
};

function legacyBody(method: string, params?: Record<string, unknown>) {
  return { jsonrpc: '2.0', id: 7, method, ...(params ? { params } : {}) };
}

test.each([
  ['a version this server knows', '2025-06-18', '2025-06-18'],
  ['an unknown version', '2024-11-05', '2025-11-25'],
])('a legacy initialize with %s negotiates a legacy version', async (_label, requested, negotiated) => {
  const { url } = await startPlugin({
    pluginConfig: { instructions: 'Company data tools.' },
  });
  const response = await post(
    url,
    legacyBody('initialize', {
      protocolVersion: requested,
      capabilities: {},
      clientInfo: { name: 'legacy', version: '1' },
    }),
    LEGACY_HEADERS,
  );
  expect(response.status).toBe(200);
  expect(response.json.result).toEqual({
    protocolVersion: negotiated,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'hybridclaw-published-tools', version: '0.1.0' },
    instructions: 'Company data tools.',
  });
});

test('a legacy client lists and calls tools without a handshake or session', async () => {
  const { url, dispatch } = await startPlugin();
  const list = await post(url, legacyBody('tools/list'), {
    ...LEGACY_HEADERS,
    'mcp-protocol-version': '2025-06-18',
  });
  expect(list.status).toBe(200);
  expect(
    (list.json.result.tools as Array<{ name: string }>).map((tool) => tool.name),
  ).toContain('ask_sales_pipeline');

  const call = await post(
    url,
    legacyBody('tools/call', {
      name: 'ask_sales_pipeline',
      arguments: { question: 'How is Q3 pipeline?' },
    }),
    LEGACY_HEADERS,
  );
  expect(call.status).toBe(200);
  expect(call.json.result.structuredContent).toMatchObject({
    status: 'completed',
    answer: 'Pipeline is 4.2M.',
  });
  expect(dispatch).toHaveBeenCalledWith(
    expect.objectContaining({
      allowedTools: ['bash', 'read'],
      instructions: SALES_TOOL.instructions,
    }),
  );
});

test.each([
  ['ping', legacyBody('ping'), (json: { result?: unknown }) => json.result, {}],
  [
    'an unknown method',
    legacyBody('resources/list'),
    (json: { error?: { code: number } }) => json.error?.code,
    -32601,
  ],
  [
    'an unknown tool',
    legacyBody('tools/call', { name: 'ask_ghost', arguments: {} }),
    (json: { error?: { code: number } }) => json.error?.code,
    -32602,
  ],
])('a legacy %s is answered with HTTP 200', async (_label, body, pick, expected) => {
  const { url } = await startPlugin();
  const response = await post(url, body, LEGACY_HEADERS);
  expect(response.status).toBe(200);
  expect(pick(response.json)).toEqual(expected);
});

test('a legacy request still needs the token', async () => {
  const { url, dispatch } = await startPlugin();
  const response = await post(url, legacyBody('tools/list'), {
    ...LEGACY_HEADERS,
    authorization: undefined,
  });
  expect(response.status).toBe(401);
  expect(dispatch).not.toHaveBeenCalled();
});

test('a notification is accepted without a body', async () => {
  const { url } = await startPlugin();
  const response = await post(url, { jsonrpc: '2.0', method: 'x/ping' });
  expect(response.status).toBe(202);
  expect(response.json).toBeNull();
});

test('a base64-encoded Mcp-Name is decoded before comparison', async () => {
  const { url } = await startPlugin();
  const encoded = `=?base64?${Buffer.from('ask_anything').toString('base64')}?=`;
  const response = await post(
    url,
    rpcBody('tools/call', {
      name: 'ask_anything',
      arguments: { question: 'hi' },
    }),
    { 'mcp-name': encoded },
  );
  expect(response.status).toBe(200);
  expect(response.json.result.structuredContent.status).toBe('completed');
});

test('server/discover advertises the version, tools and server identity', async () => {
  const { url } = await startPlugin({
    pluginConfig: { instructions: 'Company data tools.' },
  });
  const response = await post(url, rpcBody('server/discover'));
  expect(response.json.result).toMatchObject({
    resultType: 'complete',
    supportedVersions: [VERSION, '2025-11-25', '2025-06-18', '2025-03-26'],
    capabilities: { tools: { listChanged: false } },
    instructions: 'Company data tools.',
    cacheScope: 'private',
    _meta: {
      'io.modelcontextprotocol/serverInfo': {
        name: 'hybridclaw-published-tools',
      },
    },
  });
  expect(response.json.result.ttlMs).toBeGreaterThan(0);
});

test('tools/list exposes descriptions but never the instructions', async () => {
  const { url } = await startPlugin();
  const response = await post(url, rpcBody('tools/list'));
  const tools = response.json.result.tools as Array<{
    name: string;
    description: string;
    inputSchema: { required: string[] };
  }>;
  expect(tools.map((tool) => tool.name)).toEqual([
    'ask_sales_pipeline',
    'ask_anything',
    'hybridclaw_get_result',
  ]);
  expect(tools[0].description).toBe(SALES_TOOL.description);
  expect(tools[0].inputSchema.required).toEqual(['question']);
  expect(JSON.stringify(response.json)).not.toContain(
    'internal-instructions-marker',
  );
});

test('a call runs one scoped turn and a follow-up continues its session', async () => {
  const { url, dispatch } = await startPlugin();
  const first = await callTool(url, 'ask_sales_pipeline', {
    question: 'How is Q3 pipeline?',
  });
  expect(first.json.result.resultType).toBe('complete');
  const structured = first.json.result.structuredContent;
  expect(structured).toMatchObject({
    status: 'completed',
    answer: 'Pipeline is 4.2M.',
  });
  expect(first.json.result.isError).toBeUndefined();
  expect(dispatch).toHaveBeenCalledWith(
    expect.objectContaining({
      content: 'How is Q3 pipeline?',
      agentId: 'sales',
      channelId: 'mcp',
      allowedTools: ['bash', 'read'],
      instructions: SALES_TOOL.instructions,
    }),
  );

  await callTool(url, 'ask_sales_pipeline', {
    question: 'And for EMEA?',
    conversation_id: structured.conversation_id,
  });
  const [firstRequest, secondRequest] = dispatch.mock.calls.map(
    (call) => call[0] as { sessionId: string },
  );
  expect(secondRequest.sessionId).toBe(firstRequest.sessionId);
  expect(firstRequest.sessionId).toContain(structured.conversation_id);
});

test('a "*" allowlist leaves the agent tool policy unchanged', async () => {
  const { url, dispatch } = await startPlugin();
  await callTool(url, 'ask_anything', { question: 'hi' });
  const request = dispatch.mock.calls[0]?.[0] as Record<string, unknown>;
  expect(request).not.toHaveProperty('allowedTools');
  expect(request).not.toHaveProperty('instructions');
  expect(request.agentId).toBe('main');
});

test.each([
  ['an empty question', { question: ' ' }],
  ['an unknown conversation', { question: 'hi', conversation_id: 'c_nope' }],
])('%s is a tool error the model can correct', async (_label, args) => {
  const { url, dispatch } = await startPlugin();
  const response = await callTool(url, 'ask_anything', args);
  expect(response.status).toBe(200);
  expect(response.json.result.isError).toBe(true);
  expect(dispatch).not.toHaveBeenCalled();
});

test('a conversation cannot move to another published tool', async () => {
  const { url, dispatch } = await startPlugin();
  const first = await callTool(url, 'ask_anything', { question: 'hi' });
  const response = await callTool(url, 'ask_sales_pipeline', {
    question: 'hi',
    conversation_id: first.json.result.structuredContent.conversation_id,
  });
  expect(response.json.result.isError).toBe(true);
  expect(dispatch).toHaveBeenCalledTimes(1);
});

test('an unknown tool is an invalid-params error', async () => {
  const { url } = await startPlugin();
  const response = await callTool(url, 'ask_ghost', { question: 'hi' });
  expect(response.status).toBe(400);
  expect(response.json.error.code).toBe(-32602);
});

test('a slow turn returns a run_id, blocks its conversation, and get_result finishes it', async () => {
  let finish!: (value: unknown) => void;
  const { url, dispatch } = await startPlugin({
    pluginConfig: { syncWaitSeconds: 0 },
    dispatch: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const first = await callTool(url, 'ask_anything', { question: 'slow' });
  const running = first.json.result.structuredContent;
  expect(running).toMatchObject({ status: 'running' });
  expect(running.run_id).toMatch(/^r_/);

  const blocked = await callTool(url, 'ask_anything', {
    question: 'again',
    conversation_id: running.conversation_id,
  });
  expect(blocked.json.result.isError).toBe(true);
  expect(dispatch).toHaveBeenCalledTimes(1);

  finish({ status: 'success', result: 'done slowly' });
  await vi.waitFor(async () => {
    const result = await callTool(url, 'hybridclaw_get_result', {
      run_id: running.run_id,
    });
    expect(result.json.result.structuredContent).toMatchObject({
      status: 'completed',
      answer: 'done slowly',
    });
  });
});

test('a turn that stops at an approval retires its conversation, across restarts', async () => {
  const pendingApproval = {
    approvalId: 'a1',
    prompt: 'Reply yes to approve',
    intent: 'send an email',
    reason: 'external side effect',
  };
  const { url, dispatch, homeDir } = await startPlugin({
    dispatch: async () => ({
      status: 'success',
      result: 'Reply yes to approve',
      pendingApproval,
    }),
  });
  const first = await callTool(url, 'ask_anything', { question: 'email Bob' });
  expect(first.json.result.isError).toBe(true);
  expect(first.json.result.structuredContent).toEqual({
    status: 'approval_required',
  });
  expect(first.json.result.content[0].text).toContain('send an email');

  const sessionConversation = decodeURIComponent(
    String((dispatch.mock.calls[0]?.[0] as { sessionId: string }).sessionId),
  )
    .split('.')
    .pop();
  const { ConversationStore } = await import(
    '../plugins/published-tools/src/conversation-store.js'
  );
  const reloaded = new ConversationStore(
    path.join(homeDir, 'data', 'plugins', 'published-tools', 'conversations.json'),
  );
  expect(reloaded.get(String(sessionConversation))?.retiredAt).toEqual(
    expect.any(Number),
  );

  const yes = await callTool(url, 'ask_anything', {
    question: 'yes',
    conversation_id: sessionConversation,
  });
  expect(yes.json.result.isError).toBe(true);
  expect(dispatch).toHaveBeenCalledTimes(1);
});
