import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { TurnToolHistory } from '../container/src/turn-tool-history.js';
import {
  expandStoredMessage,
  sanitizeToolHistory,
} from '../src/session/tool-history.js';
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
      toolHistory: new TurnToolHistory('session-test'),
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
              method: 'item/completed',
              params: {
                item: {
                  type: 'commandExecution',
                  command: `echo before-${index}`,
                  aggregatedOutput: `before-${index}`,
                  status: 'completed',
                  exitCode: 0,
                },
              },
            });
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
              item: {
                type: 'commandExecution',
                command: `echo ${index}`,
                aggregatedOutput: String(index),
                status: 'completed',
                exitCode: 0,
              },
            },
          });
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
    expect(DEFAULT_RUNTIME_CONFIG.codex.turnRuntime).toBe('hybridclaw');
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

  test('replays call names, arguments and result ids even with empty assistant content', () => {
    const messages = [
      {
        role: 'assistant' as const,
        content: null,
        tool_calls: [
          {
            id: 'write-a',
            type: 'function' as const,
            function: {
              name: 'write',
              arguments: '{"path":"report.txt","content":"42"}',
            },
          },
        ],
      },
      { role: 'tool' as const, tool_call_id: 'write-a', content: 'Success' },
      { role: 'user' as const, content: 'Which file did you save?' },
    ];
    const before = structuredClone(messages);
    const prompt = buildCodexTurnText(messages);
    expect(prompt).toContain(
      'Tool call (write-a): write {"path":"report.txt","content":"42"}',
    );
    expect(prompt).toContain('Tool result (write-a): Success');
    expect(messages).toEqual(before);
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

    expect(config.codex.runtime).toBe('app-server');
    expect(config.codex.turnRuntime).toBe('app-server');
    expect(spawnSync).toHaveBeenCalledWith('codex', ['--version'], {
      encoding: 'utf-8',
    });
    expect(spawnSync).toHaveBeenCalledWith('codex', ['app-server', '--help'], {
      encoding: 'utf-8',
    });
  });

  test('validates app-server turnRuntime alias when editing config', async () => {
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

    setRuntimeConfigValueAtPath(config, 'codex.turnRuntime', 'APP-SERVER');

    expect(config.codex.runtime).toBe('app-server');
    expect(config.codex.turnRuntime).toBe('app-server');
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
    expect(first.toolHistory).toHaveLength(2);
    expect(JSON.stringify(first.toolHistory)).toContain('before-0');
    expect(JSON.stringify(first.toolHistory)).not.toContain('codex.approval');
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
    expect(resumedFirst?.toolHistory).toHaveLength(2);
    expect(resumedFirst?.toolHistoryForReplay).toEqual(
      resumedFirst?.toolHistory,
    );
    expect(JSON.stringify(resumedFirst?.toolHistory)).not.toContain('before-0');
    expect(JSON.stringify(resumedSecond?.toolHistory)).not.toContain(
      'before-1',
    );
    expect(
      spawn.mock.calls.filter(([, args]) => args[0] === '--version'),
    ).toHaveLength(1);
  });

  test('reports activity while an app-server turn is outstanding', async () => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let appServer: ReturnType<typeof createMockChild> | null = null;
    const spawn = vi.fn((_command: string, args: string[]) => {
      const child = createMockChild();
      if (args[0] === '--version') {
        queueMicrotask(() => child.emit('exit', 0));
        return child;
      }
      appServer = child;
      child.stdin.write = vi.fn((line: string) => {
        const message = JSON.parse(line) as { id?: number; method?: string };
        if (message.method === 'initialize') {
          writeJsonLine(child, { id: message.id, result: {} });
        } else if (message.method === 'thread/start') {
          writeJsonLine(child, {
            id: message.id,
            result: { thread: { id: 'thread-heartbeat' } },
          });
        } else if (message.method === 'turn/start') {
          writeJsonLine(child, {
            id: message.id,
            result: { turn: { id: 'turn-heartbeat', status: 'in_progress' } },
          });
        }
        return true;
      });
      return child;
    });
    vi.doMock('node:child_process', () => ({ spawn }));
    const { runCodexAppServerTurn } = await import(
      '../container/src/codex-app-server.js'
    );
    const onActivity = vi.fn();
    try {
      const turn = runCodexAppServerTurn({
        sessionId: 'session-heartbeat',
        messages: [{ role: 'user', content: 'run a long tool' }],
        model: 'openai-codex/gpt-5.4',
        cwd: '/workspace',
        provider: 'openai-codex',
        onActivity,
      });
      await vi.waitFor(() => {
        const child = appServer as ReturnType<typeof createMockChild> | null;
        expect(child).not.toBeNull();
        expect(child?.stdin.write).toHaveBeenCalledTimes(3);
      });
      expect(onActivity).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(25_000);
      expect(onActivity).toHaveBeenCalledTimes(2);

      const child = appServer as unknown as ReturnType<typeof createMockChild>;
      writeJsonLine(child, {
        method: 'item/completed',
        params: { item: { type: 'agentMessage', text: 'done' } },
      });
      writeJsonLine(child, {
        method: 'turn/completed',
        params: { turn: { status: 'completed' } },
      });
      const output = await turn;
      expect(output.result).toBe('done');

      await vi.advanceTimersByTimeAsync(30_000);
      expect(onActivity).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('retains completed native exchanges when the app-server exits before finishing', async () => {
    vi.resetModules();
    const spawn = vi.fn((_command: string, args: string[]) => {
      const child = createMockChild();
      if (args[0] === '--version') {
        queueMicrotask(() => child.emit('exit', 0));
        return child;
      }
      child.stdin.write = vi.fn((line: string) => {
        const message = JSON.parse(line);
        if (message.method === 'initialize')
          writeJsonLine(child, { id: message.id, result: {} });
        if (message.method === 'thread/start')
          writeJsonLine(child, {
            id: message.id,
            result: { thread: { id: 'thread-error' } },
          });
        if (message.method === 'turn/start') {
          writeJsonLine(child, {
            id: message.id,
            result: { turn: { status: 'in_progress' } },
          });
          setTimeout(() => {
            writeJsonLine(child, {
              method: 'item/completed',
              params: {
                item: {
                  type: 'commandExecution',
                  command: 'echo saved',
                  aggregatedOutput: 'saved',
                  status: 'completed',
                  exitCode: 0,
                },
              },
            });
            child.emit('exit', 1);
          }, 0);
        }
        return true;
      });
      return child;
    });
    vi.doMock('node:child_process', () => ({ spawn }));
    const { runCodexAppServerTurn } = await import(
      '../container/src/codex-app-server.js'
    );
    const output = await runCodexAppServerTurn({
      sessionId: 'session-error',
      messages: [{ role: 'user', content: 'Run the command' }],
      model: 'openai-codex/gpt-5.4',
    });
    expect(output.status).toBe('error');
    expect(output.toolHistory).toHaveLength(2);
    expect(JSON.stringify(output.toolHistory)).toContain('echo saved');
    expect(output.toolHistoryForReplay).toEqual(output.toolHistory);
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
    const history = projection.toolHistory.finish('Done');
    const replay = expandStoredMessage({
      role: 'assistant',
      content: 'Done',
      tool_history_json: JSON.stringify(history),
    });
    const prompt = buildCodexTurnText([
      ...replay,
      { role: 'user', content: 'What did you do?' },
    ]);
    expect(prompt).toContain('codex.command {"command":"npm test"}');
    expect(prompt).toContain('src/index.ts');
    expect(history.filter((message) => message.role === 'tool')).toHaveLength(
      2,
    );
  });

  test('retains failed command and MCP outcomes explicitly in native tool history', () => {
    const projection = makeProjection();
    projectCodexThreadItem(projection, {
      type: 'commandExecution',
      command: 'test -f missing.txt',
      aggregatedOutput: '',
      status: 'completed',
      exitCode: 1,
    });
    projectCodexThreadItem(projection, {
      type: 'mcpToolCall',
      server: 'example',
      tool: 'lookup',
      arguments: {},
      status: 'completed',
      result: {
        isError: true,
        content: [{ type: 'text', text: 'Unavailable' }],
      },
    });
    expect(
      projection.toolExecutions.every((execution) => execution.isError),
    ).toBe(true);
    const history = projection.toolHistory.finish('Done');
    for (const message of history.filter((entry) => entry.role === 'tool')) {
      expect(message.content).toMatch(/^Tool failed:\n/);
    }
  });

  test('native tool history remains credential-redactable at the gateway boundary', () => {
    const projection = makeProjection();
    projectCodexThreadItem(projection, {
      type: 'mcpToolCall',
      server: 'example',
      tool: 'lookup',
      arguments: { api_key: 'test-key' },
      result: { api_key: 'test-result-key', value: 'visible' },
      status: 'completed',
    });
    const sanitized = sanitizeToolHistory(
      projection.toolHistory.finish('Done'),
    );
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain('test-key');
    expect(serialized).not.toContain('test-result-key');
    expect(serialized).toContain('visible');
  });

  test.each([
    'failed',
    'declined',
  ])('does not record a %s file change as successful', (status) => {
    const projection = makeProjection();
    projectCodexThreadItem(projection, {
      type: 'fileChange',
      changes: [{ path: 'report.txt' }],
      status,
    });
    expect(projection.toolExecutions[0].isError).toBe(true);
    expect(projection.toolHistory.finish('Done')[1].content).toBe(
      `Tool failed:\n${status}`,
    );
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
    expect(projection.toolHistory.finish('Done')).toEqual([]);
  });
});
