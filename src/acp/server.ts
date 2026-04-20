import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import * as acp from '@agentclientprotocol/sdk';
import { initAgentRegistry } from '../agents/agent-registry.js';
import { getRuntimeConfig } from '../config/runtime-config.js';
import { handleGatewayMessage } from '../gateway/gateway-chat-service.js';
import { handleGatewayCommand } from '../gateway/gateway-service.js';
import type { GatewayChatResult } from '../gateway/gateway-types.js';
import {
  handleTextChannelApprovalCommand,
  renderTextChannelCommandResult,
  resolveTextChannelSlashCommands,
} from '../gateway/text-channel-commands.js';
import { logger } from '../logger.js';
import { initDatabase, isDatabaseInitialized } from '../memory/db.js';
import type {
  PendingApproval,
  ToolExecution,
  ToolProgressEvent,
} from '../types/execution.js';
import type { McpServerConfig } from '../types/models.js';
import { acpMcpServersToConfigMap } from './mcp.js';
import { buildAcpAvailableCommands, convertAcpPromptBlocks } from './prompt.js';

interface AcpSessionState {
  sessionId: string;
  gatewaySessionId: string;
  cwd: string;
  mcpServersOverride: Record<string, McpServerConfig>;
  activeAbort?: AbortController;
}

let cachedAcpVersion: string | null = null;

function resolveAcpVersion(): string {
  if (cachedAcpVersion) return cachedAcpVersion;
  const envVersion = String(process.env.npm_package_version || '').trim();
  if (envVersion) {
    cachedAcpVersion = envVersion;
    return cachedAcpVersion;
  }

  try {
    const packageJsonPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'package.json',
    );
    const raw = fs.readFileSync(packageJsonPath, 'utf-8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    const version =
      typeof parsed.version === 'string' ? parsed.version.trim() : '';
    if (version) {
      cachedAcpVersion = version;
      return cachedAcpVersion;
    }
  } catch {
    // Fall back below.
  }

  cachedAcpVersion = '0.0.0';
  return cachedAcpVersion;
}

function buildPermissionOptions(
  approval: PendingApproval,
): acp.PermissionOption[] {
  const options: acp.PermissionOption[] = [
    {
      kind: 'allow_once',
      name: 'Allow once',
      optionId: 'yes',
    },
  ];

  if (approval.allowSession) {
    options.push({
      kind: 'allow_always',
      name: 'Allow for this session',
      optionId: 'session',
    });
  } else if (approval.allowAgent) {
    options.push({
      kind: 'allow_always',
      name: 'Allow for this agent',
      optionId: 'agent',
    });
  } else if (approval.allowAll) {
    options.push({
      kind: 'allow_always',
      name: 'Allow for this workspace',
      optionId: 'all',
    });
  }

  options.push({
    kind: 'reject_once',
    name: 'Deny',
    optionId: 'no',
  });
  return options;
}

function inferToolKind(toolName: string): acp.ToolKind {
  const normalized = toolName.trim().toLowerCase();
  if (
    normalized === 'read' ||
    normalized === 'glob' ||
    normalized === 'vision_analyze'
  ) {
    return 'read';
  }
  if (
    normalized === 'grep' ||
    normalized === 'web_search' ||
    normalized === 'session_search'
  ) {
    return 'search';
  }
  if (
    normalized === 'write' ||
    normalized === 'edit' ||
    normalized === 'apply_patch'
  ) {
    return 'edit';
  }
  if (normalized === 'delete') {
    return 'delete';
  }
  if (normalized === 'move') {
    return 'move';
  }
  if (
    normalized === 'bash' ||
    normalized.startsWith('browser_') ||
    normalized === 'http_request'
  ) {
    return 'execute';
  }
  if (normalized === 'web_fetch' || normalized === 'web_extract') {
    return 'fetch';
  }
  if (normalized === 'delegate' || normalized === 'plan') {
    return 'think';
  }
  return 'other';
}

