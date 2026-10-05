import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { BROWSER_SIGN_IN_LOOKUP_PATH } from '../src/gateway/gateway-browser-sign-ins.js';
import {
  ADMIN_RBAC_ACTIONS,
  isAdminActionAllowed,
  resolveAdminRbacAction,
  resolveOpenAICompatibleAccess,
} from '../src/security/admin-rbac.js';
import {
  AGENT_RUNTIME_TOKEN_CLAIMS,
  deriveAgentRuntimeToken,
} from '../src/security/agent-runtime-token.js';
import { cleanupGatewayRuntime } from './helpers/gateway-test-setup.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempHome = useTempDir('hybridclaw-agent-runtime-token-');
useCleanMocks({
  cleanup: cleanupGatewayRuntime,
  resetModules: true,
  restoreAllMocks: true,
  unmock: [
    'node:http',
    '../src/gateway/admin-terminal.js',
    '../src/providers/auxiliary.js',
  ],
  unstubAllEnvs: true,
});

const GATEWAY_TOKEN = 'gateway-test-token';
const WEB_TOKEN = 'web-test-token';

// Every route an agent runtime calls back into, as the runtime calls it.
const AGENT_ROUTES = [
  '/api/browser/tool',
  '/api/delegate',
  '/api/device-data',
  '/api/discord/action',
  '/api/http/request',
  '/api/interactive-escalations',
  '/api/message/action',
  '/api/plugin/tool',
  '/api/preferences',
  '/api/runtime/shell-env',
  '/api/scheduler/task',
  '/api/secret/inject',
  '/api/todo',
  '/api/track',
  '/api/work',
  BROWSER_SIGN_IN_LOOKUP_PATH,
];

const OPERATOR_ROUTES: Array<[string, string]> = [
  ['GET', '/api/admin/secrets'],
  ['PUT', '/api/admin/secrets/EXAMPLE_KEY'],
  ['POST', '/api/admin/terminal'],
  ['POST', '/api/admin/mcp'],
  ['PUT', '/api/admin/mcp'],
  ['GET', '/api/admin/overview'],
  ['POST', '/api/admin/tokens'],
  ['GET', '/api/admin/config'],
  ['POST', '/api/admin/scheduler'],
  ['POST', '/api/admin/shutdown'],
  ['GET', '/api/status'],
  ['GET', '/api/history'],
  ['POST', '/api/chat'],
  ['POST', '/api/command'],
  ['GET', '/v1/models'],
];

describe('agent runtime RBAC claims', () => {
  test.each(AGENT_ROUTES)('maps POST %s to agent.runtime', (route) => {
    expect(resolveAdminRbacAction(route, 'POST')).toBe('agent.runtime');
    expect(resolveAdminRbacAction(route, 'GET')).not.toBe('agent.runtime');
  });

  test('claims no catalog action but agent.runtime', () => {
    for (const action of ADMIN_RBAC_ACTIONS) {
      expect(isAdminActionAllowed({ ...AGENT_RUNTIME_TOKEN_CLAIMS }, action)).toBe(
        action === 'agent.runtime',
      );
    }
  });

  test.each([
    [{ ...AGENT_RUNTIME_TOKEN_CLAIMS }, 'POST', '/v1/chat/completions', 'decision'],
    [{ ...AGENT_RUNTIME_TOKEN_CLAIMS }, 'GET', '/v1/models', 'denied'],
    [{ ...AGENT_RUNTIME_TOKEN_CLAIMS }, 'GET', '/v1/chat/completions/x', 'denied'],
    [{ actions: ['openai.api'] }, 'GET', '/v1/models', 'full'],
    [{ actions: [] }, 'POST', '/v1/chat/completions', 'denied'],
    [null, 'POST', '/v1/chat/completions', 'full'],
  ] as const)(
    'resolves OpenAI-compatible access for %j %s %s',
    (payload, method, pathname, expected) => {
      expect(resolveOpenAICompatibleAccess(payload, pathname, method)).toBe(
        expected,
      );
    },
  );
});

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

// A fresh module graph stands in for another process (a CLI command running
// an agent): it shares only the environment and the runtime home on disk.
async function resolveTokenInFreshProcess(): Promise<string> {
  vi.resetModules();
  const { resolveAgentRuntimeToken } = await import(
    '../src/security/agent-runtime-token.js'
  );
  return resolveAgentRuntimeToken();
}

async function startGateway(
  options: { operatorTokens?: boolean } = {},
): Promise<{
  handler: Handler;
  runtimeToken: string;
  callAuxiliaryModel: ReturnType<typeof vi.fn>;
}> {
  vi.resetModules();
  vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
  if (options.operatorTokens !== false) {
    vi.stubEnv('GATEWAY_API_TOKEN', GATEWAY_TOKEN);
    vi.stubEnv('WEB_API_TOKEN', WEB_TOKEN);
  }
  let handler: Handler | null = null;
  vi.doMock('node:http', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:http')>();
    const createServer = vi.fn((next: Handler) => {
      handler = next;
      return { on: vi.fn(), listen: vi.fn(), close: vi.fn() };
    });
    return { ...actual, default: { ...actual, createServer }, createServer };
  });
  // The terminal would start a host shell; a refused request must never get
  // that far, so the stub only has to exist.
  const startSession = vi.fn();
  vi.doMock('../src/gateway/admin-terminal.js', () => ({
    createAdminTerminalManager: vi.fn(() => ({
      startSession,
      stopSession: vi.fn(),
      handleUpgrade: vi.fn(),
      broadcastShutdown: vi.fn(),
      dispose: vi.fn(),
    })),
  }));
  const callAuxiliaryModel = vi.fn(async () => ({
    model: 'judge-model',
    provider: 'test',
    content: 'PASS',
  }));
  vi.doMock('../src/providers/auxiliary.js', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    callAuxiliaryModel,
  }));
  const { startGatewayHttpServer } = await import(
    '../src/gateway/gateway-http-server.js'
  );
  const { resolveAgentRuntimeToken } = await import(
    '../src/security/agent-runtime-token.js'
  );
  // `gateway start` persists a generated token before serving.
  const runtimeToken = resolveAgentRuntimeToken();
  startGatewayHttpServer();
  if (!handler) throw new Error('Gateway HTTP server did not initialize.');
  return { handler, runtimeToken, callAuxiliaryModel };
}

