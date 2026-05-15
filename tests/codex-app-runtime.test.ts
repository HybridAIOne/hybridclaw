import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  buildCodexApprovalResponseForDirective,
  buildCodexAppServerArgs,
  buildCodexMcpContextPayloads,
  buildCodexTurnText,
  projectCodexThreadItem,
} from '../container/src/codex-app-server.js';
import {
  buildUnavailableCallbackToolResult,
  getHybridClawCallbackMcpToolNames,
  isHybridClawCallbackToolName,
} from '../container/src/codex-hybridclaw-mcp.js';
import {
  DEFAULT_RUNTIME_CONFIG,
  normalizeCodexTurnRuntime,
} from '../src/config/runtime-config.js';

describe('Codex app-server runtime helpers', () => {
  afterEach(() => {
    vi.doUnmock('node:child_process');
    vi.resetModules();
  });

  function makeProjection(): Parameters<typeof projectCodexThreadItem>[0] {
    return {
      threadId: null,
      textDeltas: [],
      agentMessages: [],
      toolExecutions: [],
      toolsUsed: new Set<string>(),
      tokenUsage: {
        modelCalls: 1,
        apiUsageAvailable: false,
        apiPromptTokens: 0,
        apiCompletionTokens: 0,
        apiTotalTokens: 0,
        apiCacheUsageAvailable: false,
        apiCacheReadTokens: 0,
        apiCacheWriteTokens: 0,
        estimatedPromptTokens: 0,
        estimatedCompletionTokens: 0,
        estimatedTotalTokens: 0,
      },
      approvalEvents: [],
      pendingApproval: null,
      error: null,
      completed: false,
    };
  }

  function createMockChild() {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      stdin: { write: ReturnType<typeof vi.fn> };
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = { write: vi.fn() };
    child.kill = vi.fn(() => {
      child.emit('exit', null, 'SIGTERM');
      return true;
    });
    return child;
  }

  function writeJsonLine(
    child: ReturnType<typeof createMockChild>,
    value: unknown,
  ) {
    child.stdout.write(`${JSON.stringify(value)}\n`);
  }

  function createCodexSpawnMock() {
    let appServerIndex = 0;
    return vi.fn((_command: string, args: string[]) => {
      const child = createMockChild();
      if (args[0] === '--version') {
        queueMicrotask(() => child.emit('exit', 0));
        return child;
      }

      const index = appServerIndex;
      appServerIndex += 1;
      const approvalRequestId = 900 + index;
      child.stdin.write = vi.fn((line: string) => {
        const message = JSON.parse(line) as {
          id?: number;
          method?: string;
          result?: unknown;
        };
        if (message.method === 'initialize') {
          writeJsonLine(child, { id: message.id, result: {} });
          return true;
        }
        if (message.method === 'thread/start') {
          writeJsonLine(child, {
            id: message.id,
            result: { thread: { id: `thread-${index}` } },
          });
          return true;
        }
        if (message.method === 'turn/start') {
          writeJsonLine(child, {
            id: message.id,
            result: { turn: { id: `turn-${index}`, status: 'in_progress' } },
          });
          setTimeout(() => {
            writeJsonLine(child, {
              id: approvalRequestId,
              method: 'item/commandExecution/requestApproval',
              params: { command: `echo ${index}` },
            });
          }, 0);
          return true;
        }
        if (message.id === approvalRequestId && message.result) {
          writeJsonLine(child, {
            method: 'item/completed',
            params: {
              item: { type: 'agentMessage', text: `approved-${index}` },
            },
          });
          writeJsonLine(child, {
            method: 'turn/completed',
            params: { turn: { status: 'completed' } },
          });
          return true;
        }
        return true;
      });
      return child;
    });
  }

  test('defaults to the existing HybridClaw runtime', () => {
    expect(DEFAULT_RUNTIME_CONFIG.codex.runtime).toBe('hybridclaw');
    expect(normalizeCodexTurnRuntime('app-server')).toBe('app-server');
    expect(normalizeCodexTurnRuntime('unknown')).toBe('hybridclaw');
  });

  test('builds a turn prompt without mutating system instructions', () => {
    expect(
      buildCodexTurnText([
        { role: 'system', content: 'system stays separate' },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'second' },
        { role: 'user', content: 'third' },
      ]),
    ).toContain('Current user request:\nthird');
  });

  test('registers the HybridClaw callback MCP server with transient context', () => {
    const args = buildCodexAppServerArgs(
      undefined,
      '/tmp/hybridclaw-context.json',
    );
    const joined = args.join('\n');

    expect(args.slice(0, 3)).toEqual(['app-server', '--listen', 'stdio://']);
    expect(joined).toContain('mcp_servers.hybridclaw.command');
    expect(joined).toContain('mcp_servers.hybridclaw.args');
    expect(joined).toContain(
      'mcp_servers.hybridclaw.env.HYBRIDCLAW_CODEX_MCP_CONTEXT_PATH',
    );
    expect(joined).toContain('/tmp/hybridclaw-context.json');
  });

  test('callback MCP exposes safe HybridClaw surfaces and clear fallback messaging', () => {
    const names = getHybridClawCallbackMcpToolNames();

    expect(names).toContain('web_fetch');
    expect(names).toContain('web_extract');
    expect(names).toContain('web_search');
    expect(names).toContain('vision_analyze');
    expect(names).toContain('image_generate');
    expect(names).toContain('audio_transcribe');
    expect(names).toContain('skill_lookup');
    expect(names).toContain('voice_status');
    expect(names).not.toContain('tts_status');
    expect(names).toContain('browser_navigate');
    expect(isHybridClawCallbackToolName('bash')).toBe(false);

    expect(buildUnavailableCallbackToolResult('bash')).toEqual({
      content: [
        {
          type: 'text',
          text: 'HybridClaw callback tool is unavailable in Codex app-server mode: bash',
        },
      ],
      isError: true,
    });
  });

  test('validates missing Codex CLI with an actionable error', async () => {
    vi.resetModules();
    const spawnSync = vi.fn().mockReturnValue({
      error: Object.assign(new Error('spawn codex ENOENT'), {
        code: 'ENOENT',
      }),
    });
    vi.doMock('node:child_process', () => ({ spawnSync }));
    const { assertCodexAppServerRuntimeAvailable } = await import(
      '../src/config/runtime-config-edit.js'
    );

    expect(() => assertCodexAppServerRuntimeAvailable()).toThrow(
      'Install the OpenAI Codex CLI',
    );
  });

  test('validates missing app-server support with an actionable upgrade error', async () => {
    vi.resetModules();
    const spawnSync = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stderr: '' })
      .mockReturnValueOnce({ status: 1, stderr: 'unknown command' });
    vi.doMock('node:child_process', () => ({ spawnSync }));
    const { assertCodexAppServerRuntimeAvailable } = await import(
      '../src/config/runtime-config-edit.js'
    );

    expect(() => assertCodexAppServerRuntimeAvailable()).toThrow(
      'Upgrade the OpenAI Codex CLI',
    );
  });

  test('validates app-server runtime case-insensitively when editing config', async () => {
    vi.resetModules();
    const spawnSync = vi.fn().mockReturnValue({ status: 0, stderr: '' });
    vi.doMock('node:child_process', () => ({ spawnSync }));
    const { setRuntimeConfigValueAtPath } = await import(
      '../src/config/runtime-config-edit.js'
    );
    const { DEFAULT_RUNTIME_CONFIG } = await import(
      '../src/config/runtime-config.js'
    );
    const config = structuredClone(DEFAULT_RUNTIME_CONFIG);

    setRuntimeConfigValueAtPath(config, 'codex.runtime', 'APP-SERVER');

    expect(spawnSync).toHaveBeenCalledWith('codex', ['--version'], {
      encoding: 'utf-8',
    });
    expect(spawnSync).toHaveBeenCalledWith('codex', ['app-server', '--help'], {
      encoding: 'utf-8',
    });
  });

  test('translates Codex approval requests into Codex app-server responses', () => {
    expect(
      buildCodexApprovalResponseForDirective(
        'item/commandExecution/requestApproval',
        'approve abc123',
      ),
    ).toEqual({ decision: 'accept' });
    expect(
      buildCodexApprovalResponseForDirective(
        'item/fileChange/requestApproval',
        'approve abc123 for session',
      ),
    ).toEqual({ decision: 'acceptForSession' });
    expect(
      buildCodexApprovalResponseForDirective('execCommandApproval', 'deny'),
    ).toEqual({ decision: 'denied' });
    expect(
      buildCodexApprovalResponseForDirective(
        'item/permissions/requestApproval',
        'approve for session',
        {
          permissions: {
            fileSystem: { writableRoots: ['/workspace'] },
          },
        },
      ),
    ).toEqual({
      permissions: {
        fileSystem: { writableRoots: ['/workspace'] },
      },
      scope: 'session',
      strictAutoReview: true,
    });
  });

  test('keeps pending app-server approvals isolated by session', async () => {
    vi.resetModules();
    const spawn = createCodexSpawnMock();
    vi.doMock('node:child_process', () => ({ spawn }));
    const { resumePendingCodexAppServerApproval, runCodexAppServerTurn } =
      await import('../container/src/codex-app-server.js');
    const baseParams = {
      messages: [{ role: 'user' as const, content: 'run a command' }],
      model: 'openai-codex/gpt-5.4',
      cwd: '/workspace',
      provider: 'openai-codex' as const,
    };

    const first = await runCodexAppServerTurn({
      ...baseParams,
      sessionId: 'session-a',
    });
    const second = await runCodexAppServerTurn({
      ...baseParams,
      sessionId: 'session-b',
    });

    expect(first.pendingApproval?.approvalId).toBeTruthy();
    expect(second.pendingApproval?.approvalId).toBeTruthy();
    expect(
      await resumePendingCodexAppServerApproval({
        sessionId: 'session-c',
        messages: [{ role: 'user', content: 'approve' }],
      }),
    ).toBeNull();

    const resumedFirst = await resumePendingCodexAppServerApproval({
      sessionId: 'session-a',
      messages: [
        {
          role: 'user',
          content: `approve ${first.pendingApproval?.approvalId}`,
        },
      ],
    });
    const resumedSecond = await resumePendingCodexAppServerApproval({
      sessionId: 'session-b',
      messages: [
        {
          role: 'user',
          content: `approve ${second.pendingApproval?.approvalId}`,
        },
      ],
    });

    expect(resumedFirst?.result).toBe('approved-0');
    expect(resumedSecond?.result).toBe('approved-1');
    expect(
      spawn.mock.calls.filter(([, args]) => args[0] === '--version'),
    ).toHaveLength(1);
  });

  test('migrates user MCP servers without embedding sensitive environment values', () => {
    const args = buildCodexAppServerArgs(
      {
        docs: {
          transport: 'stdio',
          command: 'node',
          args: ['server.js'],
          cwd: '/workspace',
          env: {
            SAFE_MODE: '1',
            API_TOKEN: 'secret-token',
            OPENAI_KEY: 'secret-openai-key',
            DB_PASS: 'secret-db-pass',
            SVC_CREDENTIAL: 'secret-service-credential',
            X_API_SECRET: 'secret-api-secret',
            password: 'secret-password',
          },
        },
        remote: {
          transport: 'http',
          url: 'https://mcp.example.com',
          headers: { Authorization: 'Bearer secret' },
        },
        'bad name': {
          transport: 'stdio',
          command: 'node',
        },
      },
      '/tmp/hybridclaw-context.json',
    );
    const joined = args.join('\n');

    expect(joined).toContain('mcp_servers.docs.command');
    expect(joined).toContain('mcp_servers.docs.args');
    expect(joined).toContain('mcp_servers.docs.cwd');
    expect(joined).toContain('mcp_servers.docs.env.SAFE_MODE');
    expect(joined).toContain('mcp_servers.remote.url');
    expect(joined).not.toContain('API_TOKEN');
    expect(joined).not.toContain('secret-token');
    expect(joined).not.toContain('OPENAI_KEY');
    expect(joined).not.toContain('secret-openai-key');
    expect(joined).not.toContain('DB_PASS');
    expect(joined).not.toContain('secret-db-pass');
    expect(joined).not.toContain('SVC_CREDENTIAL');
    expect(joined).not.toContain('secret-service-credential');
    expect(joined).not.toContain('X_API_SECRET');
    expect(joined).not.toContain('secret-api-secret');
    expect(joined).not.toContain('password');
    expect(joined).not.toContain('secret-password');
    expect(joined).not.toContain('Authorization');
    expect(joined).not.toContain('bad name');
  });

  test('keeps callback MCP secrets out of the persisted context payload', () => {
    const payloads = buildCodexMcpContextPayloads({
      provider: 'openai-codex',
      providerMethod: 'oauth',
      baseUrl: 'https://api.example.com',
      apiKey: 'secret-api-key',
      model: 'openai-codex/gpt-5.4',
      chatbotId: 'chatbot-a',
      requestHeaders: { Authorization: 'Bearer secret-header' },
      gatewayBaseUrl: 'https://gateway.example.com',
      gatewayApiToken: 'secret-gateway-token',
      webSearch: {
        provider: 'brave',
        fallbackProviders: [],
        defaultCount: 5,
        cacheTtlMinutes: 0,
        searxngBaseUrl: '',
        tavilySearchDepth: 'basic',
        braveApiKey: 'secret-web-key',
      },
      providerCredentials: { openai: { apiKey: 'secret-provider-key' } },
    });
    const fileContext = JSON.stringify(payloads.fileContext);
    const secretContext = JSON.stringify(payloads.secretContext);

    expect(fileContext).toContain('openai-codex');
    expect(fileContext).toContain('"provider":"brave"');
    expect(fileContext).toContain('"defaultCount":5');
    expect(fileContext).not.toContain('secret-api-key');
    expect(fileContext).not.toContain('secret-gateway-token');
    expect(fileContext).not.toContain('Authorization');
    expect(fileContext).not.toContain('secret-web-key');
    expect(fileContext).not.toContain('secret-provider-key');
    expect(secretContext).toContain('secret-api-key');
    expect(secretContext).toContain('secret-gateway-token');
    expect(secretContext).toContain('secret-web-key');
    expect(secretContext).not.toContain('"defaultCount":5');
  });

  test('projects Codex command and patch items into HybridClaw tool executions', () => {
    const projection = makeProjection();

    projectCodexThreadItem(projection, {
      type: 'commandExecution',
      command: 'npm test',
      aggregatedOutput: 'ok',
      status: 'completed',
      durationMs: 12,
    });
    projectCodexThreadItem(projection, {
      type: 'fileChange',
      changes: [{ path: 'src/index.ts' }],
      status: 'applied',
    });

    expect([...projection.toolsUsed]).toEqual(['codex.command', 'codex.patch']);
    expect(projection.toolExecutions[0]).toMatchObject({
      name: 'codex.command',
      arguments: 'npm test',
      result: 'ok',
      isError: false,
    });
    expect(projection.toolExecutions[1]?.arguments).toContain('src/index.ts');
  });

  test('projects Codex MCP and dynamic tool items into HybridClaw tool executions', () => {
    const projection = makeProjection();

    projectCodexThreadItem(projection, {
      type: 'mcpToolCall',
      server: 'hybridclaw',
      tool: 'web_fetch',
      arguments: { url: 'https://example.com' },
      result: [{ type: 'text', text: 'ok' }],
      durationMs: 5,
    });
    projectCodexThreadItem(projection, {
      type: 'dynamicToolCall',
      tool: 'apply_patch',
      arguments: { path: 'src/index.ts' },
      status: 'completed',
    });

    expect([...projection.toolsUsed]).toEqual(['codex.mcp', 'codex.tool']);
    expect(projection.toolExecutions[0]).toMatchObject({
      name: 'codex.mcp',
      isError: false,
    });
    expect(projection.toolExecutions[0]?.arguments).toContain(
      'hybridclaw.web_fetch',
    );
    expect(projection.toolExecutions[1]).toMatchObject({
      name: 'codex.tool',
      isError: false,
    });
    expect(projection.toolExecutions[1]?.arguments).toContain('apply_patch');
  });

  test('projects Codex plan and sandbox items into normalized tool executions', () => {
    const projection = makeProjection();

    projectCodexThreadItem(projection, {
      type: 'planUpdate',
      plan: [{ step: 'inspect', status: 'completed' }],
      status: 'completed',
    });
    projectCodexThreadItem(projection, {
      type: 'sandboxPolicy',
      profile: 'workspace-write',
      status: 'active',
    });

    expect([...projection.toolsUsed]).toEqual(['codex.plan', 'codex.sandbox']);
    expect(projection.toolExecutions[0]?.arguments).toContain('inspect');
    expect(projection.toolExecutions[1]?.arguments).toContain(
      'workspace-write',
    );
  });
});