function parseToolArguments(argumentsText: string): unknown {
  const trimmed = argumentsText.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function findApprovalExecution(
  pendingApproval: PendingApproval,
  toolExecutions: ToolExecution[] | undefined,
): ToolExecution | undefined {
  return toolExecutions?.find(
    (execution) => execution.approvalRequestId === pendingApproval.approvalId,
  );
}

class AcpTurnReporter {
  private updateQueue: Promise<void> = Promise.resolve();
  private emittedText = false;
  private nextToolCallId = 1;
  private pendingToolCalls = new Map<string, string[]>();

  constructor(
    private readonly connection: acp.AgentSideConnection,
    private readonly sessionId: string,
  ) {}

  get hasEmittedText(): boolean {
    return this.emittedText;
  }

  enqueueText(text: string): void {
    const chunk = text.trim();
    if (!chunk) return;
    this.emittedText = true;
    this.enqueue(async () => {
      await this.connection.sessionUpdate({
        sessionId: this.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: text,
          },
        },
      });
    });
  }

  enqueueToolProgress(event: ToolProgressEvent): void {
    const queue = this.pendingToolCalls.get(event.toolName) || [];
    if (event.phase === 'start') {
      const toolCallId = `tool-${this.nextToolCallId++}`;
      queue.push(toolCallId);
      this.pendingToolCalls.set(event.toolName, queue);
      this.enqueue(async () => {
        await this.connection.sessionUpdate({
          sessionId: this.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId,
            title: event.preview?.trim()
              ? `${event.toolName}: ${event.preview.trim()}`
              : event.toolName,
            kind: inferToolKind(event.toolName),
            status: 'in_progress',
            ...(event.preview?.trim()
              ? { rawInput: { preview: event.preview.trim() } }
              : {}),
          },
        });
      });
      return;
    }

    const toolCallId = queue.shift() || `tool-${this.nextToolCallId++}`;
    if (queue.length > 0) {
      this.pendingToolCalls.set(event.toolName, queue);
    } else {
      this.pendingToolCalls.delete(event.toolName);
    }
    this.enqueue(async () => {
      await this.connection.sessionUpdate({
        sessionId: this.sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'completed',
          ...(event.preview?.trim()
            ? {
                content: [
                  {
                    type: 'content',
                    content: {
                      type: 'text',
                      text: event.preview.trim(),
                    },
                  },
                ],
                rawOutput: {
                  preview: event.preview.trim(),
                  durationMs: event.durationMs ?? null,
                },
              }
            : {}),
        },
      });
    });
  }

  async flush(): Promise<void> {
    await this.updateQueue;
  }

  private enqueue(task: () => Promise<void>): void {
    this.updateQueue = this.updateQueue.then(task).catch((error) => {
      logger.warn(
        { err: error, sessionId: this.sessionId },
        'ACP session update failed',
      );
    });
  }
}

class HybridClawAcpAgent implements acp.Agent {
  private readonly sessions = new Map<string, AcpSessionState>();

  constructor(private readonly connection: acp.AgentSideConnection) {
    this.connection.signal.addEventListener('abort', () => {
      for (const session of this.sessions.values()) {
        session.activeAbort?.abort();
      }
    });
  }