async function send(
  handler: Handler,
  params: { method: string; url: string; token?: string; body?: unknown },
): Promise<{ status: number; body: string }> {
  const req = Object.assign(
    Readable.from(
      params.body === undefined ? [] : [Buffer.from(JSON.stringify(params.body))],
    ),
    {
      method: params.method,
      url: params.url,
      headers: {
        host: '127.0.0.1:9090',
        ...(params.body === undefined
          ? {}
          : { 'content-type': 'application/json' }),
        ...(params.token ? { authorization: `Bearer ${params.token}` } : {}),
      },
      socket: { remoteAddress: '127.0.0.1' },
    },
  );
  const result = { status: 0, body: '' };
  const res = {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    setHeader: vi.fn(),
    getHeader: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
    writeHead(status: number) {
      result.status = status;
      res.headersSent = true;
      return res;
    },
    write(chunk: unknown) {
      result.body += String(chunk);
      return true;
    },
    end(chunk?: unknown) {
      if (chunk != null) result.body += String(chunk);
      res.writableEnded = true;
    },
  };
  handler(req as never, res as never);
  await vi.waitFor(() => expect(res.writableEnded).toBe(true));
  return result;
}

describe('agent runtime gateway credential', () => {
  beforeEach(() => {
    vi.stubEnv('HOME', makeTempHome());
  });

  test('is derived from the gateway token and differs from the operator tokens', async () => {
    const { runtimeToken } = await startGateway();

    expect(runtimeToken).toMatch(/^[a-f0-9]{64}$/);
    expect(runtimeToken).not.toBe(GATEWAY_TOKEN);
    expect(runtimeToken).not.toBe(WEB_TOKEN);
    expect(deriveAgentRuntimeToken('')).toBe('');
  });

  test('is accepted when another process derives it from the same gateway token', async () => {
    const { handler } = await startGateway();
    const accepted = await resolveTokenInFreshProcess();
    vi.stubEnv('GATEWAY_API_TOKEN', 'another-gateway-token');
    const rejected = await resolveTokenInFreshProcess();

    for (const [token, status] of [
      [accepted, 200],
      [rejected, 401],
    ] as const) {
      const response = await send(handler, {
        method: 'POST',
        url: '/api/runtime/shell-env',
        token,
      });
      expect(response.status).toBe(status);
    }
  });

  test.each([
    'the gateway',
    'the other process',
  ])('agrees on a generated gateway token when %s starts first', async (first) => {
    vi.stubEnv('GATEWAY_API_TOKEN', '');
    vi.stubEnv('WEB_API_TOKEN', '');
    const earlier =
      first === 'the other process' ? await resolveTokenInFreshProcess() : '';
    const { handler, runtimeToken } = await startGateway({
      operatorTokens: false,
    });
    const later = earlier || (await resolveTokenInFreshProcess());

    expect(later).toBe(runtimeToken);
    const response = await send(handler, {
      method: 'POST',
      url: '/api/runtime/shell-env',
      token: later,
    });
    expect(response.status).toBe(200);
  });

  test.each(OPERATOR_ROUTES)(
    'is refused on %s %s',
    async (method, url) => {
      const { handler, runtimeToken } = await startGateway();

      const response = await send(handler, { method, url, token: runtimeToken });

      expect(response.status).toBe(403);
    },
  );

  test('is not a query-string credential', async () => {
    const { handler, runtimeToken } = await startGateway();

    const response = await send(handler, {
      method: 'GET',
      url: `/api/artifact?path=a.txt&token=${runtimeToken}`,
    });

    expect(response.status).toBe(401);
  });

  test('reaches the agent tool routes', async () => {
    const { handler, runtimeToken } = await startGateway();

    const withToken = await send(handler, {
      method: 'POST',
      url: '/api/runtime/shell-env',
      token: runtimeToken,
    });
    const withoutToken = await send(handler, {
      method: 'POST',
      url: '/api/runtime/shell-env',
    });

    expect(withToken.status).toBe(200);
    expect(withoutToken.status).toBe(401);
  });

  test('reaches decision completions but not agent turns', async () => {
    const { handler, runtimeToken, callAuxiliaryModel } = await startGateway();
    const messages = [{ role: 'user', content: 'Is this SQL safe?' }];

    const decision = await send(handler, {
      method: 'POST',
      url: '/v1/chat/completions',
      token: runtimeToken,
      body: { model: 'auxiliary/eval_judge', messages },
    });
    const agentTurn = await send(handler, {
      method: 'POST',
      url: '/v1/chat/completions',
      token: runtimeToken,
      body: { model: 'gpt-5', messages },
    });

    expect(decision.status).toBe(200);
    expect(callAuxiliaryModel).toHaveBeenCalledTimes(1);
    expect(agentTurn.status).toBe(403);
  });

  test('leaves the gateway token an operator credential', async () => {
    const { handler } = await startGateway();

    const response = await send(handler, {
      method: 'GET',
      url: '/api/admin/secrets',
      token: GATEWAY_TOKEN,
    });

    expect(response.status).toBe(200);
  });
});