  async initialize(): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: {
          embeddedContext: true,
          image: true,
          audio: false,
        },
        mcpCapabilities: {
          http: true,
          sse: true,
        },
      },
      agentInfo: {
        name: 'HybridClaw',
        version: resolveAcpVersion(),
      },
    };
  }

  async newSession(
    params: acp.NewSessionRequest,
  ): Promise<acp.NewSessionResponse> {
    const sessionId = randomUUID();
    const session: AcpSessionState = {
      sessionId,
      gatewaySessionId: sessionId,
      cwd: path.resolve(params.cwd),
      mcpServersOverride: acpMcpServersToConfigMap(params.mcpServers),
    };
    this.sessions.set(sessionId, session);

    void this.connection
      .sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: buildAcpAvailableCommands(),
        },
      })
      .catch((error) => {
        logger.warn(
          { err: error, sessionId },
          'Failed to publish ACP command catalog',
        );
      });

    return { sessionId };
  }

  async authenticate(): Promise<acp.AuthenticateResponse> {
    return {};
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Unknown ACP session ${params.sessionId}`);
    }

    session.activeAbort?.abort();
    const abortController = new AbortController();
    session.activeAbort = abortController;

    const reporter = new AcpTurnReporter(this.connection, session.sessionId);

    try {
      const promptInput = convertAcpPromptBlocks(params.prompt);
      let result = await this.runPromptStep({
        session,
        content: promptInput.content,
        media: promptInput.media,
        reporter,
        abortSignal: abortController.signal,
      });

      while (result.pendingApproval && !abortController.signal.aborted) {
        await reporter.flush();
        const permission = await this.requestPermission({
          session,
          pendingApproval: result.pendingApproval,
          toolExecutions: result.toolExecutions,
        });
        if (permission === 'cancelled') {
          return {
            stopReason: 'cancelled',
            ...(params.messageId ? { userMessageId: params.messageId } : {}),
          };
        }

        result = await this.runApprovalStep({
          session,
          action: permission,
          approvalId: result.pendingApproval.approvalId,
          reporter,
          abortSignal: abortController.signal,
        });
      }

      await reporter.flush();

      return {
        stopReason: abortController.signal.aborted ? 'cancelled' : 'end_turn',
        ...(params.messageId ? { userMessageId: params.messageId } : {}),
      };
    } finally {
      if (session.activeAbort === abortController) {
        session.activeAbort = undefined;
      }
    }
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    this.sessions.get(params.sessionId)?.activeAbort?.abort();
  }

  async unstable_closeSession(
    params: acp.CloseSessionRequest,
  ): Promise<acp.CloseSessionResponse> {
    this.sessions.get(params.sessionId)?.activeAbort?.abort();
    this.sessions.delete(params.sessionId);
    return {};
  }

  private async runPromptStep(params: {
    session: AcpSessionState;
    content: string;
    media: ReturnType<typeof convertAcpPromptBlocks>['media'];
    reporter: AcpTurnReporter;
    abortSignal: AbortSignal;
  }): Promise<GatewayChatResult> {
    const slashResult = await this.runSlashCommands({
      session: params.session,
      content: params.content,
    });
    if (slashResult) {
      if (slashResult.result?.trim()) {
        params.reporter.enqueueText(slashResult.result);
      }
      await params.reporter.flush();
      return slashResult;
    }

    const result = await handleGatewayMessage({
      sessionId: params.session.gatewaySessionId,
      guildId: null,
      channelId: 'cli',
      userId: `acp:${params.session.sessionId}`,
      username: 'ACP',
      content: params.content,
      media: params.media,
      workspacePathOverride: params.session.cwd,
      workspaceDisplayRootOverride: params.session.cwd,
      mcpServersOverride: params.session.mcpServersOverride,
      abortSignal: params.abortSignal,
      source: 'acp',
      onTextDelta: (delta) => {
        params.reporter.enqueueText(delta);
      },
      onToolProgress: (event) => {
        params.reporter.enqueueToolProgress(event);
      },
    });

    if (result.sessionId?.trim()) {
      params.session.gatewaySessionId = result.sessionId.trim();
    }
    if (params.abortSignal.aborted) {
      return result;
    }
    if (result.status === 'error') {
      throw new Error(result.error || 'HybridClaw ACP request failed');
    }
    if (
      !result.pendingApproval &&
      !params.reporter.hasEmittedText &&
      result.result?.trim()
    ) {
      params.reporter.enqueueText(result.result);
      await params.reporter.flush();
    }
    return result;
  }

  private async runApprovalStep(params: {
    session: AcpSessionState;
    action: 'yes' | 'session' | 'agent' | 'all' | 'no';
    approvalId: string;
    reporter: AcpTurnReporter;
    abortSignal: AbortSignal;
  }): Promise<GatewayChatResult> {
    const handled = await handleTextChannelApprovalCommand({
      sessionId: params.session.gatewaySessionId,
      guildId: null,
      channelId: 'cli',
      userId: `acp:${params.session.sessionId}`,
      username: 'ACP',
      args: ['approve', params.action, params.approvalId],
    });

    if (!handled) {
      throw new Error(
        'ACP approval bridge did not handle the approval command',
      );
    }

    if (handled.sessionId?.trim()) {
      params.session.gatewaySessionId = handled.sessionId.trim();
    }
    if (params.abortSignal.aborted) {
      return {
        status: 'success',
        result: null,
        toolsUsed: [],
      };
    }

    if (handled.text?.trim()) {
      params.reporter.enqueueText(handled.text);
      await params.reporter.flush();
    }

    return {
      status: 'success',
      result: handled.text || null,
      toolsUsed: [],
      ...(handled.pendingApproval
        ? { pendingApproval: handled.pendingApproval }
        : {}),
      ...(handled.sessionId ? { sessionId: handled.sessionId } : {}),
    };
  }

  private async requestPermission(params: {
    session: AcpSessionState;
    pendingApproval: PendingApproval;
    toolExecutions?: ToolExecution[];
  }): Promise<'yes' | 'session' | 'agent' | 'all' | 'no' | 'cancelled'> {
    const execution = findApprovalExecution(
      params.pendingApproval,
      params.toolExecutions,
    );
    const title =
      execution?.name || params.pendingApproval.intent || 'Pending approval';
    const permission = await this.connection.requestPermission({
      sessionId: params.session.sessionId,
      toolCall: {
        toolCallId: `approval-${params.pendingApproval.approvalId}`,
        title,
        kind: execution ? inferToolKind(execution.name) : 'other',
        status: 'pending',
        rawInput: execution?.arguments.trim()
          ? parseToolArguments(execution.arguments)
          : {
              prompt: params.pendingApproval.prompt,
              intent: params.pendingApproval.intent,
              reason: params.pendingApproval.reason,
            },
      },
      options: buildPermissionOptions(params.pendingApproval),
    });

    if (permission.outcome.outcome === 'cancelled') {
      return 'cancelled';
    }
    switch (permission.outcome.optionId) {
      case 'yes':
      case 'session':
      case 'agent':
      case 'all':
      case 'no':
        return permission.outcome.optionId;
      default:
        throw new Error(
          `Unsupported ACP approval option: ${permission.outcome.optionId}`,
        );
    }
  }

  private async runSlashCommands(params: {
    session: AcpSessionState;
    content: string;
  }): Promise<GatewayChatResult | null> {
    const slashCommands = resolveTextChannelSlashCommands(params.content);
    if (!slashCommands) return null;

    const textParts: string[] = [];
    let pendingApproval:
      | NonNullable<GatewayChatResult['pendingApproval']>
      | undefined;
    let sessionId = params.session.gatewaySessionId;

    for (const args of slashCommands) {
      if ((args[0] || '').trim().toLowerCase() === 'approve') {
        const handled = await handleTextChannelApprovalCommand({
          sessionId,
          guildId: null,
          channelId: 'cli',
          userId: `acp:${params.session.sessionId}`,
          username: 'ACP',
          args,
        });
        if (!handled) continue;
        sessionId = handled.sessionId || sessionId;
        if (handled.text?.trim()) {
          textParts.push(handled.text);
        }
        if (handled.pendingApproval) {
          pendingApproval = handled.pendingApproval;
        }
        continue;
      }

      const commandResult = await handleGatewayCommand({
        sessionId,
        guildId: null,
        channelId: 'cli',
        args,
        userId: `acp:${params.session.sessionId}`,
        username: 'ACP',
      });
      sessionId = commandResult.sessionId || sessionId;
      const rendered = renderTextChannelCommandResult(commandResult).trim();
      if (rendered) {
        textParts.push(rendered);
      }
    }

    params.session.gatewaySessionId = sessionId;
    return {
      status: 'success',
      result: textParts.join('\n\n').trim() || 'Done.',
      toolsUsed: [],
      sessionId,
      ...(pendingApproval ? { pendingApproval } : {}),
    };
  }
}

export async function runAcpServer(): Promise<void> {
  if (!isDatabaseInitialized()) {
    initDatabase({ quiet: true });
  }
  initAgentRegistry(getRuntimeConfig().agents);

  const stream = acp.ndJsonStream(
    Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
  );
  const connection = new acp.AgentSideConnection(
    (conn) => new HybridClawAcpAgent(conn),
    stream,
  );
  await connection.closed;
}
